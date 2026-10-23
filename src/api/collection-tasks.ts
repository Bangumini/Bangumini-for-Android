import type { QueryClient } from "@tanstack/react-query";
import { AppState } from "react-native";

import {
  getEpisodes,
  getUserCollection,
  patchSubjectEpisodes,
  postUserCollection,
} from "../../shared/api/client";
import type { CollectionType, Episode, PagedResponse, UserCollection } from "../../shared/api/types";
import {
  applyCollectionPatch,
  mergeCollectionPatchIntoList,
  removeCollection,
  updateCollectionListForType,
  upsertCollection,
} from "../../shared/collection-cache";
import {
  completePersistentCollectionTask,
  deletePersistentCollectionTask,
  markPersistentCollectionTaskFailed,
  markPersistentCollectionTaskRunning,
  readCachedCollection,
  readCachedValueEntryAllowStale,
  readDuePersistentCollectionTask,
  readNextPersistentCollectionTaskRunAt,
  readPersistentCollectionTasks,
  recoverRunningPersistentCollectionTasks,
  retryPersistentCollectionTask,
  upsertPersistentCollectionTask,
  writeCachedCollection,
  writeCachedEpisodes,
  writeCachedValue,
  type PersistentCollectionTask,
  type PersistentCollectionTaskStatus,
} from "../../shared/storage/sqlite-cache";
import { showToast } from "../utils/toast";

export const COLLECTION_TASK_EVENT = "bangumini:collection-task";
export const COLLECTION_TASK_QUEUE_EVENT = "bangumini:collection-task-queue";

const COLLECTIONS_CACHE_PREFIX = "collections-";
const COLLECTION_TYPES: CollectionType[] = [1, 2, 3, 4, 5];
const RETRY_BASE_DELAY_MS = 30_000;
const RETRY_MAX_DELAY_MS = 30 * 60_000;

export type CollectionTaskStatus = "started" | "finished" | "failed";
export type CollectionTaskKind = "set-collection-type" | "set-progress" | "complete-progress";

type CollectionTaskBasePayload = {
  username: string;
  subjectId: number;
  subjectTitle: string;
  previousType?: CollectionType;
};

export type SetCollectionTypeTaskPayload = CollectionTaskBasePayload & {
  nextType: CollectionType;
};

export type SetProgressTaskPayload = CollectionTaskBasePayload & {
  targetEp: number;
  ensureWatching: boolean;
};

export type CompleteProgressTaskPayload = CollectionTaskBasePayload & {
  targetEp: number;
  totalEp: number;
  ensureWatching: boolean;
  markWatched: boolean;
};

export type CollectionTaskPayload =
  | SetCollectionTypeTaskPayload
  | SetProgressTaskPayload
  | CompleteProgressTaskPayload;

export type SetCollectionTypeTask = PersistentCollectionTask<SetCollectionTypeTaskPayload> & {
  kind: "set-collection-type";
  status: PersistentCollectionTaskStatus;
};

export type SetProgressTask = PersistentCollectionTask<SetProgressTaskPayload> & {
  kind: "set-progress";
  status: PersistentCollectionTaskStatus;
};

export type CompleteProgressTask = PersistentCollectionTask<CompleteProgressTaskPayload> & {
  kind: "complete-progress";
  status: PersistentCollectionTaskStatus;
};

export type CollectionTask = SetCollectionTypeTask | SetProgressTask | CompleteProgressTask;

export type CollectionTaskEventDetail = {
  taskId: string;
  status: CollectionTaskStatus;
  kind: CollectionTaskKind;
  subjectId: number;
  previousType?: CollectionType;
  nextType?: CollectionType;
};

type CollectionTaskListener = (detail: CollectionTaskEventDetail) => void;
type CollectionTaskQueueListener = () => void;

let queryClient: QueryClient | null = null;
let workerStarted = false;
let workerRunning = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
const collectionTaskListeners = new Set<CollectionTaskListener>();
const collectionTaskQueueListeners = new Set<CollectionTaskQueueListener>();

function emitCollectionTaskEvent(detail: CollectionTaskEventDetail) {
  collectionTaskListeners.forEach((listener) => listener(detail));
}

