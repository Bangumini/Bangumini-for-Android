// 跨季连续计数回归测试（零依赖，需要 Node ≥ 22.6）
// 运行：node --experimental-strip-types scripts/test-cross-season-count.mjs
import assert from "node:assert/strict";
import { getCrossSeasonEpisodeOffset } from "../shared/cross-season-count.ts";

// 单季条目：ep 与 sort 一致，偏移为 0。
assert.equal(
	getCrossSeasonEpisodeOffset([
		{ id: 1, ep: 1, sort: 1, type: 0 },
		{ id: 2, ep: 2, sort: 2, type: 0 },
	]),
	0,
	"单季条目不应产生偏移",
);

// 第二季：第 1 集 sort = 13、ep = 1，偏移为 12。
assert.equal(
	getCrossSeasonEpisodeOffset([
		{ id: 1, ep: 1, sort: 13, type: 0 },
		{ id: 2, ep: 2, sort: 14, type: 0 },
	]),
	12,
	"第二季应按 ep/sort 差值产生连续计数偏移",
);

// 多条主线集时取 ep 最小的一条；SP（type != 0）与异常值不参与。
assert.equal(
	getCrossSeasonEpisodeOffset([
		{ id: 3, ep: 2, sort: 14, type: 0 },
		{ id: 1, ep: 1, sort: 13, type: 0 },
		{ id: 4, ep: 1, sort: 1, type: 1 },
		{ id: 5, ep: 2, sort: 2, type: 2 },
	]),
	12,
	"应只统计 type=0 的主线集并按最小 ep 计算",
);

// ep/sort 缺失或非法时安全降级。
assert.equal(
	getCrossSeasonEpisodeOffset([
		{ id: 1, ep: Number.NaN, sort: 13, type: 0 },
	]),
	0,
	"非法 ep 不得参与计算",
);
assert.equal(getCrossSeasonEpisodeOffset([]), 0, "空列表偏移为 0");

process.stdout.write("cross season count: 全部通过 ✓\n");
