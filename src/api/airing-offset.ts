import AsyncStorage from "@react-native-async-storage/async-storage";
import { randomUUID } from "expo-crypto";

import { isValidAiringOffsetDays, type AiringOffsets } from "../../shared/airing-offset";
import type { OffsetSyncRecord, OffsetSyncRecords } from "../../shared/airing-offset-sync";

/** 仅作旧数据备份，任何路径都不再写入或删除此 key。 */
export const AIRING_OFFSETS_STORAGE_KEY = "bangumini_airing_offsets";
export const AIRING_OFFSET_ACCOUNTS_STORAGE_KEY = "bangumini_airing_offset_accounts_v1";

export type AiringOffsetAccountState = {
  syncEnabled: boolean;
  records: OffsetSyncRecords;
  bases: Readonly<Record<string, OffsetSyncRecords>>;
  syncedAt: Readonly<Record<string, number>>;
};
type Database = {
  version: 1;
  legacyOwner: string | null;
  accounts: Readonly<Record<string, AiringOffsetAccountState>>;
};
const EMPTY_OFFSETS: AiringOffsets = Object.freeze({});
const EMPTY_STATE: AiringOffsetAccountState = Object.freeze({
  syncEnabled: false, records: Object.freeze({}), bases: Object.freeze({}), syncedAt: Object.freeze({}),
});
let snapshot = EMPTY_OFFSETS;
let account: string | null = null;
let scopeVersion = 0;
let database: Database | undefined;
let initialization: Promise<void> | undefined;
let ioQueue: Promise<unknown> = Promise.resolve();
const listeners = new Set<() => void>();
const stateListeners = new Set<() => void>();

function isValidSubjectId(subjectId: number) {
  return Number.isSafeInteger(subjectId) && subjectId > 0;
}
function scopeKey(value: string | null): string {
  return value === null ? "guest" : `account:${value}`;
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function copyRecords(value: unknown): OffsetSyncRecords {
  if (!object(value)) throw new Error("偏置 records 格式无效");
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, record]) => {
    if (String(Number(key)) !== key || !isValidSubjectId(Number(key)) || !object(record)
      || !isValidAiringOffsetDays(record.days) || typeof record.revision !== "string"
      || record.revision.length === 0 || record.revision.length > 128
      || !Number.isSafeInteger(record.updatedAt) || (record.updatedAt as number) < 0) {
      throw new Error("偏置 record 格式无效");
    }
    return [key, Object.freeze({ days: record.days, revision: record.revision, updatedAt: record.updatedAt }) as OffsetSyncRecord];
  })));
}
/** 防止调用方在保存后修改传入对象，或通过快照间接修改内存数据库。 */
function copyState(value: unknown): AiringOffsetAccountState {
  if (!object(value) || !object(value.bases) || !object(value.syncedAt)) throw new Error("偏置账号状态无效");
  const syncEnabled = "syncEnabled" in value ? value.syncEnabled : false;
  if (typeof syncEnabled !== "boolean") throw new Error("偏置同步开关格式无效");
  const bases = Object.freeze(Object.fromEntries(Object.entries(value.bases).map(([key, records]) => [key, copyRecords(records)])));
  const syncedAt = Object.freeze(Object.fromEntries(Object.entries(value.syncedAt).map(([key, time]) => {
    if (!Number.isSafeInteger(time) || (time as number) < 0) throw new Error("偏置同步时间无效");
    return [key, time as number];
  })));
  return Object.freeze({ syncEnabled, records: copyRecords(value.records), bases, syncedAt });
}
function stateFor(value: string | null): AiringOffsetAccountState {
  return database?.accounts[scopeKey(value)] ?? EMPTY_STATE;
}
function publish(next: OffsetSyncRecords) {
  const flat = Object.fromEntries(Object.entries(next).filter(([, record]) => record.days !== 0).map(([key, record]) => [key, record.days]));
  const keys = Object.keys(flat);
  if (keys.length === Object.keys(snapshot).length && keys.every(key => flat[key] === snapshot[Number(key)])) return;
  snapshot = Object.freeze(flat);
  for (const listener of listeners) listener();
}
function notifyState() {
  for (const listener of stateListeners) listener();
}
function enqueue<T>(run: () => Promise<T>): Promise<T> {
  const operation = ioQueue.then(run);
  ioQueue = operation.catch(() => {});
  return operation;
}
function restore(): Promise<void> {
  if (database) return Promise.resolve();
  if (!initialization) {
    initialization = (async () => {
      const raw = await AsyncStorage.getItem(AIRING_OFFSET_ACCOUNTS_STORAGE_KEY);
      if (raw === null) {
        database = { version: 1, legacyOwner: null, accounts: Object.freeze({}) };
        return;
      }
      // canonical 损坏时拒绝保存，不能将未能读取的数据当成空数据库覆盖。
      const parsed: unknown = JSON.parse(raw);
      if (!object(parsed) || parsed.version !== 1 || !object(parsed.accounts)
        || (parsed.legacyOwner !== null && typeof parsed.legacyOwner !== "string")) throw new Error("偏置账号数据库格式无效");
      database = {
        version: 1, legacyOwner: parsed.legacyOwner,
        accounts: Object.freeze(Object.fromEntries(Object.entries(parsed.accounts).map(([key, state]) => [key, copyState(state)]))),
      };
    })().finally(() => { initialization = undefined; });
  }
  return initialization;
}
async function commit(next: Database): Promise<void> {
  await AsyncStorage.setItem(AIRING_OFFSET_ACCOUNTS_STORAGE_KEY, JSON.stringify(next));
  database = next;
}
function parseLegacy(raw: string | null): OffsetSyncRecords {
  let parsed: unknown;
  try { parsed = JSON.parse(raw ?? "null"); } catch { return EMPTY_STATE.records; }
  if (!object(parsed)) return EMPTY_STATE.records;
  return Object.freeze(Object.fromEntries(Object.entries(parsed).filter(([key, value]) =>
    String(Number(key)) === key && isValidSubjectId(Number(key)) && isValidAiringOffsetDays(value) && value !== 0
  ).map(([key, days]) => [key, Object.freeze({ days: days as number, revision: randomUUID(), updatedAt: Date.now() })])));
}

