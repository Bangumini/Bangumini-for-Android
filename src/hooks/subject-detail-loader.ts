import { notifyManager, type QueryClient } from "@tanstack/react-query";
import { getEpisodes, getSubject, getSubjectCharacters, getSubjectPersons, getSubjectRelations, getUserCollection } from "../../shared/api/client";
import type { Episode, PagedResponse, RelatedCharacter, RelatedPerson, Subject, SubjectRelation, UserCollection } from "../../shared/api/types";
import type { CollectionPatch } from "../../shared/collection-cache";
import {
  deleteCachedCollection, readCachedCharacters, readCachedCharactersWithin, readCachedCollection, readCachedCollectionWithin,
  readCachedEpisodes, readCachedEpisodesWithin, readCachedPersons, readCachedPersonsWithin, readCachedRelations,
  readCachedRelationsWithin, readCachedSubject, readCachedSubjectDeep, readCachedSubjectDeepWithin,
  writeCachedCharacters, writeCachedCollection, writeCachedEpisodes, writeCachedPersons, writeCachedRelations, writeCachedSubject,
} from "../../shared/storage/sqlite-cache";
import { getCollectionTaskQueue, getOptimisticCollectionPatchForSubject, subscribeCollectionTaskQueue } from "../api/collection-tasks";

export const DETAIL_CACHE_MAX_AGE = 1000 * 60 * 60 * 24;
const EPISODE_CACHE_MAX_AGE = 1000 * 60 * 30;
export type SubjectDetailData = {
  subject: Subject | null;
  collection: UserCollection | null;
  episodes: PagedResponse<Episode> | null;
  persons: RelatedPerson[];
  characters: RelatedCharacter[];
  relations: SubjectRelation[];
  artistMap: Record<number, string | null>;
};
export type DetailResource = Exclude<keyof SubjectDetailData, "artistMap">;
type PendingProjection = { patch: CollectionPatch | null; isCurrent: () => boolean };
export type DetailSnapshot = {
  data: SubjectDetailData;
  updatedAt: Record<DetailResource, number>;
  collectionProtected?: boolean;
  collectionBase: UserCollection | null;
  pendingProjection: PendingProjection;
  publicGuard: PublicResourceGuard;
  guard: CollectionGuard;
};
const resources: DetailResource[] = ["subject", "collection", "episodes", "persons", "characters", "relations"];
type PublicResource = Exclude<DetailResource, "collection">;
type PublicLoads = {
  epoch: number;
  owners: Map<string, number>;
  writes: Map<string, Promise<unknown>>;
  subjects: Map<number, Subject>;
  artists: Map<number, SubjectDetailData["artistMap"]>;
};
const publicLoads = new WeakMap<QueryClient, PublicLoads>();

// 公共资源不按账号分桶：旧账号的后台任务不能覆盖新账号已经开始的新一轮。
class PublicResourceGuard {
  private state: PublicLoads;
  private epoch: number;
  constructor(private client: QueryClient | undefined, subjectId: number) {
    let state = client ? publicLoads.get(client) : undefined;
    if (!state) {
      state = { epoch: 0, owners: new Map(), writes: new Map(), subjects: new Map(), artists: new Map() };
      if (client) publicLoads.set(client, state);
    }
    this.state = state;
    this.epoch = ++state.epoch;
    for (const resource of resources) if (resource !== "collection") this.claim(resource, subjectId);
  }
  private key(resource: PublicResource, id: number) { return JSON.stringify([resource, id]); }
  claim(resource: PublicResource, id: number) {
    const key = this.key(resource, id);
    this.state.owners.set(key, Math.max(this.state.owners.get(key) ?? 0, this.epoch));
  }
  current(resource: PublicResource, id: number) { return this.state.owners.get(this.key(resource, id)) === this.epoch; }
  latestSubject(id: number) { return this.state.subjects.get(id) ?? this.client?.getQueryData<Subject>(["subject", id]); }
  rememberSubject(subject: Subject) { if (this.current("subject", subject.id)) this.state.subjects.set(subject.id, subject); }
  artistMap(id: number) { return this.state.artists.get(id); }
  rememberArtists(id: number, map: SubjectDetailData["artistMap"]) { this.state.artists.set(id, map); }
  write<T>(resource: PublicResource, id: number, write: () => Promise<T>): Promise<T | undefined> {
    const key = this.key(resource, id);
    // 已开始的 SQLite 写入不能取消；同资源串行使较新写入必定位于旧写入之后。
    const previous = this.state.writes.get(key) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(() => this.current(resource, id) ? write() : undefined);
    this.state.writes.set(key, task);
    const remove = () => { if (this.state.writes.get(key) === task) this.state.writes.delete(key); };
    void task.then(remove, remove);
    return task;
  }
}
const publishing = new WeakMap<QueryClient, number>();
export const isDetailPublication = (client: QueryClient) => Boolean(publishing.get(client));
export const detailResourceKey = (resource: DetailResource, subjectId: number, username: string | null) =>
  resource === "collection" ? [resource, username, subjectId] : [resource, subjectId];
