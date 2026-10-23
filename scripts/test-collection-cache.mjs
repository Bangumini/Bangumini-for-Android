// 运行：node --experimental-strip-types scripts/test-collection-cache.mjs（Node >= 22.6）
import assert from "node:assert/strict";
import {
  applyCollectionPatch,
  hasCollectionStateChanged,
  mergeCollectionPatchIntoList,
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
console.log("collection cache: 全部通过 ✓");
