// 渲染真实 React Native 收藏页，记录每次提交的分组和进度；只替换原生控件与外部 IO。
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { QueryClient, notifyManager } from "@tanstack/react-query";
import { readCachedQueryMap } from "../src/api/query-map-cache.ts";

const root = new URL("../", import.meta.url);
const directory = await mkdtemp(join(tmpdir(), "bangumini-native-collections-"));
const mocksUrl = pathToFileURL(join(directory, "mocks.mjs")).href;
const exports = new Set();
const originalNow = Date.now;
const NOW = Date.UTC(2026, 3, 10, 12);
let clock = NOW;
Date.now = () => clock;
notifyManager.setScheduler((callback) => callback());
const clients = [];
const mounted = new Set();

async function compile(relativePath, name, worker = false) {
  let source = await readFile(new URL(relativePath, root), "utf8");
  if (!worker) {
    source = source.replace(/\bstartCollectionTaskWorker,\s*/, "");
    source = `import { startCollectionTaskWorker } from "page-worker-bootstrap";\n${source}`;
  }
  const parsed = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  for (const statement of parsed.statements) {
    if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly) continue;
    const specifier = statement.moduleSpecifier.text;
    let replacement = mocksUrl;
    if (!worker && specifier.endsWith("/api/collection-tasks")) {
      replacement = pathToFileURL(join(directory, "worker.mjs")).href;
    } else if (specifier.endsWith("/hooks/useCacheRefreshPending")) {
      replacement = pathToFileURL(join(directory, "refresh-hook.mjs")).href;
    } else if (specifier.includes("shared/") && !specifier.endsWith("/api/client") && !specifier.endsWith("/api/anilist") && !specifier.endsWith("/storage/sqlite-cache")) {
      replacement = new URL(specifier.slice(specifier.indexOf("shared/")) + ".ts", root).href;
    } else if (specifier.endsWith("/api/query-map-cache") || specifier.endsWith("/api/stale-cache-refresh")) {
      replacement = new URL(`src/api/${specifier.split("/").at(-1)}.ts`, root).href;
    } else {
      for (const binding of statement.importClause?.namedBindings?.elements ?? []) {
        if (!binding.isTypeOnly) exports.add(binding.propertyName?.text ?? binding.name.text);
      }
    }
    source = source.replaceAll(JSON.stringify(specifier), JSON.stringify(replacement));
  }
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX },
  }).outputText.replaceAll('"react/jsx-runtime"', JSON.stringify(import.meta.resolve("react/jsx-runtime")));
  await writeFile(join(directory, name), compiled);
}

