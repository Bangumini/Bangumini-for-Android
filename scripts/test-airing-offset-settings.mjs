// 编译真实 Android 存储、hook 和原生控件；仅替换 AsyncStorage 与原生 host，不复制业务逻辑。
// 运行：node --experimental-strip-types scripts/test-airing-offset-settings.mjs
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

const root = new URL("../", import.meta.url);
const directory = await mkdtemp(join(tmpdir(), "bangumini-airing-offset-"));
const url = (name) => pathToFileURL(join(directory, name)).href;
await writeFile(join(directory, "mocks.mjs"), `
import React from ${JSON.stringify(import.meta.resolve("react"))};
export const disk = new Map();
export const io = { failReads: false, failWrites: false, readGate: null, writeGate: null, reads: 0, writes: 0, activeWrites: 0, maxWrites: 0 };
export default {
  async getItem(key) {
    io.reads++;
    const previous = disk.get(key) ?? null;
    await io.readGate;
    if (io.failReads) throw new Error("denied read");
    return previous;
  },
  async setItem(key, value) {
    io.writes++; io.activeWrites++; io.maxWrites = Math.max(io.maxWrites, io.activeWrites);
    try {
      await io.writeGate;
      if (io.failWrites) throw new Error("quota exceeded");
      disk.set(key, value);
    } finally { io.activeWrites--; }
  },
};
export const StyleSheet = { create: value => value, hairlineWidth: 1 };
export const View = props => React.createElement("View", props, props.children);
export const Text = props => React.createElement("Text", props, props.children);
export const TextInput = props => React.createElement("TextInput", props);
export const Pressable = props => React.createElement("Pressable", props, props.children);
export const ActivityIndicator = props => React.createElement("ActivityIndicator", props);
`);
async function compile(relative, name, replacements = {}) {
  let source = await readFile(new URL(relative, root), "utf8");
  const parsed = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  for (const statement of parsed.statements) {
    if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly) continue;
    const specifier = statement.moduleSpecifier.text;
    let replacement = replacements[specifier];
    if (!replacement && specifier.includes("shared/")) replacement = new URL(specifier.slice(specifier.indexOf("shared/")).replace(/\.ts$/, "") + ".ts", root).href;
    if (!replacement && specifier.includes("theme/colors")) replacement = new URL("src/theme/colors.ts", root).href;
    if (!replacement && ["react", "react/jsx-runtime"].includes(specifier)) replacement = import.meta.resolve(specifier);
    if (!replacement && ["react-native", "@react-native-async-storage/async-storage"].includes(specifier)) replacement = url("mocks.mjs");
    if (!replacement) throw new Error(`测试未映射导入：${relative}: ${specifier}`);
    source = source.replaceAll(JSON.stringify(specifier), JSON.stringify(replacement));
  }
  await writeFile(join(directory, name), ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX },
  }).outputText.replaceAll('"react/jsx-runtime"', JSON.stringify(import.meta.resolve("react/jsx-runtime"))));
}
await compile("src/api/airing-offset.ts", "api.mjs");
await compile("src/hooks/useAiringOffsets.ts", "hook.mjs", { "../api/airing-offset": url("api.mjs"), "../api/airing-offset.ts": url("api.mjs") });
await compile("src/components/AiringOffsetControl.tsx", "control.mjs", { "../api/airing-offset": url("api.mjs"), "../api/airing-offset.ts": url("api.mjs") });
const { disk, io } = await import(url("mocks.mjs"));
let imports = 0;
const load = () => import(url("api.mjs") + `?restart=${imports++}`);
const api = await import(url("api.mjs"));
const { getAiringOffsetsSnapshot: get, setAiringOffsetDays: set, initializeAiringOffsets: initialize } = api;
const key = api.AIRING_OFFSETS_STORAGE_KEY;
assert.equal(key, "bangumini_airing_offsets");
const empty = get();
assert.deepEqual(empty, {});
assert.strictEqual(get(), empty);
assert(Object.isFrozen(empty));
let notifications = 0;
const unsubscribe = api.subscribeAiringOffsets(() => notifications++);
await initialize();
await Promise.all([set(10, -1), set(20, 1), set(30, 3), set(10, -2)]);
assert.deepEqual(get(), { 10: -2, 20: 1, 30: 3 }, "并发保存串行合并，不覆盖其他条目或同条目较新意图");
assert.equal(io.maxWrites, 1, "同一时刻只能有一个持久化写入");
const same = get();
const count = notifications;
await set(10, -2);
assert.strictEqual(get(), same);
assert.equal(notifications, count);
await set(30, 0);
assert(!Object.hasOwn(JSON.parse(disk.get(key)), "30"));
await Promise.all([set(10, 365), set(20, -365)]);
assert.deepEqual(get(), { 10: 365, 20: -365 });
const restored = await load();
await restored.initializeAiringOffsets();
assert.deepEqual(restored.getAiringOffsetsSnapshot(), get());
for (const invalid of [-366, 366, 0.5, -1.5, NaN, Infinity, "1", null, undefined]) {
  const previous = get();
  await assert.rejects(set(10, invalid), RangeError);
  assert.strictEqual(get(), previous);
}
for (const id of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) await assert.rejects(set(id, 1), RangeError);
const previous = get();
const diskBefore = disk.get(key);
const notificationsBefore = notifications;
io.failWrites = true;
await assert.rejects(set(10, 2), /quota/);
await assert.rejects(set(10, 0), /quota/);
assert.strictEqual(get(), previous);
assert.equal(disk.get(key), diskBefore);
assert.equal(notifications, notificationsBefore, "写失败不发布新快照");
io.failWrites = false;
await set(10, 0);
assert.deepEqual(get(), { 20: -365 }, "失败队列可以继续保存");
unsubscribe();
const afterUnsubscribe = notifications;
await set(20, 0);
assert.equal(notifications, afterUnsubscribe);

