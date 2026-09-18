// 在看页分钟级排期回归测试（零依赖，需要 Node ≥ 22.6）
// 运行：node --experimental-strip-types scripts/test-airing-schedule.mjs
import assert from "node:assert/strict";
import {
	deriveAiredEpisodeCount,
	deriveAiringSchedule,
	getEffectiveAiringAt,
	getLatestEpisodeAiringAt,
	getNextEpisodeAiringAt,
	getNextRecentAiringExpiry,
	getNextScheduleBoundary,
	isRecentlyAired,
	getNextTokyoDayBoundary,
} from "../shared/airing-schedule.ts";
import {
	getDisplayLabel,
	sortCollections,
} from "../shared/sort-collections.ts";

function jstTimestamp(date, hour, minute) {
	const [year, month, day] = date.split("-").map(Number);
	return Date.UTC(year, month - 1, day, hour - 9, minute);
}

function observation(date, hour, minute, episode) {
	return {
		airingAt: jstTimestamp(date, hour, minute) / 1000,
		episode,
		fetchedAt: jstTimestamp(date, hour, minute) - 60_000,
	};
}

const normalEpisodes = [
	{ ep: 6, airdate: "2026-08-14" },
	{ ep: 7, airdate: "2026-08-21" },
	{ ep: 8, airdate: "2026-08-28" },
];
const normalSchedule = deriveAiringSchedule(
	5,
	normalEpisodes,
	observation("2026-08-21", 22, 30, 7),
);
assert.equal(normalSchedule.dayOffset, 0);
assert.equal(normalSchedule.minuteOfDayJst, 22 * 60 + 30);
assert.equal(normalSchedule.confidence, "aligned");
assert.equal(
	deriveAiredEpisodeCount(
		normalEpisodes,
		normalSchedule,
		jstTimestamp("2026-08-21", 22, 29),
	),
	1,
	"普通条目在首播前不应提前计入",
);
assert.equal(
	deriveAiredEpisodeCount(
		normalEpisodes,
		normalSchedule,
		jstTimestamp("2026-08-21", 22, 30),
	),
	2,
	"普通条目到达首播时刻应立即计入",
);

const lateNightEpisodes = [
	{ ep: 7, airdate: "2026-08-14" },
	{ ep: 8, airdate: "2026-08-21" },
	{ ep: 9, airdate: "2026-08-28" },
];
const lateNightSchedule = deriveAiringSchedule(
	5,
	lateNightEpisodes,
	observation("2026-08-22", 1, 30, 8),
);
assert.equal(lateNightSchedule.dayOffset, 1);
assert.equal(lateNightSchedule.confidence, "aligned");
const lateNightWithoutCalendar = deriveAiringSchedule(
	undefined,
	lateNightEpisodes,
	observation("2026-08-22", 1, 30, 8),
);
assert.equal(
	lateNightWithoutCalendar.dayOffset,
	1,
	"Calendar 缺口时应从匹配 BGM episode 的 airdate 推导深夜跨日",
);
assert.equal(lateNightWithoutCalendar.confidence, "aligned");

// ca8114d：episode airdate 证据优先于星期启发式；weekday 不一致时只影响 confidence。
const episodeLedRollover = deriveAiringSchedule(
	2,
	[{ ep: 5, airdate: "2026-08-21" }],
	observation("2026-08-22", 1, 30, 5),
);
assert.equal(
	episodeLedRollover.dayOffset,
	1,
	"episode airdate 应独立于星期启发式确定深夜跨日",
);
assert.equal(episodeLedRollover.confidence, "track_conflict");
assert.equal(
	getEffectiveAiringAt({ ep: 5, airdate: "2026-08-21" }, episodeLedRollover),
	jstTimestamp("2026-08-22", 1, 30),
	"按 episode airdate 推导跨日后，绝对首播时间不得提前一天",
);

// ca8114d：episode 列表缺少跨日名义日期时，仍可用星期启发式识别跨日。
const incompleteLateNight = deriveAiringSchedule(
	5,
	[{ ep: 9, airdate: "2026-08-14" }],
	observation("2026-08-22", 1, 30, 9),
);
assert.equal(
	incompleteLateNight.dayOffset,
	1,
	"episode 列表不完整时不得把周五 25:30 退化成当日 00:00",
);
assert.equal(incompleteLateNight.confidence, "track_conflict");

