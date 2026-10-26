// 运行：node --experimental-strip-types scripts/test-airing-offset-sync-settings.mjs
// 渲染真实组件与 hook；仅替换 RN host 和用户确认的远端 manager 公开接口。
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

const root = new URL("../", import.meta.url);
const directory = await mkdtemp(join(tmpdir(), "bangumini-offset-sync-ui-"));
const url = name => pathToFileURL(join(directory, name)).href;
await writeFile(join(directory, "native.mjs"), `
import React from ${JSON.stringify(import.meta.resolve("react"))};
export const StyleSheet = { create: value => value, hairlineWidth: 1 };
${["View", "Text", "TextInput", "Pressable", "Switch"].map(name => `export const ${name} = props => React.createElement("${name}", props, props.children);`).join("\n")}
`);
// singleton 必须由生产模块导入，不能在 hook 中自行构造 manager。
await writeFile(join(directory, "singleton.mjs"), "export const offsetSync = globalThis.__offsetSyncUIManager;");
async function compile(relative, name, replacements = {}) {
  let source = await readFile(new URL(relative, root), "utf8");
  const parsed = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  for (const statement of parsed.statements) {
    if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly) continue;
    const specifier = statement.moduleSpecifier.text;
    let replacement = replacements[specifier];
    if (!replacement && specifier.includes("shared/")) replacement = new URL(specifier.slice(specifier.indexOf("shared/")) + ".ts", root).href;
    if (!replacement && specifier.includes("theme/colors")) replacement = new URL("src/theme/colors.ts", root).href;
    if (!replacement && ["react", "react/jsx-runtime"].includes(specifier)) replacement = import.meta.resolve(specifier);
    if (!replacement && specifier === "react-native") replacement = url("native.mjs");
    if (!replacement) throw new Error(`未映射导入：${relative}: ${specifier}`);
    source = source.replaceAll(JSON.stringify(specifier), JSON.stringify(replacement));
  }
  await writeFile(join(directory, name), ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX },
  }).outputText.replaceAll('"react/jsx-runtime"', JSON.stringify(import.meta.resolve("react/jsx-runtime"))));
}
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const webdav = (password = "alice-secret") => ({ provider: "webdav", autoSync: true, prefix: "bangumini", url: "https://dav.example.test", username: "storage-user", password });
class RemoteManager {
  snapshot = { account: "Alice", ready: true, enabled: false, configured: false, autoSync: true, phase: "idle", conflicts: [], lastSyncedAt: null, error: null };
  listeners = new Set();
  configs = new Map();
  received = [];
  configGate = null;
  operationGate = null;
  exists = false;
  enableGate = null;
  configReads = 0;
  getSnapshot() { return this.snapshot; }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  publish(patch) { this.snapshot = { ...this.snapshot, ...patch }; for (const listener of this.listeners) listener(); }
  async setAccount() { throw new Error("UI 不得设置账号"); }
  setAppActive() { throw new Error("UI 不得轮询前后台"); }
  async setEnabled(enabled) { const account = this.snapshot.account; this.received.push(["enabled", enabled]); await this.enableGate; if (this.snapshot.account === account) this.publish({ enabled, phase: "idle" }); }
  async getConfig() { this.configReads++; assert(this.snapshot.account && this.snapshot.ready, "未登录或 bootstrap 未完成时不能读取凭证"); const config = this.configs.get(this.snapshot.account) ?? null; await this.configGate; return config; }
  async saveConfig(config) { this.received.push(["save", config]); const account = this.snapshot.account; await this.operationGate; this.configs.set(account, config); if (this.snapshot.account === account) this.publish({ configured: true, autoSync: config.autoSync }); }
  async testConnection(config) { this.received.push(["read", config]); await this.operationGate; return { exists: this.exists }; }
  async syncNow() { this.received.push(["sync", this.configs.get(this.snapshot.account)]); await this.operationGate; }
  async disconnect() { this.received.push(["disconnect"]); this.configs.delete(this.snapshot.account); this.publish({ configured: false }); }
  async resolveConflict(id, choice) { this.received.push(["resolve", id, choice]); await this.operationGate; this.publish({ conflicts: this.snapshot.conflicts.filter(item => item.subjectId !== id) }); }
}
const singleton = new RemoteManager();
globalThis.__offsetSyncUIManager = singleton;
await compile("src/hooks/useAiringOffsetSync.ts", "hook.mjs", { "../api/airing-offset-sync": url("singleton.mjs") });
await compile("src/components/AiringOffsetSyncSettings.tsx", "settings.mjs", { "../hooks/useAiringOffsetSync": url("hook.mjs"), "../api/airing-offset-sync": url("singleton.mjs") });
const { default: Settings } = await import(url("settings.mjs"));
let renderer;
const mount = async manager => { await act(async () => { renderer = TestRenderer.create(React.createElement(Settings, manager ? { manager } : {})); }); };
const unmount = () => act(() => renderer.unmount());
const text = () => renderer.root.findAllByType("Text").map(node => node.children.filter(child => typeof child === "string").join("")).join("\n");
const control = (type, label) => renderer.root.findAllByType(type).find(node => node.props.accessibilityLabel === label);
const button = label => { const node = control("Pressable", label); assert(node, `缺少按钮：${label}`); return node; };
const input = label => { const node = control("TextInput", label); assert(node, `缺少输入框：${label}`); return node; };
const change = (label, value) => act(() => input(label).props.onChangeText(value));
const press = async label => { assert.equal(button(label).props.disabled, false, `${label} 应可用`); await act(async () => { button(label).props.onPress(); }); };
const toggleSync = async enabled => { const node = control("Switch", "同步"); assert.equal(node.props.disabled, false); await act(async () => node.props.onValueChange(enabled)); };

