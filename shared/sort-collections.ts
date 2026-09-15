import type { CalendarItem, UserCollection } from "./api/types";

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

function getTokyoDateKey(nowMs: number): string {
	const date = new Date(nowMs + JST_OFFSET_MS);
	return [
		date.getUTCFullYear(),
		String(date.getUTCMonth() + 1).padStart(2, "0"),
		String(date.getUTCDate()).padStart(2, "0"),
	].join("-");
}

export function getTodayBangumiWeekday(nowMs: number): number {
	const jsDay = new Date(nowMs).getDay();
	return jsDay === 0 ? 7 : jsDay;
}

function weekdayOffset(weekday: number, today: number): number {
	return (weekday - today + 7) % 7;
}

function getTotalEp(c: UserCollection): number {
	return c.subject.total_episodes || c.subject.eps || 0;
}

/**
 * 用户对条目的投入程度：完成度为主、已观看集数为辅，减少短篇比例偏置。
 * 总集数未知时返回 null，调用方应回退至更新时间排序。
 */
export function getInterestWeight(c: UserCollection): number | null {
	const totalEp = getTotalEp(c);
	if (!Number.isFinite(totalEp) || totalEp <= 0) return null;

	const watchedEp = Math.min(Math.max(c.ep_status, 0), totalEp);
	const completion = watchedEp / totalEp;
	const viewingDepth = Math.min(watchedEp / 6, 1);
	return 0.75 * completion + 0.25 * viewingDepth;
}

function getWeekdayFromDate(dateStr: string): number {
	const [year, month, day] = dateStr.split("-").map(Number);
	if (!year || !month || !day) return 0;
	const jsDay = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
	return jsDay === 0 ? 7 : jsDay;
}

export type SortedGroup =
	| "airing_not_caught"
	| "finished_started"
	| "finished_unwatched"
	| "completed"
	| "airing_caught"
	| "pre_air";

export interface CollectionMeta {
	group: SortedGroup;
	weekday: number;
	airedEp: number;
}

export interface SortedCollection extends CollectionMeta {
	collection: UserCollection;
}

export interface SortCollectionsOptions {
	nowMs: number;
	airedEpMap: ReadonlyMap<number, number>;
	airingSignalMap?: ReadonlyMap<number, unknown>;
	nextAiringAtMap?: ReadonlyMap<number, number>;
}

export interface DisplayLabelOptions {
	nowMs: number;
	nextAiringAtMap?: ReadonlyMap<number, number>;
}

type CollectionGroupEntry = {
	c: UserCollection;
	meta: CollectionMeta;
};

function createCollectionGroups(): Record<SortedGroup, CollectionGroupEntry[]> {
	return {
		airing_not_caught: [],
		finished_started: [],
		finished_unwatched: [],
		completed: [],
		airing_caught: [],
		pre_air: [],
	};
}

export function getCollectionMeta(
	c: UserCollection,
	airingMap: ReadonlyMap<number, number>,
	options: SortCollectionsOptions,
): CollectionMeta {
	const weekday =
		airingMap.get(c.subject_id) ??
		c.subject.air_weekday ??
		(c.subject.date ? getWeekdayFromDate(c.subject.date) : 0);
	const totalEp = getTotalEp(c);
	// BGM 日历为主要在播信号；AniList 仅在 BGM 日历缺失时辅助判定。
	const isAiring =
		airingMap.has(c.subject_id) ||
		Boolean(options.airingSignalMap?.has(c.subject_id));
	const knownAiredEp = isAiring ? options.airedEpMap.get(c.subject_id) : totalEp;
	// BGM 剧集数据完全缺失时保持当前进度，不因网络错误制造已播集数。
	const airedEp = knownAiredEp ?? c.ep_status;

	let group: SortedGroup;
	const todayDateKey = getTokyoDateKey(options.nowMs);

	if (isAiring && c.subject.date && c.subject.date > todayDateKey) {
		group = "pre_air";
	} else if (totalEp > 0 && c.ep_status >= totalEp) {
		group = "completed";
	} else if (!isAiring && c.ep_status === 0) {
		group = "finished_unwatched";
	} else if (isAiring && c.ep_status < airedEp) {
		group = "airing_not_caught";
	} else if (isAiring) {
		group = "airing_caught";
	} else {
		group = "finished_started";
	}

	return { group, weekday, airedEp };
}