export function sameDetailData(left: unknown, right: unknown) { return JSON.stringify(left) === JSON.stringify(right); }
export function emptySubjectDetailData(): SubjectDetailData {
  return { subject: null, collection: null, episodes: null, persons: [], characters: [], relations: [], artistMap: {} };
}

const defaultDeps = {
  readSubjectWithin: readCachedSubjectDeepWithin, readSubject: readCachedSubjectDeep, readSubjectPreview: readCachedSubject,
  readCollectionWithin: readCachedCollectionWithin, readCollection: readCachedCollection,
  readEpisodesWithin: readCachedEpisodesWithin, readEpisodes: readCachedEpisodes,
  readPersonsWithin: readCachedPersonsWithin, readPersons: readCachedPersons,
  readCharactersWithin: readCachedCharactersWithin, readCharacters: readCachedCharacters,
  readRelationsWithin: readCachedRelationsWithin, readRelations: readCachedRelations,
  getSubject, getCollection: getUserCollection, getEpisodes, getPersons: getSubjectPersons,
  getCharacters: getSubjectCharacters, getRelations: getSubjectRelations,
  writeSubject: writeCachedSubject, writeCollection: writeCachedCollection, deleteCollection: deleteCachedCollection,
  writeEpisodes: writeCachedEpisodes, writePersons: writeCachedPersons, writeCharacters: writeCachedCharacters, writeRelations: writeCachedRelations,
  readPendingPatch: async (subjectId: number, username: string): Promise<CollectionPatch | null> =>
    getOptimisticCollectionPatchForSubject(subjectId, (await getCollectionTaskQueue()).filter(task => task.payload.username === username)),
  subscribePending: subscribeCollectionTaskQueue,
};
export type SubjectDetailLoaderDeps = typeof defaultDeps;

// 记录成功写入的 revision，而不只比较最终值；改动后又改回也不能被旧请求覆盖。
class CollectionGuard {
  private baseline: number;
  private ownWrites = 0;
  private unsubscribe: () => void;
  constructor(private client: QueryClient | undefined, private key: readonly unknown[]) {
    this.baseline = this.revision();
    this.unsubscribe = client?.getQueryCache().subscribe(event => {
      if (event.type === "updated" && event.action.type === "success" && sameDetailData(event.query.queryKey, key) && publishing.get(client)) this.ownWrites++;
    }) ?? (() => {});
  }
  private revision() { return this.client?.getQueryState(this.key)?.dataUpdateCount ?? 0; }
  version() { return this.revision() - this.ownWrites; }
  changed() { return this.version() > this.baseline; }
  live() { return this.client?.getQueryData<UserCollection | null>(this.key); }
  dispose() { this.unsubscribe(); }
}