// 未登录不能启用；默认关闭，仅开启后才加载和展示配置，保留用户删减后的说明。
singleton.publish({ account: null });
await mount();
assert.equal(renderer.root.findAllByType("Text").filter(node => node.props.accessibilityRole === "header")[0].children.join(""), "同步");
assert.equal(control("Switch", "同步").props.value, false);
assert.equal(control("Switch", "同步").props.disabled, true);
assert.doesNotMatch(text(), /放送日期偏置同步/);
assert.match(text(), /登录后配置/);
assert.equal(renderer.root.findAllByType("TextInput").length, 0);
assert.equal(renderer.root.findAllByType("Pressable").length, 0);
await act(async () => singleton.publish({ account: "Alice" }));
assert.equal(renderer.root.findAllByType("TextInput").length, 0);
assert.equal(singleton.configReads, 0, "关闭时不加载配置表单凭证");
assert.equal(control("Switch", "同步").props.disabled, false);
await act(async () => control("Switch", "同步").props.onValueChange(true));
assert.equal(control("Switch", "同步").props.value, true);
assert.match(text(), /HTTPS/);
assert.equal(input("WebDAV 密码").props.secureTextEntry, true);
assert.equal(input("WebDAV 地址").props.keyboardType, "url");
assert.equal(input("存储目录前缀").props.value, "bangumini");
for (const node of renderer.root.findAllByType("TextInput")) {
  assert.equal(node.props.autoCorrect, false);
  assert.equal(node.props.autoCapitalize, "none");
  assert.equal(node.props.autoComplete, "off");
  assert(node.props.style.minHeight >= 48);
}
// 第二片：切换存储类型、保存草稿与只读探测；404 不代表有写权限。
assert.equal(control("Switch", "自动同步").props.value, true);
await press("S3");
assert.equal(button("S3").props.accessibilityState.selected, true);
assert.equal(input("S3 Region").props.value, "auto");
assert.equal(control("Switch", "S3 forcePathStyle").props.value, true);
for (const label of ["S3 Access Key ID", "S3 Secret Access Key", "S3 Session Token（可选）"]) assert.equal(input(label).props.secureTextEntry, true);
change("S3 Endpoint", "https://s3.example.test");
change("S3 Bucket", "offsets");
change("S3 Access Key ID", "access-id");
change("S3 Secret Access Key", "s3-secret");
change("S3 Session Token（可选）", "temporary-session-secret");
act(() => control("Switch", "S3 forcePathStyle").props.onValueChange(false));
await press("保存配置");
assert.equal(singleton.configs.get("Alice").provider, "s3");
assert.equal(singleton.configs.get("Alice").region, "auto");
assert.equal(singleton.configs.get("Alice").forcePathStyle, false);
assert.equal(singleton.configs.get("Alice").sessionToken, "temporary-session-secret");
await press("WebDAV");
change("WebDAV 地址", "http://insecure.example.test");
change("WebDAV 用户名", "dav-user");
change("WebDAV 密码", "test-secret");
assert.equal(button("保存配置").props.disabled, true);
change("WebDAV 地址", "https://dav.example.test/root");
assert.match(text(), /未保存/);
assert.equal(button("立即同步").props.disabled, true);
assert.match(text(), /请先保存/);
await press("测试读取连接（只读）");
assert.match(text(), /连接可用.*未找到.*文件.*未验证写权限/);
assert.doesNotMatch(text(), /已验证全读写/);
assert.equal(singleton.configs.get("Alice").provider, "s3", "只读测试不能保存草稿");
await press("保存配置");
assert.equal(singleton.configs.get("Alice").password, "test-secret");
assert.match(text(), /配置已保存/);
await press("立即同步");
assert.equal(singleton.received.at(-1)[1].password, "test-secret");
assert.doesNotMatch(text(), /test-secret|s3-secret|access-id|temporary-session-secret/);
for (const node of renderer.root.findAllByType("Pressable")) {
  assert.equal(node.props.accessibilityRole, "button");
  assert.equal(typeof node.props.accessibilityState.disabled, "boolean");
  assert(node.props.style.some(style => style?.minHeight >= 48));
}
for (const node of renderer.root.findAllByType("Switch")) {
  assert.equal(node.props.accessibilityRole, "switch");
  assert.equal(node.props.accessibilityState.checked, node.props.value);
  assert(node.props.style.minHeight >= 48);
}
// 第三片：状态、已脱敏错误、冲突不默认覆盖，逐条展示具体值并明确选择。
const record = days => ({ days, revision: `revision-${days}`, updatedAt: 1 });
await act(async () => singleton.publish({
  phase: "conflict", lastSyncedAt: Date.parse("2026-01-02T03:04:00Z"),
  conflicts: [{ subjectId: 10, local: record(0), remote: record(365) }, { subjectId: 20, local: record(-365), remote: record(1) }],
}));
assert.match(text(), /上次成功/);
assert.match(text(), /冲突：2 条/);
assert.match(text(), /条目 10/);
assert.match(text(), /本机：默认排期（0 天）/);
assert.match(text(), /远端：延后365天（\+365 天）/);
assert.match(text(), /本机：提前365天（-365 天）/);
assert.match(text(), /其他条目仍.*同步/);
assert(!singleton.received.some(item => item[0] === "resolve"), "冲突不能自动默认覆盖");
await press("条目 10：保留本机");
assert.deepEqual(singleton.received.at(-1), ["resolve", 10, "local"]);
await press("条目 20：使用远端");
assert.deepEqual(singleton.received.at(-1), ["resolve", 20, "remote"]);
assert.match(text(), /冲突：0 条/);
await act(async () => singleton.publish({ phase: "syncing" }));
assert.match(text(), /同步中/);
for (const label of ["保存配置", "测试读取连接（只读）", "立即同步", "断开同步"]) {
  assert.equal(button(label).props.disabled, true);
  assert.equal(button(label).props.accessibilityState.disabled, true);
}
assert.notEqual(input("WebDAV 密码").props.editable, false, "网络任务不能锁住草稿输入或其他条目偏置编辑");
await act(async () => singleton.publish({ phase: "error", error: "远端连接失败（已去敏）" }));
assert.match(text(), /远端连接失败（已去敏）/);
const rejection = deferred();
singleton.operationGate = rejection.promise;
await press("测试读取连接（只读）");
await act(async () => rejection.reject(new Error("unsafe https://user:raw-password@host/?secret=raw-key")));
assert.match(text(), /读取连接失败/);
assert.doesNotMatch(text(), /raw-password|raw-key|unsafe/);
singleton.operationGate = null;
singleton.exists = true;
await press("测试读取连接（只读）");
assert.match(text(), /成功读取.*只读测试未验证写权限/);
await press("断开同步");
assert.match(text(), /本地偏置和远端文件均保留/);
assert.equal(button("立即同步").props.disabled, true);
unmount();

