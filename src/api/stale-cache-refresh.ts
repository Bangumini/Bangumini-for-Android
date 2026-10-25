import type { QueryClient, QueryKey } from "@tanstack/react-query";

const refreshInFlight = new WeakMap<QueryClient, Map<string, Promise<boolean>>>();
const refreshListeners = new WeakMap<QueryClient, Set<() => void>>();

export function hasCacheRefreshInFlight(client: QueryClient, keys: readonly string[]): boolean {
  return keys.some((key) => refreshInFlight.get(client)?.has(key));
}

export function subscribeCacheRefresh(client: QueryClient, listener: () => void): () => void {
  let listeners = refreshListeners.get(client);
  if (!listeners) {
    listeners = new Set();
    refreshListeners.set(client, listeners);
  }
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function notifyRefresh(client: QueryClient) {
  for (const listener of [...(refreshListeners.get(client) ?? [])]) {
    try {
      listener();
    } catch (error) {
      // 单个订阅者异常不能阻断其他通知，也不能影响任务清理。
      console.warn("[stale-cache-refresh] refresh listener failed", error);
    }
  }
}

export function isCacheStale(updatedAt: number, maxAgeMs: number, now = Date.now()) {
  return now - updatedAt > maxAgeMs;
}

function isSamePayload(currentData: unknown, nextData: unknown) {
  try {
    return JSON.stringify(currentData) === JSON.stringify(nextData);
  } catch {
    return false;
  }
}

export function refreshQueryDataIfChanged<T>({
  queryClient,
  queryKey,
  refreshKey,
  currentData,
  refresh,
  hasLocalChanges,
  mergeLatest,
}: {
  queryClient: QueryClient;
  queryKey: QueryKey;
  refreshKey: string;
  currentData: T;
  refresh: () => Promise<T>;
  hasLocalChanges?: (liveData: T, originalData: T) => boolean;
  mergeLatest?: (nextData: T, liveData: T, originalData: T) => T;
}): Promise<boolean> {
  let pending = refreshInFlight.get(queryClient);
  if (!pending) {
    pending = new Map();
    refreshInFlight.set(queryClient, pending);
  }
  const existing = pending.get(refreshKey);
  if (existing) return existing;

  // 延后执行也能捕获同步 throw，并确保 refresh 或通知重入时已注册共享任务。
  const task = Promise.resolve().then(refresh)
    .then((result) => {
      const liveData = queryClient.getQueryData<T>(queryKey);
      const nextData = mergeLatest && liveData !== undefined
        ? mergeLatest(result, liveData, currentData)
        : result;
      if (
        !mergeLatest &&
        liveData !== undefined &&
        !isSamePayload(liveData, currentData) &&
        !isSamePayload(liveData, nextData) &&
        (!hasLocalChanges || hasLocalChanges(liveData, currentData))
      ) {
        // 刷新期间已有本地交互更新，避免迟到的网络快照覆盖它。
        return false;
      }

      const baseData = liveData === undefined ? currentData : liveData;
      if (!isSamePayload(baseData, nextData)) {
        queryClient.setQueryData<T>(queryKey, nextData);
        return true;
      }
      return false;
    })
    .catch((error) => {
      console.warn("[stale-cache-refresh] background refresh failed", error);
      return false;
    })
    .finally(() => {
      pending.delete(refreshKey);
      notifyRefresh(queryClient);
    });
  pending.set(refreshKey, task);
  notifyRefresh(queryClient);
  return task;
}
