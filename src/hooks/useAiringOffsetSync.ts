import { useCallback, useSyncExternalStore } from "react";
import { offsetSync } from "../api/airing-offset-sync";
import type { AiringOffsetSyncManager } from "../api/airing-offset-sync-types";

/** 只订阅 root 已初始化的同步器；不创建实例，也不接管账号或前后台状态。 */
export function useAiringOffsetSync(manager: AiringOffsetSyncManager = offsetSync) {
  const subscribe = useCallback((listener: () => void) => manager.subscribe(listener), [manager]);
  const getSnapshot = useCallback(() => manager.getSnapshot(), [manager]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
