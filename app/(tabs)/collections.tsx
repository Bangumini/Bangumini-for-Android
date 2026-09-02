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
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
	runOnJS,
	useAnimatedStyle,
	useSharedValue,
	withSequence,
	withSpring,
	withTiming,
} from "react-native-reanimated";
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
	getNextEpisodeAiringAt,
	getNextScheduleBoundary,
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
	deleteCachedValuesByPrefix,
	getPreferredSubjectCoverUrl,
	readCachedCollection,
	readCachedSubject,
	readCachedValue,
	readCachedValueWithin,
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
import { SearchInput } from "../../src/components/SearchInput";
import { SegmentedControl } from "../../src/components/SegmentedControl";
import {
	EmptyState,
	ErrorState,
	LoadingState,
} from "../../src/components/ScreenState";
import { SubjectCard } from "../../src/components/SubjectCard";
import { useAuth } from "../../src/hooks/useAuth";
import { colors } from "../../src/theme/colors";
import { useAlert } from "../../src/components/Dialog";

const CACHE_MAX_AGE = 1000 * 60 * 60 * 24;
const AIRING_CACHE_PREFIX = "anilist-airing-v2-";
const LEGACY_AIRING_CACHE_PREFIX = "anilist-airing-";
const EPISODES_CACHE_PREFIX = "episodes-schedule-v2-";
const LEGACY_EPISODES_CACHE_PREFIX = "episodes-";
const AIRING_REQUEST_DELAY = 700;
const EPISODES_CACHE_MAX_AGE = 1000 * 60 * 30;
const CLOCK_EPSILON_MS = 1000;
const PAGE_SIZE = 20;

const EMPTY_AIRING_MAP = new Map<number, number>();
const EMPTY_AIRING_RECORD_MAP = new Map<number, AiringCacheRecord>();
const EMPTY_EPISODE_LIST_MAP = new Map<number, Episode[]>();

