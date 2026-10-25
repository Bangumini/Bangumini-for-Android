// 运行：node --experimental-strip-types scripts/test-stale-cache-refresh.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import ts from "typescript";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { QueryClient, QueryClientProvider, notifyManager, useQuery } from "@tanstack/react-query";
import * as refreshApi from "../src/api/stale-cache-refresh.ts";

const { refreshQueryDataIfChanged } = refreshApi;
const createClient = () => new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

await test("去重调用者共享可 await 的同一个 Promise，不能把 null 当成完成", async () => {
  const client = createClient();
  const network = deferred();
  const options = {
    queryClient: client, queryKey: ["same"], refreshKey: "same", currentData: 1,
    refresh: () => network.promise,
  };
  client.setQueryData(options.queryKey, 1);
  const first = refreshQueryDataIfChanged(options);
  const second = refreshQueryDataIfChanged(options);
  try {
    assert.ok(second instanceof Promise, "第二个 caller 仍须等待后台刷新");
    assert.equal(second, first);
    let settled = false;
    void second.then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false);
  } finally {
    network.resolve(2);
    await first;
    client.clear();
  }
});

await test("相同 refreshKey 在不同 QueryClient 中独立刷新", async () => {
  const left = createClient(), right = createClient();
  const firstNetwork = deferred(), secondNetwork = deferred();
  const base = { queryKey: ["isolated"], refreshKey: "isolated", currentData: 0 };
  const first = refreshQueryDataIfChanged({ ...base, queryClient: left, refresh: () => firstNetwork.promise });
  const second = refreshQueryDataIfChanged({ ...base, queryClient: right, refresh: () => secondNetwork.promise });
  try {
    assert.ok(second instanceof Promise, "另一个 client 不能被全局 Set 阻塞");
    assert.notEqual(second, first);
    firstNetwork.resolve(1);
    secondNetwork.resolve(2);
    assert.deepEqual(await Promise.all([first, second]), [true, true]);
    assert.equal(left.getQueryData(base.queryKey), 1);
    assert.equal(right.getQueryData(base.queryKey), 2);
  } finally {
    firstNetwork.resolve(1);
    secondNetwork.resolve(2);
    await Promise.all([first, second]);
    left.clear(); right.clear();
  }
});

await test("pending 按 client/key 查询，开始结束各通知一次，注册后重入仍共享任务", async () => {
  const client = createClient(), other = createClient();
  const network = deferred();
  const events = [];
  let reentered, starts = 0;
  const options = {
    queryClient: client, queryKey: ["pending"], refreshKey: "pending", currentData: 0,
    refresh: () => { starts++; return network.promise; },
  };
  const unsubscribe = refreshApi.subscribeCacheRefresh(client, () => {
    const pending = refreshApi.hasCacheRefreshInFlight(client, ["missing", "pending"]);
    events.push(pending);
    if (pending) reentered = refreshQueryDataIfChanged(options);
  });
  assert.equal(refreshApi.hasCacheRefreshInFlight(client, ["pending"]), false);
  const task = refreshQueryDataIfChanged(options);
  try {
    assert.equal(reentered, task, "通知不能早于任务注册");
    assert.equal(refreshApi.hasCacheRefreshInFlight(client, []), false);
    assert.equal(refreshApi.hasCacheRefreshInFlight(client, ["unrelated"]), false);
    assert.equal(refreshApi.hasCacheRefreshInFlight(other, ["pending"]), false);
    network.resolve(1);
    assert.equal(await task, true);
    assert.equal(starts, 1);
    assert.deepEqual(events, [true, false]);
    assert.equal(refreshApi.hasCacheRefreshInFlight(client, ["pending"]), false);
    unsubscribe();
    await refreshQueryDataIfChanged({ ...options, currentData: 1 });
    assert.deepEqual(events, [true, false], "退订后不再接收通知");
  } finally {
    network.resolve(1);
    await task;
    unsubscribe(); client.clear(); other.clear();
  }
});

await test("同 client 不同 key 独立；局部失败不提前撤掉其他 pending", async () => {
  const client = createClient();
  const slow = deferred(), broken = deferred();
  const start = (key, network) => refreshQueryDataIfChanged({
    queryClient: client, queryKey: [key], refreshKey: key, currentData: 0, refresh: () => network.promise,
  });
  const first = start("slow", slow), second = start("broken", broken);
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args);
  try {
    assert.equal(refreshApi.hasCacheRefreshInFlight(client, ["slow", "broken"]), true);
    broken.reject(new Error("局部网络失败"));
    assert.equal(await second, false);
    assert.equal(refreshApi.hasCacheRefreshInFlight(client, ["broken"]), false);
    assert.equal(refreshApi.hasCacheRefreshInFlight(client, ["slow"]), true);
    assert.equal(warnings.length, 1);
    slow.resolve(1);
    assert.equal(await first, true);
    assert.equal(refreshApi.hasCacheRefreshInFlight(client, ["slow", "broken"]), false);
  } finally {
    slow.resolve(1); broken.resolve(1);
    await Promise.all([first, second]);
    console.warn = originalWarn; client.clear();
  }
});