// ca8114d：BGM 日历缺失但 episode airdate 同日对齐时应判 aligned。
const noCalendarSameDay = deriveAiringSchedule(
	undefined,
	[{ ep: 5, airdate: "2026-08-20" }],
	observation("2026-08-20", 22, 0, 5),
);
assert.equal(noCalendarSameDay.dayOffset, 0);
assert.equal(
	noCalendarSameDay.confidence,
	"aligned",
	"BGM 日历缺失但 episode airdate 对齐时应判 aligned",
);
assert.equal(
	getEffectiveAiringAt(lateNightEpisodes[1], lateNightSchedule),
	jstTimestamp("2026-08-22", 1, 30),
	"周五 25:30 应转换为周六 01:30 JST",
);
assert.equal(
	deriveAiredEpisodeCount(
		lateNightEpisodes,
		lateNightSchedule,
		jstTimestamp("2026-08-22", 1, 29),
	),
	1,
	"深夜档在实际播出前仍应视为已追平",
);
assert.equal(
	deriveAiredEpisodeCount(
		lateNightEpisodes,
		lateNightSchedule,
		jstTimestamp("2026-08-22", 1, 30),
	),
	2,
	"深夜档到达实际播出时刻后应进入未追平状态",
);

const maidEpisodes = [
	{ ep: 8, airdate: "2026-08-19" },
	{ ep: 9, airdate: "2026-08-26" },
];
const maidSchedule = deriveAiringSchedule(
	3,
	maidEpisodes,
	observation("2026-08-26", 22, 30, 10),
);
assert.equal(
	maidSchedule.confidence,
	"track_conflict",
	"AniList 先行配信集号不得覆盖 BGM 集号",
);
assert.equal(maidSchedule.dayOffset, 0);
assert.equal(
	deriveAiredEpisodeCount(
		maidEpisodes,
		maidSchedule,
		jstTimestamp("2026-08-26", 22, 29),
	),
	1,
);
assert.equal(
	deriveAiredEpisodeCount(
		maidEpisodes,
		maidSchedule,
		jstTimestamp("2026-08-26", 22, 30),
	),
	2,
);

const streamingConflict = deriveAiringSchedule(
	4,
	[{ ep: 9, airdate: "2026-08-27" }],
	observation("2026-08-24", 22, 0, 9),
);
assert.equal(streamingConflict.confidence, "track_conflict");
assert.equal(streamingConflict.dayOffset, 0);
assert.equal(
	getEffectiveAiringAt({ ep: 9, airdate: "2026-08-27" }, streamingConflict),
	jstTimestamp("2026-08-27", 22, 0),
	"发行轨冲突时保留 BGM 日期，只提取 AniList 时分",
);

assert.equal(
	deriveAiredEpisodeCount(
		[{ ep: 1, airdate: "2026-08-23" }],
		null,
		jstTimestamp("2026-08-23", 0, 0),
	),
	1,
	"无 AniList 排期时退回 BGM 日期粒度",
);
const clockNow = jstTimestamp("2026-08-22", 1, 29);
const episodeBoundary = getNextEpisodeAiringAt(
	lateNightEpisodes,
	lateNightSchedule,
	clockNow,
);
assert.equal(
	episodeBoundary,
	jstTimestamp("2026-08-22", 1, 30),
	"调度器应找到最近的绝对播出边界",
);
assert.equal(
	getNextScheduleBoundary([episodeBoundary], clockNow),
	episodeBoundary,
	"剧集边界早于 JST 日界时必须优先唤醒",
);
const lateNightAiringAt = jstTimestamp("2026-08-22", 1, 30);
assert.equal(
	getLatestEpisodeAiringAt(
		lateNightEpisodes,
		lateNightSchedule,
		lateNightAiringAt,
	),
	lateNightAiringAt,
	"调度器应找到最近一次已播出的精确时间",
);
assert.equal(
	isRecentlyAired(
		lateNightAiringAt,
		lateNightAiringAt + 6 * 60 * 60 * 1000 - 1,
	),
	true,
	"更新后的六小时内应显示刚更新标识",
);
assert.equal(
	isRecentlyAired(
		lateNightAiringAt,
		lateNightAiringAt + 6 * 60 * 60 * 1000,
	),
	false,
	"更新满六小时后不应继续显示刚更新标识",
);
assert.equal(
	getLatestEpisodeAiringAt(lateNightEpisodes, null, lateNightAiringAt),
	null,
	"缺少精确排期时不应推测刚更新标识",
);
assert.equal(
	getNextRecentAiringExpiry(
		[lateNightAiringAt, lateNightAiringAt - 60 * 60 * 1000],
		lateNightAiringAt,
	),
	lateNightAiringAt + 5 * 60 * 60 * 1000,
	"应优先安排最早的刚更新标签失效边界",
);
assert.equal(
	getNextScheduleBoundary([], clockNow),
	getNextTokyoDayBoundary(clockNow),
	"无分钟排期时必须在 JST 下一自然日边界唤醒",
);