for (const raw of [
  '{"10":-1,"20":2,"30":0,"40":366,"50":-366,"60":0.25,"70":"1","80":null,"0":1,"-1":2,"1.5":3,"001":2,"9007199254740992":1,"__proto__":3}',
  "broken JSON", "[]", "null", "7", '"string"',
]) {
  disk.set(key, raw);
  const fresh = await load();
  await fresh.initializeAiringOffsets();
  assert.deepEqual(fresh.getAiringOffsetsSnapshot(), raw.startsWith('{"10"') ? { 10: -1, 20: 2 } : {});
}
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
disk.set(key, '{"90":-3}');
const delayed = await load();
const gate = deferred();
io.readGate = gate.promise;
const readsBeforeWarming = io.reads;
const warming = delayed.initializeAiringOffsets();
const warmingAgain = delayed.initializeAiringOffsets();
const saving = delayed.setAiringOffsetDays(10, 2);
assert.deepEqual(delayed.getAiringOffsetsSnapshot(), {});
assert.equal(io.reads, readsBeforeWarming + 1, "并发预热只读取一次");
gate.resolve();
await Promise.all([warming, warmingAgain, saving]);
io.readGate = null;
assert.deepEqual(delayed.getAiringOffsetsSnapshot(), { 10: 2, 90: -3 }, "初始化期间保存不得被旧读取覆盖，也不能丢失磁盘其他偏好");
const readFailure = await load();
io.failReads = true;
await readFailure.initializeAiringOffsets();
assert.deepEqual(readFailure.getAiringOffsetsSnapshot(), {}, "恢复失败安全显示默认，不抛未处理拒绝");
await assert.rejects(readFailure.setAiringOffsetDays(10, 1), /read/);
assert.deepEqual(JSON.parse(disk.get(key)), { 10: 2, 90: -3 }, "读取失败不能以空快照覆盖磁盘");
io.failReads = false;
await readFailure.initializeAiringOffsets();
assert.deepEqual(readFailure.getAiringOffsetsSnapshot(), { 10: 2, 90: -3 }, "恢复失败允许重试");

// 真实 useSyncExternalStore hook：初始化、订阅、快照稳定性与卸载。
const { useAiringOffsets } = await import(url("hook.mjs"));
const { default: Control } = await import(url("control.mjs"));
let renders = 0;
let latest;
function Consumer() { latest = useAiringOffsets(); renders++; return React.createElement("snapshot", { offsets: latest }); }
let renderer;
await act(async () => { renderer = TestRenderer.create(React.createElement(Consumer)); });
await act(async () => { await set(10, -1); });
assert.strictEqual(latest, get());
const stableRenders = renders;
await act(async () => { await set(10, -1); });
assert.equal(renders, stableRenders, "保存同值不能导致 hook 重渲染循环");
act(() => renderer.unmount());
await set(10, 0);
assert.equal(renders, stableRenders);
// 新模块的 hook 自己触发初始化，不依赖 RootLayout。
await compile("src/hooks/useAiringOffsets.ts", "cold-hook.mjs", { "../api/airing-offset": url("cold-api.mjs"), "../api/airing-offset.ts": url("cold-api.mjs") });
await compile("src/api/airing-offset.ts", "cold-api.mjs");
disk.set(key, '{"77":7}');
const { useAiringOffsets: useCold } = await import(url("cold-hook.mjs"));
let cold;
function ColdConsumer() { cold = useCold(); return null; }
await act(async () => { renderer = TestRenderer.create(React.createElement(ColdConsumer)); });
assert.deepEqual(cold, { 77: 7 });
act(() => renderer.unmount());

