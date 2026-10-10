import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	AppState,
	SectionList,
	Pressable,
	RefreshControl,
	ScrollView,
	StyleSheet,
	Text,
	View,
} from "react-native";
import * as Clipboard from "expo-clipboard";
import { router, useFocusEffect } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Ionicons } from "@expo/vector-icons";

import {
	getAllEpisodes,
	getAllUserCollections,
	getCalendar,
	getSubject,
} from "../../shared/api/client";
import { getAiringAt } from "../../shared/api/anilist";
import type {
	CalendarItem,
	CollectionType,
	Episode,
	PagedResponse,
	UserCollection,
} from "../../shared/api/types";
import { CollectionTypeLabel, SubjectTypeLabel } from "../../shared/api/types";
import { buildSubjectKeywords } from "../../shared/pinyin-keywords";
import {
	applyAiringLookupResult,
	isAiringCacheRecord,
	isAiringRecordUsable,
	shouldRefreshAiringRecord,
	toAiringObservation,
	type AiringCacheRecord,
} from "../../shared/airing-cache";
import {
	deriveAiredEpisodeCount,
	deriveAiringSchedule,
	getLatestEpisodeAiringAt,
	getNextEpisodeAiringAt,
	getNextRecentAiringExpiry,
	getNextScheduleBoundary,
	isRecentlyAired,
	type AiringObservation,
	type AiringSchedule,
} from "../../shared/airing-schedule";
import {
	getDisplayLabel,
	GROUP_COLOR,
	GROUP_LABEL,
	sortCollections,
} from "../../shared/sort-collections";
import type {
	SortedCollection,
	SortedGroup,
} from "../../shared/sort-collections";
import {
	deleteCachedValue,
	deleteCachedValuesByPrefix,
	getPreferredSubjectCoverUrl,
	readCachedCollection,
	readCachedSubject,
	readCachedValueEntry,
	readCachedValues,
	writeCachedCollection,
	writeCachedSubject,
	writeCachedSubjectPreviews,
	writeCachedValue,
} from "../../shared/storage/sqlite-cache";
import { getSubjectTitleForCopy } from "../../src/api/subject-title-copy";
import {
	getCollectionTaskQueue,
	getCollectionTaskSummary,
	getOptimisticCollectionPatchForSubject,
	ignoreCollectionTask,
	retryCollectionTask,
	startCollectionTaskWorker,
	subscribeCollectionTaskQueue,
	type CollectionTask,
} from "../../src/api/collection-tasks";
import { useHeaderSearch } from "../../src/components/SearchInput";
import { SegmentedControl } from "../../src/components/SegmentedControl";
import {
	EmptyState,
	ErrorState,
	LoadingState,
} from "../../src/components/ScreenState";
import { SubjectCard } from "../../src/components/SubjectCard";
import { SwipePager } from "../../src/components/SwipePager";
import { useAuth } from "../../src/hooks/useAuth";
import { colors } from "../../src/theme/colors";
import { useAlert } from "../../src/components/Dialog";
import { refreshQueryDataIfChanged } from "../../src/api/stale-cache-refresh";

const CACHE_MAX_AGE = 1000 * 60 * 60 * 24;
const AIRING_CACHE_PREFIX = "anilist-airing-v2-";
const EPISODES_CACHE_PREFIX = "episodes-schedule-v2-";
const AIRING_REQUEST_DELAY = 700;
const EPISODES_CACHE_MAX_AGE = 1000 * 60 * 30;
const CLOCK_EPSILON_MS = 1000;
const PAGE_SIZE = 20;

const EMPTY_COLLECTIONS: UserCollection[] = [];
const EMPTY_AIRING_MAP = new Map<number, number>();
const EMPTY_AIRING_RECORD_MAP = new Map<number, AiringCacheRecord>();
const EMPTY_EPISODE_LIST_MAP = new Map<number, Episode[]>();
const EMPTY_SORTED_COLLECTIONS: SortedCollection[] = [];
const EMPTY_DISPLAY_LABEL_MAP = new Map<number, string | null>();
const EMPTY_SUBJECT_ID_SET = new Set<number>();

type EpisodeScheduleCache = {
	episodes: Episode[];
	checkedAt: number;
};

type CachedSnapshot<T> = {
	key: string;
	value: T | null;
	version: number;
	complete: boolean;
};

type CommittedCollectionsState = {
	scopeKey: string;
	version: string;
	sorted: SortedCollection[];
	displayLabelMap: Map<number, string | null>;
	justUpdatedSubjectIds: Set<number>;
};

/** 分组 section（仅在看 tab 使用；跨页延续的组在后续页仍渲染组头） */
interface CollectionSection {
	group?: SortedGroup;
	title?: string;
	color?: string;
	count?: number;
	data: SortedCollection[];
}

const COLLECTION_OPTIONS: { value: CollectionType; label: string }[] = [
	{ value: 3, label: "在看" },
	{ value: 1, label: "想看" },
	{ value: 2, label: "看过" },
	{ value: 4, label: "搁置" },
	{ value: 5, label: "抛弃" },
];

async function readCachedAiringRecords(subjectIds: number[]) {
	const uniqueIds = [...new Set(subjectIds)];
	const keys = uniqueIds.map((id) => `${AIRING_CACHE_PREFIX}${id}`);
	const cachedByKey = await readCachedValues<unknown>(keys);
	const nowMs = Date.now();
	const map = new Map<number, AiringCacheRecord>();
	const invalidKeys: string[] = [];
	for (const id of uniqueIds) {
		const key = `${AIRING_CACHE_PREFIX}${id}`;
		const value = cachedByKey.get(key);
		if (value !== undefined && !isAiringCacheRecord(value)) {
			invalidKeys.push(key);
			continue;
		}
		if (isAiringCacheRecord(value) && isAiringRecordUsable(value, nowMs)) {
			map.set(id, value);
		}
	}
	if (invalidKeys.length > 0) {
		await Promise.all(invalidKeys.map((key) => deleteCachedValue(key)));
	}
	return map;
}

function getInfoboxAliases(subject: Awaited<ReturnType<typeof getSubject>>) {
	const aliases: string[] = [];
	for (const item of subject.infobox ?? []) {
		if (!/(别名|中文名|英文名|日文名|原作名)/.test(item.key)) continue;
		if (typeof item.value === "string") aliases.push(item.value);
		else for (const value of item.value) aliases.push(value.v);
	}
	return aliases;
}