function emitCollectionTaskQueueChanged() {
  collectionTaskQueueListeners.forEach((listener) => listener());
}

export function subscribeCollectionTasks(listener: CollectionTaskListener) {
  collectionTaskListeners.add(listener);
  return () => collectionTaskListeners.delete(listener);
}

export function subscribeCollectionTaskQueue(listener: CollectionTaskQueueListener) {
  collectionTaskQueueListeners.add(listener);
  return () => collectionTaskQueueListeners.delete(listener);
}

function isNotFoundError(error: unknown) {
  return error instanceof Error && error.message.includes("Bangumi API error 404");
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isCollectionTaskKind(kind: string): kind is CollectionTaskKind {
  return kind === "set-collection-type" || kind === "set-progress" || kind === "complete-progress";
}

function isCollectionType(value: unknown): value is CollectionType {
  return value === 1 || value === 2 || value === 3 || value === 4 || value === 5;
}

function asCollectionTask(task: PersistentCollectionTask): CollectionTask | null {
  if (!isCollectionTaskKind(task.kind)) return null;
  if (!task.payload || typeof task.payload !== "object") return null;

  const payload = task.payload as Partial<CollectionTaskPayload>;
  if (typeof payload.username !== "string" || typeof payload.subjectId !== "number") return null;
  if (typeof payload.subjectTitle !== "string") return null;
  if (payload.previousType !== undefined && !isCollectionType(payload.previousType)) return null;

  if (task.kind === "set-collection-type") {
    if (!isCollectionType((payload as Partial<SetCollectionTypeTaskPayload>).nextType)) return null;
  } else {
    const progressPayload = payload as Partial<SetProgressTaskPayload | CompleteProgressTaskPayload>;
    if (typeof progressPayload.targetEp !== "number") return null;
    if (typeof progressPayload.ensureWatching !== "boolean") return null;

    if (task.kind === "complete-progress") {
      const completePayload = payload as Partial<CompleteProgressTaskPayload>;
      if (typeof completePayload.totalEp !== "number") return null;
      if (typeof completePayload.markWatched !== "boolean") return null;
    }
  }

  return task as CollectionTask;
}

function getTaskId(kind: CollectionTaskKind, username: string, subjectId: number) {
  return `${kind}:${username}:${subjectId}`;
}

async function getTaskIdForEnqueue(kind: CollectionTaskKind, username: string, subjectId: number) {
  const baseId = getTaskId(kind, username, subjectId);
  const tasks = await getCollectionTaskQueue();
  const existing = tasks.find((task) => task.id === baseId);
  return existing?.status === "running" ? `${baseId}:${Date.now()}` : baseId;
}

function getTaskSubjectId(task: Pick<CollectionTask, "payload">) {
  return task.payload.subjectId;
}

function getTaskPreviousType(task: CollectionTask) {
  return task.payload.previousType;
}

function getExpectedNextType(task: CollectionTask): CollectionType | undefined {
  if (task.kind === "set-collection-type") return task.payload.nextType;
  if (task.kind === "set-progress") return task.payload.ensureWatching ? 3 : undefined;
  if (task.kind === "complete-progress") return task.payload.markWatched ? 2 : 3;
  return undefined;
}

export function mergePendingCollectionTasks({
  data,
  currentData,
  tasks,
  cachedCollections,
  username,
  collectionType,
}: {
  data: PagedResponse<UserCollection>;
  currentData?: PagedResponse<UserCollection>;
  tasks: CollectionTask[];
  cachedCollections?: UserCollection[];
  username: string;
  collectionType: CollectionType;
}): PagedResponse<UserCollection> {
  const userTasks = tasks.filter((task) => task.payload.username === username);
  const subjectIds = new Set(userTasks.map((task) => getTaskSubjectId(task)));
  if (subjectIds.size === 0) return data;

  const fallbackBySubjectId = new Map<number, UserCollection>();
  for (const collection of cachedCollections ?? []) {
    fallbackBySubjectId.set(collection.subject_id, collection);
  }
  // 当前内存比 SQLite 快照更新，作为缺失条目的优先回填来源。
  for (const collection of currentData?.data ?? []) {
    fallbackBySubjectId.set(collection.subject_id, collection);
  }

  let mergedData = data;
  for (const subjectId of subjectIds) {
    const patch = getOptimisticCollectionPatchForSubject(subjectId, userTasks);
    if (!patch) continue;
    mergedData = mergeCollectionPatchIntoList({
      data: mergedData,
      subjectId,
      patch,
      collectionType,
      fallbackCollection: fallbackBySubjectId.get(subjectId),
    });
  }
  return mergedData;
}

function publishCollectionToQueryCaches(username: string, collection: UserCollection) {
  queryClient?.setQueryData(["collection", username, collection.subject_id], collection);
  for (const type of COLLECTION_TYPES) {
    queryClient?.setQueryData<PagedResponse<UserCollection>>(
      ["collections", type, username],
      (old) => updateCollectionListForType(old, collection, type),
    );
  }
}

async function syncCollectionCaches(username: string, collection: UserCollection) {
  // 旧任务的最终确认也可能迟于新意图；界面始终投影该用户剩余队列。
  const tasks = (await getCollectionTaskQueue()).filter((task) => task.payload.username === username);
  const patch = getOptimisticCollectionPatchForSubject(collection.subject_id, tasks);
  publishCollectionToQueryCaches(username, patch ? applyCollectionPatch(collection, patch) : collection);

  // 内存先一次性提交；持久化仅存服务端基础值，不将尚未成功的意图落盘。
  await writeCachedCollection(username, collection);
  for (const type of COLLECTION_TYPES) {
    const cacheKey = `${COLLECTIONS_CACHE_PREFIX}${type}-${username}`;
    const cached = await readCachedValueEntryAllowStale<PagedResponse<UserCollection>>(cacheKey);
    if (!cached?.payload.data) continue;
    await writeCachedValue(cacheKey, type === collection.type
      ? upsertCollection(cached.payload, collection)
      : removeCollection(cached.payload, collection.subject_id));
  }
  // 收藏进度不会改变剧集总数和播出排期，不触发整页及排期查询失效。
}

async function fetchCollectionOrNull(username: string, subjectId: number) {
  try {
    return await getUserCollection(username, subjectId);
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
}

async function ensureCollectionType(username: string, subjectId: number, nextType: CollectionType) {
  const current = await fetchCollectionOrNull(username, subjectId);
  if (current?.type === nextType) return current;

  await postUserCollection(subjectId, { type: nextType });
  return getUserCollection(username, subjectId);
}

async function fetchEpisodesForProgress(subjectId: number) {
  const episodes = await getEpisodes(subjectId);
  await writeCachedEpisodes(subjectId, episodes);
  return episodes;
}

function getMainEpisodeIdsBetween(episodes: Episode[], fromEp: number, toEp: number) {
  return episodes
    .slice()
    .sort((a, b) => a.sort - b.sort)
    .filter((episode) => episode.type === 0)
    .slice(fromEp, toEp)
    .map((episode) => episode.id);
}

async function executeProgressTask(payload: SetProgressTaskPayload | CompleteProgressTaskPayload) {
  const { username, subjectId, targetEp, ensureWatching } = payload;
  let collection = ensureWatching
    ? await ensureCollectionType(username, subjectId, 3)
    : await fetchCollectionOrNull(username, subjectId);

  if (!collection) {
    throw new Error("Collection is required before updating progress");
  }

  const currentEp = collection.ep_status;
  if (currentEp !== targetEp) {
    const episodes = await fetchEpisodesForProgress(subjectId);
    const from = Math.min(currentEp, targetEp);
    const to = Math.max(currentEp, targetEp);
    const episodeIds = getMainEpisodeIdsBetween(episodes.data, from, to);

    if (episodeIds.length === 0 && from !== to) {
      throw new Error("Episode list is not ready");
    }

    if (episodeIds.length > 0) {
      await patchSubjectEpisodes(subjectId, {
        episode_id: episodeIds,
        type: targetEp > currentEp ? 2 : 0,
      });
    }

    collection = await getUserCollection(username, subjectId);
  }

  if ("markWatched" in payload && payload.markWatched && collection.type !== 2) {
    await postUserCollection(subjectId, { type: 2 });
    collection = await getUserCollection(username, subjectId);
  }

  return collection;
}

async function executeCollectionTask(task: CollectionTask) {
  if (task.kind === "set-collection-type") {
    return ensureCollectionType(
      task.payload.username,
      task.payload.subjectId,
      task.payload.nextType,
    );
  }

  return executeProgressTask(task.payload);
}

function getRetryDelay(attemptCount: number) {
  return Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * (2 ** attemptCount));
}

function showFailureToast(task: CollectionTask) {
  if (AppState.currentState !== "active") return;
  const message = task.kind === "set-progress" || task.kind === "complete-progress"
    ? "进度同步失败，将稍后重试"
    : "收藏状态同步失败，将稍后重试";
  showToast(message);
}

async function scheduleNextWorkerRun() {
  if (retryTimer !== null) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }

  const nextRunAt = await readNextPersistentCollectionTaskRunAt();
  if (nextRunAt === null) return;

  retryTimer = setTimeout(() => {
    retryTimer = null;
    void kickCollectionTaskWorker();
  }, Math.max(1000, nextRunAt - Date.now()));
}

