import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const root = new URL("../", import.meta.url);
const dir = await mkdtemp(join(tmpdir(), "offset-config-"));
const source = (await readFile(new URL("src/api/offset-sync-config-store.ts", root), "utf8"))
  .replaceAll('"../../shared/offset-sync-config"', JSON.stringify(new URL("shared/offset-sync-config.ts", root).href));
await writeFile(join(dir, "store.mjs"), ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText);
const { createOffsetSyncConfigStore } = await import(pathToFileURL(join(dir, "store.mjs")).href);
const secure = new Map();
const deps = {
  getItem: async key => secure.get(key) ?? null,
  setItem: async (key, value) => {
    assert(Buffer.byteLength(value, "utf8") <= 2048, "单个安全存储值不能超过兼容大小");
    secure.set(key, value);
  },
  deleteItem: async key => { secure.delete(key); },
  hash: async value => createHash("sha256").update(value).digest("hex"),
  randomId: randomUUID,
};
const store = createOffsetSyncConfigStore(deps);
const webdav = { provider: "webdav", autoSync: true, prefix: "/bangumini/", url: "https://dav.example.test/dav/", username: "user", password: "fake-test-password" };
await store.set("alice", webdav);
assert.deepEqual(await store.get("alice"), { ...webdav, prefix: "bangumini", url: "https://dav.example.test/dav" });
assert.equal(await store.get("bob"), null, "不同 Bangumi 账号不能读取彼此凭证");
assert.deepEqual(await createOffsetSyncConfigStore(deps).get("alice"), await store.get("alice"), "重启后可从安全存储恢复");
const large = { provider: "s3", autoSync: false, prefix: "个人偏置", endpoint: "https://s3.example.test/", region: "auto", bucket: "private-test-bucket", accessKeyId: "fake-access-id", secretAccessKey: "fake-secret", sessionToken: "模拟令牌🧪".repeat(900), forcePathStyle: true };
await store.set("bob", large);
assert.deepEqual(await store.get("bob"), { ...large, endpoint: "https://s3.example.test" }, "长临时令牌和 Unicode 应分块安全往返");
const failure = createOffsetSyncConfigStore({ ...deps, setItem: async (key, value) => { if (key.endsWith(".head")) throw new Error("fake-test-password must never leak"); await deps.setItem(key, value); } });
await assert.rejects(failure.set("alice", { ...webdav, password: "new-fake-secret" }), error => /保存失败/.test(error.message) && !/fake-test-password|new-fake-secret/.test(error.message));
assert.equal((await store.get("alice")).password, "fake-test-password", "新配置提交失败不能破坏旧凭证");
await store.delete("alice");
assert.equal(await store.get("alice"), null);
assert.deepEqual(await store.get("bob"), { ...large, endpoint: "https://s3.example.test" }, "断开一个账号不能影响另一个账号");
await store.set("alice", webdav);
await assert.rejects(store.set("alice", { ...webdav, password: 42 }), /密码|配置/);
assert.equal((await store.get("alice")).password, "fake-test-password", "非法配置不能覆盖已保存的凭证");
console.log("offset sync config store: 安全配置、分块原子提交与账号隔离通过 ✓");