export function createSubjectDetailCollectionGuard(client: QueryClient, subjectId: number, username: string | null) {
  return new CollectionGuard(client, detailResourceKey("collection", subjectId, username));
}
export function projectDetailCollection(base: UserCollection | null, live: UserCollection | null | undefined) {
  if (live === undefined) return base;
  if (live === null || base === null) return live;
  return base.type === live.type && base.ep_status === live.ep_status
    ? base : { ...base, type: live.type, ep_status: live.ep_status };
}
function projectPendingCollection(base: UserCollection | null, guard: CollectionGuard, pending: PendingProjection) {
  let collection = guard.changed() ? projectDetailCollection(base, guard.live()) : base;
  // patch 只能覆盖其读取时已存在的确认值，不能复活读取后已被 worker 完成的旧意图。
  if (pending.isCurrent() && pending.patch) {
    const fallback = collection ?? guard.live();
    if (fallback) collection = { ...fallback, ...pending.patch };
  }
  return collection;
}
async function safeLocal<T>(read: () => Promise<T | null>) {
  try { return await read(); } catch { return null; }
}
function enrichLocalSubject(memory: Subject, disk: Subject | null): Subject {
  if (!disk) return memory;
  return { ...disk, ...memory, summary: memory.summary || disk.summary, infobox: memory.infobox ?? disk.infobox,
    air_weekday: memory.air_weekday ?? disk.air_weekday, date: memory.date || disk.date,
    eps: memory.eps || disk.eps, total_episodes: memory.total_episodes || disk.total_episodes };
}
async function localValue<T>(client: QueryClient | undefined, key: readonly unknown[], fresh: () => Promise<T | null>, stale: () => Promise<T | null>, maxAge: number, enrich?: (memory: T, disk: T | null) => T) {
  const recent = await safeLocal(fresh);
  const disk = recent ?? await safeLocal(stale);
  // 磁盘读取期间 worker 可能已完成，内存必须最后读取。
  const memory = client?.getQueryData<T | null>(key);
  const hasMemory = memory !== undefined && (memory !== null || key[0] === "collection");
  const updatedAt = hasMemory ? client?.getQueryState(key)?.dataUpdatedAt ?? 0 : recent !== null ? Date.now() : 0;
  const value = !hasMemory ? disk : memory != null && enrich ? enrich(memory, disk) : memory ?? null;
  return { value, updatedAt, needsRefresh: (!hasMemory && disk === null) || Date.now() - updatedAt >= maxAge };
}
function extractArtist(subject: Subject | null) {
  const value = (key: string) => subject?.infobox?.find(item => item.key === key)?.value;
  const artist = value("艺术家");
  if (typeof artist === "string") return artist;
  return [...new Set([value("作词"), value("作曲")].filter((item): item is string => typeof item === "string"))].join(" / ") || null;
}

// 唯一的 Query cache 发布接缝：首个本地快照、整个网络阶段结束后的完整快照。
export function publishSubjectDetailSnapshot(client: QueryClient, subjectId: number, username: string | null, snapshot: DetailSnapshot, initial: boolean): SubjectDetailData {
  const collection = projectPendingCollection(snapshot.collectionBase, snapshot.guard, snapshot.pendingProjection);
  let next = collection === snapshot.data.collection ? snapshot.data : { ...snapshot.data, collection };
  const protectedCollection = snapshot.collectionProtected || snapshot.guard.changed() || !snapshot.pendingProjection.isCurrent();
  publishing.set(client, (publishing.get(client) ?? 0) + 1);
  try {
    notifyManager.batch(() => {
      for (const resource of resources) {
        if (resource === "collection" && (!username || protectedCollection)) continue;
        const key = detailResourceKey(resource, subjectId, username);
        const current = client.getQueryData(key);
        if (resource !== "collection" && !snapshot.publicGuard.current(resource, subjectId)) {
          // 老任务仍完成其账号收藏，但公共展示改用较新任务的缓存，不回写旧响应。
          if (current !== undefined) next = { ...next, [resource]: current };
          continue;
        }
        if (initial && current !== undefined && current !== null) {
          if (resource !== "subject" || !current || !next.subject) continue;
          // 卡片可能只有预览字段；初版仍要补回本机已有的完整简介与 infobox。
          next = { ...next, subject: enrichLocalSubject(current as Subject, next.subject) };
        }
        if (!sameDetailData(current, next[resource])) client.setQueryData(key, next[resource], { updatedAt: snapshot.updatedAt[resource] });
        else {
          // 成功的同内容响应只推进 freshness，不产生 success/revision 或新的详情 data。
          const query = client.getQueryCache().find({ queryKey: key, exact: true });
          if (query && snapshot.updatedAt[resource] > query.state.dataUpdatedAt) query.setState({ dataUpdatedAt: snapshot.updatedAt[resource] });
        }
      }
    });
    if (snapshot.publicGuard.current("relations", subjectId)) snapshot.publicGuard.rememberArtists(subjectId, next.artistMap);
    else next = { ...next, artistMap: snapshot.publicGuard.artistMap(subjectId) ?? next.artistMap };
  } finally { publishing.set(client, (publishing.get(client) ?? 1) - 1); }
  return next;
}