await test("同步 throw 与抛错订阅者不破坏通知、清理、后续重试或产生 unhandled rejection", async () => {
  const client = createClient();
  const events = [], unhandled = [], warnings = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  const badUnsubscribe = refreshApi.subscribeCacheRefresh(client, () => { throw new Error("订阅者异常"); });
  const unsubscribe = refreshApi.subscribeCacheRefresh(client, () => events.push(refreshApi.hasCacheRefreshInFlight(client, ["throw"])));
  try {
    const options = {
      queryClient: client, queryKey: ["throw"], refreshKey: "throw", currentData: 0,
      refresh: () => { throw new Error("同步 refresh 异常"); },
    };
    const task = refreshQueryDataIfChanged(options);
    assert.ok(task instanceof Promise);
    assert.equal(await task, false);
    assert.deepEqual(events, [true, false]);
    assert.equal(refreshApi.hasCacheRefreshInFlight(client, ["throw"]), false);
    assert.equal(await refreshQueryDataIfChanged({ ...options, refresh: async () => 1 }), true);
    assert.deepEqual(events, [true, false, true, false]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
    assert.ok(warnings.length >= 1);
  } finally {
    badUnsubscribe(); unsubscribe(); client.clear();
    console.warn = originalWarn;
    process.off("unhandledRejection", onUnhandled);
  }
});

await test("不同内容只写一次，相同内容不增加 dataUpdateCount 或改动更新时间", async () => {
  const client = createClient(), queryKey = ["payload"];
  client.setQueryData(queryKey, { value: 1 }, { updatedAt: 100 });
  const options = { queryClient: client, queryKey, refreshKey: "payload", currentData: { value: 1 } };
  const before = client.getQueryState(queryKey);
  assert.equal(await refreshQueryDataIfChanged({ ...options, refresh: async () => ({ value: 1 }) }), false);
  assert.equal(client.getQueryState(queryKey).dataUpdateCount, before.dataUpdateCount);
  assert.equal(client.getQueryState(queryKey).dataUpdatedAt, 100);
  assert.equal(await refreshQueryDataIfChanged({ ...options, refresh: async () => ({ value: 2 }) }), true);
  assert.deepEqual(client.getQueryData(queryKey), { value: 2 });
  assert.equal(client.getQueryState(queryKey).dataUpdateCount, before.dataUpdateCount + 1);
  client.clear();
});

await test("默认避免覆盖本地变化，保留 hasLocalChanges 的自定义判定", async () => {
  const client = createClient(), queryKey = ["local"];
  const original = { progress: 1, name: "old" };
  const live = { progress: 2, name: "local" };
  const response = { progress: 1, name: "new" };
  for (const hasLocalChanges of [undefined, (current, baseline) => current.progress !== baseline.progress, () => false]) {
    const network = deferred();
    client.setQueryData(queryKey, original);
    const task = refreshQueryDataIfChanged({
      queryClient: client, queryKey, refreshKey: "local", currentData: original,
      refresh: () => network.promise, hasLocalChanges,
    });
    client.setQueryData(queryKey, live);
    const count = client.getQueryState(queryKey).dataUpdateCount;
    network.resolve(response);
    const acceptsServer = hasLocalChanges?.(live, original) === false;
    assert.equal(await task, acceptsServer);
    assert.deepEqual(client.getQueryData(queryKey), acceptsServer ? response : live);
    assert.equal(client.getQueryState(queryKey).dataUpdateCount, count + (acceptsServer ? 1 : 0));
  }
  client.clear();
});

await test("mergeLatest 接收网络/实时/原始数据，接受新元数据并保留请求期间进度", async () => {
  const client = createClient(), queryKey = ["merge"];
  const original = { progress: 1, name: "old" };
  const response = { progress: 1, name: "new metadata" };
  const network = deferred();
  client.setQueryData(queryKey, original);
  let calls = 0;
  const options = {
    queryClient: client, queryKey, refreshKey: "merge", currentData: original,
    mergeLatest: (next, live, baseline) => {
      calls++;
      assert.equal(next, response);
      assert.deepEqual(baseline, original);
      assert.equal(live.progress, 4);
      return { ...next, progress: live.progress };
    },
  };
  const task = refreshQueryDataIfChanged({ ...options, refresh: () => network.promise });
  client.setQueryData(queryKey, { ...original, progress: 4 });
  network.resolve(response);
  assert.equal(await task, true);
  assert.equal(calls, 1);
  assert.deepEqual(client.getQueryData(queryKey), { progress: 4, name: "new metadata" });
  const count = client.getQueryState(queryKey).dataUpdateCount;
  assert.equal(await refreshQueryDataIfChanged({ ...options, refresh: async () => response }), false);
  assert.equal(client.getQueryState(queryKey).dataUpdateCount, count, "合并结果相同不重复发布");
  client.clear();
});

await test("实时缓存为 null 时仍是有效快照，相同响应不能增加 dataUpdateCount", async () => {
  const client = createClient(), queryKey = ["null-cache"];
  client.setQueryData(queryKey, null);
  const count = client.getQueryState(queryKey).dataUpdateCount;
  assert.equal(await refreshQueryDataIfChanged({
    queryClient: client, queryKey, refreshKey: "null-cache", currentData: { old: true }, refresh: async () => null,
  }), false);
  assert.equal(client.getQueryState(queryKey).dataUpdateCount, count);
  client.clear();
});

await test("mergeLatest 抛错只降级该刷新并清 pending；无内存缓存时直接接收网络", async () => {
  const client = createClient(), queryKey = ["merge-error"];
  client.setQueryData(queryKey, 0);
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args);
  const options = {
    queryClient: client, queryKey, refreshKey: "merge-error", currentData: 0, refresh: async () => 1,
    mergeLatest: () => { throw new Error("merge failed"); },
  };
  try {
    assert.equal(await refreshQueryDataIfChanged(options), false);
    assert.equal(client.getQueryData(queryKey), 0);
    assert.equal(refreshApi.hasCacheRefreshInFlight(client, ["merge-error"]), false);
    assert.equal(warnings.length, 1);
    client.removeQueries({ queryKey });
    assert.equal(await refreshQueryDataIfChanged(options), true, "没有 liveData 时不调用合并器");
    assert.equal(client.getQueryData(queryKey), 1);
  } finally {
    console.warn = originalWarn;
    client.clear();
  }
});

