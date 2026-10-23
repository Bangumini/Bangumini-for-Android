// 收藏 worker 重复跳组回归测试：只替换真实模块的外部依赖，不复制 worker 算法。
// 运行：node --experimental-strip-types scripts/test-collection-worker.mjs（Node >= 22.6）
// 收集全部回退后退出非零，不能把已知回退标成预期通过。
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { QueryClient } from "@tanstack/react-query";
import { sortCollections } from "../shared/sort-collections.ts";

const USER = "worker-test-user";
const SUBJECT = 7;
const TYPES = [1, 2, 3, 4, 5];
const BASE = { username: USER, subjectId: SUBJECT, subjectTitle: "测试条目", previousType: 3 };
const originalGlobals = new Map(["setTimeout", "clearTimeout"].map((name) => [
  name, Object.getOwnPropertyDescriptor(globalThis, name),
]));
let tempDir;
let active;
let caseNumber = 0;
let passed = 0;
let failed = 0;

function setGlobal(name, value) {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

function collection(type = 3, ep_status = 1) {
  return {
    subject_id: SUBJECT, subject_type: 2, type, ep_status, vol_status: 0,
    rate: 0, private: false, tags: [], comment: "", updated_at: "2020-01-01T00:00:00Z",
    subject: {
      id: SUBJECT, type: 2, name: "Worker fixture", name_cn: "测试条目",
      eps: 2, total_episodes: 2, date: "2020-01-01", air_weekday: 3,
    },
  };
}

function page(data) {
  return { data, total: data.length, limit: 30, offset: 0 };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

// 没有 sleep 或真实 retry timer；有界 microtask 屏障只负责报告测试装配错误。
async function until(predicate, label) {
  for (let turn = 0; turn < 1000; turn += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error(`未到达确定性屏障：${label}`);
}

function stateOf(value) {
  if (!value) return { type: null, ep_status: null, group: "absent" };
  // 不模拟分组：使用仓库真实排序器，空日历使 fixture 与当天日期/时区无关。
  const [{ group }] = sortCollections([value], [], { nowMs: 1_700_000_000_000, airedEpMap: new Map() });
  return { type: value.type, ep_status: value.ep_status, group };
}

function formatState(state) {
  return `type=${state.type ?? "∅"} ep_status=${state.ep_status ?? "∅"} group=${state.group}`;
}

function createHarness() {
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } });
  const tasks = new Map();
  const cacheValues = new Map();
  const expected = [];
  const unexpected = [];
  const trace = [];
  const updates = [];
  const taskEvents = [];
  const persisted = [];
  const timers = new Map();
  const gates = [];
  const runs = [];
  let writeGate;
  let clock = 1_700_000_000_000;
  let timerId = 0;
  let recoveries = 0;
  let enabled = false;
  let idleCount = 0;
  let stage = "初始化";
  const clone = (value) => structuredClone(value);
  const ordered = () => [...tasks.values()].sort((a, b) => a.createdAt - b.createdAt || a.updatedAt - b.updatedAt);
  const taskAt = (id) => {
    assert.ok(tasks.has(id), `不存在的任务：${id}`);
    return tasks.get(id);
  };
  const sqlite = {
    async upsertPersistentCollectionTask(input) {
      const old = tasks.get(input.id);
      const now = ++clock;
      const task = {
        ...clone(input), status: "pending", attemptCount: 0, lastError: null,
        runAfter: 0, createdAt: old?.createdAt ?? now, updatedAt: now,
      };
      tasks.set(task.id, task);
      return clone(task);
    },
    async readPersistentCollectionTasks() { return clone(ordered()); },
    async readDuePersistentCollectionTask() {
      return clone(enabled ? ordered().find((task) => ["pending", "failed"].includes(task.status) && task.runAfter <= Date.now()) ?? null : null);
    },
    async readNextPersistentCollectionTaskRunAt() {
      idleCount += 1;
      const pending = enabled ? ordered().filter((task) => ["pending", "failed"].includes(task.status)) : [];
      return pending.length ? Math.min(...pending.map((task) => task.runAfter)) : null;
    },
    async markPersistentCollectionTaskRunning(id) {
      Object.assign(taskAt(id), { status: "running", updatedAt: ++clock });
    },
    async markPersistentCollectionTaskFailed(id, error, runAfter) {
      const task = taskAt(id);
      Object.assign(task, { status: "failed", attemptCount: task.attemptCount + 1, lastError: error, runAfter, updatedAt: ++clock });
      unexpected.push(`worker 失败：${error}`);
    },
    async completePersistentCollectionTask(id) { return tasks.delete(id); },
    async deletePersistentCollectionTask(id) { tasks.delete(id); },
    async retryPersistentCollectionTask(id) {
      Object.assign(taskAt(id), { status: "pending", runAfter: 0, lastError: null, updatedAt: ++clock });
    },
    async recoverRunningPersistentCollectionTasks() {
      for (const task of tasks.values()) {
        if (task.status === "running") Object.assign(task, { status: "pending", runAfter: 0, updatedAt: ++clock });
      }
      recoveries += 1;
    },
    async writeCachedCollection(username, value) {
      persisted.push(clone(value));
      if (writeGate) {
        const gate = writeGate;
        writeGate = undefined;
        gate.entered = true;
        trace.push(`屏障 ${gate.label}：内存提交后暂停 SQLite 写入`);
        await gate.release.promise;
      }
      cacheValues.set(`collection:${username}:${value.subject_id}`, clone(value));
    },
    async readCachedCollection(username, subjectId) {
      return clone(cacheValues.get(`collection:${username}:${subjectId}`) ?? null);
    },
    async writeCachedEpisodes(id, value) { cacheValues.set(`episodes:${id}`, clone(value)); },
    async readCachedValue(key) { return clone(cacheValues.get(key) ?? null); },
    async readCachedValueEntryAllowStale(key) {
      return cacheValues.has(key) ? { payload: clone(cacheValues.get(key)), isStale: false } : null;
    },
    async writeCachedValue(key, value) { cacheValues.set(key, clone(value)); },
  };
  const browser = {
    setTimeout(callback, delay) {
      // worker timer 只登记，不运行/不持有 Node 句柄；成功场景不应安排重试。
      const id = ++timerId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
  };
  const h = {
    client, browser, sqlite, trace, updates, taskEvents, tasks, runs, persisted,
    appState: { currentState: "active", addEventListener() { return { remove() {} }; } },
    async api(name, args) {
      trace.push(`API ${name} ${JSON.stringify(args)}`);
      const next = expected.shift();
      try {
        assert.ok(next, `未预期 API：${name}`);
        assert.equal(name, next.name, "API 顺序");
        assert.deepEqual(args, next.args, `API ${name} 参数`);
        if (next.gate) {
          next.gate.entered = true;
          trace.push(`屏障 ${next.gate.label}：响应已捕获，等待释放`);
          await next.gate.release.promise;
        }
        stage = `API ${name} 返回${next.value?.subject_id ? ` type=${next.value.type} ep_status=${next.value.ep_status}` : ""}`;
        return clone(next.value);
      } catch (error) {
        unexpected.push(error.message);
        throw error;
      }
    },
    expect(name, args, value, gate) { expected.push({ name, args, value, gate }); },
    gate(label) {
      const gate = { label, entered: false, release: deferred() };
      gates.push(gate);
      return gate;
    },
    stage(label) { stage = label; trace.push(`阶段 ${label}`); },
    pauseNextCollectionWrite(gate) { writeGate = gate; },
    persistedCollection() { return clone(cacheValues.get(`collection:${USER}:${SUBJECT}`)); },
    clearBase() { cacheValues.clear(); },
    async projectPending(worker) {
      const pending = await worker.getCollectionTaskQueue();
      for (const type of TYPES) {
        const key = ["collections", type, USER];
        const projected = worker.mergePendingCollectionTasks({
          data: client.getQueryData(key), currentData: client.getQueryData(key),
          tasks: pending, cachedCollections: [collection()], username: USER, collectionType: type,
        });
        client.setQueryData(key, projected);
        const item = projected.data.find((entry) => entry.subject_id === SUBJECT);
        if (item) client.setQueryData(["collection", USER, SUBJECT], item);
      }
    },
    async start(worker) {
      worker.subscribeCollectionTasks((detail) => {
        taskEvents.push(clone(detail));
        trace.push(`TASK ${detail.status} ${detail.kind} nextType=${detail.nextType}`);
      });
      worker.startCollectionTaskWorker(client);
      await until(() => recoveries === 1 && idleCount === 1, "启动恢复与空队列退出");
      await Promise.resolve();
      await Promise.resolve();
    },
    async optimistic(worker) {
      // Android 的乐观意图来自队列；将真实投影放入缓存，隔离页面渲染并监视 worker 覆盖。
      await until(() => idleCount >= 2, "入队自动 kick 在暂停的存储边界退出");
      await Promise.resolve();
      await Promise.resolve();
      const patch = worker.getOptimisticCollectionPatchForSubject(SUBJECT, await worker.getCollectionTaskQueue());
      const next = { ...client.getQueryData(["collection", USER, SUBJECT]), ...patch };
      client.setQueryData(["collection", USER, SUBJECT], next);
      for (const type of TYPES) {
        client.setQueryData(["collections", type, USER], page(type === next.type ? [next] : []));
      }
    },
    kick(worker) {
      enabled = true;
      const run = worker.kickCollectionTaskWorker();
      runs.push(run);
      return run;
    },
    checkInfrastructure() {
      assert.deepEqual(unexpected, [], "隔离环境/worker 不应有额外错误");
      assert.equal(expected.length, 0, "应消费全部 API 预期");
      assert.equal(tasks.size, 0, "成功后任务队列应排空");
      assert.equal(timers.size, 0, "成功场景不应遗留重试 timer");
      assert.equal(taskEvents.filter((event) => event.status === "failed").length, 0);
    },
    async cleanup() {
      enabled = false;
      for (const gate of gates) gate.release.resolve();
      await Promise.allSettled(runs);
      unsubscribe();
      client.clear();
      timers.clear();
    },
  };
  const initial = collection();
  cacheValues.set(`collection:${USER}:${SUBJECT}`, clone(initial));
  client.setQueryData(["collection", USER, SUBJECT], initial);
  for (const type of TYPES) {
    const value = page(type === initial.type ? [initial] : []);
    client.setQueryData(["collections", type, USER], value);
    cacheValues.set(`collections-${type}-${USER}`, clone(value));
  }
  const unsubscribe = client.getQueryCache().subscribe((event) => {
    if (event.type !== "updated") return;
    const key = event.query.queryKey;
    if (!["collection", "collections"].includes(key[0])) return;
    const value = event.query.state.data;
    const item = key[0] === "collection" ? value : value?.data.find((entry) => entry.subject_id === SUBJECT);
    const update = { index: updates.length + 1, key: [...key], action: event.action.type, stage, ...stateOf(item) };
    updates.push(update);
    trace.push(`CACHE #${update.index} ${key[0] === "collection" ? "单条" : `列表${key[1]}`} ${formatState(update)} [${stage}; ${update.action}]`);
  });
  return h;
}

function assertNoRegression(h, begin, target) {
  const relevant = h.updates.slice(begin).filter((update) => update.type !== null);
  assert.ok(relevant.some((update) => update.key[0] === "collection"), "应观察到 worker 更新单条缓存");
  assert.ok(relevant.some((update) => update.key[0] === "collections"), "应观察到 worker 更新列表缓存");
  const regressions = h.updates.slice(begin).filter((update) => {
    const shouldContain = update.key[0] === "collection" || update.key[1] === target.type;
    return shouldContain
      ? Object.entries(target).some(([key, value]) => update[key] !== value)
      : update.type !== null;
  });
  assert.equal(regressions.length, 0, `乐观目标被覆盖（${regressions.length} 次），首次 CACHE #${regressions[0]?.index}：${regressions[0] ? formatState(regressions[0]) : "无"}`);
  const completed = h.taskEvents.filter((event) => event.status === "finished").length;
  const publications = h.updates.slice(begin).filter((update) => update.key[0] === "collection" && update.action === "success");
  assert.equal(publications.length, completed, "每个任务只能提交一次最终单条确认值");
  assert.equal(h.persisted.length, completed, "每个任务只能持久化一次最终服务端确认值");
}

async function test(name, run) {
  const h = createHarness();
  active = h;
  caseNumber += 1;
  try {
    // 每个用例重新加载真实 worker，隔离 queryClient/workerRunning 等模块状态。
    const worker = await import(pathToFileURL(join(tempDir, "collection-tasks.ts")).href + `?case=${caseNumber}`);
    await h.start(worker);
    await run(h, worker);
    passed += 1;
    console.log(`✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`\n✗ ${name}\n${h.trace.join("\n")}\n断言失败：${error.stack}`);
  } finally {
    await h.cleanup();
    active = undefined;
  }
}

try {
  tempDir = await mkdtemp(join(tmpdir(), "bangumini-collection-worker-test-"));
  let source = await readFile(new URL("../src/api/collection-tasks.ts", import.meta.url), "utf8");
  const stubNames = new Set();
  // 所有运行时依赖都必须显式分类；新增依赖时失败关闭，避免悄悄接入真实 API/DB。
  source = source.replace(/import\s+(type\s+)?([\s\S]*?)\s+from\s+"([^"]+)";/g, (statement, typeOnly, bindings, dependency) => {
    if (typeOnly) return statement;
    if (dependency === "../../shared/collection-cache") {
      return statement.replace(`"${dependency}"`, JSON.stringify(new URL("../shared/collection-cache.ts", import.meta.url).href));
    }
    assert.ok(["react-native", "../utils/toast", "../../shared/api/client", "../../shared/storage/sqlite-cache"].includes(dependency), `未分类的运行时依赖：${dependency}`);
    for (const name of bindings.replace(/[{}]/g, "").split(",").map((part) => part.trim()).filter(Boolean)) {
      if (!name.startsWith("type ")) stubNames.add(name);
    }
    return statement.replace(`"${dependency}"`, '"./stubs.mjs"');
  });
  const exports = [...stubNames].map((name) => name === "AppState" ? `export const AppState = { get currentState() { return dispatch("AppState", []).currentState; }, addEventListener(...args) { return dispatch("AppState", []).addEventListener(...args); } };` : `export const ${name} = (...args) => dispatch(${JSON.stringify(name)}, args);`).join("\n");
  await Promise.all([
    writeFile(join(tempDir, "package.json"), '{"type":"module"}\n'),
    writeFile(join(tempDir, "collection-tasks.ts"), source),
    writeFile(join(tempDir, "stubs.mjs"), `let dispatch;\nexport function connect(value) { dispatch = value; }\n${exports}\n`),
  ]);
  const stubs = await import(pathToFileURL(join(tempDir, "stubs.mjs")).href);
  stubs.connect((name, args) => {
    assert.ok(active, `用例外的依赖调用：${name}`);
    if (name === "AppState") return active.appState;
    assert.notEqual(name, "showToast", "成功测试不应出现失败 toast");
    if (Object.hasOwn(active.sqlite, name)) return active.sqlite[name](...args);
    assert.ok(["getEpisodes", "getUserCollection", "patchSubjectEpisodes", "postUserCollection"].includes(name), `未支持的 stub：${name}`);
    return active.api(name, args);
  });
  // 原生 worker 使用全局 timer；只登记不执行，避免真实等待和句柄泄漏。
  setGlobal("setTimeout", (...args) => active.browser.setTimeout(...args));
  setGlobal("clearTimeout", (...args) => active.browser.clearTimeout(...args));

  await test("ignore：清除 QueryData 里的进度投影并离线恢复 SQLite 确认值", async (h, worker) => {
    const task = await worker.enqueueCompleteProgressTask({ ...BASE, targetEp: 2, totalEp: 2, ensureWatching: true, markWatched: false });
    await h.projectPending(worker);
    assert.equal(h.client.getQueryData(["collections", 3, USER]).data[0].ep_status, 2);
    let notifications = 0;
    const unsubscribe = worker.subscribeCollectionTaskQueue(() => { notifications += 1; });
    await worker.ignoreCollectionTask(task.id);
    unsubscribe();
    assert.equal(notifications, 1, "忽略完成必须通知队列订阅者");
    assert.equal(h.client.getQueryData(["collections", 3, USER]).data[0].ep_status, 1, "不能留下已忽略的进度投影");
    assert.equal(h.client.getQueryData(["collection", USER, SUBJECT]).ep_status, 1);
    assert.equal(h.client.getQueryState(["collection", USER, SUBJECT]).isInvalidated, true);
    assert.equal(h.client.getQueryState(["collections", 3, USER]).isInvalidated, true);
    h.checkInfrastructure();
  });

  await test("ignore：恢复被移出列表的条目，保留剩余进度任务且不影响其他账号", async (h, worker) => {
    const progress = await worker.enqueueCompleteProgressTask({ ...BASE, targetEp: 2, totalEp: 2, ensureWatching: true, markWatched: false });
    const moved = await worker.enqueueSetCollectionTypeTask({ ...BASE, nextType: 5 });
    await h.projectPending(worker);
    assert.equal(h.client.getQueryData(["collections", 3, USER]).data.length, 0);
    h.client.setQueryData(["collections", 3, "another-user"], page([collection(3, 0)]));
    h.client.setQueryData(["collection", "another-user", SUBJECT], collection(3, 0));
    h.client.setQueryData(["collection", USER, 99], { ...collection(), subject_id: 99 });
    await worker.ignoreCollectionTask(moved.id);
    const restored = h.client.getQueryData(["collections", 3, USER]).data[0];
    assert.equal(restored?.subject_id, SUBJECT, "从 SQLite 基础值补回被投影移除的条目");
    assert.equal(restored.ep_status, 2, "剩余同用户任务仍需叠加");
    assert.equal(h.client.getQueryData(["collections", 5, USER]).data.length, 0);
    assert.equal(h.client.getQueryData(["collection", USER, SUBJECT]).type, 3);
    for (const key of [["collections", 3, "another-user"], ["collection", "another-user", SUBJECT], ["collection", USER, 99]]) {
      assert.equal(h.client.getQueryState(key).isInvalidated, false, "只能定向失效当前账号/条目");
    }
    assert.equal(h.persistedCollection().ep_status, 1, "忽略不应将剩余投影写入 SQLite");
    await worker.ignoreCollectionTask(progress.id);
    assert.equal(h.client.getQueryData(["collections", 3, USER]).data[0].ep_status, 1);
    h.checkInfrastructure();
  });

  await test("ignore：没有磁盘基础值也必须定向失效并通知队列", async (h, worker) => {
    const task = await worker.enqueueSetCollectionTypeTask({ ...BASE, nextType: 5 });
    await h.projectPending(worker);
    h.clearBase();
    let notifications = 0;
    const unsubscribe = worker.subscribeCollectionTaskQueue(() => { notifications += 1; });
    await worker.ignoreCollectionTask(task.id);
    unsubscribe();
    assert.equal(notifications, 1);
    assert.equal(h.client.getQueryState(["collection", USER, SUBJECT]).isInvalidated, true);
    for (const type of TYPES) assert.equal(h.client.getQueryState(["collections", type, USER]).isInvalidated, true);
    h.checkInfrastructure();
  });

  await test("markWatched：乐观 type=2 不得被 worker 的 type=3 中间结果覆盖", async (h, worker) => {
    h.expect("getUserCollection", [USER, SUBJECT], collection(3, 1));
    h.expect("getEpisodes", [SUBJECT], page([{ id: 101, type: 0, sort: 1 }, { id: 102, type: 0, sort: 2 }]));
    h.expect("patchSubjectEpisodes", [SUBJECT, { episode_id: [102], type: 2 }], undefined);
    h.expect("getUserCollection", [USER, SUBJECT], collection(3, 2));
    h.expect("postUserCollection", [SUBJECT, { type: 2 }], undefined);
    h.expect("getUserCollection", [USER, SUBJECT], collection(2, 2));
    h.stage("enqueue complete-progress，目标 type=2 ep_status=2");
    const task = await worker.enqueueCompleteProgressTask({ ...BASE, targetEp: 2, totalEp: 2, ensureWatching: false, markWatched: true });
    assert.equal(task.status, "pending");
    await h.optimistic(worker);
    assert.deepEqual(stateOf(h.client.getQueryData(["collection", USER, SUBJECT])), { type: 2, ep_status: 2, group: "completed" });
    const begin = h.updates.length;
    await h.kick(worker);
    h.checkInfrastructure();
    assert.deepEqual(stateOf(h.client.getQueryData(["collection", USER, SUBJECT])), { type: 2, ep_status: 2, group: "completed" });
    assertNoRegression(h, begin, { type: 2, ep_status: 2, group: "completed" });
  });

  await test("ensureWatching：旧进度不得把 completed 拉回 finished_started", async (h, worker) => {
    h.expect("getUserCollection", [USER, SUBJECT], collection(3, 1));
    h.expect("getEpisodes", [SUBJECT], page([{ id: 101, type: 0, sort: 1 }, { id: 102, type: 0, sort: 2 }]));
    h.expect("patchSubjectEpisodes", [SUBJECT, { episode_id: [102], type: 2 }], undefined);
    h.expect("getUserCollection", [USER, SUBJECT], collection(3, 2));
    h.stage("enqueue complete-progress，目标 type=3 ep_status=2，ensureWatching=true");
    await worker.enqueueCompleteProgressTask({ ...BASE, targetEp: 2, totalEp: 2, ensureWatching: true, markWatched: false });
    await h.optimistic(worker);
    const target = { type: 3, ep_status: 2, group: "completed" };
    assert.deepEqual(stateOf(h.client.getQueryData(["collection", USER, SUBJECT])), target);
    const begin = h.updates.length;
    await h.kick(worker);
    h.checkInfrastructure();
    assert.deepEqual(stateOf(h.client.getQueryData(["collection", USER, SUBJECT])), target);
    assertNoRegression(h, begin, target);
  });

  await test("运行旧任务时新任务入队：迟到 type=2 响应不得覆盖新目标 type=5", async (h, worker) => {
    const oldResponse = h.gate("旧任务最终 GET");
    const nextRead = h.gate("新任务首个 GET");
    h.expect("getUserCollection", [USER, SUBJECT], collection(3, 1));
    h.expect("postUserCollection", [SUBJECT, { type: 2 }], undefined);
    h.expect("getUserCollection", [USER, SUBJECT], collection(2, 1), oldResponse);
    h.expect("getUserCollection", [USER, SUBJECT], collection(2, 1), nextRead);
    h.expect("postUserCollection", [SUBJECT, { type: 5 }], undefined);
    h.expect("getUserCollection", [USER, SUBJECT], collection(5, 1));
    h.stage("enqueue 旧目标 type=2");
    const oldTask = await worker.enqueueSetCollectionTypeTask({ ...BASE, nextType: 2 });
    await h.optimistic(worker);
    const running = h.kick(worker);
    await until(() => oldResponse.entered, "旧任务已 running 且 GET 响应未交付");
    assert.equal((await worker.getCollectionTaskQueue()).find((task) => task.id === oldTask.id)?.status, "running");
    h.stage("旧响应被屏障阻塞时 enqueue 新目标 type=5");
    const newTask = await worker.enqueueSetCollectionTypeTask({ ...BASE, previousType: 2, nextType: 5 });
    assert.notEqual(newTask.id, oldTask.id, "running 任务的新目标必须独立入队");
    assert.equal(newTask.status, "pending");
    assert.equal((await worker.getCollectionTaskQueue()).length, 2);
    await h.optimistic(worker);
    const target = { type: 5, ep_status: 1, group: "finished_started" };
    assert.deepEqual(stateOf(h.client.getQueryData(["collection", USER, SUBJECT])), target);
    const begin = h.updates.length;
    h.stage("释放旧任务 type=2 响应；新任务仍 pending");
    oldResponse.release.resolve();
    await until(() => nextRead.entered, "新任务开始但尚未修改服务端");
    assert.equal(h.persistedCollection().type, 2, "SQLite 只保存旧任务已确认的基础值，不保存 pending type=5");
    nextRead.release.resolve();
    await running;
    h.checkInfrastructure();
    assert.equal(h.taskEvents.filter((event) => event.status === "finished").length, 2);
    assert.deepEqual(stateOf(h.client.getQueryData(["collection", USER, SUBJECT])), target);
    assertNoRegression(h, begin, target);
  });

  await test("连续进度任务：旧任务确认不得覆盖更新的目标集数", async (h, worker) => {
    const oldResponse = h.gate("旧进度任务最终 GET");
    h.expect("getUserCollection", [USER, SUBJECT], collection(3, 1));
    h.expect("getEpisodes", [SUBJECT], page([{ id: 101, type: 0, sort: 1 }, { id: 102, type: 0, sort: 2 }]));
    h.expect("patchSubjectEpisodes", [SUBJECT, { episode_id: [102], type: 2 }], undefined);
    h.expect("getUserCollection", [USER, SUBJECT], collection(3, 2), oldResponse);
    h.expect("getUserCollection", [USER, SUBJECT], collection(3, 2));
    h.expect("getEpisodes", [SUBJECT], page([{ id: 101, type: 0, sort: 1 }, { id: 102, type: 0, sort: 2 }]));
    h.expect("patchSubjectEpisodes", [SUBJECT, { episode_id: [101, 102], type: 0 }], undefined);
    h.expect("getUserCollection", [USER, SUBJECT], collection(3, 0));
    const payload = { ...BASE, targetEp: 2, totalEp: 2, ensureWatching: true, markWatched: false };
    const oldTask = await worker.enqueueCompleteProgressTask(payload);
    await h.optimistic(worker);
    const running = h.kick(worker);
    await until(() => oldResponse.entered, "旧进度确认尚未交付");
    const newTask = await worker.enqueueCompleteProgressTask({ ...payload, targetEp: 0 });
    assert.notEqual(newTask.id, oldTask.id);
    await h.optimistic(worker);
    const begin = h.updates.length;
    oldResponse.release.resolve();
    await running;
    h.checkInfrastructure();
    assertNoRegression(h, begin, { type: 3, ep_status: 0, group: "finished_unwatched" });
  });

  await test("SQLite 持久化迟到不得重新发布旧任务的确认值", async (h, worker) => {
    const writeResponse = h.gate("旧任务最终 SQLite 写入");
    h.pauseNextCollectionWrite(writeResponse);
    h.expect("getUserCollection", [USER, SUBJECT], collection(3, 1));
    h.expect("postUserCollection", [SUBJECT, { type: 2 }], undefined);
    h.expect("getUserCollection", [USER, SUBJECT], collection(2, 1));
    h.expect("getUserCollection", [USER, SUBJECT], collection(2, 1));
    h.expect("postUserCollection", [SUBJECT, { type: 5 }], undefined);
    h.expect("getUserCollection", [USER, SUBJECT], collection(5, 1));
    await worker.enqueueSetCollectionTypeTask({ ...BASE, nextType: 2 });
    await h.optimistic(worker);
    const running = h.kick(worker);
    await until(() => writeResponse.entered, "旧任务已提交内存，SQLite 尚未完成");
    await worker.enqueueSetCollectionTypeTask({ ...BASE, previousType: 2, nextType: 5 });
    await h.optimistic(worker);
    const begin = h.updates.length;
    writeResponse.release.resolve();
    await running;
    h.checkInfrastructure();
    const target = { type: 5, ep_status: 1, group: "finished_started" };
    const regressions = h.updates.slice(begin).filter((update) => update.type !== null && update.type !== 5);
    assert.deepEqual(regressions, [], "SQLite 完成不能重新发布旧的可见状态");
    assert.deepEqual(stateOf(h.client.getQueryData(["collection", USER, SUBJECT])), target);
    assert.equal(h.persistedCollection().type, 5);
  });

  await test("待处理任务合并：跨账号隔离、跨类型移除及空列表回填", async (h, worker) => {
    const task = (username, kind, payload, createdAt) => ({
      id: `${username}:${createdAt}`, username, kind, status: "pending", attemptCount: 0,
      createdAt, updatedAt: createdAt, payload: { ...BASE, username, ...payload },
    });
    const tasks = [
      task(USER, "complete-progress", { targetEp: 2, totalEp: 2, ensureWatching: true, markWatched: false }, 1),
      task(USER, "set-collection-type", { nextType: 5 }, 2),
      task("another-user", "set-collection-type", { nextType: 1 }, 3),
    ];
    const merge = (data, collectionType, extra = {}) => worker.mergePendingCollectionTasks({
      data, collectionType, username: USER, tasks, ...extra,
    });
    assert.equal(merge(page([collection()]), 3).data.length, 0, "新目标已转移到 type=5");
    const next = merge(page([]), 5, { currentData: page([collection(3, 1)]), cachedCollections: [collection(3, 0)] });
    assert.equal(next.total, 1);
    assert.equal(next.data[0].type, 5, "其他用户同 subject 的任务不能覆盖当前意图");
    assert.equal(next.data[0].ep_status, 2);
    assert.equal(merge(page([]), 5, { cachedCollections: [collection()] }).data[0].type, 5);
    assert.equal(merge(page([]), 5).total, 0, "缺少条目信息时不能伪造条目");
    const original = page([collection()]);
    assert.equal(worker.mergePendingCollectionTasks({ data: original, collectionType: 3, username: "no-tasks", tasks }), original);
    h.checkInfrastructure();
  });

  await test("已满足目标的进度任务也只能提交一次最终确认值", async (h, worker) => {
    h.expect("getUserCollection", [USER, SUBJECT], collection(3, 1));
    h.stage("enqueue 目标与服务端一致的进度任务");
    await worker.enqueueCompleteProgressTask({ ...BASE, targetEp: 1, totalEp: 2, ensureWatching: true, markWatched: false });
    await h.optimistic(worker);
    const begin = h.updates.length;
    await h.kick(worker);
    h.checkInfrastructure();
    assertNoRegression(h, begin, { type: 3, ep_status: 1, group: "finished_started" });
  });

  await test("对照：单个收藏类型任务在服务端确认同一目标时不发生回退", async (h, worker) => {
    h.expect("getUserCollection", [USER, SUBJECT], collection(3, 1));
    h.expect("postUserCollection", [SUBJECT, { type: 2 }], undefined);
    h.expect("getUserCollection", [USER, SUBJECT], collection(2, 1));
    h.stage("enqueue 单个目标 type=2");
    await worker.enqueueSetCollectionTypeTask({ ...BASE, nextType: 2 });
    await h.optimistic(worker);
    const target = { type: 2, ep_status: 1, group: "finished_started" };
    assert.deepEqual(stateOf(h.client.getQueryData(["collection", USER, SUBJECT])), target);
    const begin = h.updates.length;
    await h.kick(worker);
    h.checkInfrastructure();
    assertNoRegression(h, begin, target);
  });

  console.log(`\nCollection worker：${passed} 通过，${failed} 失败`);
  if (failed) process.exitCode = 1;
} finally {
  for (const [name, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
}
