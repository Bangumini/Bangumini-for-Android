// 真实 WebDAV RN SDK 与 S3 命令穿过底层 fetch；不替换 createClient/send。
// 运行：node --experimental-strip-types scripts/test-offset-sync-storage.mjs
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const root = new URL("../", import.meta.url);
const directory = await mkdtemp(join(tmpdir(), "bangumini-offset-storage-"));
const requests = [];
let respond = () => new Response("", { status: 404 });
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, options) => {
  const request = new Request(input, options);
  const body = request.method === "GET" || request.method === "HEAD" ? "" : await request.text();
  requests.push({ method: request.method, url: request.url, headers: request.headers, body, signal: request.signal });
  return respond(request, body);
};
let source = await readFile(new URL("src/api/offset-sync-storage.ts", root), "utf8");
for (const specifier of ["webdav/react-native", "@aws-sdk/client-s3", "@smithy/fetch-http-handler"]) {
  source = source.replaceAll(JSON.stringify(specifier), JSON.stringify(import.meta.resolve(specifier)));
}
source = source.replaceAll('"./offset-sync-runtime"', '"data:text/javascript,"');
source = source.replaceAll('"../../shared/offset-sync-config"', JSON.stringify(new URL("shared/offset-sync-config.ts", root).href));
await writeFile(join(directory, "storage.mjs"), ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText);
const { createOffsetSyncStorage, OffsetSyncPreconditionError, offsetSyncStorageErrorMessage } = await import(pathToFileURL(join(directory, "storage.mjs")));
const webdav = { provider: "webdav", url: "https://dav.example.test/base", username: "alice", password: "sensitive-password", prefix: "bangumini", autoSync: false };
const s3 = { provider: "s3", endpoint: "https://r2.example.test", region: "auto", bucket: "offsets", accessKeyId: "test-access-key", secretAccessKey: "test-secret-key", sessionToken: "test-session-token", forcePathStyle: true, prefix: "bangumini", autoSync: false };
try {
  const storage = createOffsetSyncStorage(webdav, "alice");
  assert.equal(await storage.read(), null, "远端404才表示不存在");
  assert.deepEqual(requests.map(r => r.method), ["GET"], "只读缺失文件不能创建目录");
  assert.equal(requests[0].url, "https://dav.example.test/base/bangumini/accounts/alice/airing-offsets.v1.json");
  assert.equal(requests[0].headers.get("authorization"), "Basic YWxpY2U6c2Vuc2l0aXZlLXBhc3N3b3Jk");
  console.log("offset-sync-storage: WebDAV 404 is read-only ✓");

  const content = '{"条目":"你好🌙","offset":-1}';
  respond = () => new Response(content, { headers: { ETag: '"revision-1"', "Content-Type": "application/json" } });
  assert.deepEqual(await storage.read(), { content, etag: '"revision-1"' });
  for (const etag of [undefined, "", 'W/"weak"', "unquoted", '"bad\"tag"']) {
    respond = () => new Response(content, { headers: etag === undefined ? {} : { ETag: etag } });
    await assert.rejects(storage.read(), /ETag/, "缺失或弱ETag不能成为覆盖基线");
  }
  for (const status of [401, 403, 409, 500]) {
    respond = () => new Response("sensitive-password raw-private-response", { status });
    await assert.rejects(storage.read(), error => {
      assert.match(error.message, new RegExp(`HTTP ${status}`));
      assert(!error.message.includes("sensitive"));
      return true;
    });
  }
  console.log("offset-sync-storage: WebDAV UTF-8 / strong ETag / HTTP errors ✓");

  requests.length = 0;
  respond = request => new Response(null, { status: request.method === "MKCOL" ? 405 : 201 });
  await storage.write(content, null);
  assert.deepEqual(requests.map(r => [r.method, new URL(r.url).pathname]), [
    ["MKCOL", "/base/bangumini/"], ["MKCOL", "/base/bangumini/accounts/"],
    ["MKCOL", "/base/bangumini/accounts/alice/"], ["PUT", "/base/bangumini/accounts/alice/airing-offsets.v1.json"],
  ]);
  let put = requests.at(-1);
  assert.equal(put.headers.get("if-none-match"), "*");
  assert.equal(put.headers.get("if-match"), null);
  assert.equal(put.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(put.body, content);
  await storage.write(content, '"revision-1"');
  put = requests.at(-1);
  assert.equal(put.headers.get("if-match"), '"revision-1"');
  assert.equal(put.headers.get("if-none-match"), null);
  for (const status of [409, 412]) {
    respond = request => new Response(null, { status: request.method === "MKCOL" ? 201 : status });
    await assert.rejects(storage.write(content, null), OffsetSyncPreconditionError);
    await assert.rejects(storage.write(content, '"revision-1"'), OffsetSyncPreconditionError);
  }
  respond = () => new Response("private", { status: 401 });
  requests.length = 0;
  await assert.rejects(storage.write(content, null), /HTTP 401/);
  assert.equal(requests.length, 1, "目录鉴权失败不能继续PUT");
  await assert.rejects(storage.write(content, ""), /ETag/);
  console.log("offset-sync-storage: WebDAV directories / atomic conditional JSON writes ✓");

  requests.length = 0;
  const objectStore = createOffsetSyncStorage(s3, "alice");
  respond = () => new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 });
  assert.equal(await objectStore.read(), null);
  let get = requests.at(-1);
  assert.equal(get.method, "GET");
  assert.equal(new URL(get.url).pathname, "/offsets/bangumini/accounts/alice/airing-offsets.v1.json");
  assert.match(get.headers.get("authorization"), /^AWS4-HMAC-SHA256 Credential=test-access-key\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=.+, Signature=[0-9a-f]{64}$/);
  assert.equal(get.headers.get("x-amz-security-token"), "test-session-token");
  respond = () => new Response(content, { headers: { ETag: '"s3-revision"', "Content-Length": String(Buffer.byteLength(content)) } });
  assert.deepEqual(await objectStore.read(), { content, etag: '"s3-revision"' });
  for (const etag of [undefined, "", 'W/"weak"']) {
    respond = () => new Response(content, { headers: etag === undefined ? {} : { ETag: etag } });
    await assert.rejects(objectStore.read(), /ETag/);
  }
  for (const status of [401, 403, 500]) {
    respond = () => new Response('<Error><Code>Denied</Code><Message>test-secret-key</Message></Error>', { status });
    await assert.rejects(objectStore.read(), error => {
      assert.match(error.message, new RegExp(`HTTP ${status}`));
      assert(!error.message.includes("test-secret"));
      assert(!error.message.includes("<Error>"));
      return true;
    });
  }
  console.log("offset-sync-storage: real signed S3 GetObject / UTF-8 / 404 / strong ETag ✓");

  respond = () => new Response(null, { status: 200 });
  await objectStore.write(content, null);
  put = requests.at(-1);
  assert.equal(put.method, "PUT");
  assert.equal(put.body, content);
  assert.equal(put.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(put.headers.get("if-none-match"), "*");
  assert.equal(put.headers.get("if-match"), null);
  assert(![...put.headers.keys()].some(key => key.startsWith("x-amz-checksum-")), "不向R2自动发送不必要的CRC checksum");
  assert.match(put.headers.get("authorization"), /SignedHeaders=[^,]*if-none-match[^,]*,/);
  await objectStore.write(content, '"s3-revision"');
  assert.equal(requests.at(-1).headers.get("if-match"), '"s3-revision"');
  assert.match(requests.at(-1).headers.get("authorization"), /SignedHeaders=[^,]*if-match[^,]*,/);
  for (const status of [409, 412]) {
    respond = () => new Response('<Error><Code>PreconditionFailed</Code></Error>', { status });
    await assert.rejects(objectStore.write(content, null), OffsetSyncPreconditionError);
    await assert.rejects(objectStore.write(content, '"s3-revision"'), OffsetSyncPreconditionError);
  }
  respond = () => new Response(null, { status: 200 });
  const virtualHostStore = createOffsetSyncStorage({ ...s3, forcePathStyle: false, region: "eu-west-1", sessionToken: undefined }, "alice");
  await virtualHostStore.write(content, null);
  put = requests.at(-1);
  assert.equal(new URL(put.url).host, "offsets.r2.example.test");
  assert.equal(new URL(put.url).pathname, "/bangumini/accounts/alice/airing-offsets.v1.json");
  assert.match(put.headers.get("authorization"), /\/eu-west-1\/s3\/aws4_request/);
  assert.equal(put.headers.get("x-amz-security-token"), null);
  console.log("offset-sync-storage: signed S3 conditional PutObject / region / path style ✓");

  for (const adapter of [storage, objectStore]) {
    respond = () => new Response("small", { headers: { ETag: '"v1"', "Content-Length": "2097153" } });
    await assert.rejects(adapter.read(), /2 MiB/, "提前检查远端Content-Length");
    respond = () => new Response("界".repeat(699_051), { headers: { ETag: '"v1"' } });
    await assert.rejects(adapter.read(), /2 MiB/, "缺失Content-Length也按UTF-8字节检查读完的body");
    requests.length = 0;
    await assert.rejects(adapter.write("界".repeat(699_051), null), /2 MiB/);
    assert.equal(requests.length, 0, "超大本地文本不能写目录或覆盖远端");
  }
  assert.throws(() => createOffsetSyncStorage({ ...webdav, url: "http://dav.example.test" }, "alice"), /HTTPS/);
  assert.throws(() => createOffsetSyncStorage({ ...s3, endpoint: "http://r2.example.test" }, "alice"), /HTTPS/);
  assert.equal(offsetSyncStorageErrorMessage(new Error("https://alice:sensitive-password@private.example.test <XML>")), "远端存储请求失败，请检查配置或网络后重试");
  assert.equal(offsetSyncStorageErrorMessage({ status: 401, message: "secret" }), "远端存储请求失败（HTTP 401）");
  console.log("offset-sync-storage: 2 MiB UTF-8 limits / HTTPS / credential-safe messages ✓");

  async function rejectsPromptly(promise) {
    let timer;
    try {
      await assert.rejects(Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("test: operation did not stop")), 200); })]), /取消|超时/);
    } finally { clearTimeout(timer); }
  }
  for (const adapter of [storage, objectStore]) {
    for (const operation of [signal => adapter.read(signal), signal => adapter.write(content, null, signal)]) {
      requests.length = 0;
      respond = () => new Promise(() => {}); // 即使传输层忽略取消，调用者也必须及时返回。
      const controller = new AbortController();
      const pending = operation(controller.signal);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(requests.length, 1);
      controller.abort(new Error("sensitive-password must not escape"));
      await rejectsPromptly(pending);
      assert(requests[0].signal.aborted, "调用者signal必须传至真实SDK底层网络");
      const preAborted = new AbortController();
      preAborted.abort();
      requests.length = 0;
      await rejectsPromptly(operation(preAborted.signal));
      assert.equal(requests.length, 0, "已经取消的任务不能发网络请求");
    }
    for (const operation of [() => adapter.read(), () => adapter.write(content, null)]) {
      const originalSetTimeout = globalThis.setTimeout;
      const callbacks = [];
      globalThis.setTimeout = (callback, delay, ...args) => {
        if (delay === 30_000) { callbacks.push(() => callback(...args)); return { fakeDeadline: true }; }
        return originalSetTimeout(callback, delay, ...args);
      };
      let pending;
      try {
        pending = operation();
        await new Promise(resolve => setImmediate(resolve));
      } finally { globalThis.setTimeout = originalSetTimeout; }
      assert(callbacks.length > 0, "每次存储操作都必须有30秒deadline");
      callbacks.forEach(callback => callback());
      await rejectsPromptly(pending);
    }
  }
  requests.length = 0;
  let finishDirectory;
  respond = () => new Promise(resolve => { finishDirectory = resolve; });
  const directoryAbort = new AbortController();
  const directoryWrite = storage.write(content, null, directoryAbort.signal);
  await new Promise(resolve => setImmediate(resolve));
  directoryAbort.abort();
  await rejectsPromptly(directoryWrite);
  finishDirectory(new Response(null, { status: 201 }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 1, "取消后晚到的MKCOL不能触发后续目录创建或PUT");
  for (const adapter of [storage, objectStore]) {
    let releaseBody;
    respond = () => new Response(new ReadableStream({ start(controller) { releaseBody = () => controller.close(); } }), { headers: { ETag: '"body-pending"' } });
    const bodyAbort = new AbortController();
    const readingBody = adapter.read(bodyAbort.signal);
    await new Promise(resolve => setImmediate(resolve));
    bodyAbort.abort();
    await rejectsPromptly(readingBody);
    releaseBody();
  }
  respond = () => {
    const response = new Response(content, { headers: { ETag: '"rn-blob"' } });
    Object.defineProperty(response, "body", { value: undefined }); // RN fetch 没有流式 body，官方 handler 退回 Blob。
    return response;
  };
  assert.deepEqual(await objectStore.read(), { content, etag: '"rn-blob"' });
  console.log("offset-sync-storage: abort / pre-abort / whole-body deadlines / RN Blob ✓");

  let runtimeSource = await readFile(new URL("src/api/offset-sync-runtime.ts", root), "utf8");
  runtimeSource = runtimeSource.replaceAll('"react-native-url-polyfill/auto"', '"data:text/javascript,"'); // Node 已有 URL；仅隔离 native 平台探测。
  runtimeSource = runtimeSource.replaceAll('"expo-crypto"', '"node:crypto"'); // 只替换原生安全随机数桥，不替换 SDK。
  for (const specifier of ["web-streams-polyfill", "fast-text-encoding"]) {
    runtimeSource = runtimeSource.replaceAll(JSON.stringify(specifier), JSON.stringify(import.meta.resolve(specifier)));
  }
  await writeFile(join(directory, "runtime.mjs"), ts.transpileModule(runtimeSource, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText);
  const globals = ["crypto", "TextEncoder", "TextDecoder", "ReadableStream", "ReadableStreamDefaultReader", "ReadableStreamBYOBReader", "ReadableStreamBYOBRequest", "ReadableByteStreamController", "ReadableStreamDefaultController", "WritableStream", "WritableStreamDefaultWriter", "WritableStreamDefaultController", "TransformStream", "TransformStreamDefaultController", "ByteLengthQueuingStrategy", "CountQueuingStrategy"];
  const descriptors = new Map(globals.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  try {
    for (const name of globals) Object.defineProperty(globalThis, name, { value: undefined, writable: true, configurable: true });
    await import(pathToFileURL(join(directory, "runtime.mjs")));
    assert.equal(typeof globalThis.TextEncoder, "function", "RN缺少TextEncoder时必须补齐");
    assert.equal(typeof globalThis.TextDecoder, "function", "RN缺少TextDecoder时必须补齐");
    assert.equal(new TextDecoder().decode(new TextEncoder().encode("你好🌙")), "你好🌙");
    assert.equal(typeof globalThis.ReadableStream, "function");
    assert.equal(globalThis.crypto.getRandomValues(new Uint8Array(16)).length, 16);
  } finally {
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
  console.log("offset-sync-storage: RN missing globals restored by real polyfills ✓");
} finally {
  globalThis.fetch = originalFetch;
}
