import { useCallback, useEffect, useRef, useState } from "react";
import type { QueryClient } from "@tanstack/react-query";
import {
  createSubjectDetailCollectionGuard, emptySubjectDetailData, isDetailPublication, loadSubjectDetailData, projectDetailCollection, publishSubjectDetailSnapshot,
  sameDetailData, type SubjectDetailData,
} from "./subject-detail-loader";

type DetailJob = {
  data: SubjectDetailData | null;
  listeners: Set<() => void>;
  done: Promise<void>;
  force: boolean;
  finished: boolean;
  phase: "loading" | "initial" | "settled";
  collectionGuard?: ReturnType<typeof createSubjectDetailCollectionGuard>;
};
const jobs = new WeakMap<QueryClient, Map<string, DetailJob>>();
const identityKey = (subjectId: number, username: string | null) => JSON.stringify([username, subjectId]);

// 共享的是整个两阶段任务，不是仅返回 initial 的 Promise；卸载不会取消发布和完成屏障。
function loadOnce(subjectId: number, username: string | null, client: QueryClient, force = false, collectionGuard?: DetailJob["collectionGuard"]): DetailJob {
  let pending = jobs.get(client);
  if (!pending) { pending = new Map(); jobs.set(client, pending); }
  const key = identityKey(subjectId, username);
  const existing = pending.get(key);
  if (existing) return existing;
  const job: DetailJob = { data: null, listeners: new Set(), force, collectionGuard, finished: false, phase: "loading", done: Promise.resolve() };
  pending.set(key, job);
  const publish = (data: SubjectDetailData, phase: DetailJob["phase"]) => {
    const phaseChanged = job.phase !== phase;
    job.phase = phase;
    if (sameDetailData(job.data, data)) {
      if (phaseChanged) for (const listener of job.listeners) listener();
      return;
    }
    job.data = data;
    for (const listener of job.listeners) listener();
  };
  const unsubscribe = client.getQueryCache().subscribe(event => {
    if (isDetailPublication(client) || !job.data || event.type !== "updated" || event.action.type !== "success") return;
    const queryKey = event.query.queryKey;
    if (queryKey[0] !== "collection" || queryKey[1] !== username || queryKey[2] !== subjectId) return;
    // 重挂时共享初版也应携带期间 worker 的更新，而不是重复旧进度。
    const collection = projectDetailCollection(job.data.collection, client.getQueryData<UserCollectionData>(queryKey));
    if (collection !== job.data.collection) job.data = { ...job.data, collection };
  });
  job.done = loadSubjectDetailData({ subjectId, username, queryClient: client, force, collectionGuard }).then(async result => {
    publish(publishSubjectDetailSnapshot(client, subjectId, username, result.initial, true), "initial");
    publish(publishSubjectDetailSnapshot(client, subjectId, username, await result.settled, false), "settled");
  }).catch(() => {
    // 单个资源在 loader 内降级；未知错误也不能撤销已发布的本地首屏。
  }).finally(() => {
    job.finished = true;
    unsubscribe();
    if (pending.get(key) === job) pending.delete(key);
    if (job.data === null) for (const listener of job.listeners) listener();
  });
  return job;
}

export function useSubjectDetailData(subjectId: number, username: string | null, queryClient: QueryClient) {
  const key = identityKey(subjectId, username);
  const activeKey = useRef(key);
  activeKey.current = key;
  const [state, setState] = useState<{ key: string; data: SubjectDetailData; loading: boolean; refreshing: boolean }>(
    () => ({ key, data: emptySubjectDetailData(), loading: true, refreshing: false }),
  );
  const stateRef = useRef(state);
  stateRef.current = state;
  const refreshSerial = useRef(0);
  const refreshIntent = useRef<string | null>(null);
  const update = useCallback((data: SubjectDetailData | null, loading = false) => {
    if (activeKey.current !== key) return;
    const visible = stateRef.current;
    if (visible.key === key && visible.loading === loading && (data === null || sameDetailData(visible.data, data))) return;
    setState(current => {
      const next = data ?? (current.key === key ? current.data : emptySubjectDetailData());
      return current.key === key && current.loading === loading && sameDetailData(current.data, next)
        ? current : { key, data: next, loading, refreshing: current.key === key && current.refreshing };
    });
  }, [key]);
  useEffect(() => {
    if (!Number.isFinite(subjectId)) { update(null); return; }
    let cancelled = false;
    const job = loadOnce(subjectId, username, queryClient);
    const sync = () => {
      // 手动刷新已接管时保留当前展示，不再接收被等待的旧普通任务终版。
      if (!cancelled && refreshIntent.current !== key) update(job.data, job.data === null && !job.finished);
    };
    job.listeners.add(sync);
    sync();
    const unsubscribe = queryClient.getQueryCache().subscribe(event => {
      if (isDetailPublication(queryClient) || event.type !== "updated" || event.action.type !== "success") return;
      const queryKey = event.query.queryKey;
      if (queryKey[0] !== "collection" || queryKey[1] !== username || queryKey[2] !== subjectId) return;
      const live = queryClient.getQueryData<UserCollectionData>(["collection", username, subjectId]);
      // 只投影可交互字段，其他资源和 API 元数据仍由完整快照提交。
      setState(current => {
        if (cancelled || current.loading || current.key !== key || activeKey.current !== key) return current;
        const collection = projectDetailCollection(current.data.collection, live);
        return collection === current.data.collection ? current : { ...current, data: { ...current.data, collection } };
      });
    });
    return () => { cancelled = true; job.listeners.delete(sync); unsubscribe(); };
  }, [key, subjectId, username, queryClient, update]);

  const refresh = useCallback(async () => {
    if (!Number.isFinite(subjectId)) return;
    const serial = ++refreshSerial.current;
    refreshIntent.current = key;
    setState(current => current.key === key ? { ...current, refreshing: true } : current);
    // 保护屏障从用户开始刷新算起，等待旧任务期间的 worker 提交也不能被下一轮覆盖。
    const collectionGuard = createSubjectDetailCollectionGuard(queryClient, subjectId, username);
    let job = loadOnce(subjectId, username, queryClient, true, collectionGuard);
    try {
      // 普通后台任务必须先真正 settled；手动刷新随后强制全部资源（含音乐衍生 API）。
      if (!job.force) { await job.done; job = loadOnce(subjectId, username, queryClient, true, collectionGuard); }
      // 新 force 初版也不替换当前首屏，只接收其完整终版；worker 字段监听不受影响。
      const sync = () => { if (job.phase === "settled") update(job.data, false); };
      job.listeners.add(sync);
      try { sync(); await job.done; sync(); }
      finally { job.listeners.delete(sync); }
    } finally {
      if (job.collectionGuard !== collectionGuard) collectionGuard.dispose();
      if (refreshSerial.current === serial) {
        refreshIntent.current = null;
        if (activeKey.current === key) setState(current => current.key === key ? { ...current, refreshing: false } : current);
      }
    }
  }, [key, subjectId, username, queryClient, update]);

  // effect 运行前的切页首帧也必须隔离，不能闪现上一条目或上一账号。
  const visible = state.key === key ? state : { data: emptySubjectDetailData(), loading: true, refreshing: false };
  return { data: visible.data, loading: visible.loading, refreshing: visible.refreshing, refresh };
}
type UserCollectionData = SubjectDetailData["collection"];