const subject = {
	id: 627136,
	name: "うしろの正面カムイさん",
	name_cn: "从后面来的神威先生",
	date: "2026-07-03",
	eps: 12,
	total_episodes: 12,
};
const collection = {
	subject_id: subject.id,
	subject,
	ep_status: 1,
};
const calendar = [{ weekday: { id: 5 }, items: [subject] }];
const airingSignalMap = new Map([
	[subject.id, observation("2026-08-22", 1, 30, 8)],
]);
const beforeNow = jstTimestamp("2026-08-22", 1, 29);
const beforeNextAiringMap = new Map([
	[subject.id, jstTimestamp("2026-08-22", 1, 30)],
]);
const beforeSorted = sortCollections([collection], calendar, {
	nowMs: beforeNow,
	airedEpMap: new Map([[subject.id, 1]]),
	airingSignalMap,
	nextAiringAtMap: beforeNextAiringMap,
});
assert.equal(
	beforeSorted[0].group,
	"airing_caught",
	"条目 X 在深夜首播前必须留在已追上进度组",
);
const afterBoundary = jstTimestamp("2026-08-22", 1, 30);
const afterNextAiringMap = new Map([
	[
		subject.id,
		getNextEpisodeAiringAt(lateNightEpisodes, lateNightSchedule, afterBoundary),
	],
]);
const afterSorted = sortCollections([collection], calendar, {
	nowMs: afterBoundary,
	airedEpMap: new Map([[subject.id, 2]]),
	airingSignalMap,
	nextAiringAtMap: afterNextAiringMap,
});
assert.equal(
	afterSorted[0].group,
	"airing_not_caught",
	"条目 X 到达深夜首播时刻后必须进入第一组",
);
collection.ep_status = 2;
const caughtUpLabel = getDisplayLabel(
	collection,
	{ ...afterSorted[0], group: "airing_caught" },
	{ nowMs: afterBoundary, nextAiringAtMap: afterNextAiringMap },
);
assert.match(
	caughtUpLabel,
	/^下周/,
	"今日播出结束后，下一集标签不得错误显示为今日",
);

const doublePremiereEpisodes = [
	{ ep: 1, airdate: "2026-07-05" },
	{ ep: 2, airdate: "2026-07-05" },
	{ ep: 3, airdate: "2026-07-12" },
];
const doublePremiereSchedule = deriveAiringSchedule(
	7,
	doublePremiereEpisodes,
	observation("2026-07-05", 23, 0, 2),
);
assert.equal(doublePremiereSchedule.confidence, "aligned");
assert.equal(
	deriveAiredEpisodeCount(
		doublePremiereEpisodes,
		doublePremiereSchedule,
		jstTimestamp("2026-07-05", 22, 59),
	),
	0,
);
assert.equal(
	deriveAiredEpisodeCount(
		doublePremiereEpisodes,
		doublePremiereSchedule,
		jstTimestamp("2026-07-05", 23, 0),
	),
	2,
	"BGM 同日双集首播应在同一边界一次计入两集",
);

const missingEpisodeCollection = {
	...collection,
	ep_status: 0,
	subject: { ...subject, total_episodes: 12 },
};
const missingEpisodeSorted = sortCollections(
	[missingEpisodeCollection],
	calendar,
	{
		nowMs: beforeNow,
		airedEpMap: new Map(),
		airingSignalMap,
		nextAiringAtMap: new Map(),
	},
);
assert.equal(missingEpisodeSorted[0].airedEp, 0);
assert.equal(
	missingEpisodeSorted[0].group,
	"airing_caught",
	"BGM episodes 完全缺失时不得强制制造至少一集已播",
);

process.stdout.write("airing schedule: 全部通过 ✓\n");
