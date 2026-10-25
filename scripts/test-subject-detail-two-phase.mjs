// 执行真实详情页面、hook 和 loader；仅替换 Native host、数据库与 API IO。
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { QueryClient, QueryClientProvider, notifyManager } from "@tanstack/react-query";

const root = new URL("../", import.meta.url);
const directory = await mkdtemp(join(tmpdir(), "bangumini-detail-two-phase-"));
const url = name => pathToFileURL(join(directory, name)).href;
const names = new Set();
const defaults = new Set();
const real = new Map([
  ["src/api/collection-tasks.ts", "worker.mjs"],
  ["src/hooks/subject-detail-loader.ts", "loader.mjs"],
  ["src/hooks/useSubjectDetailData.ts", "hook.mjs"],
  ["app/subject/[id].tsx", "page.mjs"],
]);
for (const [path, name] of real) {
  let source;
  try { source = await readFile(new URL(path, root), "utf8"); }
  catch (error) { if (error.code === "ENOENT") continue; throw error; }
  if (name === "page.mjs") {
    source = source.replace(/\bstartCollectionTaskWorker,\s*/, "");
    source = `import { startCollectionTaskWorker } from "native-worker-bootstrap";\n${source}`;
  }
  const parsed = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  for (const statement of parsed.statements) {
    if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly) continue;
    const specifier = statement.moduleSpecifier.text;
    let target = url("mocks.mjs");
    if (["react", "@tanstack/react-query"].includes(specifier)) target = import.meta.resolve(specifier);
    else {
      const owned = [...real].find(([file]) => specifier.endsWith("/" + file.split("/").at(-1).replace(/\.tsx?$/, "")));
      if (owned && name !== owned[1]) target = url(owned[1]);
      else if (specifier.endsWith("shared/collection-cache") || specifier.endsWith("shared/airing-offset")) target = new URL(specifier.slice(specifier.indexOf("shared/")) + ".ts", root).href;
      else {
        if (statement.importClause?.name) defaults.add(statement.importClause.name.text);
        for (const binding of statement.importClause?.namedBindings?.elements ?? []) {
          if (!binding.isTypeOnly) names.add(binding.propertyName?.text ?? binding.name.text);
        }
      }
    }
    source = source.replaceAll(JSON.stringify(specifier), JSON.stringify(target));
  }
  const compiled = ts.transpileModule(source, { fileName: path, compilerOptions: {
    target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText.replaceAll('"react/jsx-runtime"', JSON.stringify(import.meta.resolve("react/jsx-runtime")));
  await writeFile(join(directory, name), compiled);
}
const special = new Set(["useLocalSearchParams", "useAuth", "useAiringOffsets", "useAlert", "StyleSheet", "colors", "router", "Linking", "AppState", "CollectionTypeLabel", "getPreferredSubjectCoverUrl", "startCollectionTaskWorker", "Text", "View", "Pressable", "ScrollView", "RefreshControl", "EmptyState", "LoadingState"]);
await writeFile(join(directory, "mocks.mjs"), `
import React from ${JSON.stringify(import.meta.resolve("react"))};
let io = {}, identity = { id: "7", username: "alice" };
export function configure(next, who = { id: "7", username: "alice" }) { io = next; identity = who; }
export function setIdentity(who) { identity = who; }
export const useLocalSearchParams = () => ({ id: identity.id });
export const useAuth = () => ({ checking: false, loggedIn: !!identity.username, username: identity.username });
export const useAiringOffsets = () => ({});
export const useAlert = () => () => {};
export const StyleSheet = { create: value => value, hairlineWidth: 1 };
export const colors = {};
export const router = { push() {} };
export const Linking = { openURL() {} };
export const AppState = { currentState: "active", addEventListener: () => ({ remove() {} }) };
export const CollectionTypeLabel = { 1: "想看", 2: "看过", 3: "在看", 4: "搁置", 5: "抛弃" };
export const getPreferredSubjectCoverUrl = () => "";
export const startCollectionTaskWorker = () => {};
${["Text", "View", "Pressable", "ScrollView", "RefreshControl", "EmptyState", "LoadingState"].map(name => `export const ${name} = props => React.createElement(${JSON.stringify(name)}, props, props.children);`).join("\n")}
export default function NativeComponent(props) { return React.createElement("native-component", props, props.children); }
function call(name, args) { if (io[name]) return io[name](...args); throw new Error("未配置 IO: " + name); }
${[...names].filter(name => !special.has(name)).map(name => `export const ${name} = (...args) => call(${JSON.stringify(name)}, args);`).join("\n")}
`);
const mocks = await import(url("mocks.mjs"));
const { default: Page } = await import(url("page.mjs"));
const { useSubjectDetailData } = await import(url("hook.mjs"));
const { loadSubjectDetailData, publishSubjectDetailSnapshot } = await import(url("loader.mjs"));
notifyManager.setScheduler(callback => callback());
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const subject = (id = 7, name = "本地标题") => ({ id, type: 2, name, name_cn: name, summary: "完整简介", eps: 12, total_episodes: 12, air_weekday: 4 });
const collection = (ep_status = 1, type = 3) => ({ subject_id: 7, ep_status, type, subject: subject() });
const episodePage = { data: Array.from({ length: 12 }, (_, index) => ({ id: index + 1, type: 0, sort: index + 1, airdate: "2026-04-09" })), total: 12, limit: 100, offset: 0 };
const relations = [{ id: 70, type: 3, relation: "片头曲", name: "本地OP", name_cn: "" }];
const disk = { subject: subject(), collection: collection(), episodes: episodePage,
  persons: [{ id: 2, name: "本地Staff", relation: "监督" }],
  characters: [{ id: 3, name: "本地角色", relation: "主角" }], relations };
const artist = { ...subject(70), infobox: [{ key: "艺术家", value: "本地艺术家" }] };
function fixture() {
  const io = {}, network = {}, writes = [];
  for (const resource of ["Subject", "Collection", "Episodes", "Persons", "Characters", "Relations"]) {
    const lower = resource.toLowerCase();
    io[`readCached${resource}`] = async () => disk[lower];
    io[`readCached${resource}Within`] = async () => disk[lower];
    io[`writeCached${resource}`] = async (...args) => { writes.push([lower, ...args]); return args.at(-1); };
    network[lower] = deferred();
  }
  io.readCachedSubject = async id => id === 70 ? artist : disk.subject;
  io.readCachedSubjectDeep = async id => id === 70 ? artist : disk.subject;
  io.readCachedSubjectDeepWithin = async () => disk.subject;
  io.getSubject = id => id === 70 ? Promise.resolve(artist) : network.subject.promise;
  io.getUserCollection = () => network.collection.promise;
  io.getEpisodes = () => network.episodes.promise;
  io.getSubjectPersons = () => network.persons.promise;
  io.getSubjectCharacters = () => network.characters.promise;
  io.getSubjectRelations = () => network.relations.promise;
  io.readPersistentCollectionTasks = async () => [];
  io.deleteCachedCollection = async (...args) => { writes.push(["delete", ...args]); };
  io.isCrossSeasonCountEnabled = async () => false;
  return { io, network, writes };
}
const clients = [], renderers = [];
function client() { const c = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } }); clients.push(c); return c; }
function mount(c, frames = []) {
  let renderer;
  act(() => { renderer = TestRenderer.create(React.createElement(QueryClientProvider, { client: c },
    React.createElement(React.Profiler, { id: "detail", onRender: () => { if (renderer) frames.push(text(renderer)); } }, React.createElement(Page)))); });
  renderers.push(renderer);
  return renderer;
}
const flush = async () => { await act(async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setTimeout(resolve, 0)); }); };
const text = renderer => { const visit = node => node == null ? "" : typeof node === "string" ? node : Array.isArray(node) ? node.map(visit).join("|") : visit(node.children); return visit(renderer.toJSON()); };
const failures = [];
async function check(name, run) {
  try { await run(); console.log(`✓ ${name}`); }
  catch (error) { failures.push(error); console.error(`✗ ${name}: ${error.stack}`); }
  for (const renderer of renderers.splice(0)) act(() => renderer.unmount());
  for (const c of clients.splice(0)) c.clear();
}
await check("真实页面在本地资源齐全前不分散提交首屏", async () => {
  const f = fixture(), staff = deferred(), c = client(), frames = [];
  f.io.readCachedPersonsWithin = () => staff.promise;
  f.io.readCachedPersons = () => staff.promise;
  mocks.configure(f.io);
  const renderer = mount(c, frames);
  await flush();
  assert.ok(!text(renderer).includes("本地标题"), "Staff 磁盘未返回时 legacy 已先显示 subject：这就是首屏分散提交");
  staff.resolve(disk.persons);
  await flush();
  for (const value of ["本地标题", "本地Staff", "本地角色", "本地OP", "本地艺术家"]) assert.ok(text(renderer).includes(value), value);
  for (const frame of frames.filter(frame => frame.includes("本地标题"))) {
    assert.ok(frame.includes("本地Staff") && frame.includes("本地艺术家"), "所有可见详情帧必须是完整快照");
  }
});
function stale(f) {
  for (const key of Object.keys(f.io)) if (key.endsWith("Within")) f.io[key] = async () => null;
  return f;
}
function settlePrimary(f, overrides = {}) {
  for (const key of Object.keys(f.network)) f.network[key].resolve(Object.hasOwn(overrides, key) ? overrides[key] : disk[key]);
}
function probe(c, id = 7, username = "alice") {
  const frames = [];
  let latest;
  function Probe({ subjectId, account }) {
    latest = useSubjectDetailData(subjectId, account, c);
    frames.push(latest);
    return React.createElement("probe", { data: latest.data });
  }
  let renderer;
  act(() => { renderer = TestRenderer.create(React.createElement(Probe, { subjectId: id, account: username })); });
  renderers.push(renderer);
  return { frames, get latest() { return latest; }, renderer,
    switchTo(subjectId, account) { act(() => renderer.update(React.createElement(Probe, { subjectId, account }))); },
    unmount() { act(() => renderer.unmount()); renderers.splice(renderers.indexOf(renderer), 1); } };
}
await check("真实 hook：内存缺失磁盘完整，网络多先后与音乐衍生全部完成后才一次发布", async () => {
  const f = stale(fixture()), c = client(), music = deferred(), calls = [];
  f.io.getSubject = id => { calls.push(id); return id === 71 ? music.promise : f.network.subject.promise; };
  f.io.readCachedSubjectDeep = async id => id === 71 ? null : id === 70 ? artist : disk.subject;
  mocks.configure(f.io);
  const p = probe(c);
  await flush();
  assert.equal(p.latest.data.subject.name, "本地标题");
  assert.equal(p.latest.data.artistMap[70], "本地艺术家");
  assert.equal(p.latest.loading, false);
  const initial = p.latest.data, start = p.frames.length;
  const updates = [];
  const unsubscribe = c.getQueryCache().subscribe(e => { if (e.type === "updated" && e.action.type === "success") updates.push(e.query.queryKey); });
  f.network.subject.resolve(subject(7, "新标题"));
  await flush();
  assert.equal(p.latest.data, initial);
  f.network.collection.resolve(collection(2));
  f.network.episodes.resolve({ ...episodePage, total: 2 });
  f.network.persons.resolve([{ ...disk.persons[0], name: "新Staff" }]);
  f.network.characters.resolve([{ ...disk.characters[0], name: "新角色" }]);
  await flush();
  assert.equal(p.latest.data, initial);
  f.network.relations.resolve([{ ...relations[0], id: 71, name: "新OP" }]);
  await flush();
  assert.ok(calls.includes(71), "必须等待真实音乐条目 API");
  assert.equal(p.latest.data, initial);
  assert.deepEqual(updates, [], "网络阶段不能向单条 Query cache 分散提交");
  music.resolve({ ...artist, id: 71, infobox: [{ key: "艺术家", value: "新艺术家" }] });
  await flush();
  assert.equal(p.latest.data.subject.name, "新标题");
  assert.equal(p.latest.data.persons[0].name, "新Staff");
  assert.equal(p.latest.data.artistMap[71], "新艺术家");
  assert.equal(p.frames.length - start, 1, "settled 仅一次 setData，不分散渲染资源");
  assert.equal(updates.length, 6);
  unsubscribe();
});
await check("局部失败仅保留对应资源缓存，音乐失败保留本地艺术家", async () => {
  const f = stale(fixture()), c = client();
  mocks.configure(f.io);
  const p = probe(c);
  await flush();
  f.network.persons.reject(new Error("staff offline"));
  f.network.characters.reject(new Error("cast offline"));
  f.network.collection.reject(new Error("collection offline"));
  settlePrimary(f, { subject: subject(7, "可用的新标题") });
  await flush();
  assert.equal(p.latest.data.subject.name, "可用的新标题");
  assert.deepEqual(p.latest.data.persons, disk.persons);
  assert.deepEqual(p.latest.data.characters, disk.characters);
  assert.deepEqual(p.latest.data.collection, disk.collection);
  assert.equal(p.latest.data.artistMap[70], "本地艺术家");
});
await check("网络内容相同不更新 data，也不刷新 Query cache revision", async () => {
  const f = stale(fixture()), c = client();
  mocks.configure(f.io);
  const p = probe(c);
  await flush();
  const initial = p.latest.data, count = p.frames.length;
  const revision = c.getQueryState(["subject", 7]).dataUpdateCount;
  settlePrimary(f);
  await flush();
  assert.equal(p.latest.data, initial);
  assert.equal(p.frames.length, count);
  assert.equal(c.getQueryState(["subject", 7]).dataUpdateCount, revision);
});
await check("初版等待持久化队列且严格按账号投影", async () => {
  const f = stale(fixture()), c = client(), queue = deferred();
  f.io.readPersistentCollectionTasks = () => queue.promise;
  mocks.configure(f.io);
  const p = probe(c);
  await flush();
  assert.equal(p.latest.data.subject, null);
  queue.resolve([
    { id: "alice-progress", kind: "complete-progress", status: "pending", createdAt: 1, updatedAt: 1, payload: { username: "alice", subjectId: 7, subjectTitle: "条目7", targetEp: 8, totalEp: 12, ensureWatching: false, markWatched: false } },
    { id: "bob-progress", kind: "complete-progress", status: "pending", createdAt: 2, updatedAt: 2, payload: { username: "bob", subjectId: 7, subjectTitle: "条目7", targetEp: 11, totalEp: 12, ensureWatching: false, markWatched: true } },
  ]);
  await flush();
  assert.equal(p.latest.data.collection.ep_status, 8);
  assert.equal(p.latest.data.collection.type, 3);
  settlePrimary(f, { collection: collection(0) });
  await flush();
  assert.equal(p.latest.data.collection.ep_status, 8);
  assert.ok(!f.writes.some(write => write[0] === "collection"), "不得把旧响应或乐观队列写成确认值");
});
for (const change of ["progress", "type", "progress-reverted", "type-reverted"]) {
  await check(`并发 ${change}：立即投影、旧响应不落盘、服务端新 metadata 仍接收`, async () => {
    const f = stale(fixture()), c = client();
    mocks.configure(f.io);
    const p = probe(c);
    await flush();
    const field = change.startsWith("progress") ? "ep_status" : "type";
    const target = field === "ep_status" ? 8 : 2;
    act(() => c.setQueryData(["collection", "alice", 7], { ...collection(), [field]: target }));
    assert.equal(p.latest.data.collection[field], target);
    if (change.endsWith("reverted")) act(() => c.setQueryData(["collection", "alice", 7], collection()));
    const expected = change.endsWith("reverted") ? collection()[field] : target;
    settlePrimary(f, { collection: { ...collection(0, 1), subject: subject(7, "服务端新元数据") } });
    await flush();
    assert.equal(p.latest.data.collection[field], expected);
    assert.equal(p.latest.data.collection.subject.name, "服务端新元数据");
    assert.equal(c.getQueryData(["collection", "alice", 7])[field], expected);
    assert.ok(!f.writes.some(write => write[0] === "collection"));
  });
}
await check("初版磁盘/队列读取期间迟到 worker 不能被旧快照覆盖", async () => {
  const f = stale(fixture()), c = client(), queue = deferred();
  f.io.readPersistentCollectionTasks = () => queue.promise;
  mocks.configure(f.io);
  const p = probe(c);
  await flush();
  act(() => c.setQueryData(["collection", "alice", 7], collection(9, 2)));
  assert.equal(p.latest.data.collection, null, "本地首屏尚未齐全时不得单独发布 worker 的收藏字段");
  queue.resolve([]);
  await flush();
  assert.equal(p.latest.data.collection.ep_status, 9);
  assert.equal(p.latest.data.collection.type, 2);
  settlePrimary(f, { collection: collection(0, 1) });
  await flush();
  assert.equal(p.latest.data.collection.ep_status, 9);
  assert.ok(!f.writes.some(write => write[0] === "collection"));
});
await check("最终队列读取期间迟到 worker 与其他写盘期间新 revision 都保护收藏", async () => {
  const f = stale(fixture()), c = client(), queue = deferred(), write = deferred();
  let queueReads = 0;
  f.io.readPersistentCollectionTasks = () => ++queueReads === 1 ? Promise.resolve([]) : queue.promise;
  f.io.writeCachedPersons = () => write.promise;
  mocks.configure(f.io);
  const p = probe(c);
  await flush();
  settlePrimary(f, { collection: collection(0, 1) });
  await flush();
  act(() => c.setQueryData(["collection", "alice", 7], collection(8, 2)));
  write.resolve();
  await flush();
  assert.equal(queueReads, 2);
  act(() => c.setQueryData(["collection", "alice", 7], collection(10, 4)));
  queue.resolve([]);
  await flush();
  assert.equal(p.latest.data.collection.ep_status, 10);
  assert.equal(p.latest.data.collection.type, 4);
  assert.ok(!f.writes.some(write => write[0] === "collection"));
});
await check("挂起网络期间重挂同账号同条目复用 initial 与整个 pending，切页/账号首帧不闪旧数据", async () => {
  const f = stale(fixture()), c = client(), calls = [];
  f.io.getSubject = id => { calls.push(id); return f.network.subject.promise; };
  f.io.readCachedCollection = async user => user === "alice" ? collection(1) : collection(5, 4);
  mocks.configure(f.io);
  const p = probe(c);
  await flush();
  p.unmount();
  const again = probe(c);
  await flush();
  assert.equal(again.latest.data.subject.name, "本地标题");
  assert.deepEqual(calls, [7]);
  const before = again.frames.length;
  again.switchTo(8, "bob");
  assert.equal(again.frames[before].data.subject, null);
  assert.equal(again.frames[before].data.collection, null);
  await flush();
  assert.equal(again.latest.data.collection.ep_status, 5);
  assert.ok(calls.includes(8));
  again.switchTo(7, "alice");
  await flush();
  assert.equal(again.latest.data.collection.ep_status, 1);
  assert.equal(calls.filter(id => id === 7).length, 1);
  settlePrimary(f);
  await flush();
});
await check("共享 pool 按 QueryClient 和账号隔离", async () => {
  const f = stale(fixture()), a = client(), b = client(), calls = [];
  f.io.getUserCollection = user => { calls.push(user); return f.network.collection.promise; };
  mocks.configure(f.io);
  probe(a, 7, "alice"); probe(a, 7, "alice"); probe(a, 7, "bob"); probe(b, 7, "alice");
  await flush();
  assert.deepEqual(calls.sort(), ["alice", "alice", "bob"]);
  settlePrimary(f);
  await flush();
});
await check("手动 refresh 等待旧任务并强制所有资源，音乐结束前 loading 不提前撤销", async () => {
  const f = stale(fixture()), c = client(), calls = [], forced = {}, music = deferred();
  for (const key of Object.keys(f.network)) forced[key] = deferred();
  const apis = { subject: "getSubject", collection: "getUserCollection", episodes: "getEpisodes", persons: "getSubjectPersons", characters: "getSubjectCharacters", relations: "getSubjectRelations" };
  const counts = {};
  for (const [key, api] of Object.entries(apis)) f.io[api] = (...args) => {
    if (key === "subject" && args[0] === 70) { calls.push("music"); return music.promise; }
    calls.push(key); counts[key] = (counts[key] ?? 0) + 1;
    return counts[key] === 1 ? f.network[key].promise : forced[key].promise;
  };
  mocks.configure(f.io);
  const p = probe(c);
  await flush();
  let finished = false, promise;
  act(() => { promise = p.latest.refresh().then(() => { finished = true; }); });
  await flush();
  assert.equal(p.latest.refreshing, true);
  assert.equal(finished, false);
  assert.equal(calls.filter(key => key === "subject").length, 1);
  settlePrimary(f);
  await flush();
  for (const key of Object.keys(f.network)) assert.equal(counts[key], 2, `${key} 必须强制请求`);
  for (const key of Object.keys(forced)) forced[key].resolve(disk[key]);
  await flush();
  assert.ok(calls.includes("music"));
  assert.equal(finished, false);
  assert.equal(p.latest.refreshing, true);
  music.resolve(artist);
  await act(async () => { await promise; });
  assert.equal(p.latest.refreshing, false);
  assert.equal(finished, true);
});
await check("真实页面切换账号/条目立即清除进度草稿且不闪旧收藏", async () => {
  const f = fixture(), c = client();
  f.io.readCachedCollectionWithin = async user => user === "alice" ? collection(1) : collection(6, 4);
  mocks.configure(f.io);
  const renderer = mount(c);
  await flush();
  const increment = renderer.root.findAllByType("Pressable").find(node => node.findAllByType("Text").some(t => t.props.children === "+"));
  act(() => increment.props.onPress());
  assert.ok(text(renderer).includes("待提交"));
  mocks.setIdentity({ id: "7", username: "bob" });
  act(() => renderer.update(React.createElement(QueryClientProvider, { client: c }, React.createElement(Page))));
  assert.ok(!text(renderer).includes("待提交"));
  await flush();
  assert.ok(text(renderer).includes("6| / |12"));
});
await check("内存已有单条收藏时持久化队列仍优先，不能被 publish 的 live 投影冲掉", async () => {
  const f = stale(fixture()), c = client();
  c.setQueryData(["collection", "alice", 7], collection(1), { updatedAt: 0 });
  f.io.readPersistentCollectionTasks = async () => [{ id: "queued", kind: "set-collection-type", status: "pending", createdAt: 1, updatedAt: 1,
    payload: { username: "alice", subjectId: 7, subjectTitle: "条目7", nextType: 4 } }];
  mocks.configure(f.io);
  const p = probe(c);
  await flush();
  assert.equal(p.latest.data.collection.type, 4);
  settlePrimary(f, { collection: collection(0, 1) });
  await flush();
  assert.equal(p.latest.data.collection.type, 4);
  assert.ok(!f.writes.some(write => write[0] === "collection"));
});
await check("worker 在网络挂起期间更新后再重挂，复用的 initial 不能退回旧进度", async () => {
  const f = stale(fixture()), c = client();
  mocks.configure(f.io);
  const p = probe(c);
  await flush();
  act(() => c.setQueryData(["collection", "alice", 7], collection(9, 4)));
  p.unmount();
  const again = probe(c);
  await flush();
  assert.equal(again.latest.data.collection.ep_status, 9);
  assert.equal(again.latest.data.collection.type, 4);
  settlePrimary(f);
  await flush();
});
await check("loader 接缝：队列读取挂起期间新通知必须重读，再发布最新 patch", async () => {
  const f = stale(fixture()), c = client(), firstRead = deferred();
  mocks.configure(f.io);
  let notify, reads = 0;
  const job = loadSubjectDetailData({ subjectId: 7, username: "alice", queryClient: c, deps: {
    subscribePending: listener => { notify = listener; return () => {}; },
    readPendingPatch: async () => ++reads === 1 ? firstRead.promise : { ep_status: 10, type: 4 },
  } });
  await flush();
  notify();
  firstRead.resolve({ ep_status: 2, type: 3 });
  const result = await job;
  assert.ok(reads >= 2);
  assert.equal(c.getQueryData(["subject", 7]), undefined, "loader 自身不能在 publish 节点之前散写缓存");
  const initial = publishSubjectDetailSnapshot(c, 7, "alice", result.initial, true);
  assert.equal(initial.collection.ep_status, 10);
  assert.equal(initial.collection.type, 4);
  settlePrimary(f);
  const next = await result.settled;
  assert.equal(next.data.collection.ep_status, 10);
  assert.ok(!f.writes.some(write => write[0] === "collection"));
});
await check("强制刷新音乐 API 失败保留艺术家，subject 仍经过 preview enrichment 写回", async () => {
  const f = fixture(), c = client(), music = deferred();
  f.io.getSubject = id => id === 70 ? music.promise : f.network.subject.promise;
  f.io.writeCachedSubject = async value => { f.writes.push(["subject", value]); return { ...value, rank: 42 }; };
  mocks.configure(f.io);
  const result = await loadSubjectDetailData({ subjectId: 7, username: "alice", queryClient: c, force: true });
  publishSubjectDetailSnapshot(c, 7, "alice", result.initial, true);
  settlePrimary(f, { subject: { ...subject(7, "新标题"), air_weekday: undefined } });
  await flush();
  music.reject(new Error("music offline"));
  const next = await result.settled;
  assert.equal(next.data.artistMap[70], "本地艺术家");
  assert.equal(next.data.subject.air_weekday, 4);
  assert.equal(next.data.subject.rank, 42);
  assert.equal(f.writes.find(write => write[0] === "subject")[1].air_weekday, 4);
});
await check("404 仅在无并发意图时删除收藏；并发 type 不能被 404 清空", async () => {
  for (const concurrent of [false, true]) {
    const f = stale(fixture()), c = client();
    mocks.configure(f.io);
    const p = probe(c);
    await flush();
    if (concurrent) act(() => c.setQueryData(["collection", "alice", 7], collection(5, 4)));
    f.network.collection.reject(new Error("Bangumi API error 404"));
    settlePrimary(f);
    await flush();
    assert.equal(p.latest.data.collection?.type ?? null, concurrent ? 4 : null);
    assert.equal(f.writes.some(write => write[0] === "delete"), !concurrent);
    p.unmount();
  }
});
await check("真实页面下拉刷新等待完整音乐阶段且覆盖 Staff/角色/关联", async () => {
  const f = fixture(), c = client(), music = deferred();
  const calls = [];
  for (const api of ["getUserCollection", "getEpisodes", "getSubjectPersons", "getSubjectCharacters", "getSubjectRelations"]) {
    const original = f.io[api]; f.io[api] = (...args) => { calls.push(api); return original(...args); };
  }
  f.io.getSubject = id => id === 70 ? music.promise : f.network.subject.promise;
  mocks.configure(f.io);
  const renderer = mount(c);
  await flush();
  const refreshControl = () => renderer.root.findByType("ScrollView").props.refreshControl.props;
  let done = false, task;
  act(() => { task = refreshControl().onRefresh().then(() => { done = true; }); });
  await flush();
  assert.equal(refreshControl().refreshing, true);
  for (const api of ["getSubjectPersons", "getSubjectCharacters", "getSubjectRelations"]) assert.ok(calls.includes(api));
  settlePrimary(f);
  await flush();
  assert.equal(done, false);
  assert.equal(refreshControl().refreshing, true);
  music.resolve(artist);
  await act(async () => { await task; });
  assert.equal(refreshControl().refreshing, false);
});
await check("内存只有 subject-card preview 时初版应补齐已有 deep cache，不等待网络", async () => {
  const f = stale(fixture()), c = client();
  const deep = { ...subject(), infobox: [{ key: "制作", value: "本地制作" }] };
  f.io.readCachedSubjectDeep = async id => id === 70 ? artist : deep;
  c.setQueryData(["subject", 7], { ...subject(), name: "较新的卡片标题", summary: "", infobox: undefined, air_weekday: undefined });
  c.setQueryData(["subject", 70], { ...artist, infobox: undefined });
  mocks.configure(f.io);
  const p = probe(c);
  await flush();
  assert.equal(p.latest.data.subject.summary, "完整简介");
  assert.equal(p.latest.data.subject.name, "较新的卡片标题");
  assert.equal(p.latest.data.subject.air_weekday, 4);
  assert.deepEqual(p.latest.data.subject.infobox, deep.infobox);
  assert.equal(c.getQueryData(["subject", 7]).summary, "完整简介");
  assert.equal(p.latest.data.artistMap[70], "本地艺术家");
});
await check("非收藏资源的内存 null 不遮蔽完整磁盘缓存，收藏 null 仍表示未收藏", async () => {
  const f = fixture(), c = client();
  for (const resource of ["subject", "episodes", "persons", "characters", "relations"]) c.setQueryData([resource, 7], null);
  c.setQueryData(["collection", "alice", 7], null);
  mocks.configure(f.io);
  const p = probe(c);
  await flush();
  assert.equal(p.latest.data.subject?.name, "本地标题");
  assert.equal(p.latest.data.episodes?.total, 12);
  assert.deepEqual(p.latest.data.persons, disk.persons);
  assert.deepEqual(p.latest.data.characters, disk.characters);
  assert.deepEqual(p.latest.data.relations, disk.relations);
  assert.equal(p.latest.data.collection, null);
});
for (const phase of ["initial", "settled"]) {
  await check(`${phase} snapshot 捕获旧 pending=3 后 worker 确认5并清队列，发布不得回退`, async () => {
    const f = stale(fixture()), c = client();
    let patch = { ep_status: 3, type: 3 }, notify;
    mocks.configure(f.io);
    const result = await loadSubjectDetailData({ subjectId: 7, username: "alice", queryClient: c, deps: {
      readPendingPatch: async () => patch,
      subscribePending: listener => { notify = listener; return () => {}; },
    } });
    let snapshot = result.initial;
    if (phase === "settled") {
      publishSubjectDetailSnapshot(c, 7, "alice", result.initial, true);
      settlePrimary(f);
      snapshot = await result.settled;
    }
    assert.equal(snapshot.data.collection.ep_status, 3);
    c.setQueryData(["collection", "alice", 7], collection(5, 4));
    patch = null;
    notify();
    const published = publishSubjectDetailSnapshot(c, 7, "alice", snapshot, phase === "initial");
    assert.equal(published.collection.ep_status, 5, "旧 patch 不能盖掉 snapshot 产生之后的 worker 确认");
    assert.equal(published.collection.type, 4);
    assert.equal(c.getQueryData(["collection", "alice", 7]).ep_status, 5);
    settlePrimary(f);
    await result.settled;
  });
  await check(`${phase} snapshot 的 pending=5 确实晚于 worker 确认3，仍应保留更新的目标`, async () => {
    const f = stale(fixture()), c = client();
    let reads = 0;
    c.setQueryData(["collection", "alice", 7], collection(1), { updatedAt: 0 });
    mocks.configure(f.io);
    const result = await loadSubjectDetailData({ subjectId: 7, username: "alice", queryClient: c, deps: {
      readPendingPatch: async () => {
        if (++reads === (phase === "initial" ? 1 : 2)) c.setQueryData(["collection", "alice", 7], collection(3, 3));
        return { ep_status: 5, type: 4 };
      },
    } });
    let snapshot = result.initial;
    if (phase === "settled") {
      publishSubjectDetailSnapshot(c, 7, "alice", result.initial, true);
      settlePrimary(f);
      snapshot = await result.settled;
    }
    const published = publishSubjectDetailSnapshot(c, 7, "alice", snapshot, phase === "initial");
    assert.equal(published.collection.ep_status, 5);
    assert.equal(published.collection.type, 4);
    assert.equal(c.getQueryData(["collection", "alice", 7]).ep_status, 3, "pending 不应伪装为 worker 的确认 QueryData");
    settlePrimary(f);
    await result.settled;
  });
  await check(`${phase} pendingPatch 返回到外层 await 之间 worker 完成，也不得复活已清除目标`, async () => {
    const f = stale(fixture()), c = client();
    let reads = 0, patch = { ep_status: 3, type: 3 }, notify;
    mocks.configure(f.io);
    const result = await loadSubjectDetailData({ subjectId: 7, username: "alice", queryClient: c, deps: {
      subscribePending: listener => { notify = listener; return () => {}; },
      readPendingPatch: () => {
        const answer = Promise.resolve(patch);
        if (++reads === (phase === "initial" ? 1 : 2)) queueMicrotask(() => queueMicrotask(() => {
          c.setQueryData(["collection", "alice", 7], collection(5, 4)); patch = null; notify();
        }));
        return answer;
      },
    } });
    let snapshot = result.initial;
    if (phase === "settled") {
      publishSubjectDetailSnapshot(c, 7, "alice", result.initial, true);
      settlePrimary(f);
      snapshot = await result.settled;
    }
    const published = publishSubjectDetailSnapshot(c, 7, "alice", snapshot, phase === "initial");
    assert.equal(published.collection.ep_status, 5);
    assert.equal(published.collection.type, 4);
    settlePrimary(f);
    await result.settled;
    assert.ok(!f.writes.some(write => write[0] === "collection"));
  });
}
await check("相同网络响应只更新内部 freshness，不改 revision/data；真实 hook 重挂不重复回源", async () => {
  const f = stale(fixture()), c = client(), counts = {};
  const apis = { subject: "getSubject", collection: "getUserCollection", episodes: "getEpisodes", persons: "getSubjectPersons", characters: "getSubjectCharacters", relations: "getSubjectRelations" };
  for (const [key, api] of Object.entries(apis)) {
    const original = f.io[api];
    f.io[api] = (...args) => { counts[key] = (counts[key] ?? 0) + 1; return original(...args); };
  }
  mocks.configure(f.io);
  const p = probe(c);
  await flush();
  const data = p.latest.data, frameCount = p.frames.length;
  const revision = c.getQueryState(["subject", 7]).dataUpdateCount;
  settlePrimary(f);
  await flush();
  assert.equal(p.latest.data, data);
  assert.equal(p.frames.length, frameCount);
  assert.equal(c.getQueryState(["subject", 7]).dataUpdateCount, revision);
  assert.ok(c.getQueryState(["subject", 7]).dataUpdatedAt > 0, "成功的同内容响应仍须推进内部新鲜度");
  p.unmount();
  const again = probe(c);
  await flush();
  assert.equal(again.latest.data.subject.name, "本地标题");
  for (const key of Object.keys(apis)) assert.equal(counts[key], 1, `${key} 重挂不得因旧 memory timestamp 再次回源`);
});
await check("普通 pending 中手动 refresh 只保留当前快照与 force 终版，worker 字段仍立即显示", async () => {
  const f = stale(fixture()), c = client(), forced = {}, counts = {};
  const apis = { subject: "getSubject", collection: "getUserCollection", episodes: "getEpisodes", persons: "getSubjectPersons", characters: "getSubjectCharacters", relations: "getSubjectRelations" };
  for (const key of Object.keys(apis)) forced[key] = deferred();
  for (const [key, api] of Object.entries(apis)) f.io[api] = (...args) => {
    if (key === "subject" && args[0] === 70) return Promise.resolve(artist);
    counts[key] = (counts[key] ?? 0) + 1;
    return counts[key] === 1 ? f.network[key].promise : forced[key].promise;
  };
  mocks.configure(f.io);
  const p = probe(c);
  await flush();
  const start = p.frames.length;
  let task;
  act(() => { task = p.latest.refresh(); });
  act(() => c.setQueryData(["collection", "alice", 7], collection(8, 4)));
  assert.equal(p.latest.data.collection.ep_status, 8);
  assert.equal(p.latest.data.collection.type, 4);
  settlePrimary(f, { subject: subject(7, "旧轮次网络") });
  await flush();
  assert.equal(p.latest.data.subject.name, "本地标题", "refresh 开始后的旧轮次终版不得显示");
  assert.equal(p.latest.loading, false, "新 force 初版未就绪时也不能撤掉当前本地快照");
  for (const key of Object.keys(forced)) forced[key].resolve(key === "subject" ? subject(7, "用户刷新终版") : disk[key]);
  await act(async () => { await task; });
  const titles = [...new Set(p.frames.slice(start).map(frame => frame.data.subject?.name))];
  console.log("pending 中手动刷新显示序列：", titles);
  assert.deepEqual(titles, ["本地标题", "用户刷新终版"]);
  assert.equal(p.latest.data.collection.ep_status, 8);
});
await check("Alice 旧请求晚于 Bob 新轮返回，不覆盖公共 Query/SQLite，Bob 重挂仍是新数据", async () => {
  const f = stale(fixture()), c = client(), newer = {}, counts = {}, persisted = new Map();
  const apis = { subject: "getSubject", collection: "getUserCollection", episodes: "getEpisodes", persons: "getSubjectPersons", characters: "getSubjectCharacters", relations: "getSubjectRelations" };
  for (const key of Object.keys(apis)) newer[key] = deferred();
  for (const [key, api] of Object.entries(apis)) f.io[api] = (...args) => {
    if (key === "subject" && args[0] === 70) return Promise.resolve(artist);
    counts[key] = (counts[key] ?? 0) + 1;
    return counts[key] === 1 ? f.network[key].promise : newer[key].promise;
  };
  for (const resource of ["Subject", "Episodes", "Persons", "Characters", "Relations"]) f.io[`writeCached${resource}`] = async (...args) => {
    f.writes.push([resource.toLowerCase(), ...args]); persisted.set(resource.toLowerCase(), args.at(-1)); return args.at(-1);
  };
  mocks.configure(f.io);
  const p = probe(c);
  await flush();
  p.switchTo(7, "bob");
  await flush();
  const latest = { ...disk, subject: subject(7, "Bob 新标题"), episodes: { ...episodePage, total: 30 },
    persons: [{ ...disk.persons[0], name: "新Staff" }], characters: [{ ...disk.characters[0], name: "新角色" }],
    relations: [{ ...relations[0], name: "新OP" }] };
  for (const key of Object.keys(newer)) newer[key].resolve(latest[key]);
  await flush();
  assert.equal(c.getQueryData(["subject", 7]).name, "Bob 新标题");
  const writeCount = f.writes.length;
  settlePrimary(f, { subject: subject(7, "Alice 迟到旧标题"), episodes: { ...episodePage, total: 1 } });
  await flush();
  for (const resource of ["subject", "episodes", "persons", "characters", "relations"]) {
    assert.deepEqual(c.getQueryData([resource, 7]), latest[resource], resource);
    assert.deepEqual(persisted.get(resource), latest[resource], `${resource} SQLite 不能被旧任务写回`);
  }
  assert.ok(!f.writes.slice(writeCount).some(write => write[0] !== "collection"), "旧账号任务仍可完成 collection，但不能再写公共资源");
  p.unmount();
  const again = probe(c, 7, "bob");
  await flush();
  assert.equal(again.latest.data.subject.name, "Bob 新标题");
  assert.equal(counts.subject, 2);
});
await check("旧详情的衍生音乐请求迟到，不覆盖新任务已经持久化的艺术家", async () => {
  const f = fixture(), c = client(), oldMusic = deferred(), newMusic = deferred();
  let musicReads = 0;
  f.io.getSubject = id => id === 70 ? ++musicReads === 1 ? oldMusic.promise : newMusic.promise : f.network.subject.promise;
  mocks.configure(f.io);
  const old = await loadSubjectDetailData({ subjectId: 7, username: "alice", queryClient: c, force: true });
  publishSubjectDetailSnapshot(c, 7, "alice", old.initial, true);
  settlePrimary(f);
  await flush();
  assert.equal(musicReads, 1);
  const newer = await loadSubjectDetailData({ subjectId: 7, username: "bob", queryClient: c, force: true });
  publishSubjectDetailSnapshot(c, 7, "bob", newer.initial, true);
  await flush();
  const newArtist = { ...artist, infobox: [{ key: "艺术家", value: "新艺术家" }] };
  newMusic.resolve(newArtist);
  const next = await newer.settled;
  publishSubjectDetailSnapshot(c, 7, "bob", next, false);
  oldMusic.resolve({ ...artist, infobox: [{ key: "艺术家", value: "旧艺术家" }] });
  const oldNext = await old.settled;
  const oldPublished = publishSubjectDetailSnapshot(c, 7, "alice", oldNext, false);
  assert.ok(!f.writes.some(write => write[0] === "subject" && write.at(-1).infobox?.[0]?.value === "旧艺术家"));
  assert.equal(oldPublished.artistMap[70], "新艺术家");
});
await check("新公共轮次刚开始仍挂起时，较早请求也不得先落盘或发布旧网络结果", async () => {
  const f = stale(fixture()), c = client(), nextSubject = deferred();
  let subjects = 0;
  f.io.getSubject = id => id === 70 ? Promise.resolve(artist) : ++subjects === 1 ? f.network.subject.promise : nextSubject.promise;
  mocks.configure(f.io);
  const old = await loadSubjectDetailData({ subjectId: 7, username: "alice", queryClient: c });
  publishSubjectDetailSnapshot(c, 7, "alice", old.initial, true);
  const newer = await loadSubjectDetailData({ subjectId: 7, username: "bob", queryClient: c });
  publishSubjectDetailSnapshot(c, 7, "bob", newer.initial, true);
  settlePrimary(f, { subject: subject(7, "不应先提交的旧网络") });
  const oldNext = await old.settled;
  const displayed = publishSubjectDetailSnapshot(c, 7, "alice", oldNext, false);
  assert.equal(displayed.subject.name, "本地标题");
  assert.equal(c.getQueryData(["subject", 7]).name, "本地标题");
  assert.ok(!f.writes.some(write => write[0] === "subject"));
  nextSubject.resolve(subject(7, "新轮完整标题"));
  publishSubjectDetailSnapshot(c, 7, "bob", await newer.settled, false);
  assert.equal(c.getQueryData(["subject", 7]).name, "新轮完整标题");
});
await check("较早 SQLite 写入已经在途时同资源串行，新轮数据最后落盘且旧任务不能发布", async () => {
  const f = fixture(), c = client(), nextSubject = deferred(), oldWrite = deferred(), order = [];
  let subjects = 0, persisted;
  f.io.getSubject = id => id === 70 ? Promise.resolve(artist) : ++subjects === 1 ? f.network.subject.promise : nextSubject.promise;
  f.io.writeCachedSubject = async value => {
    if (value.id !== 7) return value;
    order.push(value.name);
    if (value.name === "旧写入") await oldWrite.promise;
    persisted = value;
    return value;
  };
  mocks.configure(f.io);
  const old = await loadSubjectDetailData({ subjectId: 7, username: "alice", queryClient: c, force: true });
  publishSubjectDetailSnapshot(c, 7, "alice", old.initial, true);
  settlePrimary(f, { subject: subject(7, "旧写入") });
  await flush();
  assert.deepEqual(order, ["旧写入"]);
  const newer = await loadSubjectDetailData({ subjectId: 7, username: "bob", queryClient: c, force: true });
  publishSubjectDetailSnapshot(c, 7, "bob", newer.initial, true);
  nextSubject.resolve(subject(7, "新写入"));
  await flush();
  assert.deepEqual(order, ["旧写入"], "新写入须等待已经开始的同资源 IO 完成");
  oldWrite.resolve();
  publishSubjectDetailSnapshot(c, 7, "alice", await old.settled, false);
  publishSubjectDetailSnapshot(c, 7, "bob", await newer.settled, false);
  assert.deepEqual(order, ["旧写入", "新写入"]);
  assert.equal(persisted.name, "新写入");
  assert.equal(c.getQueryData(["subject", 7]).name, "新写入");
});
await check("衍生音乐与该音乐独立详情共用 subject/id epoch，不影响旧详情其他资源正常完成", async () => {
  const f = fixture(), c = client(), oldMusic = deferred(), musicDetail = deferred();
  let musicReads = 0;
  f.io.getSubject = id => id === 70 ? ++musicReads === 1 ? oldMusic.promise : musicDetail.promise : f.network.subject.promise;
  f.io.getSubjectRelations = id => id === 70 ? Promise.resolve([]) : f.network.relations.promise;
  mocks.configure(f.io);
  const old = await loadSubjectDetailData({ subjectId: 7, username: "alice", queryClient: c, force: true });
  publishSubjectDetailSnapshot(c, 7, "alice", old.initial, true);
  settlePrimary(f);
  await flush();
  const newer = await loadSubjectDetailData({ subjectId: 70, username: "bob", queryClient: c, force: true });
  publishSubjectDetailSnapshot(c, 70, "bob", newer.initial, true);
  musicDetail.resolve({ ...artist, infobox: [{ key: "艺术家", value: "独立详情新艺术家" }] });
  publishSubjectDetailSnapshot(c, 70, "bob", await newer.settled, false);
  oldMusic.resolve({ ...artist, infobox: [{ key: "艺术家", value: "旧衍生艺术家" }] });
  const displayed = publishSubjectDetailSnapshot(c, 7, "alice", await old.settled, false);
  assert.equal(displayed.artistMap[70], "独立详情新艺术家");
  assert.equal(c.getQueryData(["subject", 70]).infobox[0].value, "独立详情新艺术家");
  assert.ok(!f.writes.some(write => write[0] === "subject" && write.at(-1).infobox?.[0]?.value === "旧衍生艺术家"));
  assert.ok(f.writes.some(write => write[0] === "subject" && write.at(-1).id === 7), "仅撤销被新任务接管的资源，不能取消整个旧 job");
});
if (failures.length) process.exitCode = 1;
else console.log("详情两阶段加载回归通过");