// 第四片：同一帧重复点击只发一个请求；保存期间的新草稿不能被旧完成结果覆盖。
const controlled = new RemoteManager();
controlled.configs.set("Alice", webdav());
controlled.publish({ configured: true, enabled: true });
await mount(controlled);
act(() => control("Switch", "自动同步").props.onValueChange(false));
change("WebDAV 密码", "replacement-secret");
const saving = deferred();
controlled.operationGate = saving.promise;
const saveHandler = button("保存配置").props.onPress;
await act(async () => { saveHandler(); saveHandler(); });
assert.deepEqual(controlled.received.map(item => item[0]), ["save"], "不能重复发送包含凭证的保存请求");
for (const label of ["保存配置", "测试读取连接（只读）", "立即同步", "断开同步"]) assert.equal(button(label).props.disabled, true);
change("WebDAV 密码", "newer-draft-secret");
await act(async () => saving.resolve());
controlled.operationGate = null;
assert.equal(input("WebDAV 密码").props.value, "newer-draft-secret");
assert.match(text(), /未保存/);
assert.equal(button("立即同步").props.disabled, true);
await press("保存配置");
assert.equal(controlled.configs.get("Alice").autoSync, false);
assert.equal(button("立即同步").props.disabled, false, "关闭自动同步后仍可手动");
const syncing = deferred();
controlled.operationGate = syncing.promise;
await press("立即同步");
assert.equal(button("立即同步").props.disabled, true);
await act(async () => syncing.resolve());
controlled.operationGate = null;
unmount();

