import type { CollectionType, PagedResponse, UserCollection } from "./api/types";
import type { SortedCollection } from "./sort-collections";

export type CollectionPatch = Partial<Pick<UserCollection, "ep_status" | "type">>;

export function applyCollectionPatch(collection: UserCollection, patch: CollectionPatch): UserCollection {
  return { ...collection, ...patch };
}

export function upsertCollection(
  data: PagedResponse<UserCollection>,
  collection: UserCollection,
): PagedResponse<UserCollection> {
  const index = data.data.findIndex((item) => item.subject_id === collection.subject_id);
  if (index >= 0) {
    const next = [...data.data];
    next[index] = collection;
    return { ...data, data: next };
  }
  return { ...data, total: data.total + 1, data: [collection, ...data.data] };
}

export function removeCollection(
  data: PagedResponse<UserCollection>,
  subjectId: number,
): PagedResponse<UserCollection> {
  const index = data.data.findIndex((item) => item.subject_id === subjectId);
  if (index < 0) return data;
  const next = [...data.data];
  next.splice(index, 1);
  return { ...data, total: Math.max(0, data.total - 1), data: next };
}

export function updateCollectionListForType(
  data: PagedResponse<UserCollection> | undefined,
  collection: UserCollection,
  collectionType: CollectionType,
) {
  if (!data) return data;
  return collection.type === collectionType
    ? upsertCollection(data, collection)
    : removeCollection(data, collection.subject_id);
}

export function mergeCollectionPatchIntoList({
  data,
  subjectId,
  patch,
  collectionType,
  fallbackCollection,
}: {
  data: PagedResponse<UserCollection>;
  subjectId: number;
  patch: CollectionPatch;
  collectionType: CollectionType;
  fallbackCollection?: UserCollection;
}): PagedResponse<UserCollection> {
  const source = data.data.find((item) => item.subject_id === subjectId) ?? fallbackCollection;
  if (!source) return data;
  const merged = applyCollectionPatch(source, patch);
  return merged.type === collectionType
    ? upsertCollection(data, merged)
    : removeCollection(data, subjectId);
}

/** 只保留请求期间改变的收藏目标字段与成员，条目元数据优先使用网络快照。 */
export function mergeConcurrentCollectionChanges({
  data,
  originalData,
  liveData,
  collectionType,
}: {
  data: PagedResponse<UserCollection>;
  originalData: PagedResponse<UserCollection>;
  liveData: PagedResponse<UserCollection>;
  collectionType: CollectionType;
}): PagedResponse<UserCollection> {
  const originalById = new Map(originalData.data.map((item) => [item.subject_id, item]));
  const liveById = new Map(liveData.data.map((item) => [item.subject_id, item]));
  let next = data;
  for (const id of originalById.keys()) {
    if (!liveById.has(id)) next = removeCollection(next, id);
  }
  for (const live of liveData.data) {
    const original = originalById.get(live.subject_id);
    const patch: CollectionPatch = {};
    if (!original || original.type !== live.type) patch.type = live.type;
    if (!original || original.ep_status !== live.ep_status) patch.ep_status = live.ep_status;
    // 未变字段接受服务端新值，不能因另一个字段发生变化而一并冻结。
    if (patch.type === undefined && patch.ep_status === undefined) continue;
    next = mergeCollectionPatchIntoList({
      data: next, subjectId: live.subject_id, patch, collectionType, fallbackCollection: live,
    });
  }
  return next;
}

/** 用户意图变化应立即展示；单纯的播出排期变化仍由页面提交门处理。 */
export function hasCollectionStateChanged(
  previous: readonly SortedCollection[],
  next: readonly SortedCollection[],
) {
  if (previous.length !== next.length) return true;
  const previousBySubjectId = new Map(previous.map((item) => [item.collection.subject_id, item.collection]));
  return next.some(({ collection }) => {
    const old = previousBySubjectId.get(collection.subject_id);
    return !old || old.type !== collection.type || old.ep_status !== collection.ep_status;
  });
}
