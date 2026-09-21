// 登录续期回归测试（使用内存 SecureStore，无网络）
import assert from "node:assert/strict";

globalThis.__banguminiSecureStore = new Map([
  ["bangumi_token", "expired-access-token"],
  ["bangumi_refresh_token", "expired-refresh-token"],
  ["bangumi_expires_at", "0"],
  ["bangumi_username", "cached-user"],
]);

let refreshRequests = 0;
globalThis.fetch = async (url) => {
  if (String(url).includes("/oauth/access_token")) {
    refreshRequests += 1;
    return new Response('{"error":"invalid_grant"}', { status: 400 });
  }
  throw new Error(`unexpected request: ${url}`);
};

const {
  clearToken,
  getAccessToken,
  getAccessTokenContext,
  invalidateAuthSession,
  isLoggedIn,
  setToken,
  subscribeAuthSessionExpired,
} = await import("../src/api/oauth.ts");
let expirationEvents = 0;
const unsubscribeExpiration = subscribeAuthSessionExpired(() => {
  expirationEvents += 1;
});

await assert.rejects(
  getAccessToken(),
  /登录状态已过期/,
  "续期被服务端拒绝后应要求用户重新登录",
);
assert.equal(refreshRequests, 1, "一次 token 获取只应发起一次续期请求");
assert.equal(expirationEvents, 1, "续期确定失败后应广播一次登录失效事件");
unsubscribeExpiration();
assert.equal(await isLoggedIn(), false, "续期失败后不应继续报告已登录");
assert.equal(globalThis.__banguminiSecureStore.size, 0, "确定失效的登录凭据应被清除");

globalThis.__banguminiSecureStore = new Map([
  ["bangumi_token", "old-access-token"],
  ["bangumi_refresh_token", "old-refresh-token"],
  ["bangumi_expires_at", "0"],
  ["bangumi_username", "old-user"],
]);
await setToken("manual-access-token");
assert.deepEqual(
  Object.fromEntries(globalThis.__banguminiSecureStore),
  { bangumi_token: "manual-access-token" },
  "手动 Token 不应继承旧会话的 refresh token、过期时间或用户名",
);
assert.equal(
  await invalidateAuthSession("old-access-token"),
  false,
  "旧请求不得使较新的登录状态失效",
);
assert.equal(
  globalThis.__banguminiSecureStore.get("bangumi_token"),
  "manual-access-token",
  "拒绝旧请求的失效操作后应保留当前 token",
);
const previousManualSession = await getAccessTokenContext();
await setToken("manual-access-token");
assert.equal(
  await invalidateAuthSession(
    previousManualSession.token,
    previousManualSession.sessionId,
  ),
  false,
  "即使 token 字符串相同，旧会话也不得清除重新登录后的会话",
);
assert.equal(
  await getAccessToken({
    forceRefresh: true,
    rejectedToken: previousManualSession.token,
    rejectedSessionId: previousManualSession.sessionId,
  }),
  "manual-access-token",
  "旧会话 401 不得强制续期使用相同 token 重新登录的新会话",
);

globalThis.__banguminiSecureStore = new Map([
  ["bangumi_token", "refreshing-access-token"],
  ["bangumi_refresh_token", "refreshing-refresh-token"],
  ["bangumi_expires_at", "0"],
]);
let resolveInFlightRefresh;
globalThis.fetch = async () =>
  new Promise((resolve) => {
    resolveInFlightRefresh = resolve;
  });
const inFlightRefresh = getAccessToken();
await new Promise((resolve) => setTimeout(resolve, 0));
await setToken("new-manual-token");
resolveInFlightRefresh(
  new Response(
    '{"access_token":"late-old-token","refresh_token":"late-old-refresh","expires_in":3600}',
    { status: 200 },
  ),
);
assert.equal(
  await inFlightRefresh,
  "new-manual-token",
  "旧续期请求完成后不应覆盖较新的登录",
);
assert.deepEqual(
  Object.fromEntries(globalThis.__banguminiSecureStore),
  { bangumi_token: "new-manual-token" },
  "旧续期响应不得恢复旧会话元数据",
);

globalThis.__banguminiSecureStore = new Map([
  ["bangumi_token", "old-flight-token"],
  ["bangumi_refresh_token", "old-flight-refresh"],
  ["bangumi_expires_at", "0"],
]);
let resolveOldSessionFlight;
globalThis.fetch = async () =>
  new Promise((resolve) => {
    resolveOldSessionFlight = resolve;
  });