try {
  await compile("src/api/collection-tasks.ts", "worker.mjs", true);
  await compile("src/hooks/useCacheRefreshPending.ts", "refresh-hook.mjs", true);
  await compile("app/(tabs)/collections.tsx", "page.mjs");
  await compile("app/(tabs)/calendar.tsx", "calendar.mjs");
  const implemented = new Set([
    "useCallback", "useEffect", "useMemo", "useRef", "useState", "useSyncExternalStore", "useQuery", "useQueryClient",
    "AppState", "SectionList", "FlatList", "RefreshControl", "StyleSheet", "Text", "View", "router",
    "useFocusEffect", "useHeaderSearch", "SegmentedControl", "EmptyState", "ErrorState", "LoadingState",
    "SubjectCard", "SwipePager", "useAuth", "colors", "useAlert", "useCollectionTaskQueue",
    "getPreferredSubjectCoverUrl", "startCollectionTaskWorker", "useAiringOffsets", "isDetailPublication",
  ]);
  await writeFile(join(directory, "mocks.mjs"), `
import React from ${JSON.stringify(import.meta.resolve("react"))};
import { useQuery as realUseQuery } from ${JSON.stringify(import.meta.resolve("@tanstack/react-query"))};
export { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from ${JSON.stringify(import.meta.resolve("react"))};
let client, snapshot, snapshotIndex = 0;
let tasks = [];
let offsets = {};
let io = {};
let queriesEnabled = false;
export const enableQueries = (enabled) => { queriesEnabled = enabled; };
const queries = new Map();
const frames = [];
const detailedFrames = [];
export const getFrames = () => frames;
export const getDetailedFrames = () => detailedFrames;
export function configure(c, s = null) { client = c; snapshot = s; snapshotIndex = 0; tasks = []; offsets = {}; frames.length = 0; detailedFrames.length = 0; }
export const configureOffsets = (next) => { offsets = next; };
export const useAiringOffsets = () => offsets;
export const configureTasks = (value) => { tasks = value; };
export const configureIO = (value) => { io = value; };
export const getQueryOptions = (key) => queries.get(JSON.stringify(key));
export function useState(initial) {
  if (initial?.key === "" && initial?.complete === false && snapshotIndex++ % 3 === 0 && snapshot) initial = snapshot;
  return React.useState(initial);
}
export const useQueryClient = () => client;
export function useQuery(options) {
  queries.set(JSON.stringify(options.queryKey), options);
  const local = ["episodes-schedule-local-v2", "anilist-airing-times-cache-v2", "totalep-backfill"].includes(options.queryKey[0]);
  const result = realUseQuery({ ...options, ...(!queriesEnabled && local ? { initialData: options.placeholderData ?? new Map() } : {}), enabled: queriesEnabled && options.enabled !== false });
  return !queriesEnabled && local ? { ...result, isFetched: true } : result;
}
export const useCollectionTaskQueue = () => tasks;
export const useAuth = () => ({ checking: false, loggedIn: true, username: "fixture-user" });
export const startCollectionTaskWorker = () => {};
let detailPublication = false;
export const configureDetailPublication = (value) => { detailPublication = value; };
export const isDetailPublication = () => detailPublication;
export const useAlert = () => () => {};
export const useFocusEffect = () => {};
export const useHeaderSearch = () => {};
export const router = { replace() {}, push() {} };
export const AppState = { currentState: "active", addEventListener: () => ({ remove() {} }) };
export const StyleSheet = { create: (value) => value, hairlineWidth: 1 };
export const colors = {};
export const View = ({ children }) => React.createElement("view", null, children);
export const Text = ({ children }) => React.createElement("text", null, children);
export const RefreshControl = () => null;
export const SegmentedControl = () => null;
export const EmptyState = () => null;
export const ErrorState = () => null;
export const LoadingState = () => null;
export const SubjectCard = () => null;
export const FlatList = (props) => React.createElement("calendar-list", props);
export const SwipePager = ({ page, renderPage }) => renderPage(page);
export const SectionList = (props) => {
  frames.push(props.sections.flatMap((section) => section.data.map((item) => [item.collection.subject_id, item.group, item.collection.ep_status])));
  detailedFrames.push(props.sections.flatMap((section) => section.data.map((item) => [item.collection.subject_id, item.collection.subject.name_cn, item.group, item.collection.ep_status, item.airedEp, props.renderItem({ item }).props.label])));
  return React.createElement("collection-list", props);
};
export const getPreferredSubjectCoverUrl = () => "";
function callIO(name, args) {
  if (Object.hasOwn(io, name)) return io[name](...args);
  throw new Error("不应调用 IO: " + name);
}
${[...exports].filter((name) => !implemented.has(name)).map((name) => `export const ${name} = (...args) => callIO(${JSON.stringify(name)}, args);`).join("\n")}
`);
  const mocks = await import(mocksUrl);
  const { QueryClientProvider } = await import("@tanstack/react-query");
  const { default: Page } = await import(pathToFileURL(join(directory, "page.mjs")).href);
  const { default: CalendarPage } = await import(pathToFileURL(join(directory, "calendar.mjs")).href);
  const subject = (id) => ({ id, type: 2, name: `Subject ${id}`, name_cn: `条目 ${id}`, date: "2000-01-01", eps: 12, total_episodes: 12 });
  const collection = (id, ep_status = 1) => ({ subject_id: id, type: 3, ep_status, subject: subject(id) });
  const page = (data) => ({ data, total: data.length, limit: 100, offset: 0 });
  const collectionsKey = ["collections", 3, "fixture-user"];
  const episodes = [1, 2, 3].map((ep) => ({ id: ep, ep, sort: ep, type: 0, airdate: "2000-01-01" }));
  const seedSchedule = (client, ids) => {
    const records = new Map(ids.map((id) => [id, { status: "no_schedule", fetchedAt: NOW }]));
    client.setQueryData(["anilist-airing-times-cache-v2", ids.join(",")], records);
    client.setQueryData(["anilist-airing-times-v2", ids.join(",")], records);
    client.setQueryData(["episodes-schedule-v2", ids.join(",")], new Map(ids.map((id) => [id, episodes])));
  };
  function createClient() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    clients.push(client);
    client.setQueryData(["calendar"], [{ weekday: { id: 5 }, items: [subject(7), subject(8)] }]);
    client.setQueryData(collectionsKey, page([collection(7), collection(8)]));
    seedSchedule(client, [7, 8]);
    return client;
  }
  function mount(client, snapshot, offsets = {}) {
    mocks.configure(client, snapshot);
    mocks.configureOffsets(offsets);
    let renderer;
    act(() => { renderer = TestRenderer.create(React.createElement(QueryClientProvider, { client }, React.createElement(Page))); });
    mounted.add(renderer);
    return renderer;
  }
  const frame = (renderer) => renderer.root.findByType("collection-list").props.sections.flatMap((section) =>
    section.data.map((item) => [item.collection.subject_id, item.group, item.collection.ep_status]));

  const failures = [];
  const pendingFixtures = new Set();
  async function check(label, run) {
    try { await run(); console.log(`✓ ${label}`); }
    catch (error) { failures.push(error); console.error(`✗ ${label}: ${error.message}`); }
    // 断言失败也要放行挂起 IO，不能让公共单条请求池污染后续回归。
    for (const fixture of pendingFixtures) {
      fixture.local.resolve(new Map()); fixture.collections.resolve(page([collection(8)]));
      fixture.calendar.resolve(fixture.rawCalendar); fixture.episode.resolve({ data: episodes }); fixture.anilist.resolve({ status: "no_schedule" });
    }
    if (pendingFixtures.size) await act(async () => { await new Promise((resolve) => setImmediate(resolve)); });
    pendingFixtures.clear();
    for (const renderer of mounted) act(() => renderer.unmount());
    mounted.clear();
    mocks.enableQueries(false);
    clock = NOW;
  }
  const listItems = (renderer) => renderer.root.findByType("collection-list").props.sections.flatMap((section) => section.data);
  const cardFor = (renderer, subjectId) => renderer.root.findByType("collection-list").props.renderItem({ item: listItems(renderer).find((item) => item.collection.subject_id === subjectId) });
  const setOffsets = (renderer, client, offsets) => act(() => {
    mocks.configureOffsets(offsets);
    renderer.update(React.createElement(QueryClientProvider, { client }, React.createElement(Page)));
  });
  const setFetching = (client, queryKey, fetching) => client.getQueryCache().find({ queryKey, exact: true }).setState({ fetchStatus: fetching ? "fetching" : "idle" });
  const detailedFrame = (renderer) => listItems(renderer).map((item) => {
    const card = cardFor(renderer, item.collection.subject_id).props;
    return [item.collection.subject_id, item.collection.subject.name_cn, item.group, item.collection.ep_status, item.airedEp, card.label];
  });
  await check("同轮收藏先返回不能提前发布服务端进度和标题", () => {
    const client = createClient();
    const renderer = mount(client);
    const initial = detailedFrame(renderer);
    act(() => {
      setFetching(client, collectionsKey, true);
      setFetching(client, ["calendar"], true);
      setFetching(client, ["episodes-schedule-v2", "7,8"], true);
    });
    act(() => {
      client.setQueryData(collectionsKey, page([{ ...collection(7, 2), subject: { ...subject(7), name_cn: "网络新标题" } }, collection(8)]));
      setFetching(client, collectionsKey, false);
    });
    assert.deepEqual(detailedFrame(renderer), initial, "收藏返回不等于整轮完成，不能以服务端进度变化冒充本地交互");
    act(() => {
      setFetching(client, ["calendar"], false);
      setFetching(client, ["episodes-schedule-v2", "7,8"], false);
    });
    assert.equal(detailedFrame(renderer).find(([id]) => id === 7)[1], "网络新标题");
    assert.equal(detailedFrame(renderer).find(([id]) => id === 7)[3], 2);
  });
  await check("详情 loader 的完整缓存发布不能冒充用户进度操作提前解冻列表", () => {
    const client = createClient();
    const renderer = mount(client);
    const initial = detailedFrame(renderer);
    act(() => {
      setFetching(client, ["calendar"], true);
      mocks.configureDetailPublication(true);
      client.setQueryData(["collection", "fixture-user", 7], collection(7, 3));
      mocks.configureDetailPublication(false);
    });
    assert.deepEqual(detailedFrame(renderer), initial);
  });
  await check("离线首版提交后不能跟随各路内部缓存逐步跳组", () => {
    const client = createClient();
    client.setQueryData(collectionsKey, page([collection(7, 3), collection(8, 3)]));
    setFetching(client, collectionsKey, true);
    setFetching(client, ["calendar"], true);
    setFetching(client, ["episodes-schedule-v2", "7,8"], true);
    const renderer = mount(client);
    const initial = detailedFrame(renderer);
    act(() => {
      client.setQueryData(["episodes-schedule-v2", "7,8"], new Map([[7, [...episodes, { id: 4, ep: 4, sort: 4, type: 0, airdate: "2000-01-01" }]], [8, episodes]]));
      setFetching(client, ["episodes-schedule-v2", "7,8"], false);
    });
    assert.deepEqual(detailedFrame(renderer), initial, "已提交的离线快照必须冻结输入，不能把后到剧集混入初版");
    act(() => { setFetching(client, collectionsKey, false); setFetching(client, ["calendar"], false); });
    assert.equal(detailedFrame(renderer).find(([id]) => id === 7)[2], "airing_not_caught");
  });
  const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
  const flush = () => act(async () => { await new Promise((resolve) => setImmediate(resolve)); });
  async function coldFixture(persistedTasks = [], hasOfflineCollections = true) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    clients.push(client);
    const local = deferred(), collections = deferred(), calendar = deferred(), episode = deferred(), anilist = deferred();
    const calls = { collections: 0, calendar: 0, episodes: 0, anilist: 0 };
    const rawCalendar = [{ weekday: { id: 5 }, items: [subject(8)] }];
    const io = {
      readCachedValueEntryAllowStale: async (key) => key !== "calendar" && !hasOfflineCollections ? null : ({ payload: key === "calendar" ? rawCalendar : page([collection(8)]), updatedAt: 1 }),
      readAllCachedCollections: async () => [],
      readCachedCollection: async () => collection(8), readCachedSubject: async () => subject(8),
      readCachedValueWithin: async () => rawCalendar, readCachedValue: async () => rawCalendar,
      readCachedValuesAllowStale: async (keys) => keys[0]?.startsWith("episodes-") ? local.promise : new Map([["anilist-airing-v2-8", { status: "no_schedule", fetchedAt: 1 }]]),
      readPersistentCollectionTasks: async () => persistedTasks,
      getAllUserCollections: () => { calls.collections++; return collections.promise; },
      getCalendar: () => { calls.calendar++; return calendar.promise; },
      getAllEpisodes: () => { calls.episodes++; return episode.promise; },
      getAiringAt: () => { calls.anilist++; return anilist.promise; },
      writeCachedValue: async () => {}, writeCachedSubjectPreviews: async () => {}, writeCachedCollection: async () => {},
    };
    mocks.configureIO(io);
    mocks.enableQueries(true);
    const renderer = mount(client);
    await flush();
    const fixture = { client, renderer, local, collections, calendar, episode, anilist, calls, rawCalendar, io };
    pendingFixtures.add(fixture);
    return fixture;
  }
  const releaseLocal = async (fixture) => {
    fixture.local.resolve(new Map([["episodes-schedule-v2-8", { episodes, checkedAt: 1 }]]));
    await flush();
  };
  await check("真实请求：先汇总全部离线数据，再等待四路网络一次提交", async () => {
    const fixture = await coldFixture();
    const { renderer, collections, calendar, episode, anilist, calls, client } = fixture;
    assert.equal(mocks.getFrames().length, 0, "本地分集尚未读取完成时不能展示错误分组的初版");
    assert.deepEqual(calls, { collections: 0, calendar: 0, episodes: 0, anilist: 0 }, "网络应在本地汇总完成后放行");
    await releaseLocal(fixture);
    const initial = detailedFrame(renderer);
    assert.deepEqual(frame(renderer), [[8, "airing_not_caught", 1]]);
    assert.deepEqual(calls, { collections: 1, calendar: 1, episodes: 1, anilist: 1 });
    collections.resolve(page([{ ...collection(8, 2), subject: { ...subject(8), name_cn: "整轮网络新标题" } }]));
    await flush(); assert.deepEqual(detailedFrame(renderer), initial);
    episode.resolve({ data: [...episodes, { id: 4, ep: 4, sort: 4, type: 0, airdate: "2000-01-01" }] });
    await flush(); assert.deepEqual(detailedFrame(renderer), initial);
    calendar.resolve([{ weekday: { id: 6 }, items: [subject(8)] }]);
    await flush(); assert.deepEqual(detailedFrame(renderer), initial);
    anilist.resolve({ status: "no_schedule" });
    await flush();
    const final = detailedFrame(renderer);
    assert.equal(final[0][1], "整轮网络新标题");
    assert.equal(final[0][3], 2);
    assert.equal(final[0][4], 4);
    const unique = [...new Set(mocks.getDetailedFrames().map((value) => JSON.stringify(value)))];
    assert.deepEqual(unique, [JSON.stringify(initial), JSON.stringify(final)], "整个请求轮次应只有离线初版和完整终版");
    const previous = listItems(renderer);
    act(() => client.setQueryData(collectionsKey, structuredClone(client.getQueryData(collectionsKey))));
    assert.strictEqual(listItems(renderer)[0], previous[0], "相同内容刷新不能替换展示条目对象");
  });
  await check("真实请求：没有离线收藏时不能把首个网络分片误当作缓存初版", async () => {
    const fixture = await coldFixture([], false);
    fixture.collections.resolve(page([{ ...collection(8), subject: { ...subject(8), name_cn: "无本地收藏的终版" } }]));
    await flush(); await releaseLocal(fixture);
    assert.equal(mocks.getFrames().length, 0, "无离线主列表时应等待完整网络版，不能先显示不完整分组");
    fixture.calendar.resolve(fixture.rawCalendar); fixture.episode.resolve({ data: episodes }); fixture.anilist.resolve({ status: "no_schedule" });
    await flush();
    assert.deepEqual(frame(fixture.renderer), [[8, "airing_not_caught", 1]]);
    assert.equal(new Set(mocks.getDetailedFrames().map((value) => JSON.stringify(value))).size, 1);
  });
  await check("真实请求：离线初版已经纳入本账号持久化任务，不得先显示旧进度", async () => {
    const queued = (username, targetEp) => ({ id: username, kind: "complete-progress", status: "pending", createdAt: 1, updatedAt: 1,
      payload: { username, subjectId: 8, subjectTitle: "条目 8", targetEp, totalEp: 12, ensureWatching: false, markWatched: false } });
    const fixture = await coldFixture([queued("fixture-user", 3), queued("another-user", 10)]);
    await releaseLocal(fixture);
    assert.deepEqual(frame(fixture.renderer), [[8, "airing_caught", 3]]);
    fixture.collections.resolve(page([collection(8)])); fixture.calendar.resolve(fixture.rawCalendar);
    fixture.episode.resolve({ data: episodes }); fixture.anilist.resolve({ status: "no_schedule" });
    await flush();
    for (const rendered of mocks.getFrames()) assert.deepEqual(rendered, [[8, "airing_caught", 3]]);
  });
  await check("真实请求：网络挂起时重挂页面仍有离线初版且复用原轮次", async () => {
    const fixture = await coldFixture();
    await releaseLocal(fixture);
    act(() => fixture.renderer.unmount()); mounted.delete(fixture.renderer);
    const renderer = mount(fixture.client);
    await flush();
    assert.deepEqual(frame(renderer), [[8, "airing_not_caught", 1]]);
    assert.deepEqual(fixture.calls, { collections: 1, calendar: 1, episodes: 1, anilist: 1 });
    fixture.collections.resolve(page([collection(8, 2)]));
    fixture.calendar.reject(new Error("calendar offline"));
    fixture.episode.reject(new Error("episodes offline"));
    await flush();
    assert.deepEqual(frame(renderer), [[8, "airing_not_caught", 1]], "仍有AniList任务时不能因重挂漏掉共享刷新");
    fixture.anilist.resolve({ status: "no_schedule" });
    await flush();
    assert.deepEqual(frame(renderer), [[8, "airing_not_caught", 2]], "部分失败保留对应离线日历和分集，不阻塞成功资源合并");
    assert.equal(listItems(renderer)[0].airedEp, 3);
  });
  await check("真实下拉刷新：强制排期回源、部分失败保留旧数据且不提前停止刷新", async () => {
    const fixture = await coldFixture(); await releaseLocal(fixture);
    fixture.collections.resolve(page([collection(8)])); fixture.calendar.resolve(fixture.rawCalendar);
    fixture.episode.resolve({ data: episodes }); fixture.anilist.resolve({ status: "no_schedule" });
    await flush();
    const initial = detailedFrame(fixture.renderer);
    const collectionGate = deferred(), calendarGate = deferred(), epGate = deferred(), airingGate = deferred();
    fixture.io.getAllUserCollections = () => collectionGate.promise;
    fixture.io.getCalendar = () => calendarGate.promise;
    fixture.io.getAllEpisodes = () => epGate.promise;
    fixture.io.getAiringAt = () => airingGate.promise;
    let refresh;
    act(() => { refresh = fixture.renderer.root.findByType("collection-list").props.refreshControl.props.onRefresh(); });
    collectionGate.resolve(page([{ ...collection(8, 2), subject: { ...subject(8), name_cn: "手动刷新终版" } }]));
    calendarGate.reject(new Error("manual calendar offline")); await flush();
    assert.deepEqual(detailedFrame(fixture.renderer), initial);
    assert.equal(fixture.renderer.root.findByType("collection-list").props.refreshControl.props.refreshing, true);
    epGate.reject(new Error("manual episodes offline")); await flush();
    assert.deepEqual(detailedFrame(fixture.renderer), initial);
    airingGate.resolve({ status: "no_schedule" });
    await act(async () => { await refresh; }); await flush();
    assert.equal(detailedFrame(fixture.renderer)[0][1], "手动刷新终版");
    assert.equal(listItems(fixture.renderer)[0].airedEp, 3, "失败分集仍沿用刷新前排期");
    assert.equal(fixture.renderer.root.findByType("collection-list").props.refreshControl.props.refreshing, false);
  });
  await check("真实请求：新增成员产生的新组合排期也属于本轮且复用单条请求", async () => {
    const fixture = await coldFixture();
    await releaseLocal(fixture);
    const initial = detailedFrame(fixture.renderer);
    fixture.collections.resolve(page([collection(8), collection(9)]));
    await flush();
    assert.deepEqual(detailedFrame(fixture.renderer), initial);
    assert.equal(fixture.calls.episodes, 2, "旧成员8复用原请求，只新增成员9的分集请求");
    fixture.episode.resolve({ data: episodes }); fixture.calendar.resolve(fixture.rawCalendar);
    await flush();
    assert.deepEqual(detailedFrame(fixture.renderer), initial);
    fixture.anilist.resolve({ status: "no_schedule" });
    // AniList 的不同条目沿用生产节流；等待新成员请求，而非只等待旧组合结束。
    for (let turn = 0; turn < 40 && frame(fixture.renderer).length !== 2; turn++) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    }
    assert.equal(frame(fixture.renderer).length, 2);
    assert.equal(fixture.calls.anilist, 2, "每个条目仅查询一次，组合变化不得重复查询8");
    assert.equal(new Set(mocks.getDetailedFrames().map((value) => JSON.stringify(value))).size, 2);
  });
  await check("真实跨页：日历页也应复用共享日历刷新，不另起未跟踪请求", async () => {
    const fixture = await coldFixture(); await releaseLocal(fixture);
    let calendarRenderer;
    await act(async () => { calendarRenderer = TestRenderer.create(React.createElement(QueryClientProvider, { client: fixture.client }, React.createElement(CalendarPage))); });
    mounted.add(calendarRenderer);
    await flush();
    assert.equal(fixture.calls.calendar, 1, "日历页不能另起未纳入完成屏障的重复请求");
    fixture.collections.resolve(page([collection(8)])); fixture.episode.resolve({ data: episodes }); fixture.anilist.resolve({ status: "no_schedule" });
    await flush();
    assert.equal(detailedFrame(fixture.renderer)[0][5], "继续观看 2");
    fixture.calendar.resolve([{ weekday: { id: 6 }, items: [subject(8)] }]);
    await flush();
    assert.equal(listItems(fixture.renderer)[0].weekday, 6);
  });
  await check("真实请求：本地进度单独投影，不能解冻半轮网络元数据", async () => {
    const fixture = await coldFixture();
    await releaseLocal(fixture);
    const { client, renderer } = fixture;
    fixture.collections.resolve(page([{ ...collection(8), subject: { ...subject(8), name_cn: "待整轮提交的新标题" } }]));
    await flush();
    const task = { id: "local-progress", kind: "complete-progress", status: "running", createdAt: 1, updatedAt: 1,
      payload: { username: "fixture-user", subjectId: 8, subjectTitle: "条目 8", targetEp: 3, totalEp: 12, ensureWatching: false, markWatched: false } };
    act(() => {
      mocks.configureTasks([task]);
      renderer.update(React.createElement(QueryClientProvider, { client }, React.createElement(Page)));
    });
    assert.deepEqual(frame(renderer), [[8, "airing_caught", 3]]);
    assert.equal(detailedFrame(renderer)[0][1], "条目 8");
    act(() => {
      client.setQueryData(collectionsKey, { ...client.getQueryData(collectionsKey), data: [{ ...client.getQueryData(collectionsKey).data[0], ep_status: 3 }] });
      client.setQueryData(["collection", "fixture-user", 8], { ...collection(8, 3), subject: { ...subject(8), name_cn: "worker新标题也不得提前混入" } });
      mocks.configureTasks([]);
      renderer.update(React.createElement(QueryClientProvider, { client }, React.createElement(Page)));
    });
    assert.deepEqual(frame(renderer), [[8, "airing_caught", 3]]);
    assert.equal(detailedFrame(renderer)[0][1], "条目 8");
    fixture.calendar.resolve(fixture.rawCalendar); fixture.episode.resolve({ data: episodes }); fixture.anilist.resolve({ status: "no_schedule" });
    await flush();
    assert.deepEqual(frame(renderer), [[8, "airing_caught", 3]]);
    assert.equal(detailedFrame(renderer)[0][1], "待整轮提交的新标题");
  });
  await check("真实请求：改进度再改回原值仍是新操作，旧响应不能落盘或回滚", async () => {
    const fixture = await coldFixture(); await releaseLocal(fixture);
    const writes = [];
    fixture.io.writeCachedCollection = async (_username, value) => { writes.push(value); };
    for (const progress of [3, 1]) act(() => {
      fixture.client.setQueryData(collectionsKey, page([collection(8, progress)]));
      fixture.client.setQueryData(["collection", "fixture-user", 8], collection(8, progress));
    });
    assert.deepEqual(frame(fixture.renderer), [[8, "airing_not_caught", 1]]);
    fixture.collections.resolve(page([{ ...collection(8, 5), subject: { ...subject(8), name_cn: "保留新标题" } }]));
    fixture.calendar.resolve(fixture.rawCalendar); fixture.episode.resolve({ data: episodes }); fixture.anilist.resolve({ status: "no_schedule" });
    await flush();
    assert.equal(fixture.client.getQueryData(collectionsKey).data[0].ep_status, 1);
    assert.equal(detailedFrame(fixture.renderer)[0][1], "保留新标题");
    assert.deepEqual(frame(fixture.renderer), [[8, "airing_not_caught", 1]]);
    assert.equal(writes.length, 0, "受本地新目标保护的旧响应不能写回确认基础缓存");
  });
  await check("移出首条后未修改条目不能二次跳组", () => {
    const client = createClient();
    // 返回详情页时重新构建首帧，成员改变导致组合 query key 改变。
    client.setQueryData(collectionsKey, page([collection(8)]));
    const renderer = mount(client);
    const optimistic = frame(renderer);
    act(() => seedSchedule(client, [8]));
    const settled = frame(renderer);
    console.log("成员变化帧：", { optimistic, settled });
    assert.deepEqual(optimistic, settled);
    assert.deepEqual(settled, [[8, "airing_not_caught", 1]]);
  });
  await check("已挂载列表乐观移出首条直到队列清空都不闪回", () => {
    const client = createClient();
    const renderer = mount(client);
    const start = mocks.getFrames().length;
    const queue = [{ id: "watched", kind: "complete-progress", status: "running", createdAt: 1, updatedAt: 1,
      payload: { username: "fixture-user", subjectId: 7, subjectTitle: "条目 7", targetEp: 3, totalEp: 12, ensureWatching: false, markWatched: true } }];
    act(() => {
      mocks.configureTasks(queue);
      renderer.update(React.createElement(QueryClientProvider, { client }, React.createElement(Page)));
    });
    assert.deepEqual(frame(renderer), [[8, "airing_not_caught", 1]]);
    act(() => seedSchedule(client, [8]));
    act(() => {
      client.setQueryData(collectionsKey, page([collection(8)]));
      client.setQueryData(["collection", "fixture-user", 7], { ...collection(7, 3), type: 2 });
      mocks.configureTasks([]);
      renderer.update(React.createElement(QueryClientProvider, { client }, React.createElement(Page)));
    });
    for (const rendered of mocks.getFrames().slice(start)) {
      assert.deepEqual(rendered, [[8, "airing_not_caught", 1]], "任务确认前后每一帧的成员和分组都应一致");
    }
  });
  await check("原始列表仅重排时首帧仍保留排期", () => {
    const client = createClient();
    client.setQueryData(collectionsKey, page([collection(8), collection(7)]));
    const renderer = mount(client);
    assert.ok(frame(renderer).every(([, group]) => group === "airing_not_caught"));
  });
  await check("BGM 日历未收录的条目也应复用 AniList 在播信号", () => {
    const client = createClient();
    client.setQueryData(["calendar"], [{ weekday: { id: 5 }, items: [subject(7)] }]);
    client.setQueryData(["anilist-airing-times-v2", "7,8"], new Map([
      [8, { status: "scheduled", airingAt: NOW / 1000 + 86400, episode: 4, fetchedAt: NOW }],
    ]));
    client.setQueryData(collectionsKey, page([collection(8)]));
    const renderer = mount(client);
    assert.deepEqual(frame(renderer), [[8, "airing_not_caught", 1]]);
  });
  await check("内存已追平时不能选回旧 SQLite 快照", () => {
    const client = createClient();
    client.setQueryData(collectionsKey, page([collection(8, 3)]));
    seedSchedule(client, [8]);
    const renderer = mount(client, { key: "collections-3-fixture-user", value: page([collection(8)]), version: 1, complete: true });
    assert.deepEqual(frame(renderer), [[8, "airing_caught", 3]]);
    for (const rendered of mocks.getFrames()) assert.deepEqual(rendered, [[8, "airing_caught", 3]], "首帧也不能闪回旧 SQLite 进度");
  });
  await check("网络未空闲时队列乐观更新也应立即移组", () => {
    const client = createClient();
    const renderer = mount(client);
    const queue = [{ id: "progress", kind: "complete-progress", status: "running", createdAt: 1, updatedAt: 1,
      payload: { username: "fixture-user", subjectId: 7, subjectTitle: "条目 7", targetEp: 3, totalEp: 12, ensureWatching: false, markWatched: false } }];
    act(() => {
      mocks.configureTasks(queue);
      client.getQueryCache().find({ queryKey: ["calendar"], exact: true }).setState({ fetchStatus: "fetching" });
      client.setQueryData(collectionsKey, (data) => ({ ...data, data: [...data.data] }));
      renderer.update(React.createElement(QueryClientProvider, { client }, React.createElement(Page)));
    });
    assert.deepEqual(frame(renderer).find(([id]) => id === 7), [7, "airing_caught", 3]);
    // 同步完成并移除队列；切换不能使已追平状态再次退回。
    act(() => {
      client.setQueryData(collectionsKey, page([collection(7, 3), collection(8)]));
      client.setQueryData(["collection", "fixture-user", 7], collection(7, 3));
      mocks.configureTasks([]);
      renderer.update(React.createElement(QueryClientProvider, { client }, React.createElement(Page)));
    });
    assert.deepEqual(frame(renderer).find(([id]) => id === 7), [7, "airing_caught", 3]);
  });
  await check("迟到的 SQLite queryFn 不能覆盖 worker 已确认的内存进度", async () => {
    const client = createClient();
    mount(client);
    let finishRead;
    const cachedRead = new Promise((resolve) => { finishRead = resolve; });
    mocks.configureIO({ readCachedValueEntryAllowStale: () => cachedRead, readCachedCollection: async () => null,
      readPersistentCollectionTasks: async () => [], getAllUserCollections: async () => page([collection(8)]),
      writeCachedValue: async () => {}, writeCachedSubjectPreviews: async () => {}, writeCachedCollection: async () => {} });
    const refetch = client.fetchQuery({ ...mocks.getQueryOptions(collectionsKey), staleTime: 0 });
    act(() => client.setQueryData(collectionsKey, page([collection(8, 4)])));
    await act(async () => { finishRead({ payload: page([collection(8)]), updatedAt: 1 }); await refetch; });
    assert.equal(client.getQueryData(collectionsKey).data[0].ep_status, 4);
  });
  await check("网络 GET 迟到且队列已清空时仍保留 worker 确认值", async () => {
    const client = createClient();
    mount(client);
    let finishNetwork;
    let enteredNetwork;
    const entered = new Promise((resolve) => { enteredNetwork = resolve; });
    const network = new Promise((resolve) => { finishNetwork = resolve; });
    mocks.configureIO({
      readCachedValueEntryAllowStale: async () => null,
      readAllCachedCollections: async () => [],
      getAllUserCollections: () => { enteredNetwork(); return network; },
      writeCachedValue: async () => {}, writeCachedSubjectPreviews: async () => {}, writeCachedCollection: async () => {},
      readPersistentCollectionTasks: async () => [],
    });
    let refetch;
    await act(async () => {
      refetch = client.fetchQuery({ ...mocks.getQueryOptions(collectionsKey), staleTime: 0 });
      await entered;
    });
    act(() => client.setQueryData(collectionsKey, page([collection(8, 4)])));
    await act(async () => { finishNetwork(page([collection(8)])); await refetch; });
    assert.equal(client.getQueryData(collectionsKey).data[0].ep_status, 4);
  });
  await check("没有本地变更时后台刷新仍能提交新数据", async () => {
    const client = createClient();
    mount(client);
    let finishNetwork;
    const network = new Promise((resolve) => { finishNetwork = resolve; });
    mocks.configureIO({
      readCachedValueEntryAllowStale: async () => ({ payload: page([collection(7), collection(8)]), updatedAt: 1 }),
      readCachedCollection: async () => null,
      readPersistentCollectionTasks: async () => [],
      getAllUserCollections: () => network,
      writeCachedValue: async () => {}, writeCachedSubjectPreviews: async () => {}, writeCachedCollection: async () => {},
    });
    await act(async () => { await client.fetchQuery({ ...mocks.getQueryOptions(collectionsKey), staleTime: 0 }); });
    await act(async () => {
      finishNetwork(page([collection(7, 3), collection(8)]));
      for (let turn = 0; turn < 100 && client.getQueryData(collectionsKey).data[0].ep_status !== 3; turn++) await Promise.resolve();
    });
    assert.equal(client.getQueryData(collectionsKey).data[0].ep_status, 3);
  });
  await check("慢组合晚完成也不能把旧剧集排期冒充最新记录", async () => {
    const client = createClient();
    client.setQueryData(collectionsKey, page([collection(7, 3), collection(8)]));
    const renderer = mount(client);
    let finishSlow;
    let enteredSlow;
    const entered = new Promise((resolve) => { enteredSlow = resolve; });
    const slow = new Promise((resolve) => { finishSlow = resolve; });
    let diskReads = 0;
    const newerEpisodes = [...episodes, { id: 4, ep: 4, sort: 4, type: 0, airdate: "2000-01-01" }];
    mocks.configureIO({
      readCachedValuesAllowStale: async () => new Map([["episodes-schedule-v2-7", ++diskReads === 1
        ? { episodes, checkedAt: NOW - 1000 }
        : { episodes: newerEpisodes, checkedAt: NOW }]]),
      getAllEpisodes: (id) => { assert.equal(id, 8); enteredSlow(); return slow; },
      writeCachedValue: async () => {},
    });
    let oldQuery;
    await act(async () => {
      await client.fetchQuery({ ...mocks.getQueryOptions(["episodes-schedule-local-v2", "7,8"]), staleTime: 0 });
      oldQuery = client.fetchQuery({ ...mocks.getQueryOptions(["episodes-schedule-v2", "7,8"]), staleTime: 0 });
      await entered;
    });
    act(() => client.setQueryData(collectionsKey, page([collection(7, 3)])));
    await act(async () => {
      await client.fetchQuery({ ...mocks.getQueryOptions(["episodes-schedule-local-v2", "7"]), staleTime: 0 });
      await client.fetchQuery({ ...mocks.getQueryOptions(["episodes-schedule-v2", "7"]), staleTime: 0 });
    });
    // 旧组合等待 B 时，另一个组合已经完成了 A 的更新。
    const newData = client.getQueryData(["episodes-schedule-v2", "7"]);
    assert.equal(newData.get(7).length, 4);
    act(() => client.setQueryData(["anilist-airing-times-v2", "7"], new Map([[7, { status: "no_schedule", fetchedAt: NOW }]])));
    await act(async () => { finishSlow({ data: episodes }); await oldQuery; });
    act(() => {
      // 模拟实际请求先后完成时的组合时间戳差异；条目记录仍是旧版本。
      client.setQueryData(["episodes-schedule-v2", "7,8"], client.getQueryData(["episodes-schedule-v2", "7,8"]), { updatedAt: NOW + 1 });
      client.setQueryData(collectionsKey, page([collection(7, 3), collection(9)]));
    });
    assert.deepEqual(frame(renderer).find(([id]) => id === 7), [7, "airing_not_caught", 3]);
    const cached = mocks.getQueryOptions(["episodes-schedule-v2", "7,9"]).placeholderData;
    assert.equal(cached.get(7).length, 4, "不能按组合完成时刻选中旧 A 的三集缓存");
  });
  await check("跨组合只复用所需条目及最新记录且不污染源缓存", () => {
    const client = createClient();
    const fresh = { fetchedAt: 200, episode: 5 };
    const old = { fetchedAt: 100, episode: 4 };
    client.setQueryData(["map-fixture", "8"], new Map([[8, fresh]]), { updatedAt: 200 });
    client.setQueryData(["map-fixture", "7,8"], new Map([[7, old], [8, old]]), { updatedAt: 300 });
    const result = readCachedQueryMap(client, [["map-fixture"]], [8], (record) => record.fetchedAt);
    assert.deepEqual(result, new Map([[8, fresh]]));
    assert.equal(readCachedQueryMap(client, [["map-fixture"]], [9]), undefined);
    assert.equal(readCachedQueryMap(client, [["different-scope"]], [8]), undefined);
    result.set(8, old);
    assert.equal(client.getQueryData(["map-fixture", "8"]).get(8), fresh);
  });
  await check("保存日期偏置必须立即跨过网络提交门且恢复默认可逆", () => {
    const client = createClient();
    const schedule = ["2026-04-03", "2026-04-10", "2026-04-17"].map((airdate, index) => ({ id: index + 1, ep: index + 1, sort: index + 13, type: 0, airdate }));
    client.setQueryData(["episodes-schedule-v2", "7,8"], new Map([[7, episodes], [8, schedule]]));
    const before = structuredClone(client.getQueryData(collectionsKey));
    const renderer = mount(client);
    assert.equal(listItems(renderer).find((item) => item.collection.subject_id === 8).group, "airing_not_caught");
    act(() => client.getQueryCache().find({ queryKey: ["calendar"], exact: true }).setState({ fetchStatus: "fetching" }));
    const start = mocks.getFrames().length;
    setOffsets(renderer, client, { 8: 1 });
    const corrected = listItems(renderer).find((item) => item.collection.subject_id === 8);
    assert.equal(corrected.group, "airing_caught");
    assert.equal(corrected.weekday, 6);
    assert.ok(cardFor(renderer, 8).props.badges.some(({ text }) => text === "手动延后1天"));
    for (const rendered of mocks.getFrames().slice(start)) assert.equal(rendered.find(([id]) => id === 8)[1], "airing_caught", "保存后的首帧也不能展示偏置前的旧快照");
    assert.deepEqual(client.getQueryData(collectionsKey), before, "不能改写API收藏缓存");
    assert.equal(schedule[1].airdate, "2026-04-10");
    assert.equal(schedule[1].sort, 14);
    act(() => client.setQueryData(["episodes-schedule-v2", "7,8"], new Map([[7, episodes], [8, structuredClone(schedule)]])));
    assert.equal(listItems(renderer).find((item) => item.collection.subject_id === 8).group, "airing_caught", "新网络原始值不能抹掉偏置");
    setOffsets(renderer, client, {});
    assert.equal(listItems(renderer).find((item) => item.collection.subject_id === 8).group, "airing_not_caught");
  });
  await check("本地缓存首帧也应用已保存的偏置", () => {
    const client = createClient();
    client.setQueryData(collectionsKey, page([collection(8)]));
    seedSchedule(client, [8]);
    const schedule = ["2026-04-04", "2026-04-11", "2026-04-18"].map((airdate, index) => ({ ep: index + 1, sort: index + 1, type: 0, airdate }));
    client.setQueryData(["episodes-schedule-v2", "8"], new Map([[8, schedule]]));
    const renderer = mount(client, undefined, { 8: -7 });
    for (const rendered of mocks.getFrames()) assert.deepEqual(rendered, [[8, "airing_not_caught", 1]]);
    assert.ok(cardFor(renderer, 8).props.badges.some(({ text }) => text === "手动提前7天"));
  });
  await check("实际页面平移深夜日期时不能抵消24/25点跨日识别", () => {
    clock = Date.parse("2026-04-11T03:00:00+09:00");
    const client = createClient();
    client.setQueryData(collectionsKey, page([collection(8, 0)]));
    seedSchedule(client, [8]);
    const records = new Map([[8, { status: "scheduled", airingAt: Date.parse("2026-04-11T01:30:00+09:00") / 1000, episode: 1, fetchedAt: clock }]]);
    client.setQueryData(["anilist-airing-times-cache-v2", "8"], records);
    client.setQueryData(["anilist-airing-times-v2", "8"], records);
    client.setQueryData(["episodes-schedule-v2", "8"], new Map([[8, [{ ep: 1, sort: 1, type: 0, airdate: "2026-04-10" }]]]));
    const renderer = mount(client);
    assert.deepEqual(frame(renderer), [[8, "airing_not_caught", 0]]);
    setOffsets(renderer, client, { 8: 1 });
    assert.deepEqual(frame(renderer), [[8, "airing_caught", 0]], "+1天后应在4月12日01:30播出，而非4月11日01:30");
    setOffsets(renderer, client, {});
    assert.deepEqual(frame(renderer), [[8, "airing_not_caught", 0]]);
  });
  await check("完整手动排期完结后可覆盖旧在播信号", () => {
    const client = createClient();
    client.setQueryData(collectionsKey, page([{ ...collection(8), subject: { ...subject(8), total_episodes: 3, eps: 3 } }]));
    seedSchedule(client, [8]);
    const renderer = mount(client);
    assert.deepEqual(frame(renderer), [[8, "airing_not_caught", 1]]);
    setOffsets(renderer, client, { 8: -1 });
    assert.deepEqual(frame(renderer), [[8, "finished_started", 1]]);
    setOffsets(renderer, client, {});
    assert.deepEqual(frame(renderer), [[8, "airing_not_caught", 1]]);
  });
  await check("日历实时移组、修正日期及提示但不改写源缓存", async () => {
    const client = createClient();
    const raw = [{ weekday: { id: 5 }, items: [{ ...subject(8), air_date: "2026-04-10", air_weekday: 5 }] }];
    client.setQueryData(["calendar"], raw);
    mocks.configure(client);
    mocks.configureIO({ getCalendar: async () => raw, writeCachedValue: async () => {}, writeCachedSubjectPreviews: async () => {} });
    let renderer;
    await act(async () => { renderer = TestRenderer.create(React.createElement(QueryClientProvider, { client }, React.createElement(CalendarPage))); });
    mounted.add(renderer);
    // 日历的默认页取设备本地星期，测试固定到源条目所在页以覆盖跨时区设备。
    act(() => renderer.root.findByType(mocks.SegmentedControl).props.onChange(5));
    assert.equal(renderer.root.findByType("calendar-list").props.data.length, 1);
    act(() => {
      mocks.configureOffsets({ 8: 1 });
      renderer.update(React.createElement(QueryClientProvider, { client }, React.createElement(CalendarPage)));
    });
    assert.equal(renderer.root.findByType("calendar-list").props.data.length, 0, "周五列表应立即移出延后条目");
    act(() => renderer.root.findByType(mocks.SegmentedControl).props.onChange(6));
    const list = renderer.root.findByType("calendar-list").props;
    assert.equal(list.data[0].id, 8);
    const card = list.renderItem({ item: list.data[0] });
    assert.ok(card.props.meta.includes("2026-04-11"));
    assert.ok(card.props.badges.some(({ text }) => text === "手动延后1天"));
    assert.deepEqual(client.getQueryData(["calendar"]), raw);
    assert.equal(raw[0].items[0].air_date, "2026-04-10");
    act(() => {
      mocks.configureOffsets({});
      renderer.update(React.createElement(QueryClientProvider, { client }, React.createElement(CalendarPage)));
    });
    assert.equal(renderer.root.findByType("calendar-list").props.data.length, 0);
    act(() => renderer.root.findByType(mocks.SegmentedControl).props.onChange(5));
    assert.equal(renderer.root.findByType("calendar-list").props.data[0].air_date, "2026-04-10");
  });
  assert.equal(failures.length, 0, `${failures.length} 个收藏渲染回归失败`);
  console.log("collections render: 全部通过 ✓");
} finally {
  for (const renderer of mounted) act(() => renderer.unmount());
  clients.forEach((client) => client.clear());
  notifyManager.setScheduler((callback) => setTimeout(callback, 0));
  Date.now = originalNow;
  await rm(directory, { recursive: true, force: true });
}