// 账号切换后即刻清空旧草稿；迟到的 Alice SecureStore 结果不能进入 Bob 的输入框。
const accounts = new RemoteManager();
accounts.configs.set("Alice", webdav("Alice-private-password"));
accounts.configs.set("Bob", { ...webdav("Bob-private-password"), username: "bob-storage" });
accounts.publish({ enabled: true });
const loadingAlice = deferred();
accounts.configGate = loadingAlice.promise;
await mount(accounts);
assert.equal(renderer.root.findAllByType("TextInput").length, 0);
accounts.configGate = null;
await act(async () => accounts.publish({ account: "Bob", configured: true }));
assert.equal(input("WebDAV 密码").props.value, "Bob-private-password");
await act(async () => loadingAlice.resolve());
assert.equal(input("WebDAV 密码").props.value, "Bob-private-password");
assert.doesNotMatch(JSON.stringify(renderer.toJSON()), /Alice-private-password/);
change("WebDAV 密码", "Bob-unsaved-password");
await act(async () => accounts.publish({ account: "Alice", configured: true }));
assert.equal(input("WebDAV 密码").props.value, "Alice-private-password");
await act(async () => accounts.publish({ account: "Bob", configured: true }));
assert.equal(input("WebDAV 密码").props.value, "Bob-private-password", "切回账号也不能复活旧草稿");
unmount();