const oldSessionFlight = getAccessToken();
await new Promise((resolve) => setTimeout(resolve, 0));
await setToken("new-session-without-refresh");
const newSessionOutcome = await Promise.race([
  getAccessToken({ forceRefresh: true }).then(
    () => "resolved",
    (error) => (error instanceof Error ? error.message : String(error)),
  ),
  new Promise((resolve) => setTimeout(() => resolve("timed out"), 100)),
]);
assert.match(
  String(newSessionOutcome),
  /登录状态已过期/,
  "新会话不得等待或复用旧会话的续期请求",
);
resolveOldSessionFlight(
  new Response(
    '{"access_token":"old-flight-result","refresh_token":"old-flight-next","expires_in":3600}',
    { status: 200 },
  ),
);
await assert.rejects(oldSessionFlight, /登录状态已过期/);
assert.equal(
  globalThis.__banguminiSecureStore.size,
  0,
  "旧会话续期结束后不得恢复已失效的新会话",
);

globalThis.__banguminiSecureStore = new Map([
  ["bangumi_token", "logout-race-token"],
  ["bangumi_refresh_token", "logout-race-refresh"],
  ["bangumi_expires_at", "0"],
]);
let resolveLoggedOutRefresh;
globalThis.fetch = async () =>
  new Promise((resolve) => {
    resolveLoggedOutRefresh = resolve;
  });
const loggedOutRefresh = getAccessToken();
await new Promise((resolve) => setTimeout(resolve, 0));
await clearToken();
resolveLoggedOutRefresh(
  new Response(
    '{"access_token":"should-not-return","refresh_token":"should-not-return","expires_in":3600}',
    { status: 200 },
  ),
);
await assert.rejects(loggedOutRefresh, /登录状态已过期/);
assert.equal(
  globalThis.__banguminiSecureStore.size,
  0,
  "登出后完成的续期请求不得恢复会话",
);

globalThis.__banguminiSecureStore = new Map([
  ["bangumi_token", "clearing-access-token"],
  ["bangumi_refresh_token", "clearing-refresh-token"],
  ["bangumi_expires_at", "0"],
]);
let notifyDeleteStarted;
const deleteStarted = new Promise((resolve) => {
  notifyDeleteStarted = resolve;
});
let releaseDeletes;
const deletesReleased = new Promise((resolve) => {
  releaseDeletes = resolve;
});
globalThis.__banguminiBeforeSecureDelete = async () => {
  notifyDeleteStarted();
  await deletesReleased;
};
let refreshDuringClearRequests = 0;
globalThis.fetch = async () => {
  refreshDuringClearRequests += 1;
  return new Response(
    '{"access_token":"revived-token","refresh_token":"revived-refresh","expires_in":3600}',
    { status: 200 },
  );
};
const clearingCredentials = clearToken();
await deleteStarted;
const accessDuringClear = getAccessToken();
await new Promise((resolve) => setTimeout(resolve, 0));
releaseDeletes();
await clearingCredentials;
await assert.rejects(accessDuringClear, /Not authenticated/);
assert.equal(
  refreshDuringClearRequests,
  0,
  "凭据清理进行中启动的读取不得使用即将失效的 refresh token",
);
globalThis.__banguminiBeforeSecureDelete = undefined;

globalThis.__banguminiSecureStore = new Map([
  ["bangumi_token", "server-rejected-access-token"],
  ["bangumi_refresh_token", "valid-refresh-token"],
  ["bangumi_expires_at", String(Date.now() + 60_000)],
]);
globalThis.fetch = async (url) => {
  if (String(url).includes("/oauth/access_token")) {
    return new Response(
      '{"access_token":"forced-access-token","refresh_token":"next-refresh-token","expires_in":3600}',
      { status: 200 },
    );
  }
  throw new Error(`unexpected request: ${url}`);
};
assert.equal(
  await getAccessToken({ forceRefresh: true }),
  "forced-access-token",
  "API 提前返回 401 时应忽略本地过期时间并强制续期",
);

globalThis.__banguminiSecureStore = new Map([
  ["bangumi_token", "expired-concurrent-token"],
  ["bangumi_refresh_token", "concurrent-refresh-token"],
  ["bangumi_expires_at", "0"],
]);
let concurrentRefreshRequests = 0;
globalThis.fetch = async () => {
  concurrentRefreshRequests += 1;
  await new Promise((resolve) => setTimeout(resolve, 5));
  return new Response(
    '{"access_token":"shared-renewed-token","expires_in":3600}',
    { status: 200 },
  );
};
assert.deepEqual(
  await Promise.all([getAccessToken(), getAccessToken(), getAccessToken()]),
  ["shared-renewed-token", "shared-renewed-token", "shared-renewed-token"],
  "并发请求应共享同一次续期结果",
);
assert.equal(concurrentRefreshRequests, 1, "并发请求只应发起一次续期请求");