// 真实 React Native 控件：草稿不写盘，日期预览、负号、步进、异步禁用和失败反馈。
let props = { subjectId: 10, appliedDays: 0, originalDate: "2026-01-01", airWeekday: 4 };
function Panel() {
  const offsets = useAiringOffsets();
  return React.createElement(Control, { ...props, appliedDays: offsets[props.subjectId] ?? 0 });
}
await act(async () => { renderer = TestRenderer.create(React.createElement(Panel)); });
const text = () => JSON.stringify(renderer.toJSON());
const button = label => renderer.root.findAllByType("Pressable").find(node => node.props.accessibilityLabel === label);
const input = () => renderer.root.findByType("TextInput");
const change = value => act(() => input().props.onChangeText(value));
const press = async label => { await act(async () => { button(label).props.onPress(); }); };
assert.match(text(), /放送日期偏置/);
assert.match(text(), /仅保存在本机/);
assert(input().props.accessibilityLabel);
const writesBeforeDraft = io.writes;
change("-");
assert.match(text(), /请输入/);
assert.equal(button("保存").props.disabled, true);
change("-1");
assert.match(text(), /2025-12-31/);
assert.match(text(), /未保存/);
assert.equal(io.writes, writesBeforeDraft);
await press("提前1天");
assert.equal(input().props.value, "-2");
await press("延后1天");
assert.equal(input().props.value, "-1");
const writeGate = deferred();
io.writeGate = writeGate.promise;
await press("保存");
assert.equal(get()[10], undefined, "持久化前不发布");
assert.match(text(), /保存中/);
assert.equal(input().props.editable, false);
for (const label of ["保存", "恢复默认", "提前1天", "延后1天"]) assert.equal(button(label).props.disabled, true);
await act(async () => { writeGate.resolve(); await Promise.resolve(); });
io.writeGate = null;
assert.equal(get()[10], -1);
assert.match(text(), /已保存/);
assert.doesNotMatch(text(), /未保存/);
change("2");
io.failWrites = true;
await press("保存");
assert.equal(get()[10], -1);
assert.match(text(), /保存失败/);
assert.match(text(), /未保存/);
await press("恢复默认");
assert.equal(get()[10], -1);
io.failWrites = false;
await press("恢复默认");
assert.equal(get()[10], undefined);
assert.equal(input().props.value, "0");
assert.match(text(), /已恢复默认/);
for (const value of ["", "1.5", "366", "-366", "1e2", "0x10"]) {
  change(value);
  assert.equal(button("保存").props.disabled, true, `仅允许整数文本：${value}`);
}
change("365");
assert.equal(button("延后1天").props.disabled, true);
change("-365");
assert.equal(button("提前1天").props.disabled, true);
change("-7");
await act(async () => { await set(10, 3); });
assert.equal(input().props.value, "3", "应用值改变时丢弃旧草稿");
props = { subjectId: 11, appliedDays: 0, previewEpisode: { sort: 13, airdate: "2026-10-03" } };
act(() => renderer.update(React.createElement(Panel)));
assert.equal(input().props.value, "0", "切换条目不能复活上一条草稿");
change("-7");
assert.match(text(), /2026-09-26/);
for (const node of renderer.root.findAllByType("Pressable")) {
  assert.equal(node.props.accessibilityRole, "button");
  const style = typeof node.props.style === "function" ? node.props.style({ pressed: false }) : node.props.style;
  const styles = Array.isArray(style) ? style.flat().filter(Boolean) : [style];
  assert(styles.some(value => value.minHeight >= 48), "Android 触控区域至少 48dp");
}
// 无效首播回退到剧集日期；没有任何日期时明确告知，不编造日期。
props = { subjectId: 11, appliedDays: 0, originalDate: "2026-02-30", previewEpisode: { sort: 13, airdate: "2026-10-03" } };
act(() => renderer.update(React.createElement(Panel)));
assert.match(text(), /2026-09-26/);
props = { subjectId: 12, appliedDays: 0 };
act(() => renderer.update(React.createElement(Panel)));
assert.match(text(), /暂无放送日期/);
assert.equal(input().props.value, "0");
// 保存未结束就切换条目，旧保存只能更新自己的偏好，不能污染新条目的草稿或反馈。
change("2");
const navigationGate = deferred();
io.writeGate = navigationGate.promise;
await press("保存");
props = { subjectId: 13, appliedDays: 0 };
act(() => renderer.update(React.createElement(Panel)));
change("-3");
await act(async () => { navigationGate.resolve(); await Promise.resolve(); });
io.writeGate = null;
assert.equal(get()[12], 2);
assert.equal(get()[13], undefined);
assert.equal(input().props.value, "-3");
assert.doesNotMatch(text(), /已保存/);
// 卸载后完成保存仍能持久化，但不能继续向已卸载组件写状态。
const unmountGate = deferred();
io.writeGate = unmountGate.promise;
await press("保存");
act(() => renderer.unmount());
unmountGate.resolve();
io.writeGate = null;
await new Promise(resolve => setImmediate(resolve));
assert.equal(get()[13], -3);
console.log("airing offset settings: 存储并发/失败恢复、真实 hook 与原生控件全部通过 ✓");