export async function getCollectionTaskQueue(): Promise<CollectionTask[]> {
  const tasks = await readPersistentCollectionTasks();
  return tasks
    .map((task) => asCollectionTask(task))
    .filter((task): task is CollectionTask => task !== null);
}

export async function enqueueSetCollectionTypeTask(payload: SetCollectionTypeTaskPayload) {
  const task = await upsertPersistentCollectionTask({
    id: await getTaskIdForEnqueue("set-collection-type", payload.username, payload.subjectId),
    kind: "set-collection-type",
    payload,
  });
  emitCollectionTaskQueueChanged();
  void kickCollectionTaskWorker();
  return task ? asCollectionTask(task) : null;
}

export async function enqueueCompleteProgressTask(payload: CompleteProgressTaskPayload) {
  const task = await upsertPersistentCollectionTask({
    id: await getTaskIdForEnqueue("complete-progress", payload.username, payload.subjectId),
    kind: "complete-progress",
    payload,
  });
  emitCollectionTaskQueueChanged();
  void kickCollectionTaskWorker();
  return task ? asCollectionTask(task) : null;
}

export async function retryCollectionTask(id: string) {
  await retryPersistentCollectionTask(id);
  emitCollectionTaskQueueChanged();
  void kickCollectionTaskWorker();
}