async function delay(ms: number) {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

async function lookupAiringTime(target: {
	subjectId: number;
	name: string;
	nameCn: string;
}) {
	let result = await getAiringAt(target.name);
	if (result.status !== "not_found") return result;

	let aliases = target.nameCn ? [target.nameCn] : [];
	try {
		aliases = [
			...aliases,
			...getInfoboxAliases(await getSubject(target.subjectId)),
		];
	} catch (error) {
		console.warn("[airing-schedule] failed to load BGM aliases", error);
	}
	for (const title of [...new Set(aliases)].filter(Boolean)) {
		if (title === target.name) continue;
		await delay(AIRING_REQUEST_DELAY);
		result = await getAiringAt(title);
		if (result.status !== "not_found") return result;
	}
	return result;
}

function getEpisodeCacheKey(subjectId: number) {
	return `${EPISODES_CACHE_PREFIX}${subjectId}`;
}

function isEpisodeScheduleCache(value: unknown): value is EpisodeScheduleCache {
	if (!value || typeof value !== "object") return false;
	const cache = value as Partial<EpisodeScheduleCache>;
	if (!Array.isArray(cache.episodes) || !Number.isFinite(cache.checkedAt)) {
		return false;
	}
	return cache.episodes.every(
		(episode) =>
			!!episode &&
			typeof episode === "object" &&
			typeof episode.ep === "number" &&
			typeof episode.type === "number" &&
			typeof episode.airdate === "string",
	);
}

function isPagedCollectionCache(value: unknown): value is PagedResponse<UserCollection> {
	if (!value || typeof value !== "object") return false;
	const payload = value as Partial<PagedResponse<UserCollection>>;
	return (
		Array.isArray(payload.data) &&
		typeof payload.total === "number" &&
		payload.data.every(
			(collection) =>
				!!collection &&
				typeof collection === "object" &&
				typeof collection.subject_id === "number" &&
				typeof collection.type === "number" &&
				typeof collection.ep_status === "number" &&
				!!collection.subject &&
				typeof collection.subject === "object" &&
				typeof collection.subject.id === "number" &&
				typeof collection.subject.name === "string",
		)
	);
}

function isCalendarCache(value: unknown): value is CalendarItem[] {
	return (
		Array.isArray(value) &&
		value.every(
			(day) =>
				!!day &&
				typeof day === "object" &&
				!!day.weekday &&
				typeof day.weekday.id === "number" &&
				Array.isArray(day.items) &&
				day.items.every(
					(item: unknown) =>
						!!item &&
						typeof item === "object" &&
						typeof (item as { id?: unknown }).id === "number",
				),
		)
	);
}

function deriveAiringMaps(
	episodeListMap: ReadonlyMap<number, Episode[]>,
	observationMap: ReadonlyMap<number, AiringObservation>,
	airingMap: ReadonlyMap<number, number>,
	nowMs: number,
) {
	const scheduleMap = new Map<number, AiringSchedule>();
	const airedEpMap = new Map<number, number>();
	const nextAiringAtMap = new Map<number, number>();
	const latestAiringAtMap = new Map<number, number>();
	for (const [subjectId, episodes] of episodeListMap) {
		const observation = observationMap.get(subjectId);
		const schedule = observation
			? deriveAiringSchedule(airingMap.get(subjectId), episodes, observation)
			: null;
		if (schedule) scheduleMap.set(subjectId, schedule);
		airedEpMap.set(subjectId, deriveAiredEpisodeCount(episodes, schedule, nowMs));
		const nextAiringAt = getNextEpisodeAiringAt(episodes, schedule, nowMs);
		if (nextAiringAt !== null) nextAiringAtMap.set(subjectId, nextAiringAt);
		const latestAiringAt = getLatestEpisodeAiringAt(episodes, schedule, nowMs);
		if (latestAiringAt !== null) latestAiringAtMap.set(subjectId, latestAiringAt);
	}
	return { scheduleMap, airedEpMap, nextAiringAtMap, latestAiringAtMap };
}

function getJustUpdatedSubjectIds(
	sorted: SortedCollection[],
	latestAiringAtMap: ReadonlyMap<number, number>,
	nowMs: number,
): Set<number> {
	const subjectIds = new Set<number>();
	for (const item of sorted) {
		if (
			item.group === "airing_not_caught" &&
			isRecentlyAired(
				latestAiringAtMap.get(item.collection.subject_id),
				nowMs,
			)
		) {
			subjectIds.add(item.collection.subject_id);
		}
	}
	return subjectIds;
}

async function readCachedCollections(
	type: CollectionType,
	username: string,
): Promise<{ payload: PagedResponse<UserCollection>; updatedAt: number } | null> {
	const cacheKey = `collections-${type}-${username}`;
	const cached = await readCachedValueEntry<unknown>(cacheKey);
	if (!cached) return null;
	if (!isPagedCollectionCache(cached.payload)) {
		await deleteCachedValue(cacheKey);
		return null;
	}
	await mergeSubjectCollections(cached.payload, username);
	cached.payload.data = cached.payload.data.filter((c) => c.type === type);
	return { payload: cached.payload, updatedAt: cached.updatedAt };
}

async function readCachedCalendar(): Promise<{
	payload: CalendarItem[];
	updatedAt: number;
} | null> {
	const cached = await readCachedValueEntry<unknown>("calendar");
	if (!cached) return null;
	if (!isCalendarCache(cached.payload)) {
		await deleteCachedValue("calendar");
		return null;
	}
	return { payload: cached.payload, updatedAt: cached.updatedAt };
}

async function loadCollections(
	type: CollectionType,
	username: string,
	force = false,
) {
	const cacheKey = `collections-${type}-${username}`;
	if (!force) {
		const cached = await readCachedCollections(type, username);
		if (cached) return cached.payload;
	}

	const data = await getAllUserCollections({ username, type });
	await writeCachedValue(cacheKey, data);
	await writeCachedSubjectPreviews(
		data.data.map((collection) => collection.subject),
	);
	Promise.allSettled(
		data.data.map((c) => writeCachedCollection(username, c)),
	).catch(() => {});
	return data;
}

async function mergeSubjectCollections(
	data: PagedResponse<UserCollection>,
	username: string,
) {
	// Read subject_collections in parallel to merge fresher ep_status/type
	const updates = await Promise.allSettled(
		data.data.map((c) => readCachedCollection(username, c.subject_id)),
	);
	for (let i = 0; i < data.data.length; i++) {
		const result = updates[i];
		if (result.status === "fulfilled" && result.value) {
			const fresh = result.value;
			data.data[i].ep_status = fresh.ep_status;
			data.data[i].type = fresh.type;
			data.data[i].rate = fresh.rate;
		}
	}
}

async function loadCalendar(force = false) {
	if (!force) {
		const cached = await readCachedCalendar();
		if (cached) return cached.payload;
	}
	const data = await getCalendar();
	await writeCachedValue("calendar", data);
	await writeCachedSubjectPreviews(data.flatMap((day) => day.items));
	return data;
}

function getAiringMap(calendar: CalendarItem[] | undefined) {
	if (!calendar) return EMPTY_AIRING_MAP;
	const map = new Map<number, number>();
	for (const day of calendar) {
		for (const subject of day.items) {
			map.set(subject.id, day.weekday.id);
		}
	}
	return map;
}

function matchesSearch(collection: UserCollection, query: string) {
	if (!query) return true;
	const subject = collection.subject;
	const haystack = [
		subject.name,
		subject.name_cn,
		...buildSubjectKeywords(subject.name_cn, subject.name),
	]
		.join(" ")
		.toLowerCase();
	return haystack.includes(query);
}

function getTaskStatusLabel(task: CollectionTask) {
	if (task.status === "failed") return "同步失败";
	if (task.status === "running") return "同步中";
	return "等待同步";
}

function getTaskPriority(task: CollectionTask) {
	if (task.status === "failed") return 0;
	if (task.status === "running") return 1;
	return 2;
}

function enrichCollections(
	collections: UserCollection[],
	totalEpBackfill?: ReadonlyMap<number, number>,
	episodeTotals?: ReadonlyMap<number, number>,
) {
	return collections.map((c) => {
		const s = { ...c.subject };

		// 优先使用完整剧集列表计算出的主线总集数，再回退到本地条目缓存和 API 字段。
		if (s.total_episodes == null || s.total_episodes === 0) {
			const fetchedTotal = episodeTotals?.get(s.id);
			if (fetchedTotal) s.total_episodes = fetchedTotal;
			const cachedTotal = totalEpBackfill?.get(s.id);
			if (
				(s.total_episodes == null || s.total_episodes === 0) &&
				cachedTotal
			) {
				s.total_episodes = cachedTotal;
			}
			if ((s.total_episodes == null || s.total_episodes === 0) && s.eps > 0) {
				s.total_episodes = s.eps;
			}
		}

		if (s.rating == null) {
			(s as Record<string, unknown>).rating = undefined;
		}

		return { ...c, subject: s };
	});
}

export default function CollectionsPage() {
	const alert = useAlert();
	const queryClient = useQueryClient();
	const { checking, loggedIn, username } = useAuth();
	const [collectionType, setCollectionType] = useState<CollectionType>(3);
	const [search, setSearch] = useState("");
	const [refreshing, setRefreshing] = useState(false);

	useHeaderSearch({
		value: search,
		onChangeText: setSearch,
		placeholder: `搜索${CollectionTypeLabel[collectionType]}`,
	});
	const [page, setPage] = useState(1);
	const [collectionTasks, setCollectionTasks] = useState<CollectionTask[]>([]);
	const [taskPanelExpanded, setTaskPanelExpanded] = useState(false);
	const [nowMs, setNowMs] = useState(() => Date.now());
	const [isPageFocused, setIsPageFocused] = useState(false);
	const [cachedCollectionsSnapshot, setCachedCollectionsSnapshot] = useState<
		CachedSnapshot<PagedResponse<UserCollection>>
	>({ key: "", value: null, version: 0, complete: false });
	const [cachedCalendarSnapshot, setCachedCalendarSnapshot] = useState<
		CachedSnapshot<CalendarItem[]>
	>({ key: "", value: null, version: 0, complete: false });
	const [cachedEpisodeSnapshot, setCachedEpisodeSnapshot] = useState<
		CachedSnapshot<Map<number, Episode[]>>
	>({ key: "", value: null, version: 0, complete: false });
	const [committedState, setCommittedState] =
		useState<CommittedCollectionsState | null>(null);
	const [backgroundRefreshCount, setBackgroundRefreshCount] = useState(0);
	const airingRefreshGenerationRef = useRef(0);
	const isMountedRef = useRef(true);
	const syncClock = useCallback(() => setNowMs(Date.now()), []);

	useEffect(() => {
		isMountedRef.current = true;
		return () => {
			isMountedRef.current = false;
		};
	}, []);

	const trackBackgroundRefresh = useCallback(
		(task: Promise<boolean> | null) => {
			if (!task) return;
			if (isMountedRef.current) {
				setBackgroundRefreshCount((count) => count + 1);
			}
			void task.finally(() => {
				if (!isMountedRef.current) return;
				setBackgroundRefreshCount((count) => Math.max(0, count - 1));
			});
		},
		[],
	);

	useEffect(() => {
		const subscription = AppState.addEventListener("change", (state) => {
			if (state === "active") syncClock();
		});
		return () => subscription.remove();
	}, [syncClock]);

	useFocusEffect(
		useCallback(() => {
			setIsPageFocused(true);
			syncClock();
			if (loggedIn && username) {
				void queryClient.invalidateQueries({
					queryKey: ["collections", collectionType, username],
					exact: true,
				});
				void queryClient.invalidateQueries({ queryKey: ["calendar"] });
			}
			void queryClient.invalidateQueries({
				queryKey: ["episodes-schedule-v2"],
			});
			void queryClient.invalidateQueries({
				queryKey: ["anilist-airing-times-v2"],
			});
			return () => setIsPageFocused(false);
		}, [collectionType, loggedIn, queryClient, syncClock, username]),
	);

	useEffect(() => {
		if (!checking && !loggedIn) router.replace("/login");
	}, [checking, loggedIn]);

	useEffect(() => {
		if (!checking && loggedIn) {
			startCollectionTaskWorker(queryClient);
		}
	}, [checking, loggedIn, queryClient]);

	useEffect(() => {
		let cancelled = false;
		const syncCollectionTasks = () => {
			void getCollectionTaskQueue().then((tasks) => {
				if (!cancelled) setCollectionTasks(tasks);
			});
		};

		syncCollectionTasks();
		const unsubscribe = subscribeCollectionTaskQueue(syncCollectionTasks);
		return () => {
			cancelled = true;
			unsubscribe();
		};
	}, []);

	const collectionsCacheKey = `collections-${collectionType}-${username}`;
	const collectionsQueryKey = [
		"collections",
		collectionType,
		username,
	] as const;
	const collectionsQuery = useQuery({
		queryKey: collectionsQueryKey,
		enabled: loggedIn && !!username,
		queryFn: async () => {
			const cached = await readCachedCollections(collectionType, username);
			if (cached) {
				if (isMountedRef.current) {
					setCachedCollectionsSnapshot({
						key: collectionsCacheKey,
						value: cached.payload,
						version: cached.updatedAt,
						complete: true,
					});
				}
				const refreshTask = refreshQueryDataIfChanged({
					queryClient,
					queryKey: collectionsQueryKey,
					refreshKey: collectionsCacheKey,
					currentData: cached.payload,
					refresh: () => loadCollections(collectionType, username, true),
				});
				trackBackgroundRefresh(refreshTask);
				return cached.payload;
			}

			if (isMountedRef.current) {
				setCachedCollectionsSnapshot({
					key: collectionsCacheKey,
					value: null,
					version: Date.now(),
					complete: false,
				});
			}
			return loadCollections(collectionType, username, true);
		},
	});

	const calendarQuery = useQuery({
		queryKey: ["calendar"],
		enabled: loggedIn && !!username,
		queryFn: async () => {
			const cached = await readCachedCalendar();
			if (cached) {
				if (isMountedRef.current) {
					setCachedCalendarSnapshot({
						key: "calendar",
						value: cached.payload,
						version: cached.updatedAt,
						complete: true,
					});
				}
				const refreshTask = refreshQueryDataIfChanged({
					queryClient,
					queryKey: ["calendar"],
					refreshKey: "calendar",
					currentData: cached.payload,
					refresh: () => loadCalendar(true),
				});
				trackBackgroundRefresh(refreshTask);
				return cached.payload;
			}

			if (isMountedRef.current) {
				setCachedCalendarSnapshot({
					key: "calendar",
					value: null,
					version: Date.now(),
					complete: false,
				});
			}
			return loadCalendar(true);
		},
	});

	const airingMap = useMemo(
		() => getAiringMap(calendarQuery.data),
		[calendarQuery.data],
	);
	const searchQuery = search.trim().toLowerCase();

	const sourceCollections = useMemo(
		() => collectionsQuery.data?.data ?? [],
		[collectionsQuery.data?.data],
	);
	const visibleCollectionTasks = useMemo(() => {
		const tasks = username
			? collectionTasks.filter((task) => task.payload.username === username)
			: collectionTasks;
		return tasks
			.slice()
			.sort(
				(a, b) =>
					getTaskPriority(a) - getTaskPriority(b) || a.createdAt - b.createdAt,
			);
	}, [collectionTasks, username]);
	const rawCollections = useMemo(
		() =>
			sourceCollections
				.map((collection) => {
					const patch = getOptimisticCollectionPatchForSubject(
						collection.subject_id,
						visibleCollectionTasks,
					);
					return patch ? { ...collection, ...patch } : collection;
				})
				.filter((collection) => collection.type === collectionType),
		[sourceCollections, visibleCollectionTasks, collectionType],
	);
	const isWatching = collectionType === 3;
	const scheduleWeekdayMap = useMemo(() => {
		const map = new Map(airingMap);
		for (const item of rawCollections) {
			const weekday = item.subject.air_weekday;
			if (!map.has(item.subject_id) && weekday && weekday > 0) {
				map.set(item.subject_id, weekday);
			}
		}
		return map;
	}, [airingMap, rawCollections]);

	// --- Phase 1: Backfill total_episodes from SQLite cache ---
	const {
		data: totalEpBackfill,
		dataUpdatedAt: totalEpBackfillUpdatedAt,
	} = useQuery({
		queryKey: [
			"totalep-backfill",
			rawCollections.map((c) => c.subject_id).join(","),
		],
		queryFn: async () => {
			const totals = new Map<number, number>();
			for (const c of rawCollections) {
				const s = c.subject;
				if ((s.total_episodes == null || s.total_episodes === 0) && !s.eps) {
					const cached = await readCachedSubject(s.id);
					if (cached?.total_episodes) totals.set(s.id, cached.total_episodes);
					else if (cached?.eps) totals.set(s.id, cached.eps);
				}
			}
			return totals;
		},
		enabled: rawCollections.length > 0,
		staleTime: 0,
	});

	// --- Phase 2: Fetch episodes for subjects with missing total_episodes ---
	const subjectsNeedingEpisodes = useMemo(() => {
		return rawCollections
			.filter((c) => {
				const s = c.subject;
				if (s.total_episodes != null && s.total_episodes > 0) return false;
				return true;
			})
			.map((c) => c.subject_id);
	}, [rawCollections]);

	const {
		data: episodeTotals,
		dataUpdatedAt: episodeTotalsUpdatedAt,
	} = useQuery({
		queryKey: ["episode-totals", subjectsNeedingEpisodes.join(",")],
		queryFn: async () => {
			if (subjectsNeedingEpisodes.length === 0) return new Map<number, number>();
			const totals = new Map<number, number>();

			// Batch fetch (10 at a time to avoid rate limiting)
			for (let i = 0; i < subjectsNeedingEpisodes.length; i += 10) {
				const batch = subjectsNeedingEpisodes.slice(i, i + 10);
				const results = await Promise.allSettled(
					batch.map((id) =>
						getAllEpisodes(id).then((data) => {
							const mainEps = data.data.filter((ep) => ep.type === 0);
							return { id, totalEp: mainEps.length };
						}),
					),
				);
				for (const result of results) {
					if (result.status === "fulfilled") {
						const { id, totalEp } = result.value;
						totals.set(id, totalEp);
						// Persist correct total_episodes to SQLite so it survives cold start
						readCachedSubject(id)
							.then((cached) => {
								if (cached)
									return writeCachedSubject({
										...cached,
										total_episodes: totalEp,
									});
							})
							.catch(() => {});
					}
				}
			}

			return totals;
		},
		enabled: subjectsNeedingEpisodes.length > 0,
		staleTime: CACHE_MAX_AGE,
		gcTime: CACHE_MAX_AGE * 2,
	});

	// --- Phase 4: Bangumi episode counts for airing subjects (airedEpMap for sorting) ---
	const airingIds = useMemo(
		() =>
			rawCollections
				.filter((item) => airingMap.has(item.subject_id))
				.map((item) => item.subject_id),
		[rawCollections, airingMap],
	);

	const staleAiringIds = useMemo(
		() =>
			isWatching
				? rawCollections
						.filter((item) => !airingMap.has(item.subject_id))
						.filter((item) => {
							const total = item.subject.eps || item.subject.total_episodes || 0;
							return total === 0 || item.ep_status < total;
						})
						.map((item) => item.subject_id)
				: [],
		[rawCollections, airingMap, isWatching],
	);

	const allEpisodeIds = useMemo(
		() =>
			isWatching
				? [...new Set(rawCollections.map((item) => item.subject_id))]
				: [],
		[isWatching, rawCollections],
	);

	// --- Phase 3: AniList 排期 cache v2 与可刷新网络查询 ---
	const airingTimeCacheIds = useMemo(
		() =>
			isWatching
				? [...new Set(rawCollections.map((item) => item.subject_id))]
				: [],
		[rawCollections, isWatching],
	);
	const airingTimeCacheKey = airingTimeCacheIds.join(",");
	const shouldReadAiringTimeCache = isWatching && airingTimeCacheIds.length > 0;
	const {
		data: cachedAiringRecordMap,
		isFetched: cachedAiringTimeFetched,
		dataUpdatedAt: cachedAiringTimeUpdatedAt,
	} = useQuery({
		queryKey: ["anilist-airing-times-cache-v2", airingTimeCacheKey],
		queryFn: () => readCachedAiringRecords(airingTimeCacheIds),
		enabled: shouldReadAiringTimeCache,
		staleTime: 5 * 60 * 1000,
		gcTime: CACHE_MAX_AGE * 2,
	});

	// --- Phase 3b: AniList airing times network backfill (only missing cached items) ---
	const airingTimeTargets = useMemo(() => {
		if (!isWatching) return [];
		const calendarReady = airingMap.size > 0;
		if (calendarReady && airingIds.length === 0 && staleAiringIds.length === 0)
			return [];
		const targetIds = calendarReady
			? new Set([...airingIds, ...staleAiringIds])
			: new Set(rawCollections.map((item) => item.subject_id));
		return rawCollections
			.filter((item) => targetIds.has(item.subject_id) && item.subject.name)
			.map((item) => ({
				subjectId: item.subject_id,
				name: item.subject.name,
				nameCn: item.subject.name_cn,
			}));
	}, [rawCollections, airingIds, staleAiringIds, airingMap, isWatching]);

	const airingTimeTargetKey = airingTimeTargets
		.map((target) => target.subjectId)
		.join(",");

	const shouldLoadAiringTimes = isWatching && airingTimeTargets.length > 0;
	const {
		data: airingRecordMapData,
		isFetching: isAiringTimeFetching,
		isError: isAiringTimeError,
		dataUpdatedAt: airingTimeUpdatedAt,
	} = useQuery({
		queryKey: ["anilist-airing-times-v2", airingTimeTargetKey],
		queryFn: async () => {
			const generation = airingRefreshGenerationRef.current;
			const persistedRecords = await readCachedAiringRecords(airingTimeCacheIds);
			const map = new Map<number, AiringCacheRecord>(persistedRecords);
			for (const [subjectId, record] of cachedAiringRecordMap ??
				EMPTY_AIRING_RECORD_MAP) {
				if (!map.has(subjectId) && isAiringRecordUsable(record, Date.now())) {
					map.set(subjectId, record);
				}
			}
			const targetsToRefresh = airingTimeTargets.filter((target) =>
				shouldRefreshAiringRecord(map.get(target.subjectId), Date.now()),
			);
			for (const [index, target] of targetsToRefresh.entries()) {
				if (generation !== airingRefreshGenerationRef.current) return map;
				if (index > 0) await delay(AIRING_REQUEST_DELAY);
				const result = await lookupAiringTime(target);
				if (generation !== airingRefreshGenerationRef.current) return map;
				if (result.status === "network_error") {
					console.warn(`[airing-schedule] ${target.subjectId}: ${result.message}`);
				}
				const record = applyAiringLookupResult(
					map.get(target.subjectId),
					result,
					Date.now(),
				);
				if (!record) continue;
				await writeCachedValue(`${AIRING_CACHE_PREFIX}${target.subjectId}`, record);
				map.set(target.subjectId, record);
			}
			return map;
		},
		enabled: shouldLoadAiringTimes && cachedAiringTimeFetched,
		staleTime: 5 * 60 * 1000,
		gcTime: CACHE_MAX_AGE * 2,
	});

	const airingRecordMap = useMemo(() => {
		if (!cachedAiringRecordMap && !airingRecordMapData) {
			return EMPTY_AIRING_RECORD_MAP;
		}
		const merged = new Map<number, AiringCacheRecord>(
			cachedAiringRecordMap ?? undefined,
		);
		if (airingRecordMapData) {
			for (const [subjectId, record] of airingRecordMapData) {
				merged.set(subjectId, record);
			}
		}
		return merged;
	}, [cachedAiringRecordMap, airingRecordMapData]);
	const airingObservationMap = useMemo(() => {
		const map = new Map<number, AiringObservation>();
		for (const [subjectId, record] of airingRecordMap) {
			const observation = toAiringObservation(record);
			if (observation) map.set(subjectId, observation);
		}
		return map;
	}, [airingRecordMap]);

	// --- Phase 4: 缓存完整 BGM 主线剧集，再从本地时钟推导已播集数 ---
	const episodeQuerySourceKey = allEpisodeIds.join(",");
	const {
		data: episodeListMapData,
		isFetching: isEpisodeFetching,
		isError: isEpisodeError,
		dataUpdatedAt: episodeUpdatedAt,
	} = useQuery({
		queryKey: ["episodes-schedule-v2", episodeQuerySourceKey],
		queryFn: async () => {
			const generation = airingRefreshGenerationRef.current;
			const map = new Map<number, Episode[]>();
			const cachedRecords = new Map<number, EpisodeScheduleCache>();
			const idsToFetch: number[] = [];
			const invalidCacheKeys: string[] = [];
			const cachedByKey = await readCachedValues<unknown>(
				allEpisodeIds.map(getEpisodeCacheKey),
			);
			const checkedAt = Date.now();
			for (const id of allEpisodeIds) {
				const cacheKey = getEpisodeCacheKey(id);
				const cached = cachedByKey.get(cacheKey);
				if (cached !== undefined && !isEpisodeScheduleCache(cached)) {
					invalidCacheKeys.push(cacheKey);
				}
				if (isEpisodeScheduleCache(cached)) {
					cachedRecords.set(id, cached);
					if (checkedAt - cached.checkedAt <= EPISODES_CACHE_MAX_AGE) {
						map.set(id, cached.episodes);
						continue;
					}
				}
				idsToFetch.push(id);
			}
			if (invalidCacheKeys.length > 0) {
				await Promise.all(
					invalidCacheKeys.map((cacheKey) => deleteCachedValue(cacheKey)),
				);
			}

			// 旧但格式兼容的 v2 缓存可立即用于首屏；新鲜度只决定是否后台回源。
			if (isMountedRef.current) {
				const cachedEpisodeListMap = new Map<number, Episode[]>();
				for (const [id, cached] of cachedRecords) {
					cachedEpisodeListMap.set(id, cached.episodes);
				}
				setCachedEpisodeSnapshot({
					key: episodeQuerySourceKey,
					value: cachedEpisodeListMap,
					version: Math.max(
						0,
						...Array.from(cachedRecords.values(), (cached) => cached.checkedAt),
					),
					complete: cachedRecords.size === allEpisodeIds.length,
				});
			}

			const results = await Promise.allSettled(
				idsToFetch.map(async (id) => ({
					id,
					episodes: (await getAllEpisodes(id)).data.filter(
						(episode) => episode.type === 0,
					),
				})),
			);
			for (let index = 0; index < results.length; index += 1) {
				if (generation !== airingRefreshGenerationRef.current) return map;
				const result = results[index];
				const id = idsToFetch[index];
				if (result.status === "fulfilled") {
					const record: EpisodeScheduleCache = {
						episodes: result.value.episodes,
						checkedAt: Date.now(),
					};
					await writeCachedValue(getEpisodeCacheKey(id), record);
					map.set(id, record.episodes);
				} else {
					console.warn(
						`[airing-schedule] failed to load BGM episodes for ${id}`,
						result.reason,
					);
					const stale = cachedRecords.get(id);
					if (stale) map.set(id, stale.episodes);
				}
			}
			return map;
		},
		enabled: isWatching && allEpisodeIds.length > 0,
		staleTime: EPISODES_CACHE_MAX_AGE,
		gcTime: CACHE_MAX_AGE * 2,
	});

	const episodeListMap = episodeListMapData ?? EMPTY_EPISODE_LIST_MAP;
	const derivedAiringData = useMemo(
		() =>
			deriveAiringMaps(
				episodeListMap,
				airingObservationMap,
				scheduleWeekdayMap,
				nowMs,
			),
		[episodeListMap, airingObservationMap, scheduleWeekdayMap, nowMs],
	);
	const episodeMap = derivedAiringData.airedEpMap;
	const nextAiringAtMap = derivedAiringData.nextAiringAtMap;
	const latestAiringAtMap = derivedAiringData.latestAiringAtMap;

	useEffect(() => {
		if (!isWatching || !isPageFocused) return;
		const nextScheduleBoundary = getNextScheduleBoundary(
			nextAiringAtMap.values(),
			nowMs,
		);
		const recentTagExpiry = getNextRecentAiringExpiry(
			latestAiringAtMap.values(),
			nowMs,
		);
		const nextClockBoundary = Math.min(
			nextScheduleBoundary,
			recentTagExpiry ?? Number.POSITIVE_INFINITY,
		);
		const shouldRefreshAiring =
			nextScheduleBoundary <= (recentTagExpiry ?? Number.POSITIVE_INFINITY);
		const timer = setTimeout(
			() => {
				syncClock();
				if (shouldRefreshAiring) {
					void queryClient.invalidateQueries({
						queryKey: ["anilist-airing-times-v2"],
					});
				}
			},
			Math.max(1000, nextClockBoundary - Date.now() + CLOCK_EPSILON_MS),
		);
		return () => clearTimeout(timer);
	}, [
		isWatching,
		isPageFocused,
		nextAiringAtMap,
		latestAiringAtMap,
		nowMs,
		queryClient,
		syncClock,
	]);

	// --- Merge all data sources ---
	const enrichedCollections = useMemo(
		() => enrichCollections(rawCollections, totalEpBackfill, episodeTotals),
		[rawCollections, totalEpBackfill, episodeTotals],
	);

	// 这组数据代表当前 React Query 状态；只有在缓存快照或完整网络状态就绪后才提交到 UI。
	const sortedCollections = useMemo(
		() =>
			sortCollections(enrichedCollections, calendarQuery.data ?? [], {
				nowMs,
				airedEpMap: episodeMap,
				airingSignalMap: airingObservationMap,
				nextAiringAtMap,
			}),
		[
			enrichedCollections,
			calendarQuery.data,
			nowMs,
			episodeMap,
			airingObservationMap,
			nextAiringAtMap,
		],
	);
	const sortedJustUpdatedSubjectIds = useMemo(
		() => getJustUpdatedSubjectIds(sortedCollections, latestAiringAtMap, nowMs),
		[sortedCollections, latestAiringAtMap, nowMs],
	);
	const sortedDisplayLabelMap = useMemo(() => {
		const map = new Map<number, string | null>();
		for (const sc of sortedCollections) {
			map.set(
				sc.collection.subject_id,
				getDisplayLabel(
					sc.collection,
					{ group: sc.group, weekday: sc.weekday, airedEp: sc.airedEp },
					{ nowMs, nextAiringAtMap },
				),
			);
		}
		return map;
	}, [sortedCollections, nowMs, nextAiringAtMap]);

	// --- Local v2 cache snapshot ---
	const cacheCollectionsData =
		cachedCollectionsSnapshot.key === collectionsCacheKey &&
		cachedCollectionsSnapshot.complete
			? cachedCollectionsSnapshot.value
			: null;
	const cacheRawCollections = useMemo(() => {
		const source = cacheCollectionsData?.data ?? EMPTY_COLLECTIONS;
		return source
			.map((collection) => {
				const patch = getOptimisticCollectionPatchForSubject(
					collection.subject_id,
					visibleCollectionTasks,
				);
				return patch ? { ...collection, ...patch } : collection;
			})
			.filter((collection) => collection.type === collectionType);
	}, [cacheCollectionsData, collectionType, visibleCollectionTasks]);
	const cacheCalendar = useMemo(
		() =>
			cachedCalendarSnapshot.key === "calendar" &&
			cachedCalendarSnapshot.complete
				? (cachedCalendarSnapshot.value ?? [])
				: [],
		[cachedCalendarSnapshot],
	);
	const cacheAiringMap = useMemo(() => getAiringMap(cacheCalendar), [cacheCalendar]);
	const cacheAiringObservationMap = useMemo(() => {
		const map = new Map<number, AiringObservation>();
		for (const [subjectId, record] of cachedAiringRecordMap ?? EMPTY_AIRING_RECORD_MAP) {
			const observation = toAiringObservation(record);
			if (observation) map.set(subjectId, observation);
		}
		return map;
	}, [cachedAiringRecordMap]);
	const cacheEpisodeListMap =
		cachedEpisodeSnapshot.key === episodeQuerySourceKey &&
		cachedEpisodeSnapshot.value
			? cachedEpisodeSnapshot.value
			: EMPTY_EPISODE_LIST_MAP;
	const cacheAiringMetadataIds = useMemo(
		() =>
			isWatching
				? cacheRawCollections
						.filter((item) => {
							const total = item.subject.eps || item.subject.total_episodes || 0;
							return (
								(total === 0 || item.ep_status < total) &&
								!cacheAiringMap.has(item.subject_id)
							);
						})
						.map((item) => item.subject_id)
				: [],
		[cacheRawCollections, cacheAiringMap, isWatching],
	);
	const cacheDerivedAiringData = useMemo(
		() =>
			deriveAiringMaps(
				cacheEpisodeListMap,
				cacheAiringObservationMap,
				cacheAiringMap,
				nowMs,
			),
		[cacheEpisodeListMap, cacheAiringObservationMap, cacheAiringMap, nowMs],
	);
	const cacheEnrichedCollections = useMemo(
		() => enrichCollections(cacheRawCollections, totalEpBackfill),
		[cacheRawCollections, totalEpBackfill],
	);
	const cacheSortedCollections = useMemo(
		() =>
			sortCollections(cacheEnrichedCollections, cacheCalendar, {
				nowMs,
				airedEpMap: cacheDerivedAiringData.airedEpMap,
				airingSignalMap: cacheAiringObservationMap,
				nextAiringAtMap: cacheDerivedAiringData.nextAiringAtMap,
			}),
		[
			cacheEnrichedCollections,
			cacheCalendar,
			nowMs,
			cacheDerivedAiringData.airedEpMap,
			cacheAiringObservationMap,
			cacheDerivedAiringData.nextAiringAtMap,
		],
	);
	const cacheJustUpdatedSubjectIds = useMemo(
		() =>
			getJustUpdatedSubjectIds(
				cacheSortedCollections,
				cacheDerivedAiringData.latestAiringAtMap,
				nowMs,
			),
		[cacheSortedCollections, cacheDerivedAiringData.latestAiringAtMap, nowMs],
	);
	const cacheDisplayLabelMap = useMemo(() => {
		const map = new Map<number, string | null>();
		for (const sc of cacheSortedCollections) {
			map.set(
				sc.collection.subject_id,
				getDisplayLabel(
					sc.collection,
					{ group: sc.group, weekday: sc.weekday, airedEp: sc.airedEp },
					{
						nowMs,
						nextAiringAtMap: cacheDerivedAiringData.nextAiringAtMap,
					},
				),
			);
		}
		return map;
	}, [
		cacheSortedCollections,
		nowMs,
		cacheDerivedAiringData.nextAiringAtMap,
	]);

	const hasCachedCollections =
		cachedCollectionsSnapshot.key === collectionsCacheKey &&
		cachedCollectionsSnapshot.complete &&
		cachedCollectionsSnapshot.value !== null;
	const hasCachedAiringMetadata =
		!isWatching ||
		cacheAiringMetadataIds.length === 0 ||
		(cachedAiringTimeFetched &&
			cachedAiringRecordMap !== undefined &&
			cacheAiringMetadataIds.every((subjectId) =>
				cachedAiringRecordMap.has(subjectId),
			));
	const shouldLoadEpisodes = isWatching && allEpisodeIds.length > 0;
	const hasCachedEpisodes =
		!shouldLoadEpisodes ||
		(cachedEpisodeSnapshot.key === episodeQuerySourceKey &&
			cachedEpisodeSnapshot.complete &&
			cachedEpisodeSnapshot.value !== null);
	const canCommitCacheSnapshot =
		Boolean(username) &&
		hasCachedCollections &&
		hasCachedAiringMetadata &&
		hasCachedEpisodes;

	const isDisplayDependencyError =
		(!collectionsQuery.data && collectionsQuery.isError) ||
		(isWatching && !calendarQuery.data && calendarQuery.isError) ||
		(isWatching && !airingRecordMapData && isAiringTimeError) ||
		(isWatching && !episodeListMapData && isEpisodeError);
	const isDisplayDataAvailable =
		Boolean(username) &&
		collectionsQuery.data !== undefined &&
		(!isWatching || calendarQuery.data !== undefined) &&
		(!shouldReadAiringTimeCache || cachedAiringTimeFetched) &&
		(!shouldLoadAiringTimes || airingRecordMapData !== undefined) &&
		(!shouldLoadEpisodes || episodeListMapData !== undefined);
	const isDisplayNetworkIdle =
		backgroundRefreshCount === 0 &&
		!collectionsQuery.isFetching &&
		(!isWatching || !calendarQuery.isFetching) &&
		(!shouldLoadAiringTimes || !isAiringTimeFetching) &&
		(!shouldLoadEpisodes || !isEpisodeFetching);
	const isDisplayReady =
		isDisplayDataAvailable && isDisplayNetworkIdle && !isDisplayDependencyError;
	const committedScopeKey = `${username}:${collectionType}`;
	const cacheCommittedVersion = [
		committedScopeKey,
		cachedCollectionsSnapshot.version,
		cachedCalendarSnapshot.version,
		cachedEpisodeSnapshot.version,
		cachedAiringTimeUpdatedAt,
		totalEpBackfillUpdatedAt,
		episodeTotalsUpdatedAt,
		nowMs,
		"cache",
	].join("|");
	const committedVersion = [
		committedScopeKey,
		collectionsQuery.dataUpdatedAt,
		calendarQuery.dataUpdatedAt,
		cachedAiringTimeUpdatedAt,
		airingTimeUpdatedAt,
		episodeUpdatedAt,
		totalEpBackfillUpdatedAt,
		episodeTotalsUpdatedAt,
		nowMs,
		"network",
	].join("|");

	useEffect(() => {
		if (!username) {
			setCommittedState(null);
			return;
		}
		if (!isDisplayReady && !canCommitCacheSnapshot) return;

		const useSettledData = isDisplayReady;
		const nextVersion = useSettledData
			? committedVersion
			: cacheCommittedVersion;
		const nextSorted = useSettledData
			? sortedCollections
			: cacheSortedCollections;
		const nextDisplayLabelMap = useSettledData
			? sortedDisplayLabelMap
			: cacheDisplayLabelMap;
		const nextJustUpdatedSubjectIds = useSettledData
			? sortedJustUpdatedSubjectIds
			: cacheJustUpdatedSubjectIds;

		setCommittedState((previous) => {
			// 网络刷新期间保留当前已经提交的快照，避免闪回到不完整数据。
			if (!useSettledData && previous?.scopeKey === committedScopeKey) {
				return previous;
			}
			if (
				previous?.scopeKey === committedScopeKey &&
				previous.version === nextVersion
			) {
				return previous;
			}
			return {
				scopeKey: committedScopeKey,
				version: nextVersion,
				sorted: nextSorted,
				displayLabelMap: nextDisplayLabelMap,
				justUpdatedSubjectIds: nextJustUpdatedSubjectIds,
			};
		});
	}, [
		cacheCommittedVersion,
		cacheDisplayLabelMap,
		cacheJustUpdatedSubjectIds,
		cacheSortedCollections,
		canCommitCacheSnapshot,
		committedScopeKey,
		committedVersion,
		isDisplayReady,
		sortedCollections,
		sortedDisplayLabelMap,
		sortedJustUpdatedSubjectIds,
		username,
	]);

	const activeCommittedState =
		committedState?.scopeKey === committedScopeKey ? committedState : null;
	const visibleSorted = activeCommittedState?.sorted ?? EMPTY_SORTED_COLLECTIONS;
	const visibleDisplayLabelMap =
		activeCommittedState?.displayLabelMap ?? EMPTY_DISPLAY_LABEL_MAP;
	const visibleJustUpdatedSubjectIds =
		activeCommittedState?.justUpdatedSubjectIds ?? EMPTY_SUBJECT_ID_SET;
	const collections = useMemo(
		() => visibleSorted.filter((item) => matchesSearch(item.collection, searchQuery)),
		[searchQuery, visibleSorted],
	);
	const justUpdatedSubjectIds = visibleJustUpdatedSubjectIds;
	const displayLabelMap = visibleDisplayLabelMap;

	// --- Pagination ---
	const totalPages = Math.max(1, Math.ceil(collections.length / PAGE_SIZE));

	// --- Grouped sections for the watching tab ---
	// 组计数取全量（搜索过滤后）而非本页，翻页时组头信息保持稳定
	const groupCounts = useMemo(() => {
		const map = new Map<SortedGroup, number>();
		for (const sc of collections) {
			map.set(sc.group, (map.get(sc.group) ?? 0) + 1);
		}
		return map;
	}, [collections]);

	const getSectionsForPage = useCallback(
		(pageNumber: number): CollectionSection[] => {
			const pageItems = collections.slice(
				(pageNumber - 1) * PAGE_SIZE,
				pageNumber * PAGE_SIZE,
			);
			// 非在看 tab：单 section 平铺，不渲染组头
			if (!isWatching) {
				return [{ data: pageItems }];
			}
			const result: CollectionSection[] = [];
			for (const item of pageItems) {
				const last = result[result.length - 1];
				if (last && last.group === item.group) {
					last.data.push(item);
				} else {
					// 每页首个 section 无条件带组头：跨页延续的组在后续页也能看到组名
					result.push({
						group: item.group,
						title: GROUP_LABEL[item.group],
						color: GROUP_COLOR[item.group],
						count: groupCounts.get(item.group) ?? 0,
						data: [item],
					});
				}
			}
			return result;
		},
		[collections, groupCounts, isWatching],
	);

	// Reset page when collection type or search changes
	useEffect(() => {
		setPage(1);
	}, [collectionType, searchQuery]);

	// Clamp page when totalPages shrinks
	useEffect(() => {
		if (page > totalPages) setPage(totalPages);
	}, [totalPages, page]);

	useEffect(() => {
		if (visibleCollectionTasks.length === 0) {
			setTaskPanelExpanded(false);
		}
	}, [visibleCollectionTasks.length]);

	async function refresh() {
		if (!username) return;
		setRefreshing(true);
		try {
			airingRefreshGenerationRef.current += 1;
			await Promise.all([
				queryClient.cancelQueries({
					queryKey: ["anilist-airing-times-cache-v2"],
				}),
				queryClient.cancelQueries({
					queryKey: ["anilist-airing-times-v2"],
				}),
				queryClient.cancelQueries({ queryKey: ["episodes-schedule-v2"] }),
			]);
			await Promise.all([
				deleteCachedValuesByPrefix(AIRING_CACHE_PREFIX),
				deleteCachedValuesByPrefix(EPISODES_CACHE_PREFIX),
			]);
			setCachedEpisodeSnapshot({
				key: "",
				value: null,
				version: Date.now(),
				complete: false,
			});
			queryClient.removeQueries({
				queryKey: ["anilist-airing-times-cache-v2"],
			});
			queryClient.removeQueries({ queryKey: ["anilist-airing-times-v2"] });
			queryClient.removeQueries({ queryKey: ["episodes-schedule-v2"] });
			syncClock();
			const [nextCollections, nextCalendar] = await Promise.all([
				loadCollections(collectionType, username, true),
				loadCalendar(true),
			]);
			queryClient.setQueryData(
				["collections", collectionType, username],
				nextCollections,
			);
			queryClient.setQueryData(["calendar"], nextCalendar);
			setCachedCollectionsSnapshot({
				key: collectionsCacheKey,
				value: nextCollections,
				version: Date.now(),
				complete: true,
			});
			setCachedCalendarSnapshot({
				key: "calendar",
				value: nextCalendar,
				version: Date.now(),
				complete: true,
			});
			queryClient.invalidateQueries({ queryKey: ["totalep-backfill"] });
			queryClient.invalidateQueries({ queryKey: ["episode-totals"] });
			queryClient.invalidateQueries({
				queryKey: ["anilist-airing-times-cache-v2"],
			});
			queryClient.invalidateQueries({ queryKey: ["anilist-airing-times-v2"] });
			queryClient.invalidateQueries({ queryKey: ["episodes-schedule-v2"] });
		} catch (error) {
			alert("刷新失败", error instanceof Error ? error.message : "请稍后重试");
		} finally {
			setRefreshing(false);
		}
	}

	async function copyTitle(collection: UserCollection) {
		const title = collection.subject.name_cn || collection.subject.name;
		await Clipboard.setStringAsync(await getSubjectTitleForCopy(title));
		alert("已复制", title);
	}

	const collectionTask = visibleCollectionTasks[0];
	const displayError = collectionsQuery.error ?? calendarQuery.error;
	const isDisplayLoading =
		collectionsQuery.isLoading ||
		(!activeCommittedState &&
			!collectionsQuery.isError &&
			(!isDisplayDependencyError || canCommitCacheSnapshot));
	const isDisplayError =
		!activeCommittedState &&
		!canCommitCacheSnapshot &&
		(isDisplayDependencyError || (collectionsQuery.isError && !collectionsQuery.data));
	if (checking) return <LoadingState label="检查登录状态" />;
	if (!loggedIn) return <LoadingState label="跳转登录" />;

	return (
		<View style={styles.screen}>
			<SegmentedControl
				options={COLLECTION_OPTIONS}
				value={collectionType}
				onChange={setCollectionType}
			/>
			{isDisplayLoading ? (
				<LoadingState label="加载收藏" />
			) : isDisplayError ? (
				<ErrorState
					message={
						displayError instanceof Error
							? displayError.message
							: "无法加载收藏相关数据"
					}
					onRetry={() => void refresh()}
				/>
			) : (
				<SwipePager
					page={page}
					pageCount={totalPages}
					onPageChange={setPage}
					renderPage={(pageNumber) => {
						const pageItems = collections.slice(
							(pageNumber - 1) * PAGE_SIZE,
							pageNumber * PAGE_SIZE,
						);
						const pageListContentStyle = [
							pageItems.length ? styles.list : styles.emptyList,
							collectionTask
								? taskPanelExpanded
									? styles.listWithExpandedTaskDock
									: styles.listWithTaskDock
								: null,
						];

						return (
							<SectionList
								sections={getSectionsForPage(pageNumber)}
								keyExtractor={(item) => String(item.collection.subject_id)}
								contentContainerStyle={pageListContentStyle}
								refreshControl={
								<RefreshControl
									refreshing={refreshing}
									onRefresh={refresh}
									tintColor={colors.primary}
									colors={[colors.primary]}
								/>
							}
							ListHeaderComponent={
								<View style={styles.headerRow}>
									<Text style={styles.count}>
										{CollectionTypeLabel[collectionType]} · {collections.length}
										{collections.length !== (collectionsQuery.data?.total ?? 0)
											? ` / ${collectionsQuery.data?.total ?? 0}`
											: ""}
									</Text>
									{collections.length > 0 && (
										<Text style={styles.pageInfo}>
											第 {pageNumber} / {totalPages} 页 · 共 {collections.length} 条
										</Text>
									)}
								</View>
							}
							ItemSeparatorComponent={() => <View style={styles.separator} />}
							ListEmptyComponent={
								<EmptyState title="没有匹配条目" detail="调整搜索词或切换收藏类型" />
							}
							renderSectionHeader={
								isWatching
									? ({ section }) => {
											const s = section as CollectionSection;
											if (!s.group) return null;
											return (
												<View style={styles.groupHeader}>
													<View
														style={[styles.groupHeaderBar, { backgroundColor: s.color }]}
													/>
													<Text style={styles.groupHeaderTitle}>{s.title}</Text>
													<Text style={styles.groupHeaderCount}>· {s.count}</Text>
												</View>
											);
										}
									: undefined
							}
							renderItem={({ item }) => {
								const c = item.collection;
								const subject = c.subject;
								const title = subject.name_cn || subject.name;
								const total = subject.total_episodes || subject.eps || 0;
								const label = isWatching
									? (displayLabelMap.get(c.subject_id) ?? undefined)
									: undefined;
								const badges = justUpdatedSubjectIds.has(c.subject_id)
									? [{ text: "刚更新", tone: "recent" as const }]
									: undefined;
								return (
									<SubjectCard
										title={title}
										subtitle={subject.name}
										coverUrl={getPreferredSubjectCoverUrl(subject)}
										accentColor={isWatching ? GROUP_COLOR[item.group] : undefined}
										badges={badges}
										label={label}
										progress={`${c.ep_status}/${total || "?"} 集`}
										meta={[
											SubjectTypeLabel[subject.type] ?? "条目",
											subject.date || "日期未知",
											(subject.score ?? subject.rating?.score)
												? `评分 ${(subject.score ?? subject.rating!.score).toFixed(1)}`
												: "暂无评分",
										]}
										onPress={() => router.push(`/subject/${c.subject_id}`)}
										onLongPress={() => void copyTitle(c)}
									/>
								);
							}}
						/>
						);
					}}
				/>
			)}

			{collectionTask ? (
				<View pointerEvents="box-none" style={styles.taskDock}>
					<View style={[styles.taskCapsule, taskPanelExpanded && styles.taskPanel]}>
						<Pressable
							style={styles.taskHeader}
							onPress={() => setTaskPanelExpanded((value) => !value)}
						>
							<View
								style={[
									styles.taskIcon,
									collectionTask.status === "failed" && styles.taskIconDanger,
									collectionTask.status === "running" && styles.taskIconActive,
								]}
							>
								<Ionicons
									name={
										collectionTask.status === "failed"
											? "alert-circle"
											: collectionTask.status === "running"
												? "sync"
												: "time-outline"
									}
									size={16}
									color={
										collectionTask.status === "failed" ? colors.danger : colors.primary
									}
								/>
							</View>
							<View style={styles.taskHeaderText}>
								<Text style={styles.taskTitle} numberOfLines={1}>
									{getCollectionTaskSummary(collectionTask)}
								</Text>
								<Text
									style={[
										styles.taskMeta,
										collectionTask.status === "failed" && styles.taskError,
									]}
									numberOfLines={1}
								>
									{getTaskStatusLabel(collectionTask)}
									{visibleCollectionTasks.length > 1
										? ` · 共 ${visibleCollectionTasks.length} 个任务`
										: ""}
								</Text>
							</View>
							{visibleCollectionTasks.length > 1 ? (
								<View style={styles.taskCountPill}>
									<Text style={styles.taskCountText}>
										{visibleCollectionTasks.length}
									</Text>
								</View>
							) : null}
							<Ionicons
								name={taskPanelExpanded ? "chevron-down" : "chevron-up"}
								size={18}
								color={colors.muted}
							/>
						</Pressable>

						{taskPanelExpanded ? (
							<ScrollView
								style={styles.taskList}
								contentContainerStyle={styles.taskListContent}
							>
								{visibleCollectionTasks.map((task) => (
									<View key={task.id} style={styles.taskItem}>
										<View style={styles.taskItemText}>
											<Text style={styles.taskItemTitle} numberOfLines={1}>
												{getCollectionTaskSummary(task)}
											</Text>
											<Text
												style={[
													styles.taskItemMeta,
													task.status === "failed" && styles.taskError,
												]}
												numberOfLines={1}
											>
												{task.status === "failed" && task.lastError
													? task.lastError
													: getTaskStatusLabel(task)}
											</Text>
										</View>
										{task.status === "failed" ? (
											<Pressable
												style={styles.taskActionButton}
												onPress={() => void retryCollectionTask(task.id)}
											>
												<Ionicons name="refresh" size={15} color={colors.primary} />
											</Pressable>
										) : null}
										{task.status !== "running" ? (
											<Pressable
												style={styles.taskActionButton}
												onPress={() => void ignoreCollectionTask(task.id)}
											>
												<Ionicons name="close" size={16} color={colors.muted} />
											</Pressable>
										) : null}
									</View>
								))}
							</ScrollView>
						) : null}
					</View>
				</View>
			) : null}
		</View>
	);
}

const styles = StyleSheet.create({
	screen: {
		flex: 1,
		backgroundColor: colors.background,
	},
	list: {
		padding: 16,
		paddingTop: 4,
		paddingBottom: 28,
	},
	listWithTaskDock: {
		paddingBottom: 104,
	},
	listWithExpandedTaskDock: {
		paddingBottom: 238,
	},
	emptyList: {
		flexGrow: 1,
		padding: 16,
	},
	taskDock: {
		position: "absolute",
		left: 14,
		right: 14,
		bottom: 14,
	},
	taskCapsule: {
		borderRadius: 24,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.border,
		backgroundColor: colors.surfaceAlt,
		shadowColor: "#000",
		shadowOpacity: 0.28,
		shadowRadius: 16,
		shadowOffset: { width: 0, height: 8 },
		elevation: 14,
		overflow: "hidden",
	},
	taskPanel: {
		borderRadius: 18,
	},
	taskHeader: {
		minHeight: 58,
		flexDirection: "row",
		alignItems: "center",
		gap: 10,
		paddingHorizontal: 12,
		paddingVertical: 10,
	},
	taskIcon: {
		width: 34,
		height: 34,
		borderRadius: 17,
		alignItems: "center",
		justifyContent: "center",
		backgroundColor: colors.chip,
	},
	taskIconActive: {
		backgroundColor: colors.primaryMuted,
	},
	taskIconDanger: {
		backgroundColor: "#3a2429",
	},
	taskHeaderText: {
		flex: 1,
		minWidth: 0,
	},
	taskTitle: {
		color: colors.text,
		fontSize: 13,
		fontWeight: "800",
	},
	taskMeta: {
		marginTop: 2,
		color: colors.muted,
		fontSize: 12,
		fontWeight: "600",
	},
	taskError: {
		color: colors.danger,
	},
	taskCountPill: {
		minWidth: 24,
		height: 24,
		alignItems: "center",
		justifyContent: "center",
		paddingHorizontal: 7,
		borderRadius: 12,
		backgroundColor: colors.chip,
	},
	taskCountText: {
		color: colors.primary,
		fontSize: 12,
		fontWeight: "800",
	},
	taskList: {
		maxHeight: 220,
		borderTopWidth: StyleSheet.hairlineWidth,
		borderTopColor: colors.border,
	},
	taskListContent: {
		gap: 7,
		padding: 8,
	},
	taskItem: {
		minHeight: 50,
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
		paddingLeft: 10,
		paddingRight: 6,
		paddingVertical: 7,
		borderRadius: 12,
		backgroundColor: colors.surface,
	},
	taskItemText: {
		flex: 1,
		minWidth: 0,
	},
	taskItemTitle: {
		color: colors.text,
		fontSize: 12,
		fontWeight: "700",
	},
	taskItemMeta: {
		marginTop: 2,
		color: colors.muted,
		fontSize: 11,
	},
	taskActionButton: {
		width: 32,
		height: 32,
		alignItems: "center",
		justifyContent: "center",
		borderRadius: 16,
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: colors.border,
		backgroundColor: colors.background,
	},
	separator: {
		height: 10,
	},
	count: {
		color: colors.muted,
		fontSize: 13,
		fontWeight: "600",
	},
	headerRow: {
		flexDirection: "row",
		justifyContent: "space-between",
		alignItems: "center",
		marginBottom: 10,
		paddingHorizontal: 1,
	},
	pageInfo: {
		color: colors.muted,
		fontSize: 13,
		fontWeight: "600",
	},
	groupHeader: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
		paddingVertical: 12,
		paddingHorizontal: 2,
		// 吸顶组头盖住滚动内容，需不透明背景
		backgroundColor: colors.background,
	},
	groupHeaderBar: {
		width: 4,
		height: 16,
		borderRadius: 2,
	},
	groupHeaderTitle: {
		color: colors.text,
		fontSize: 14,
		fontWeight: "800",
	},
	groupHeaderCount: {
		color: colors.muted,
		fontSize: 12,
		fontWeight: "600",
	},
});