globalThis.__banguminiSecureStore = new Map([
  ["bangumi_token", "temporarily-unavailable-access-token"],
  ["bangumi_refresh_token", "preserved-refresh-token"],
  ["bangumi_expires_at", "0"],
]);
globalThis.fetch = async () => new Response("service unavailable", { status: 503 });
await assert.rejects(
  getAccessToken(),
  /暂时无法续期/,
  "OAuth 服务临时故障不应被误判为凭据失效",
);
assert.equal(
  globalThis.__banguminiSecureStore.get("bangumi_refresh_token"),
  "preserved-refresh-token",
  "临时续期故障后应保留登录凭据以便稍后重试",
);

const api = await import("../shared/api/client.ts");
const tokenRequests = [];
const authorizationHeaders = [];
api.setTokenProvider(async (options) => {
  tokenRequests.push(options ?? {});
  return options?.forceRefresh ? "renewed-access-token" : "stale-access-token";
});
api.setFetchFunction(async (_url, init) => {
  authorizationHeaders.push(init?.headers?.Authorization);
  if (authorizationHeaders.length === 1) {
    return new Response('{"error":"invalid token"}', { status: 401 });
  }
  return new Response('{"username":"tester"}', { status: 200 });
});

const user = await api.getMyself();
assert.equal(user.username, "tester", "401 后续期成功应返回原请求结果");
assert.deepEqual(
  tokenRequests,
  [
    {},
    {},
    { forceRefresh: true, rejectedToken: "stale-access-token" },
  ],
  "API 401 后应确认会话未变化并强制续期一次",
);
assert.deepEqual(
  authorizationHeaders,
  ["Bearer stale-access-token", "Bearer renewed-access-token"],
  "续期后应使用新 token 重试原请求",
);

let invalidations = 0;
let rejectedRequests = 0;
api.setTokenProvider(async () => "server-rejected-token");
api.setUnauthorizedHandler(async () => {
  invalidations += 1;
});
api.setFetchFunction(async () => {
  rejectedRequests += 1;
  return new Response('{"error":"invalid token"}', { status: 401 });
});

await assert.rejects(
  api.getMyself(),
  /登录状态已过期/,
  "续期后仍返回 401 应明确要求重新登录",
);
assert.equal(rejectedRequests, 2, "API 401 最多只应强制续期重试一次");
assert.equal(invalidations, 1, "重复 401 应使全局登录状态失效一次");

let currentSessionToken = "old-session-token";
let staleRequestInvalidations = 0;
let resolveStaleRequest;
let staleRequestCount = 0;
const staleRequestTokenOptions = [];
api.setTokenProvider(async (options) => {
  staleRequestTokenOptions.push(options ?? {});
  return currentSessionToken;
});
api.setUnauthorizedHandler(async () => {
  staleRequestInvalidations += 1;
});
api.setFetchFunction(async () => {
  staleRequestCount += 1;
  if (staleRequestCount === 1) {
    return new Promise((resolve) => {
      resolveStaleRequest = resolve;
    });
  }
  return new Response('{"error":"invalid token"}', { status: 401 });
});
const staleRequest = api.getMyself();
await new Promise((resolve) => setTimeout(resolve, 0));
currentSessionToken = "new-session-token";
resolveStaleRequest(new Response('{"error":"invalid token"}', { status: 401 }));
await assert.rejects(
  staleRequest,
  /Bangumi API error 401/,
  "旧会话请求不应使新会话失效",
);
assert.equal(staleRequestInvalidations, 0, "迟到的旧请求不得清除新会话");
assert.deepEqual(
  staleRequestTokenOptions,
  [{}, {}],
  "发现会话已变化时应直接使用新 token，不应再次续期",
);

let forceRefreshRaceInvalidations = 0;
api.setTokenProvider(async (options) =>
  options?.forceRefresh
    ? { token: "new-racing-session", sessionId: 2 }
    : { token: "old-racing-session", sessionId: 1 },
);
api.setUnauthorizedHandler(async () => {
  forceRefreshRaceInvalidations += 1;
});
api.setFetchFunction(async () =>
  new Response('{"error":"invalid token"}', { status: 401 }),
);
await assert.rejects(
  api.getMyself(),
  /Bangumi API error 401/,
  "强制续期期间切换的新会话不应被旧请求判定为失效",
);
assert.equal(
  forceRefreshRaceInvalidations,
  0,
  "强制续期竞态中的旧请求不得清除新会话",
);

process.stdout.write("auth renewal: 全部通过 ✓\n");