// 保存、连接测试、手动同步的旧成功/失败均不得提示给新账号，卸载后同理。
for (const operation of ["保存配置", "测试读取连接（只读）", "立即同步"]) {
  for (const reject of [false, true]) {
    const remote = new RemoteManager();
    remote.configs.set("Alice", webdav("Alice-old"));
    remote.configs.set("Bob", webdav("Bob-new"));
    remote.publish({ configured: true, enabled: true });
    await mount(remote);
    if (operation === "保存配置") change("WebDAV 密码", "Alice-edited");
    const finishing = deferred();
    remote.operationGate = finishing.promise;
    await press(operation);
    assert.match(text(), /中…/);
    await act(async () => remote.publish({ account: "Bob", configured: true, phase: "idle", error: null }));
    assert.equal(input("WebDAV 密码").props.value, "Bob-new");
    assert.doesNotMatch(text(), /配置已保存|连接可用|请求已完成|失败|中…/);
    await act(async () => reject ? finishing.reject(new Error("Alice-secret-error")) : finishing.resolve());
    assert.equal(input("WebDAV 密码").props.value, "Bob-new");
    assert.doesNotMatch(text(), /Alice-secret-error|配置已保存|连接可用|请求已完成|失败|中…/);
    remote.operationGate = null;
    await press("立即同步");
    assert.match(text(), /请求已完成/, "旧账号完成不能锁住新账号按钮");
    unmount();

    await mount(remote);
    const afterUnmount = deferred();
    remote.operationGate = afterUnmount.promise;
    if (operation === "保存配置") change("WebDAV 密码", "Bob-edited");
    await press(operation);
    unmount();
    await act(async () => reject ? afterUnmount.reject(new Error("unmounted-secret")) : afterUnmount.resolve());
    remote.operationGate = null;
    await mount(remote);
    assert.doesNotMatch(text(), /unmounted-secret|配置已保存|连接可用|请求已完成|失败/);
    unmount();
  }
}
// bootstrap 未 ready 时不读安全配置；恢复、退出登录与 seam 切换均不能露出旧表单。
const booting = new RemoteManager();
booting.configs.set("Alice", webdav("bootstrap-secret"));
booting.publish({ ready: false, enabled: true });
await mount(booting);
assert.match(text(), /正在恢复/);
assert.equal(renderer.root.findAllByType("TextInput").length, 0);
await act(async () => booting.publish({ ready: true, configured: true }));
assert.equal(input("WebDAV 密码").props.value, "bootstrap-secret");
change("WebDAV 密码", "surviving-draft");
await act(async () => booting.publish({ phase: "syncing" }));
await act(async () => booting.publish({ phase: "idle" }));
assert.equal(input("WebDAV 密码").props.value, "surviving-draft", "普通状态推送不能重新读取配置覆盖草稿");
await act(async () => booting.publish({ account: null, configured: false }));
assert.match(text(), /登录后配置/);
assert.equal(renderer.root.findAllByType("TextInput").length, 0);
unmount();

const prior = new RemoteManager();
prior.configs.set("Alice", webdav("prior-manager-password"));
prior.publish({ enabled: true });
await mount(prior);
const replacement = new RemoteManager();
replacement.configs.set("Alice", webdav("replacement-manager-password"));
replacement.publish({ enabled: true });
const replacing = deferred();
replacement.configGate = replacing.promise;
await act(async () => renderer.update(React.createElement(Settings, { manager: replacement })));
assert.equal(renderer.root.findAllByType("TextInput").length, 0, "同账号替换 manager 也必须立即移除旧凭证");
await act(async () => replacing.resolve());
assert.equal(input("WebDAV 密码").props.value, "replacement-manager-password");
assert.doesNotMatch(JSON.stringify(renderer.toJSON()), /prior-manager-password/);
unmount();
// 关闭仅展示总开关；开启再读取已有配置，关闭保留已保存值但不保留未保存草稿。
const folding = new RemoteManager();
folding.configs.set("Alice", webdav("retained-password"));
folding.publish({ configured: true });
await mount(folding);
assert.equal(text(), "同步");
assert.equal(folding.configReads, 0);
assert.equal(renderer.root.findAllByType("Switch").length, 1);
assert.equal(renderer.root.findAllByType("TextInput").length, 0);
const lateConfig = deferred();
folding.configGate = lateConfig.promise;
await toggleSync(true);
assert.match(text(), /正在读取当前账号安全配置/);
await toggleSync(false);
assert.equal(text(), "同步");
await act(async () => lateConfig.resolve());
assert.equal(renderer.root.findAllByType("TextInput").length, 0, "关闭后迟到的凭证不能重开表单");
folding.configGate = null;
await toggleSync(true);
assert.equal(input("WebDAV 密码").props.value, "retained-password");
change("WebDAV 密码", "unsaved-draft");
await toggleSync(false);
assert.equal(folding.configs.get("Alice").password, "retained-password", "关闭不删除已保存凭证");
assert(!folding.received.some(item => item[0] === "disconnect"));
assert.equal(text(), "同步");
await toggleSync(true);
assert.equal(input("WebDAV 密码").props.value, "retained-password");
unmount();
await mount(folding);
assert.equal(control("Switch", "同步").props.value, true, "组件重建按持久化的 manager 状态显示");
await toggleSync(false);
unmount();
await mount(folding);
assert.equal(text(), "同步");
unmount();

