// 运行：node --experimental-strip-types scripts/test-collection-cache.mjs（Node >= 22.6）
import assert from "node:assert/strict";
import {
  applyCollectionPatch,
  hasCollectionStateChanged,
  mergeCollectionPatchIntoList,
  mergeConcurrentCollectionChanges,
  removeCollection,
  updateCollectionListForType,
  upsertCollection,
} from "../shared/collection-cache.ts";

function collection(subjectId, type, epStatus) {
  return {
    subject_id: subjectId, type, ep_status: epStatus,
    subject: { id: subjectId, name: `Subject ${subjectId}`, name_cn: `条目 ${subjectId}` },
  };
}
function page(data) {
  return { data, total: data.length, limit: 30, offset: 0 };
}

const watching = collection(7, 3, 2);
const watched = applyCollectionPatch(watching, { type: 2 });
const watchingPage = page([watching]);
const removed = updateCollectionListForType(watchingPage, watched, 3);
assert.equal(removed.data.length, 0);
assert.equal(removed.total, 0);
assert.equal(watchingPage.data[0], watching, "不修改原快照");
assert.equal(watching.type, 3);
const inserted = updateCollectionListForType(page([]), watched, 2);
assert.equal(inserted.data[0].subject_id, 7);
assert.equal(inserted.total, 1);
assert.equal(updateCollectionListForType(undefined, watched, 2), undefined);
assert.equal(upsertCollection(inserted, { ...watched, ep_status: 3 }).total, 1, "更新已有条目不重复计数");
assert.equal(removeCollection(watchingPage, 999), watchingPage, "删除不存在条目保持原快照");

const progressed = mergeCollectionPatchIntoList({
  data: watchingPage, subjectId: 7, patch: { ep_status: 3 }, collectionType: 3,
});
assert.equal(progressed.data[0].ep_status, 3);
assert.equal(progressed.data[0].type, 3);
const projected = mergeCollectionPatchIntoList({
  data: page([]), subjectId: 7, patch: { type: 2, ep_status: 3 },
  collectionType: 2, fallbackCollection: watching,
});
assert.equal(projected.data[0].subject_id, 7);
assert.equal(projected.data[0].type, 2);
assert.equal(projected.data[0].ep_status, 3);
const empty = page([]);
assert.equal(mergeCollectionPatchIntoList({
  data: empty, subjectId: 7, patch: { type: 2 }, collectionType: 2,
}), empty, "缺少完整收藏时不伪造条目");
assert.equal(mergeCollectionPatchIntoList({
  data: watchingPage, subjectId: 7, patch: { type: 2 }, collectionType: 3,
}).total, 0);

const oldSorted = [{ collection: watching, group: "airing_caught", weekday: 5, airedEp: 2 }];
assert.equal(hasCollectionStateChanged(oldSorted, [{
  collection: { ...watching, ep_status: 3 }, group: "airing_not_caught", weekday: 5, airedEp: 4,
}]), true);
assert.equal(hasCollectionStateChanged(oldSorted, [{ ...oldSorted[0], collection: watched }]), true);
assert.equal(hasCollectionStateChanged(oldSorted, []), true);
assert.equal(hasCollectionStateChanged(oldSorted, [{ ...oldSorted[0], collection: collection(8, 3, 2) }]), true);
assert.equal(hasCollectionStateChanged(oldSorted, [{
  collection: watching, group: "airing_not_caught", weekday: 4, airedEp: 3,
}]), false, "仅排期更新仍交由原提交门处理");
assert.equal(hasCollectionStateChanged([], []), false);
// 旧网络响应只能覆盖未发生并发用户变更的字段，条目元数据仍以网络为准。
const originalPage = page([collection(7, 3, 2), collection(8, 3, 0), collection(9, 3, 1)]);
const livePage = page([collection(7, 3, 4), collection(9, 3, 1), collection(11, 3, 2)]);
const serverSeven = {
  ...collection(7, 3, 0), rate: 9, tags: ["server"],
  subject: { id: 7, name: "New title", name_cn: "新标题", date: "2026-10-01", eps: 24 },
};
const serverPage = page([serverSeven, collection(8, 3, 0), collection(9, 3, 5), collection(10, 3, 1)]);
const originalSnapshot = structuredClone(originalPage);
const liveSnapshot = structuredClone(livePage);
const serverSnapshot = structuredClone(serverPage);
const concurrent = mergeConcurrentCollectionChanges({
  data: serverPage, originalData: originalPage, liveData: livePage, collectionType: 3,
});
assert.deepEqual(concurrent.data.map((item) => item.subject_id), [11, 7, 9, 10], "保留本地插入/移出，同时接受服务端新增成员");
assert.equal(concurrent.total, 4);
assert.equal(concurrent.data.find((item) => item.subject_id === 7).ep_status, 4, "旧响应不覆盖新进度");
assert.deepEqual(concurrent.data.find((item) => item.subject_id === 7).subject, serverSeven.subject, "进度保护不丢新条目元数据");
assert.equal(concurrent.data.find((item) => item.subject_id === 7).rate, 9);
assert.deepEqual(concurrent.data.find((item) => item.subject_id === 7).tags, ["server"]);
assert.equal(concurrent.data.find((item) => item.subject_id === 9).ep_status, 5, "本地进度未变时应接受服务端新值");
assert.deepEqual(originalPage, originalSnapshot);
assert.deepEqual(livePage, liveSnapshot);
assert.deepEqual(serverPage, serverSnapshot, "三个输入快照均不可变");
assert.equal(mergeConcurrentCollectionChanges({
  data: serverPage, originalData: originalPage, liveData: structuredClone(originalPage), collectionType: 3,
}), serverPage, "没有本地意图变化时直接接受整个服务端快照");

const removedByServer = page([]);
assert.equal(mergeConcurrentCollectionChanges({
  data: removedByServer, originalData: watchingPage, liveData: watchingPage, collectionType: 3,
}), removedByServer, "本地未变的成员被服务器删除时不能复活");

const insertedWithMetadata = mergeConcurrentCollectionChanges({
  data: page([serverSeven]), originalData: page([]), liveData: page([collection(7, 3, 6)]), collectionType: 3,
});
assert.equal(insertedWithMetadata.total, 1, "服务端已有并发插入项时不能重复计数");
assert.equal(insertedWithMetadata.data[0].ep_status, 6);
assert.deepEqual(insertedWithMetadata.data[0].subject, serverSeven.subject, "插入项优先使用网络元数据而不是 fallback");
assert.equal(mergeConcurrentCollectionChanges({
  data: watchingPage, originalData: watchingPage, liveData: page([watched]), collectionType: 3,
}).total, 0, "请求期间改为其他收藏类型应移出当前列表");

const typeChangedOnly = mergeConcurrentCollectionChanges({
  data: page([{ ...serverSeven, ep_status: 8 }]), originalData: watchingPage,
  liveData: page([watched]), collectionType: 2,
});
assert.equal(typeChangedOnly.data[0].type, 2, "保留请求期间的新收藏类型");
assert.equal(typeChangedOnly.data[0].ep_status, 8, "只改类型不能冻结未变的进度字段");
assert.deepEqual(typeChangedOnly.data[0].subject, serverSeven.subject);
const progressChangedOnly = mergeConcurrentCollectionChanges({
  data: page([{ ...serverSeven, type: 2 }]), originalData: watchingPage,
  liveData: page([{ ...watching, ep_status: 4 }]), collectionType: 3,
});
assert.equal(progressChangedOnly.total, 0, "只改进度不能回滚服务端已变化的收藏类型");
console.log("collection cache: 全部通过 ✓");