export async function loadSubjectDetailData({ subjectId, username = null, queryClient, force = false, collectionGuard, deps: overrides }: {
  subjectId: number; username?: string | null; queryClient?: QueryClient; force?: boolean; collectionGuard?: CollectionGuard; deps?: Partial<SubjectDetailLoaderDeps>;
}): Promise<{ initial: DetailSnapshot; settled: Promise<DetailSnapshot> }> {
  const deps = { ...defaultDeps, ...overrides };
  const publicGuard = new PublicResourceGuard(queryClient, subjectId);
  const guard = collectionGuard ?? new CollectionGuard(queryClient, detailResourceKey("collection", subjectId, username));
  let queueRevision = 0;
  const unsubscribeQueue = deps.subscribePending(() => { queueRevision++; });
  // 在真正读取前盖版本戳，不能在外层 await 之后才记录（其间 worker 也可能完成）。
  const pendingPatch = async (): Promise<PendingProjection> => {
    if (!username) return { patch: null, isCurrent: () => true };
    let revision: number, collectionVersion: number, patch: CollectionPatch | null;
    do {
      revision = queueRevision;
      collectionVersion = guard.version();
      patch = await deps.readPendingPatch(subjectId, username);
    } while (revision !== queueRevision || collectionVersion !== guard.version());
    return { patch, isCurrent: () => revision === queueRevision && collectionVersion === guard.version() };
  };
  const cleanup = () => { guard.dispose(); unsubscribeQueue(); };
  try {
    const [subject, collection, episodes, persons, characters, relations] = await Promise.all([
      localValue(queryClient, ["subject", subjectId], () => deps.readSubjectWithin(subjectId, DETAIL_CACHE_MAX_AGE), () => deps.readSubject(subjectId), DETAIL_CACHE_MAX_AGE, enrichLocalSubject),
      username ? localValue(queryClient, ["collection", username, subjectId], () => deps.readCollectionWithin(username, subjectId, DETAIL_CACHE_MAX_AGE), () => deps.readCollection(username, subjectId), DETAIL_CACHE_MAX_AGE)
        : Promise.resolve({ value: null, updatedAt: Date.now(), needsRefresh: false }),
      localValue(queryClient, ["episodes", subjectId], () => deps.readEpisodesWithin(subjectId, EPISODE_CACHE_MAX_AGE), () => deps.readEpisodes(subjectId), EPISODE_CACHE_MAX_AGE),
      localValue(queryClient, ["persons", subjectId], () => deps.readPersonsWithin(subjectId, DETAIL_CACHE_MAX_AGE), () => deps.readPersons(subjectId), DETAIL_CACHE_MAX_AGE),
      localValue(queryClient, ["characters", subjectId], () => deps.readCharactersWithin(subjectId, DETAIL_CACHE_MAX_AGE), () => deps.readCharacters(subjectId), DETAIL_CACHE_MAX_AGE),
      localValue(queryClient, ["relations", subjectId], () => deps.readRelationsWithin(subjectId, DETAIL_CACHE_MAX_AGE), () => deps.readRelations(subjectId), DETAIL_CACHE_MAX_AGE),
    ]);
    const data: SubjectDetailData = { subject: subject.value, collection: collection.value, episodes: episodes.value,
      persons: persons.value ?? [], characters: characters.value ?? [], relations: relations.value ?? [], artistMap: {} };
    const updatedAt = { subject: subject.updatedAt, collection: collection.updatedAt, episodes: episodes.updatedAt,
      persons: persons.updatedAt, characters: characters.updatedAt, relations: relations.updatedAt };
    const artists = new Map<number, Subject | null>();
    const readArtist = async (id: number) => {
      publicGuard.claim("subject", id);
      if (!artists.has(id)) {
        const disk = await safeLocal(() => deps.readSubject(id));
        const memory = queryClient?.getQueryData<Subject>(["subject", id]);
        artists.set(id, memory ? enrichLocalSubject(memory, disk) : disk);
      }
      return artists.get(id) ?? null;
    };
    await Promise.all(data.relations.filter(item => item.type === 3).map(async item => {
      const cached = await readArtist(item.id);
      if (cached?.infobox) data.artistMap[item.id] = extractArtist(cached);
    }));
    const initialPending = await pendingPatch();
    const initialBase = username ? projectDetailCollection(data.collection, guard.live()) : data.collection;
    data.collection = projectPendingCollection(initialBase, guard, initialPending);
    const initial: DetailSnapshot = { data, updatedAt, guard, publicGuard, collectionBase: initialBase, pendingProjection: initialPending,
      collectionProtected: guard.changed() || Boolean(initialPending.patch) || !initialPending.isCurrent() };
    const memorySubject = queryClient?.getQueryData<Subject | null>(["subject", subjectId]);
    const needs = [force || subject.needsRefresh || !data.subject?.summary?.trim() || (memorySubject !== undefined && !memorySubject?.summary?.trim()), Boolean(username) && (force || collection.needsRefresh || data.collection === null),
      force || episodes.needsRefresh, force || persons.needsRefresh, force || characters.needsRefresh, force || relations.needsRefresh];
    const settled = (async (): Promise<DetailSnapshot> => {
      const load = <T>(index: number, cached: T, fetch: () => Promise<T>) => needs[index] ? Promise.resolve().then(fetch) : Promise.resolve(cached);
      const results = await Promise.allSettled([
        load(0, data.subject, () => deps.getSubject(subjectId)),
        load(1, data.collection, async () => {
          try { return await deps.getCollection(username!, subjectId); }
          catch (error) { if (error instanceof Error && error.message.includes("Bangumi API error 404")) return null; throw error; }
        }),
        load(2, data.episodes, () => deps.getEpisodes(subjectId)), load(3, data.persons, () => deps.getPersons(subjectId)),
        load(4, data.characters, () => deps.getCharacters(subjectId)), load(5, data.relations, () => deps.getRelations(subjectId)),
      ] as const);
      const value = <T>(index: number, fallback: T): T => results[index].status === "fulfilled" ? results[index].value as T : fallback;
      const next: SubjectDetailData = { subject: value(0, data.subject), collection: value(1, data.collection),
        episodes: value(2, data.episodes), persons: value(3, data.persons), characters: value(4, data.characters), relations: value(5, data.relations), artistMap: {} };
      const artistWrites: Subject[] = [];
      await Promise.allSettled(next.relations.filter(item => item.type === 3).map(async item => {
        const cached = await readArtist(item.id);
        // 音乐查询也是同一网络阶段，失败只能回退对应曲目的本地艺术家。
        let full = cached;
        try { if (force || !cached?.infobox) { full = await deps.getSubject(item.id); artistWrites.push(full); } }
        catch { /* 保留单曲缓存，不影响其他资源。 */ }
        if (!publicGuard.current("subject", item.id)) full = publicGuard.latestSubject(item.id) ?? cached;
        next.artistMap[item.id] = full?.infobox ? extractArtist(full) : data.artistMap[item.id] ?? null;
      }));
      const times = { ...updatedAt };
      resources.forEach((resource, index) => { if (needs[index] && results[index].status === "fulfilled") times[resource] = Date.now(); });
      // 保留 subject preview 写入的封面、放送星期和深层详情补全逻辑。
      const writeSubject = (incoming: Subject) => publicGuard.write("subject", incoming.id, async () => {
        const preview = await safeLocal(() => deps.readSubjectPreview(incoming.id));
        if (!publicGuard.current("subject", incoming.id)) return undefined;
        const enriched = incoming.air_weekday == null && preview?.air_weekday != null ? { ...incoming, air_weekday: preview.air_weekday } : incoming;
        const written = await deps.writeSubject(enriched);
        publicGuard.rememberSubject(written);
        return written;
      });
      const writes: Promise<unknown>[] = artistWrites.map(item => writeSubject(item));
      if (needs[0] && results[0].status === "fulfilled" && next.subject) writes.push(writeSubject(next.subject).then(written => { if (written) next.subject = written; }));
      if (needs[2] && results[2].status === "fulfilled" && next.episodes) writes.push(publicGuard.write("episodes", subjectId, () => deps.writeEpisodes(subjectId, next.episodes!)));
      if (needs[3] && results[3].status === "fulfilled") writes.push(publicGuard.write("persons", subjectId, () => deps.writePersons(subjectId, next.persons)));
      if (needs[4] && results[4].status === "fulfilled") writes.push(publicGuard.write("characters", subjectId, () => deps.writeCharacters(subjectId, next.characters)));
      if (needs[5] && results[5].status === "fulfilled") writes.push(publicGuard.write("relations", subjectId, () => deps.writeRelations(subjectId, next.relations)));
      await Promise.allSettled(writes);
      const pending = await pendingPatch();
      const confirmed = next.collection;
      const protectedCollection = guard.changed() || Boolean(pending.patch) || !pending.isCurrent();
      next.collection = projectPendingCollection(confirmed, guard, pending);
      // 此处之后不再等待其他 IO 才开始写收藏，避免检查后 worker 又抢先完成。
      if (username && needs[1] && results[1].status === "fulfilled" && !protectedCollection) {
        await Promise.allSettled([confirmed ? deps.writeCollection(username, confirmed) : deps.deleteCollection(username, subjectId)]);
      }
      // 写盘期间发生的 worker 提交同样优先于旧网络响应。
      next.collection = projectPendingCollection(confirmed, guard, pending);
      return { data: next, updatedAt: times, guard, publicGuard, collectionBase: confirmed, pendingProjection: pending,
        collectionProtected: protectedCollection || guard.changed() || !pending.isCurrent() };
    })().finally(cleanup);
    // 调用者稍后才订阅 settled 也不会产生 unhandled rejection。
    void settled.catch(() => {});
    return { initial, settled };
  } catch (error) { cleanup(); throw error; }
}
