import AsyncStorage from "@react-native-async-storage/async-storage";

import { isValidAiringOffsetDays, type AiringOffsets } from "../../shared/airing-offset";

export const AIRING_OFFSETS_STORAGE_KEY = "bangumini_airing_offsets";

const EMPTY_OFFSETS: AiringOffsets = Object.freeze({});
let snapshot = EMPTY_OFFSETS;
let initialized = false;
let initialization: Promise<void> | undefined;
let saveQueue: Promise<void> = Promise.resolve();
const listeners = new Set<() => void>();

function isValidSubjectId(subjectId: number) {
  return Number.isSafeInteger(subjectId) && subjectId > 0;
}

function parseOffsets(raw: string | null): AiringOffsets {
  if (!raw) return EMPTY_OFFSETS;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return EMPTY_OFFSETS;
    const result: Record<number, number> = {};
    for (const [key, value] of Object.entries(parsed)) {
      const subjectId = Number(key);
      if (
        String(subjectId) === key &&
        isValidSubjectId(subjectId) &&
        isValidAiringOffsetDays(value) &&
        value !== 0
      ) result[subjectId] = value;
    }
    return Object.freeze(result);
  } catch {
    return EMPTY_OFFSETS;
  }
}

function publish(next: AiringOffsets) {
  const keys = Object.keys(next);
  if (
    keys.length === Object.keys(snapshot).length &&
    keys.every((key) => next[Number(key)] === snapshot[Number(key)])
  ) return;
  snapshot = next;
  for (const listener of listeners) listener();
}

function restore(): Promise<void> {
  if (initialized) return Promise.resolve();
  if (!initialization) {
    initialization = (async () => {
      const next = parseOffsets(await AsyncStorage.getItem(AIRING_OFFSETS_STORAGE_KEY));
      initialized = true;
      publish(next);
    })().finally(() => { initialization = undefined; });
  }
  return initialization;
}

/** 可供首屏 await；读取失败仍显示默认值，下次初始化或保存时重试。 */
export async function initializeAiringOffsets(): Promise<void> {
  try {
    await restore();
  } catch {
    // 不将读取失败作为初始化成功；也不能让 hook 的预热产生未处理的拒绝。
  }
}

export function getAiringOffsetsSnapshot(): AiringOffsets {
  return snapshot;
}

export function subscribeAiringOffsets(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export async function setAiringOffsetDays(subjectId: number, days: number): Promise<void> {
  if (!isValidSubjectId(subjectId) || !isValidAiringOffsetDays(days)) {
    throw new RangeError("放送偏置必须为 -365 至 365 的整数天，且条目 ID 必须有效");
  }
  const operation = saveQueue.then(async () => {
    // 保存必须等待读取完成：既保留其他条目的偏好，也防止旧读取回滚新保存。
    // 读取失败时拒绝保存，不能把尚未恢复的空快照写回磁盘。
    await restore();
    const next = { ...snapshot };
    if (days === 0) delete next[subjectId];
    else next[subjectId] = days;
    await AsyncStorage.setItem(AIRING_OFFSETS_STORAGE_KEY, JSON.stringify(next));
    // 本地偏好跨账号沿用，仅持久化成功后发布；不修改 API 原始缓存。
    publish(Object.freeze(next));
  });
  // 前一次失败不阻塞后续保存；调用方仍收到原始拒绝以显示错误反馈。
  saveQueue = operation.catch(() => {});
  return operation;
}