/** 可供首屏 await；失败保留重试机会，hook 预热不产生未处理拒绝。 */
export async function initializeAiringOffsets(): Promise<void> {
  try {
    await restore();
    publish(stateFor(account).records);
  } catch {
    // 保存及显式账号切换仍向调用者报告错误。
  }
}
export function getAiringOffsetsSnapshot(): AiringOffsets { return snapshot; }
export function getAiringOffsetAccount(): string | null { return account; }
export function subscribeAiringOffsets(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function subscribeAiringOffsetState(listener: () => void): () => void {
  stateListeners.add(listener);
  return () => { stateListeners.delete(listener); };
}
export function setAiringOffsetAccount(nextAccount: string | null): Promise<void> {
  const version = ++scopeVersion;
  return enqueue(async () => {
    await restore();
    if (nextAccount !== null && database!.legacyOwner === null) {
      const records = parseLegacy(await AsyncStorage.getItem(AIRING_OFFSETS_STORAGE_KEY));
      const current = stateFor(nextAccount);
      // guest 是旧备份之后的本地编辑，零值 tombstone 也必须覆盖旧值；目标账号已有记录优先。
      const migrated = copyState({ ...current, records: { ...records, ...stateFor(null).records, ...current.records } });
      // owner、账号 records 和 guest 清空同一写入提交，失败不出现半迁移。
      await commit({ version: 1, legacyOwner: nextAccount, accounts: Object.freeze({
        ...database!.accounts, guest: EMPTY_STATE, [scopeKey(nextAccount)]: migrated,
      }) });
    }
    // A→B→C 连续切换时，旧请求只能完成自己的 IO，不能重新发布旧 scope。
    if (version !== scopeVersion) return;
    account = nextAccount;
    publish(stateFor(account).records);
    notifyState();
  });
}
export function readAiringOffsetAccountState(value: string | null): Promise<AiringOffsetAccountState> {
  return enqueue(async () => { await restore(); return stateFor(value); });
}
export function updateAiringOffsetAccountState(
  value: string | null,
  update: (current: AiringOffsetAccountState) => AiringOffsetAccountState,
): Promise<AiringOffsetAccountState> {
  return enqueue(async () => {
    await restore();
    const current = stateFor(value);
    const next = copyState(update(current));
    if (JSON.stringify(next) === JSON.stringify(current)) return current;
    await commit({ ...database!, accounts: Object.freeze({ ...database!.accounts, [scopeKey(value)]: next }) });
    if (account === value) publish(next.records);
    notifyState();
    return next;
  });
}
export async function setAiringOffsetDays(subjectId: number, days: number): Promise<void> {
  if (!isValidSubjectId(subjectId) || !isValidAiringOffsetDays(days)) {
    throw new RangeError("放送偏置必须为 -365 至 365 的整数天，且条目 ID 必须有效");
  }
  // 在调用时捕获账号，不能在排队等待结束后把旧页面的保存写给新账号。
  const owner = account;
  await updateAiringOffsetAccountState(owner, current => {
    if (days !== 0 && current.records[subjectId]?.days === days) return current;
    return { ...current, records: { ...current.records,
      [subjectId]: { days, revision: randomUUID(), updatedAt: Date.now() },
    } };
  });
}
