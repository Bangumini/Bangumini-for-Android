// 在看页“未追上进度”兴趣权重排序回归测试（零依赖，需要 Node ≥ 22.6）
import assert from "node:assert/strict";
import {
	getInterestWeight,
	sortCollections,
} from "../shared/sort-collections.ts";

function makeCollection(id, name, totalEpisodes, watchedEpisodes) {
	return {
		subject_id: id,
		ep_status: watchedEpisodes,
		subject: {
			id,
			name,
			name_cn: name,
			date: "2026-01-01",
			eps: totalEpisodes,
			total_episodes: totalEpisodes,
		},
	};
}

const highInterest = makeCollection(1, "高兴趣", 12, 9);
const equalWeightLater = makeCollection(2, "同权重晚更新", 12, 6);
const equalWeightEarlier = makeCollection(3, "同权重早更新", 12, 6);
const lowInterest = makeCollection(4, "低兴趣", 2, 1);
const unknownTotal = makeCollection(5, "总集数未知", 0, 1);
const allCollections = [
	lowInterest,
	unknownTotal,
	equalWeightLater,
	highInterest,
	equalWeightEarlier,
];
const calendar = [
	{
		weekday: { id: 5 },
		items: allCollections.map(({ subject }) => subject),
	},
];
const nowMs = Date.UTC(2026, 7, 20, 0, 0);
const nextAiringAtMap = new Map([
	[1, Date.UTC(2026, 7, 27, 0, 0)],
	[2, Date.UTC(2026, 7, 21, 2, 0)],
	[3, Date.UTC(2026, 7, 21, 1, 0)],
	[4, Date.UTC(2026, 7, 20, 1, 0)],
	[5, Date.UTC(2026, 7, 20, 0, 30)],
]);
const sorted = sortCollections(allCollections, calendar, {
	nowMs,
	airedEpMap: new Map([
		[1, 10],
		[2, 7],
		[3, 7],
		[4, 2],
		[5, 2],
	]),
	nextAiringAtMap,
});

assert.deepEqual(
	sorted.map(({ collection }) => collection.subject_id),
	[1, 3, 2, 4, 5],
	"已知总集数条目应先按兴趣权重降序；同权重回退更新时间；未知总集数统一靠后",
);
assert.ok(
	getInterestWeight(highInterest) > getInterestWeight(lowInterest),
	"较高完成度与观看深度应得到较高兴趣权重",
);
assert.equal(
	getInterestWeight(unknownTotal),
	null,
	"总集数未知时不得伪造兴趣权重",
);

process.stdout.write("collection interest sort: 全部通过 ✓\n");