await test("真实 hook：Query 已返回缓存且 isFetching=false 时 pending 仍为 true，重挂载可继续等待", async () => {
  // 只转译实际 hook 的扩展名/包路径以供 Node 加载，不替换 hook、React 或 QueryClient。
  const source = (await readFile(new URL("../src/hooks/useCacheRefreshPending.ts", import.meta.url), "utf8"))
    .replace('"react"', JSON.stringify(import.meta.resolve("react")))
    .replace('"../api/stale-cache-refresh"', JSON.stringify(new URL("../src/api/stale-cache-refresh.ts", import.meta.url).href));
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  }).outputText;
  const { useCacheRefreshPending } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
  const client = createClient(), queryKey = ["hook-cached"];
  const cached = { name: "cached" }, network = deferred();
  client.setQueryData(queryKey, cached);
  const frames = [];
  let renderer, task;
  const queryFn = () => {
    task = refreshQueryDataIfChanged({
      queryClient: client, queryKey, refreshKey: "hook-refresh", currentData: cached,
      refresh: () => network.promise,
    });
    return cached;
  };
  function Probe({ keys }) {
    const query = useQuery({ queryKey, queryFn, staleTime: Infinity });
    const pending = useCacheRefreshPending(client, [...keys]);
    frames.push({ pending, isFetching: query.isFetching, data: query.data });
    assert.ok(frames.length < 30, "boolean snapshot 不能触发无穷 render");
    return null;
  }
  const tree = (keys = ["hook-refresh"]) => React.createElement(QueryClientProvider, { client }, React.createElement(Probe, { keys }));
  notifyManager.setScheduler((callback) => callback());
  try {
    await act(async () => { renderer = TestRenderer.create(tree()); });
    assert.equal(frames.at(-1).pending, false);
    // 手动真实 refetch 返回缓存，后台 helper 另行等待网络。
    await act(async () => { await client.refetchQueries({ queryKey }); });
    assert.deepEqual(frames.at(-1), { pending: true, isFetching: false, data: cached });
    await act(async () => { renderer.update(tree(["unrelated"])); });
    assert.equal(frames.at(-1).pending, false);
    await act(async () => { renderer.unmount(); });
    await act(async () => { renderer = TestRenderer.create(tree()); });
    assert.deepEqual(frames.at(-1), { pending: true, isFetching: false, data: cached });
    const renders = frames.length;
    await act(async () => {
      await refreshQueryDataIfChanged({ queryClient: client, queryKey: ["other"], refreshKey: "other", currentData: 0, refresh: async () => 1 });
    });
    assert.equal(frames.length, renders, "无关 key 的通知不造成重复 render");
    await act(async () => { network.resolve(cached); await task; });
    assert.deepEqual(frames.at(-1), { pending: false, isFetching: false, data: cached });
  } finally {
    network.resolve(cached);
    await task;
    if (renderer) await act(async () => { renderer.unmount(); });
    notifyManager.setScheduler((callback) => setTimeout(callback, 0));
    client.clear();
  }
});