// 同步/连接操作期间仍能关闭总开关；旧表单完成后不应重开配置或显示旧反馈。
for (const operation of ["立即同步", "测试读取连接（只读）"]) {
  const interrupting = new RemoteManager();
  interrupting.configs.set("Alice", webdav());
  interrupting.publish({ configured: true, enabled: true });
  await mount(interrupting);
  const oldOperation = deferred();
  interrupting.operationGate = oldOperation.promise;
  await press(operation);
  await act(async () => interrupting.publish({ phase: "syncing" }));
  assert.equal(control("Switch", "同步").props.disabled, false, "后台操作不能锁住关闭入口");
  await toggleSync(false);
  assert.equal(text(), "同步");
  await act(async () => oldOperation.resolve());
  assert.equal(text(), "同步", "已关闭的旧表单不能发布完成反馈");
  unmount();
}

// 同帧重复开关只保存一次；失败保持关闭，且不展示未经脱敏的异常。
const enableFailure = new RemoteManager();
const failingEnable = deferred();
enableFailure.enableGate = failingEnable.promise;
await mount(enableFailure);
const toggleHandler = control("Switch", "同步").props.onValueChange;
await act(async () => { toggleHandler(true); toggleHandler(true); });
assert.deepEqual(enableFailure.received, [["enabled", true]]);
assert.equal(control("Switch", "同步").props.disabled, true);
await act(async () => failingEnable.reject(new Error("unsafe raw-password raw-key")));
assert.equal(control("Switch", "同步").props.value, false);
assert.match(text(), /同步开关保存失败/);
assert.doesNotMatch(text(), /unsafe|raw-password|raw-key/);
assert.equal(renderer.root.findAllByType("TextInput").length, 0);
enableFailure.enableGate = null;
await toggleSync(true);
assert.equal(control("Switch", "同步").props.value, true, "未填写合法配置也能先启用并展开表单");
assert.equal(input("WebDAV 地址").props.value, "");
unmount();

// 开关已经持久化、但配置恢复失败时，不能将已开启状态误报为开关保存失败。
const restorationFailure = new RemoteManager();
restorationFailure.setEnabled = async enabled => {
  restorationFailure.publish({ enabled, error: enabled ? "同步已开启，但无法读取安全存储中的配置，请重试" : null });
  if (enabled) throw new Error("unsafe-config-secret");
};
await mount(restorationFailure);
await toggleSync(true);
assert.equal(control("Switch", "同步").props.value, true);
assert.match(text(), /同步已开启，但无法读取/);
assert.doesNotMatch(text(), /同步开关保存失败|unsafe-config-secret/);
await toggleSync(false);
assert.equal(text(), "同步");
unmount();

// 旧账号的开关提交不会锁住新账号，也不能将新账号设为开启。
const switching = new RemoteManager();
switching.configs.set("Bob", webdav("bob-only-password"));
const enablingAlice = deferred();
switching.enableGate = enablingAlice.promise;
await mount(switching);
await toggleSync(true);
await act(async () => switching.publish({ account: "Bob", enabled: false, configured: true }));
assert.equal(text(), "同步");
assert.equal(control("Switch", "同步").props.disabled, false);
await act(async () => enablingAlice.resolve());
assert.equal(control("Switch", "同步").props.value, false);
assert.equal(renderer.root.findAllByType("TextInput").length, 0);
switching.enableGate = null;
await toggleSync(true);
assert.equal(input("WebDAV 密码").props.value, "bob-only-password");
unmount();
console.log("airing offset sync settings: 默认关闭、展开配置、中断操作、失败重试及账号隔离通过 ✓");