export async function ignoreCollectionTask(id: string) {
  try {
    const task = (await getCollectionTaskQueue()).find((item) => item.id === id);
    await deletePersistentCollectionTask(id);
    if (!task) return;

    const { username, subjectId } = task.payload;
    try {
      // QueryData 可能已包含被忽略任务的投影，必须从磁盘确认值恢复，不能拿它作基础。
      let collection = await readCachedCollection(username, subjectId);
      if (!collection) {
        for (const type of COLLECTION_TYPES) {
          const cached = await readCachedValueEntryAllowStale<PagedResponse<UserCollection>>(
            `${COLLECTIONS_CACHE_PREFIX}${type}-${username}`,
          );
          collection = cached?.payload.data?.find((item) => item.subject_id === subjectId) ?? null;
          if (collection) break;
        }
      }
      if (collection) {
        const remaining = (await getCollectionTaskQueue()).filter((item) => item.payload.username === username);
        const patch = getOptimisticCollectionPatchForSubject(subjectId, remaining);
        publishCollectionToQueryCaches(username, patch ? applyCollectionPatch(collection, patch) : collection);
      }
    } finally {
      // 缺少基础值或离线时先保留可用缓存，联网后仅回源该用户的相关查询。
      await Promise.all([
        queryClient?.invalidateQueries({ queryKey: ["collection", username, subjectId], exact: true }),
        queryClient?.invalidateQueries({
          predicate: (query) => query.queryKey[0] === "collections" && query.queryKey[2] === username,
        }),
      ]);
    }
  } finally {
    // 恢复/回源失败也不能漏通知，否则任务面板和列表会一直保留旧队列。
    emitCollectionTaskQueueChanged();
  }
}

