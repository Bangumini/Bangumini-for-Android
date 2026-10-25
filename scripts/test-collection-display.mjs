import assert from "node:assert/strict";
import { QueryClient } from "@tanstack/react-query";
import { canRenderCachedCollectionsSnapshot } from "../shared/collection-display.ts";
import { refreshQueryDataIfChanged } from "../src/api/stale-cache-refresh.ts";

assert.equal(
  canRenderCachedCollectionsSnapshot({
    username: "cached-user",
    hasCachedCollections: true,
  }),
  true,
  "已有本地收藏时，不应等待播出和剧集辅助数据才能渲染首屏",
);

assert.equal(
  canRenderCachedCollectionsSnapshot({
    username: "cached-user",
    hasCachedCollections: false,
  }),
  false,
  "没有本地收藏时仍应等待收藏网络请求",
);

assert.equal(
  canRenderCachedCollectionsSnapshot({
    username: "cached-user",
    hasCachedCollections: true,
  }),
  true,
  "即使本地收藏为空，也应先完成本地快照提交而不是等待网络",
);

const queryClient = new QueryClient();
const queryKey = ["collections", "watching", "cached-user"];
const localData = { data: [{ subject_id: 1 }], total: 1 };
const freshData = { data: [{ subject_id: 2 }], total: 1 };
queryClient.setQueryData(queryKey, localData);

let resolveRefresh;
const refreshTask = refreshQueryDataIfChanged({
  queryClient,
  queryKey,
  refreshKey: "test-collection-display",
  currentData: localData,
  refresh: () =>
    new Promise((resolve) => {
      resolveRefresh = resolve;
    }),
});

assert.deepEqual(
  queryClient.getQueryData(queryKey),
  localData,
  "网络请求未完成时应继续展示本地数据",
);
// helper 先注册共享 pending，再在 microtask 中启动实际刷新。
await Promise.resolve();
resolveRefresh(freshData);
assert.equal(await refreshTask, true, "网络刷新产生新数据时应报告已更新");
assert.deepEqual(
  queryClient.getQueryData(queryKey),
  freshData,
  "网络请求完成后应替换为新鲜数据",
);

const protectedClient = new QueryClient();
const protectedKey = ["collections", "watching", "protected-user"];
const protectedLocalData = { data: [{ subject_id: 3, ep_status: 4 }], total: 1 };
const protectedFreshData = { data: [{ subject_id: 3, ep_status: 2 }], total: 1 };
protectedClient.setQueryData(protectedKey, protectedLocalData);
let resolveProtectedRefresh;
const protectedRefresh = refreshQueryDataIfChanged({
  queryClient: protectedClient,
  queryKey: protectedKey,
  refreshKey: "test-collection-display-protected",
  currentData: protectedLocalData,
  refresh: () =>
    new Promise((resolve) => {
      resolveProtectedRefresh = resolve;
    }),
  hasLocalChanges: () => true,
});
const userEditedData = { data: [{ subject_id: 3, ep_status: 5 }], total: 1 };
protectedClient.setQueryData(protectedKey, userEditedData);
await Promise.resolve();
resolveProtectedRefresh(protectedFreshData);
assert.equal(
  await protectedRefresh,
  false,
  "用户交互期间产生本地变更时不得应用迟到的网络快照",
);
assert.deepEqual(
  protectedClient.getQueryData(protectedKey),
  userEditedData,
  "本地交互结果应继续保留，等待任务同步后的正式数据",
);

console.log("collection display: 全部通过 ✓");