export function sortCollections(
	collections: UserCollection[],
	calendar: CalendarItem[],
	options: SortCollectionsOptions,
): SortedCollection[] {
	const airingMap = new Map<number, number>();
	for (const day of calendar) {
		for (const item of day.items) airingMap.set(item.id, day.weekday.id);
	}

	const groups = createCollectionGroups();

	for (const c of collections) {
		const meta = getCollectionMeta(c, airingMap, options);
		groups[meta.group].push({ c, meta });
	}

	// Group I 的兴趣权重相同、总集数未知条目，以及 Group III：先按
	// weekdayOffset 升序（weekday 优先取 nextAiringAt 推出的星期），同天再用
	// 精确播出时间戳裁决，名称兜底。
	const today = getTodayBangumiWeekday(options.nowMs);
	const sortByWeekdayThenTime = (
		a: { c: UserCollection },
		b: { c: UserCollection },
	) => {
		const ta = options.nextAiringAtMap?.get(a.c.subject_id);
		const tb = options.nextAiringAtMap?.get(b.c.subject_id);
		const wa = ta
			? getTodayBangumiWeekday(ta)
			: (airingMap.get(a.c.subject_id) ?? 0);
		const wb = tb
			? getTodayBangumiWeekday(tb)
			: (airingMap.get(b.c.subject_id) ?? 0);
		const offsetDiff = weekdayOffset(wa, today) - weekdayOffset(wb, today);
		if (offsetDiff !== 0) return offsetDiff;
		if (ta !== undefined && tb !== undefined && ta !== tb) return ta - tb;

		return (a.c.subject.name_cn || a.c.subject.name).localeCompare(
			b.c.subject.name_cn || b.c.subject.name,
		);
	};

	groups.airing_not_caught.sort((a, b) => {
		const weightA = getInterestWeight(a.c);
		const weightB = getInterestWeight(b.c);

		// 总集数已知的条目优先；双方均已知时严格按兴趣权重降序。
		if (weightA !== null && weightB !== null) {
			const weightDiff = weightB - weightA;
			if (weightDiff !== 0) return weightDiff;
		} else if (weightA !== null || weightB !== null) {
			return weightA === null ? 1 : -1;
		}

		return sortByWeekdayThenTime(a, b);
	});
	groups.airing_caught.sort(sortByWeekdayThenTime);
	groups.pre_air.sort((a, b) =>
		(a.c.subject.date || "").localeCompare(b.c.subject.date || ""),
	);

	const ordered = [
		...groups.airing_not_caught,
		...groups.finished_started,
		...groups.finished_unwatched,
		...groups.airing_caught,
		...groups.pre_air,
		...groups.completed,
	];
	return ordered.map(({ c, meta }) => ({ collection: c, ...meta }));
}

/** 分组左侧强调色 */
export const GROUP_COLOR = {
	airing_not_caught: "#f59e0b",
	finished_started: "#60a5fa",
	finished_unwatched: "#94a3b8",
	airing_caught: "#34d399",
	pre_air: "#e879f9",
	completed: "#eab308",
} satisfies Record<SortedGroup, string>;

/** 分组中文显示名称 */
export const GROUP_LABEL = {
	airing_not_caught: "未追上进度",
	finished_started: "完结 · 观看中",
	finished_unwatched: "完结 · 未观看",
	airing_caught: "已追上进度",
	pre_air: "即将开播",
	completed: "已看完",
} satisfies Record<SortedGroup, string>;

function getLocalDateSerial(date: Date): number {
	return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
}

export function getDisplayLabel(
	c: UserCollection,
	meta: CollectionMeta,
	options: DisplayLabelOptions,
): string | null {
	const { group, weekday } = meta;

	if (group === "pre_air") {
		if (c.subject.date) {
			const parts = c.subject.date.split("-");
			if (parts.length === 3) {
				return `${parseInt(parts[1], 10)}月${parseInt(parts[2], 10)}日 开播`;
			}
		}
		return "即将开播";
	}

	if (group === "airing_caught") {
		const nextAiringAt = options.nextAiringAtMap?.get(c.subject_id);
		if (nextAiringAt !== undefined) {
			const airingDate = new Date(nextAiringAt);
			const now = new Date(options.nowMs);
			const dayOffset = Math.round(
				(getLocalDateSerial(airingDate) - getLocalDateSerial(now)) / 86_400_000,
			);
			const localWeekday = getTodayBangumiWeekday(nextAiringAt);
			let label: string;
			if (dayOffset === 0) label = "今日";
			else if (dayOffset === 1) label = "明日";
			else if (dayOffset >= 7) {
				label = `下周${WEEKDAY_CN[localWeekday].replace("星期", "")}`;
			} else {
				label = WEEKDAY_CN[localWeekday].replace("星期", "周");
			}
			const hh = String(airingDate.getHours()).padStart(2, "0");
			const mm = String(airingDate.getMinutes()).padStart(2, "0");
			return `${label} ${hh}:${mm} 更新`;
		}

		if (weekday <= 0) return "等待更新";
		return `${WEEKDAY_CN[weekday].replace("星期", "周")}更新`;
	}

	if (group === "airing_not_caught" || group === "finished_started") {
		return `继续观看 ${c.ep_status + 1}`;
	}
	if (group === "completed") return "已看完";
	if (group === "finished_unwatched") return "开始观看";
	return null;
}

export const WEEKDAY_CN: Record<number, string> = Object.freeze({
	1: "星期一",
	2: "星期二",
	3: "星期三",
	4: "星期四",
	5: "星期五",
	6: "星期六",
	7: "星期日",
});