type EpisodeScheduleCache = {
	episodes: Episode[];
	checkedAt: number;
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
	for (const id of uniqueIds) {
		const value = cachedByKey.get(`${AIRING_CACHE_PREFIX}${id}`);
		if (isAiringCacheRecord(value) && isAiringRecordUsable(value, nowMs)) {
			map.set(id, value);
		}
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
	return Array.isArray(cache.episodes) && typeof cache.checkedAt === "number";
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
	for (const [subjectId, episodes] of episodeListMap) {
		const observation = observationMap.get(subjectId);
		const schedule = observation
			? deriveAiringSchedule(airingMap.get(subjectId), episodes, observation)
			: null;
		if (schedule) scheduleMap.set(subjectId, schedule);
		airedEpMap.set(subjectId, deriveAiredEpisodeCount(episodes, schedule, nowMs));
		const nextAiringAt = getNextEpisodeAiringAt(episodes, schedule, nowMs);
		if (nextAiringAt !== null) nextAiringAtMap.set(subjectId, nextAiringAt);
	}
	return { scheduleMap, airedEpMap, nextAiringAtMap };
}

async function loadCollections(
	type: CollectionType,
	username: string,
	force = false,
) {
	const cacheKey = `collections-${type}-${username}`;
	if (!force) {
		const cached = await readCachedValueWithin<PagedResponse<UserCollection>>(
			cacheKey,
			CACHE_MAX_AGE,
		);
		const cacheHit =
			cached ?? (await readCachedValue<PagedResponse<UserCollection>>(cacheKey));
		if (cacheHit) {
			await mergeSubjectCollections(cacheHit, username);
			cacheHit.data = cacheHit.data.filter((c) => c.type === type);

			return cacheHit;
		}
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
		const cached = await readCachedValueWithin<CalendarItem[]>(
			"calendar",
			CACHE_MAX_AGE,
		);
		const cacheHit =
			cached ?? (await readCachedValue<CalendarItem[]>("calendar"));
		if (cacheHit) return cacheHit;
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

export default function CollectionsPage() {
	const alert = useAlert();
	const queryClient = useQueryClient();
	const { checking, loggedIn, username } = useAuth();
	const [collectionType, setCollectionType] = useState<CollectionType>(3);
	const [search, setSearch] = useState("");
	const [refreshing, setRefreshing] = useState(false);
	const [page, setPage] = useState(1);
	const [collectionTasks, setCollectionTasks] = useState<CollectionTask[]>([]);
	const [taskPanelExpanded, setTaskPanelExpanded] = useState(false);
	const [nowMs, setNowMs] = useState(() => Date.now());
	const [isPageFocused, setIsPageFocused] = useState(false);
	const airingRefreshGenerationRef = useRef(0);
	const syncClock = useCallback(() => setNowMs(Date.now()), []);

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
			void queryClient.invalidateQueries({
				queryKey: ["episodes-schedule-v2"],
			});
			void queryClient.invalidateQueries({
				queryKey: ["anilist-airing-times-v2"],
			});
			return () => setIsPageFocused(false);
		}, [queryClient, syncClock]),
	);

	// --- Pagination: animated swipe between pages ---
	const translateX = useSharedValue(0);
	const fadeAnim = useSharedValue(1);
	const currentPageSV = useSharedValue(1);
	const totalPagesSV = useSharedValue(1);

	const goToPrevPage = useCallback(() => {
		setPage((p) => Math.max(1, p - 1));
	}, []);

	const goToNextPage = useCallback(() => {
		setPage((p) => p + 1); // clamped by useEffect below
	}, []);

	const panGesture = Gesture.Pan()
		.activeOffsetX([-10, 10])
		.failOffsetY([-10, 10])
		.onUpdate((e) => {
			translateX.value = e.translationX;
		})
		.onEnd((e) => {
			"worklet";
			const threshold = 40;
			if (e.translationX > threshold && currentPageSV.value > 1) {
				translateX.value = withTiming(0, { duration: 180 });
				fadeAnim.value = withSequence(
					withTiming(0, { duration: 80 }),
					withTiming(1, { duration: 120 }),
				);
				currentPageSV.value -= 1;
				runOnJS(goToPrevPage)();
			} else if (
				e.translationX < -threshold &&
				currentPageSV.value < totalPagesSV.value
			) {
				translateX.value = withTiming(0, { duration: 180 });
				fadeAnim.value = withSequence(
					withTiming(0, { duration: 80 }),
					withTiming(1, { duration: 120 }),
				);
				currentPageSV.value += 1;
				runOnJS(goToNextPage)();
			} else {
				translateX.value = withSpring(0, { damping: 20, stiffness: 300 });
			}
		});

	const animatedStyle = useAnimatedStyle(() => ({
		transform: [{ translateX: translateX.value }],
		opacity: fadeAnim.value,
	}));

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

	const collectionsQuery = useQuery({
		queryKey: ["collections", collectionType, username],
		enabled: loggedIn && !!username,
		queryFn: () => loadCollections(collectionType, username),
	});

	const calendarQuery = useQuery({
		queryKey: ["calendar"],
		enabled: loggedIn && !!username,
		queryFn: () => loadCalendar(),
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
	const { data: totalEpBackfill } = useQuery({
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

	const { data: episodeTotals } = useQuery({
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
	const { data: cachedAiringRecordMap, isFetched: cachedAiringTimeFetched } =
		useQuery({
			queryKey: ["anilist-airing-times-cache-v2", airingTimeCacheKey],
			queryFn: () => readCachedAiringRecords(airingTimeCacheIds),
			enabled: airingTimeCacheIds.length > 0,
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

	const { data: airingRecordMapData } = useQuery({
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
		enabled: airingTimeTargets.length > 0 && cachedAiringTimeFetched,
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
	const { data: episodeListMapData } = useQuery({
		queryKey: ["episodes-schedule-v2", allEpisodeIds.join(",")],
		queryFn: async () => {
			const generation = airingRefreshGenerationRef.current;
			const map = new Map<number, Episode[]>();
			const cachedRecords = new Map<number, EpisodeScheduleCache>();
			const idsToFetch: number[] = [];
			const cachedByKey = await readCachedValues<unknown>(
				allEpisodeIds.map(getEpisodeCacheKey),
			);
			const checkedAt = Date.now();
			for (const id of allEpisodeIds) {
				const cached = cachedByKey.get(getEpisodeCacheKey(id));
				if (isEpisodeScheduleCache(cached)) {
					cachedRecords.set(id, cached);
					if (checkedAt - cached.checkedAt <= EPISODES_CACHE_MAX_AGE) {
						map.set(id, cached.episodes);
						continue;
					}
				}
				idsToFetch.push(id);
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

	useEffect(() => {
		if (!isWatching || !isPageFocused) return;
		const nextBoundary = getNextScheduleBoundary(nextAiringAtMap.values(), nowMs);
		const timer = setTimeout(
			() => {
				syncClock();
				void queryClient.invalidateQueries({
					queryKey: ["anilist-airing-times-v2"],
				});
			},
			Math.max(1000, nextBoundary - Date.now() + CLOCK_EPSILON_MS),
		);
		return () => clearTimeout(timer);
	}, [
		isWatching,
		isPageFocused,
		nextAiringAtMap,
		nowMs,
		queryClient,
		syncClock,
	]);

	// --- Background refresh: always fetch network data after showing cache ---
	const lastRefreshedKeyRef = useRef<string | null>(null);

	useEffect(() => {
		const refreshKey = `collections-${collectionType}-${username}`;
		if (!username || !collectionsQuery.data) return;
		if (lastRefreshedKeyRef.current === refreshKey) return;
		lastRefreshedKeyRef.current = refreshKey;

		let cancelled = false;

		const doRefresh = async () => {
			try {
				const [networkCollections, networkCalendar] = await Promise.all([
					getAllUserCollections({ username: username!, type: collectionType }),
					getCalendar(),
				]);
				if (cancelled) return;

				const cacheKey = `collections-${collectionType}-${username}`;
				await writeCachedValue(cacheKey, networkCollections);
				await writeCachedSubjectPreviews(
					networkCollections.data.map((c) => c.subject),
				);
				Promise.allSettled(
					networkCollections.data.map((c) => writeCachedCollection(username!, c)),
				).catch(() => {});

				await writeCachedValue("calendar", networkCalendar);
				await writeCachedSubjectPreviews(
					networkCalendar.flatMap((day) => day.items),
				);

				const currentCollections = queryClient.getQueryData<
					PagedResponse<UserCollection>
				>(["collections", collectionType, username]);
				const currentCalendar = queryClient.getQueryData<CalendarItem[]>([
					"calendar",
				]);

				const filtered = {
					...networkCollections,
					data: networkCollections.data.filter((c) => c.type === collectionType),
				};

				if (
					currentCollections &&
					JSON.stringify(currentCollections.data) !== JSON.stringify(filtered.data)
				) {
					queryClient.setQueryData(
						["collections", collectionType, username],
						filtered,
					);
					queryClient.invalidateQueries({ queryKey: ["totalep-backfill"] });
					queryClient.invalidateQueries({ queryKey: ["episode-totals"] });
					queryClient.invalidateQueries({
						queryKey: ["anilist-airing-times-v2"],
					});
					queryClient.invalidateQueries({
						queryKey: ["episodes-schedule-v2"],
					});
				}

				if (
					currentCalendar &&
					JSON.stringify(currentCalendar) !== JSON.stringify(networkCalendar)
				) {
					queryClient.setQueryData(["calendar"], networkCalendar);
				}
			} catch {
				// Ignore background refresh errors — user still sees cached data
			}
		};

		doRefresh();

		return () => {
			cancelled = true;
		};
	}, [collectionType, username, collectionsQuery.data, queryClient]);

	// --- Merge all data sources ---
	const enrichedCollections = useMemo(() => {
		return rawCollections.map((c) => {
			const src = c.subject;
			const s = { ...src };

			// Patch total_episodes from all available sources
			// Prefer actual episode counts over declared counts (eps can be inaccurate)
			if (s.total_episodes == null || s.total_episodes === 0) {
				// Source 1: fresh episode fetches (most reliable — counts actual type-0 episodes)
				if (episodeTotals) {
					const v = episodeTotals.get(s.id);
					if (v) s.total_episodes = v;
				}
				// Source 2: SQLite backfill (from detail page visits)
				if (
					(s.total_episodes == null || s.total_episodes === 0) &&
					totalEpBackfill
				) {
					const v = totalEpBackfill.get(s.id);
					if (v) s.total_episodes = v;
				}
				// Source 3: eps field from API (least reliable — may include SPs or differ from actual)
				if ((s.total_episodes == null || s.total_episodes === 0) && s.eps > 0) {
					s.total_episodes = s.eps;
				}
			}

			// Normalize rating: API returns null, convert to undefined for optional chaining
			if (s.rating == null) {
				(s as Record<string, unknown>).rating = undefined;
			}

			return { ...c, subject: s };
		});
	}, [rawCollections, totalEpBackfill, episodeTotals]);

	// --- Sort and label from one clock snapshot ---
	const collections = useMemo(() => {
		const sorted: SortedCollection[] = sortCollections(
			enrichedCollections,
			calendarQuery.data ?? [],
			{
				nowMs,
				airedEpMap: episodeMap,
				airingSignalMap: airingObservationMap,
				nextAiringAtMap,
			},
		);
		return sorted.filter((sc) => matchesSearch(sc.collection, searchQuery));
	}, [
		enrichedCollections,
		calendarQuery.data,
		nowMs,
		episodeMap,
		airingObservationMap,
		nextAiringAtMap,
		searchQuery,
	]);

	const displayLabelMap = useMemo(() => {
		const map = new Map<number, string | null>();
		for (const sc of collections) {
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
	}, [collections, nowMs, nextAiringAtMap]);

	// --- Pagination ---
	const totalPages = Math.max(1, Math.ceil(collections.length / PAGE_SIZE));
	const paged = useMemo(
		() => collections.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
		[collections, page],
	);

	// --- Grouped sections for the watching tab ---
	// 组计数取全量（搜索过滤后）而非本页，翻页时组头信息保持稳定
	const groupCounts = useMemo(() => {
		const map = new Map<SortedGroup, number>();
		for (const sc of collections) {
			map.set(sc.group, (map.get(sc.group) ?? 0) + 1);
		}
		return map;
	}, [collections]);

	const sections = useMemo<CollectionSection[]>(() => {
		// 非在看 tab：单 section 平铺，不渲染组头
		if (!isWatching) {
			return [{ data: paged }];
		}
		const result: CollectionSection[] = [];
		for (const item of paged) {
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
	}, [paged, isWatching, groupCounts]);

	// Keep shared values in sync for worklet access
	useEffect(() => {
		currentPageSV.value = page;
	}, [page, currentPageSV]);
	useEffect(() => {
		totalPagesSV.value = totalPages;
	}, [totalPages, totalPagesSV]);

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
				deleteCachedValuesByPrefix(LEGACY_AIRING_CACHE_PREFIX),
				deleteCachedValuesByPrefix(EPISODES_CACHE_PREFIX),
				deleteCachedValuesByPrefix(LEGACY_EPISODES_CACHE_PREFIX),
			]);
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
	const listContentStyle = [
		paged.length ? styles.list : styles.emptyList,
		collectionTask
			? taskPanelExpanded
				? styles.listWithExpandedTaskDock
				: styles.listWithTaskDock
			: null,
	];

	if (checking) return <LoadingState label="检查登录状态" />;
	if (!loggedIn) return <LoadingState label="跳转登录" />;

	return (
		<View style={styles.screen}>
			<SegmentedControl
				options={COLLECTION_OPTIONS}
				value={collectionType}
				onChange={setCollectionType}
			/>
			<SearchInput
				value={search}
				onChangeText={setSearch}
				placeholder={`搜索${CollectionTypeLabel[collectionType]}`}
			/>

			{collectionsQuery.isLoading ? (
				<LoadingState label="加载收藏" />
			) : collectionsQuery.isError && !collectionsQuery.data ? (
				<ErrorState
					message={
						collectionsQuery.error instanceof Error
							? collectionsQuery.error.message
							: "无法加载收藏"
					}
					onRetry={() => void collectionsQuery.refetch()}
				/>
			) : (
				<GestureDetector gesture={panGesture}>
					<Animated.View style={[animatedStyle, { flex: 1 }]}>
						<SectionList
							sections={sections}
							keyExtractor={(item) => String(item.collection.subject_id)}
							contentContainerStyle={listContentStyle}
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
											第 {page} / {totalPages} 页 · 共 {collections.length} 条
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
								return (
									<SubjectCard
										title={title}
										subtitle={subject.name}
										coverUrl={getPreferredSubjectCoverUrl(subject)}
										accentColor={isWatching ? GROUP_COLOR[item.group] : undefined}
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
					</Animated.View>
				</GestureDetector>
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