export function getOptimisticCollectionPatchForSubject(
  subjectId: number,
  tasks: CollectionTask[],
): Partial<Pick<UserCollection, "ep_status" | "type">> | null {
  const patch: Partial<Pick<UserCollection, "ep_status" | "type">> = {};
  const subjectTasks = tasks
    .filter((task) => getTaskSubjectId(task) === subjectId)
    .sort((a, b) => a.createdAt - b.createdAt || a.updatedAt - b.updatedAt);

  for (const task of subjectTasks) {
    if (task.kind === "set-collection-type") {
      patch.type = task.payload.nextType;
    } else if (task.kind === "set-progress") {
      patch.ep_status = task.payload.targetEp;
      if (task.payload.ensureWatching) patch.type = 3;
    } else if (task.kind === "complete-progress") {
      patch.ep_status = task.payload.targetEp;
      patch.type = task.payload.markWatched ? 2 : 3;
    }
  }

  return Object.keys(patch).length > 0 ? patch : null;
}

export function getCollectionTaskSummary(task: CollectionTask) {
  const title = task.payload.subjectTitle || `#${task.payload.subjectId}`;
  if (task.kind === "set-collection-type") {
    return `${title} 收藏状态同步`;
  }
  if (task.kind === "complete-progress" && task.payload.markWatched) {
    return `${title} 进度与看过状态同步`;
  }
  return `${title} 观看进度同步`;
}

export async function kickCollectionTaskWorker() {
  if (workerRunning) return;
  workerRunning = true;

  try {
    while (true) {
      const dueTask = await readDuePersistentCollectionTask();
      const task = dueTask ? asCollectionTask(dueTask) : null;
      if (!dueTask) break;
      if (!task) {
        await deletePersistentCollectionTask(dueTask.id);
        emitCollectionTaskQueueChanged();
        continue;
      }

      await markPersistentCollectionTaskRunning(task.id);
      emitCollectionTaskQueueChanged();
      emitCollectionTaskEvent({
        taskId: task.id,
        status: "started",
        kind: task.kind,
        subjectId: task.payload.subjectId,
        previousType: getTaskPreviousType(task),
        nextType: getExpectedNextType(task),
      });

      try {
        const collection = await executeCollectionTask(task);
        // 进度与收藏类型全部更新后才提交，不能将任务中间读回暴露给界面。
        await syncCollectionCaches(task.payload.username, collection);
        await completePersistentCollectionTask(task.id);
        emitCollectionTaskEvent({
          taskId: task.id,
          status: "finished",
          kind: task.kind,
          subjectId: task.payload.subjectId,
          previousType: getTaskPreviousType(task),
          nextType: collection.type,
        });
        emitCollectionTaskQueueChanged();
      } catch (error) {
        const delay = getRetryDelay(task.attemptCount);
        await markPersistentCollectionTaskFailed(task.id, getErrorMessage(error), Date.now() + delay);
        emitCollectionTaskEvent({
          taskId: task.id,
          status: "failed",
          kind: task.kind,
          subjectId: task.payload.subjectId,
          previousType: getTaskPreviousType(task),
          nextType: getExpectedNextType(task),
        });
        emitCollectionTaskQueueChanged();
        if (task.attemptCount === 0) showFailureToast(task);
      }
    }
  } finally {
    workerRunning = false;
    await scheduleNextWorkerRun();
  }
}

export function startCollectionTaskWorker(client: QueryClient) {
  queryClient = client;
  if (workerStarted) {
    void kickCollectionTaskWorker();
    return;
  }

  workerStarted = true;
  AppState.addEventListener("change", (state) => {
    if (state === "active") void kickCollectionTaskWorker();
  });

  void recoverRunningPersistentCollectionTasks().then(() => {
    emitCollectionTaskQueueChanged();
    void kickCollectionTaskWorker();
  });
}
