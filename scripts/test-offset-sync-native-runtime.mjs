// 真实 Android Metro 产物在没有 Node 全局的上下文中执行；只替换原生桥与 HTTP。
// 快速定位 URL 初始化：node scripts/test-offset-sync-native-runtime.mjs --url-only
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createRequire } from "node:module";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const Metro = require("metro");
const { loadConfig } = require("metro-config");
const root = fileURLToPath(new URL("../", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "offset-native-runtime-"));
const bridge = join(directory, "native-bridge.js");
const crypto = join(directory, "crypto-bridge.js");
const entry = join(directory, "entry.js");
const urlOnly = process.argv.includes("--url-only");
await writeFile(bridge, 'exports.Platform={OS:"android",Version:35,select:options=>options.android??options.native??options.default};exports.NativeModules={};');
// 确定性随机数只用于测试桥，不能进入生产 runtime。
await writeFile(crypto, 'exports.getRandomValues=array=>{for(let i=0;i<array.length;i++)array[i]=(i+1)%256;return array;};');
await writeFile(entry, `globalThis.offsetNativeStorage=require(${JSON.stringify(join(root, urlOnly ? "src/api/offset-sync-runtime.ts" : "src/api/offset-sync-storage.ts"))});`);
const config = await loadConfig({ cwd: root, config: join(root, "metro.config.js") });
config.watchFolders = [...config.watchFolders, directory];
config.maxWorkers = 2;
const originalResolver = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === "react-native") return { type: "sourceFile", filePath: bridge };
  if (moduleName === "expo-crypto") return { type: "sourceFile", filePath: crypto };
  return originalResolver ? originalResolver(context, moduleName, platform) : context.resolveRequest(context, moduleName, platform);
};
config.serializer.getModulesRunBeforeMainModule = () => [];
config.serializer.getPolyfills = () => [];
config.reporter = { update() {} };

// RN 的 Blob 没有 arrayBuffer；FileReader 只模拟原生二进制读取，不向沙箱注入 Buffer。
class NativeFileReader {
  readAsDataURL(blob) {
    this.readyState = 1;
    Blob.prototype.arrayBuffer.call(blob).then(bytes => {
      this.result = `data:application/octet-stream;base64,${Buffer.from(bytes).toString("base64")}`;
      this.readyState = 2;
      this.onloadend?.();
    }, error => { this.error = error; this.onerror?.(); });
  }
}
function nativeResponse(content, options, NativeBlob) {
  const response = new Response(content, options);
  const blob = response.blob.bind(response);
  Object.defineProperty(response, "body", { value: undefined });
  response.blob = async () => new NativeBlob([await blob()]);
  return response;
}

for (const dev of [false, true]) {
  const bundle = await Metro.runBuild(config, { entry, platform: "android", dev, minify: false });
  const bundlePath = join(directory, `storage.android.${dev ? "dev" : "production"}.bundle.js`);
  await writeFile(bundlePath, bundle.code);
  const requests = [];
  const files = new Map();
  class NativeBlob extends Blob {}
  Object.defineProperty(NativeBlob.prototype, "arrayBuffer", { value: undefined, configurable: true, writable: true });
  const response = (content, options) => nativeResponse(content, options, NativeBlob);
  const fetch = async (input, options) => {
    const request = new Request(input, options);
    const body = ["GET", "HEAD"].includes(request.method) ? "" : await request.text();
    requests.push({ method: request.method, headers: request.headers, body });
    const parsed = new URL(request.url);
    const key = `${parsed.origin}${parsed.pathname}`;
    if (request.method === "MKCOL") return response(null, { status: 405 });
    if (request.method === "PUT") {
      files.set(key, body);
      return response(null, { status: 200 });
    }
    assert.equal(request.method, "GET");
    return files.has(key)
      ? response(files.get(key), { headers: { ETag: '"revision-1"' } })
      : response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 });
  };
  const context = vm.createContext({ console, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    AbortController, Headers, Request, Response, Blob: NativeBlob, FileReader: NativeFileReader, performance, atob, btoa, fetch });
  vm.runInContext("globalThis.global=globalThis;globalThis.self=globalThis;", context);
  assert.equal(vm.runInContext("typeof Buffer", context), "undefined");
  assert.equal(vm.runInContext("typeof TextDecoder", context), "undefined");
  assert.equal(vm.runInContext("typeof Blob.prototype.arrayBuffer", context), "undefined");
  new vm.Script(bundle.code, { filename: bundlePath }).runInContext(context, { timeout: 10_000 });
  assert.equal(vm.runInContext("typeof Blob.prototype.arrayBuffer", context), "function");
  assert.equal(requests.length, 0, "导入 SDK 不能启动网络请求");
  assert.equal(vm.runInContext('new TextDecoder().decode(new TextEncoder().encode("你好🌙"))', context), "你好🌙");
  assert.equal(vm.runInContext('new URL("https://example.test/path").hostname', context), "example.test",
    "不能因全局 module 优先让 URL polyfill 读到 punycode ESM，从而访问 undefined.decode");
  assert.equal(vm.runInContext('new URL("https://example.test/路径?q=你好🌙").searchParams.get("q")', context), "你好🌙");
  assert.equal(vm.runInContext('new URL("/oauth/callback?code=a%2Bb", "bangumini://app").searchParams.get("code")', context), "a+b");
  if (!urlOnly) {
    assert.equal(typeof context.offsetNativeStorage?.createOffsetSyncStorage, "function");
    vm.runInContext(`
      globalThis.dav=offsetNativeStorage.createOffsetSyncStorage({provider:"webdav",url:"https://dav.example.test",username:"alice",password:"test-password",prefix:"bangumini",autoSync:false},"alice");
      globalThis.s3=offsetNativeStorage.createOffsetSyncStorage({provider:"s3",endpoint:"https://r2.example.test",region:"auto",bucket:"offsets",accessKeyId:"test-access-key",secretAccessKey:"test-secret-key",forcePathStyle:true,prefix:"bangumini",autoSync:false},"alice");
    `, context);
    const content = '{"条目":"你好🌙","offset":-1}';
    for (const [provider, storage] of [["webdav", context.dav], ["s3", context.s3]]) {
      assert.equal(await storage.read(), null, `${provider} 通过真实 SDK 处理远端 404`);
      await storage.write(content, null);
      let put = requests.at(-1);
      assert.equal(put.method, "PUT");
      assert.equal(put.body, content);
      assert.equal(put.headers.get("if-none-match"), "*");
      assert.match(put.headers.get("authorization"), provider === "s3" ? /^AWS4-HMAC-SHA256 / : /^Basic /);
      assert.deepEqual(JSON.parse(JSON.stringify(await storage.read())), { content, etag: '"revision-1"' }, `${provider} 读回 UTF-8 内容`);
      await storage.write(content, '"revision-1"');
      put = requests.at(-1);
      assert.equal(put.headers.get("if-match"), '"revision-1"');
      assert.equal(put.headers.get("if-none-match"), null);
    }
  }
  console.log(`offset native runtime: Android Metro ${dev ? "dev" : "production"} URL / Unicode / OAuth${urlOnly ? "" : " / WebDAV / signed S3 / RN Blob"} ✓`);
}
