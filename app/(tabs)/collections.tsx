import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
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
import { router } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { getAllUserCollections, getCalendar, getEpisodes } from "../../shared/api/client";
import { getAiringAt } from "../../shared/api/anilist";
import type { CalendarItem, CollectionType, PagedResponse, UserCollection } from "../../shared/api/types";
import { CollectionTypeLabel, SubjectTypeLabel } from "../../shared/api/types";
import { buildSubjectKeywords } from "../../shared/pinyin-keywords";
import { getDisplayLabel, getTodayBangumiWeekday, sortCollections } from "../../shared/sort-collections";
import {
  getPreferredSubjectCoverUrl,
  readCachedCollection,
  readCachedSubject,
  readCachedValue,
  readCachedValueWithin,
  readCachedValues,
  readCachedValuesWithin,
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
import { EmptyState, ErrorState, LoadingState } from "../../src/components/ScreenState";
import { SubjectCard } from "../../src/components/SubjectCard";
import { useAuth } from "../../src/hooks/useAuth";
import { colors } from "../../src/theme/colors";
import { useAlert } from "../../src/components/Dialog";

const CACHE_MAX_AGE = 1000 * 60 * 60 * 24;
const AIRING_CACHE_PREFIX = "anilist-airing-";
const EPISODES_CACHE_PREFIX = "episodes-";
const AIRING_TIME_CACHE_MAX_AGE = 1000 * 60 * 60 * 24 * 90;
const PAGE_SIZE = 20;

const EMPTY_AIRING_MAP = new Map<number, number>();
const EMPTY_AIRING_TIME_MAP = new Map<number, { airingAt: number; episode: number }>();
const EMPTY_EPISODE_MAP = new Map<number, number>();

type AiringTime = { airingAt: number; episode: number };

const COLLECTION_OPTIONS: Array<{ value: CollectionType; label: string }> = [
  { value: 3, label: "在看" },
  { value: 1, label: "想看" },
  { value: 2, label: "看过" },
  { value: 4, label: "搁置" },
  { value: 5, label: "抛弃" },
];

const todayDateKey = (() => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
})();

async function readCachedAiringTimes(subjectIds: number[]) {
  const keys = subjectIds.map((id) => `${AIRING_CACHE_PREFIX}${id}`);
  const [cachedByKey, staleByKey] = await Promise.all([
    readCachedValuesWithin<AiringTime>(keys, AIRING_TIME_CACHE_MAX_AGE),
    readCachedValues<AiringTime>(keys),
  ]);
  const map = new Map<number, AiringTime>();
  for (const id of subjectIds) {
    const key = `${AIRING_CACHE_PREFIX}${id}`;
    const v = cachedByKey.get(key) ?? staleByKey.get(key);
    if (v) map.set(id, v);
  }
  return map;
}

async function loadCollections(type: CollectionType, username: string, force = false) {
  const cacheKey = `collections-${type}-${username}`;
  if (!force) {
    const cached = await readCachedValueWithin<PagedResponse<UserCollection>>(cacheKey, CACHE_MAX_AGE);
    const cacheHit = cached ?? await readCachedValue<PagedResponse<UserCollection>>(cacheKey);
    if (cacheHit) {
      await mergeSubjectCollections(cacheHit, username);
      cacheHit.data = cacheHit.data.filter((c) => c.type === type);

      return cacheHit;
    }
  }

  const data = await getAllUserCollections({ username, type });
  await writeCachedValue(cacheKey, data);
  await writeCachedSubjectPreviews(data.data.map((collection) => collection.subject));
  Promise.allSettled(
    data.data.map((c) => writeCachedCollection(username, c)),
  ).catch(() => {});
  return data;
}

async function mergeSubjectCollections(data: PagedResponse<UserCollection>, username: string) {
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
    const cached = await readCachedValueWithin<CalendarItem[]>("calendar", CACHE_MAX_AGE);
    const cacheHit = cached ?? await readCachedValue<CalendarItem[]>("calendar");
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
  ].join(" ").toLowerCase();
  return haystack.includes(query);
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
      } else if (e.translationX < -threshold && currentPageSV.value < totalPagesSV.value) {
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

  const airingMap = useMemo(() => getAiringMap(calendarQuery.data), [calendarQuery.data]);
  const today = getTodayBangumiWeekday();
  const searchQuery = search.trim().toLowerCase();

  const sourceCollections = collectionsQuery.data?.data ?? [];
  const visibleCollectionTasks = useMemo(
    () => username ? collectionTasks.filter((task) => task.payload.username === username) : collectionTasks,
    [collectionTasks, username],
  );
  const rawCollections = useMemo(
    () => sourceCollections
      .map((collection) => {
        const patch = getOptimisticCollectionPatchForSubject(collection.subject_id, visibleCollectionTasks);
        return patch ? { ...collection, ...patch } : collection;
      })
      .filter((collection) => collection.type === collectionType),
    [sourceCollections, visibleCollectionTasks, collectionType],
  );
  const isWatching = collectionType === 3;

  // --- Phase 1: Backfill total_episodes from SQLite cache ---
  const { data: totalEpBackfill } = useQuery({
    queryKey: ["totalep-backfill", rawCollections.map((c) => c.subject_id).join(",")],
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
            getEpisodes(id).then((data) => {
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
            readCachedSubject(id).then((cached) => {
              if (cached) return writeCachedSubject({ ...cached, total_episodes: totalEp });
            }).catch(() => {});
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
    () => rawCollections.filter((item) => airingMap.has(item.subject_id)).map((item) => item.subject_id),
    [rawCollections, airingMap],
  );

  const staleAiringIds = useMemo(
    () => isWatching
      ? rawCollections
          .filter((item) => !airingMap.has(item.subject_id))
          .filter((item) => {
            const total = item.subject.eps || item.subject.total_episodes || 0;
            return item.ep_status > 0 && (total === 0 || item.ep_status < total);
          })
          .map((item) => item.subject_id)
      : [],
    [rawCollections, airingMap, isWatching],
  );

  const allEpisodeIds = useMemo(
    () => [...new Set([...airingIds, ...staleAiringIds])],
    [airingIds, staleAiringIds],
  );

  // --- Phase 3: Cached AniList airing times (fast path for offline/first paint) ---
  const airingTimeCacheIds = useMemo(
    () => isWatching ? [...new Set(rawCollections.map((item) => item.subject_id))] : [],
    [rawCollections, isWatching],
  );
  const airingTimeCacheKey = airingTimeCacheIds.join(",");

  const {
    data: cachedAiringTimeMap,
    isFetched: cachedAiringTimeFetched,
  } = useQuery({
    queryKey: ["anilist-airing-times-cache", airingTimeCacheKey],
    queryFn: () => readCachedAiringTimes(airingTimeCacheIds),
    enabled: airingTimeCacheIds.length > 0,
    staleTime: 5 * 60 * 1000,
    gcTime: CACHE_MAX_AGE * 2,
  });

  // --- Phase 3b: AniList airing times network backfill (only missing cached items) ---
  const airingTimeTargets = useMemo(() => {
    if (!isWatching) return [];
    const calendarReady = airingMap.size > 0;
    if (calendarReady && airingIds.length === 0 && staleAiringIds.length === 0) return [];
    const targetIds = calendarReady
      ? new Set([...airingIds, ...staleAiringIds])
      : new Set(rawCollections.map((item) => item.subject_id));
    return rawCollections
      .filter((item) => targetIds.has(item.subject_id) && item.subject.name)
      .map((item) => ({
        subjectId: item.subject_id,
        name: item.subject.name,
      }));
  }, [rawCollections, airingIds, staleAiringIds, airingMap, isWatching]);

  const airingTimeTargetKey = airingTimeTargets.map((t) => t.subjectId).join(",");

  const { data: airingTimeMapData } = useQuery({
    queryKey: ["anilist-airing-times", airingTimeTargetKey],
    queryFn: async () => {
      const map = new Map<number, AiringTime>(cachedAiringTimeMap);

      const missing = airingTimeTargets.filter((t) => !map.has(t.subjectId));
      const AIRING_BATCH_SIZE = 3;
      for (let i = 0; i < missing.length; i += AIRING_BATCH_SIZE) {
        const batch = missing.slice(i, i + AIRING_BATCH_SIZE).filter((t) => t.name);
        if (batch.length === 0) continue;

        const results = await Promise.allSettled(
          batch.map(async (target) => {
            const result = await getAiringAt(target.name);
            return { target, result };
          }),
        );

        for (const r of results) {
          if (r.status === "fulfilled" && r.value.result) {
            const { target, result } = r.value;
            await writeCachedValue(`${AIRING_CACHE_PREFIX}${target.subjectId}`, result);
            map.set(target.subjectId, result);
          }
        }

        if (i + AIRING_BATCH_SIZE < missing.length) {
          await new Promise((r) => setTimeout(r, 500));
        }
      }
      return map;
    },
    enabled: airingTimeTargets.length > 0 && cachedAiringTimeFetched,
    staleTime: 5 * 60 * 1000,
    gcTime: CACHE_MAX_AGE * 2,
  });

  const airingTimeMap = useMemo(() => {
    if (!cachedAiringTimeMap && !airingTimeMapData) return EMPTY_AIRING_TIME_MAP;
    const merged = new Map<number, AiringTime>(cachedAiringTimeMap);
    if (airingTimeMapData) {
      for (const [subjectId, airingTime] of airingTimeMapData) {
        merged.set(subjectId, airingTime);
      }
    }
    return merged;
  }, [cachedAiringTimeMap, airingTimeMapData]);

  const { data: airedEpMap } = useQuery({
    queryKey: ["aired-episodes", todayDateKey, allEpisodeIds.join(",")],
    queryFn: async () => {
      if (allEpisodeIds.length === 0) return EMPTY_EPISODE_MAP;
      const map = new Map<number, number>();
      const idsToFetch: number[] = [];

      // Batch-read all cached episode counts instead of sequential per-ID queries
      const cacheKeys = allEpisodeIds.map((id) => `${EPISODES_CACHE_PREFIX}${id}`);
      const cachedByKey = await readCachedValues<{ airedEp: number; checkedAt: number }>(cacheKeys);

      for (const id of allEpisodeIds) {
        const cacheKey = `${EPISODES_CACHE_PREFIX}${id}`;
        const cached = cachedByKey.get(cacheKey);
        if (cached && Date.now() - cached.checkedAt <= CACHE_MAX_AGE) {
          map.set(id, cached.airedEp);
          continue;
        }
        idsToFetch.push(id);
      }

      if (idsToFetch.length > 0) {
        const results = await Promise.allSettled(
          idsToFetch.map((id) =>
            getEpisodes(id).then((data) => {
              const mainEps = data.data.filter((ep) => ep.type === 0);
              const airedEp = mainEps.filter((ep) => ep.airdate && ep.airdate <= todayDateKey).length;
              return { id, airedEp };
            }),
          ),
        );
        for (const result of results) {
          if (result.status === "fulfilled") {
            const { id, airedEp } = result.value;
            map.set(id, airedEp);
            await writeCachedValue(`${EPISODES_CACHE_PREFIX}${id}`, { airedEp, checkedAt: Date.now() });
          }
        }
      }
      return map;
    },
    enabled: isWatching && allEpisodeIds.length > 0,
    staleTime: CACHE_MAX_AGE,
    gcTime: CACHE_MAX_AGE * 2,
  });

  const episodeMap = airedEpMap ?? EMPTY_EPISODE_MAP;

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
        await writeCachedSubjectPreviews(networkCollections.data.map((c) => c.subject));
        Promise.allSettled(networkCollections.data.map((c) => writeCachedCollection(username!, c))).catch(() => {});

        await writeCachedValue("calendar", networkCalendar);
        await writeCachedSubjectPreviews(networkCalendar.flatMap((day) => day.items));

        const currentCollections = queryClient.getQueryData<PagedResponse<UserCollection>>(["collections", collectionType, username]);
        const currentCalendar = queryClient.getQueryData<CalendarItem[]>(["calendar"]);

        const filtered = { ...networkCollections, data: networkCollections.data.filter((c) => c.type === collectionType) };

        if (currentCollections && JSON.stringify(currentCollections.data) !== JSON.stringify(filtered.data)) {
          queryClient.setQueryData(["collections", collectionType, username], filtered);
          queryClient.invalidateQueries({ queryKey: ["totalep-backfill"] });
          queryClient.invalidateQueries({ queryKey: ["episode-totals"] });
          queryClient.invalidateQueries({ queryKey: ["anilist-airing-times"] });
          queryClient.invalidateQueries({ queryKey: ["aired-episodes"] });
        }

        if (currentCalendar && JSON.stringify(currentCalendar) !== JSON.stringify(networkCalendar)) {
          queryClient.setQueryData(["calendar"], networkCalendar);
        }
      } catch {
        // Ignore background refresh errors — user still sees cached data
      }
    };

    doRefresh();

    return () => { cancelled = true; };
  }, [collectionType, username, collectionsQuery.data]);

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
        if ((s.total_episodes == null || s.total_episodes === 0) && totalEpBackfill) {
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

  // --- Sort with real data ---
  const collections = useMemo(() => {
    const sorted = sortCollections(
      enrichedCollections,
      calendarQuery.data ?? [],
      today,
      episodeMap,
      airingTimeMap,
    );
    return sorted.filter((c) => matchesSearch(c, searchQuery));
  }, [enrichedCollections, calendarQuery.data, today, episodeMap, airingTimeMap, searchQuery]);

  const displayLabelMap = useMemo(() => {
    const map = new Map<number, string | null>();
    for (const item of collections) {
      map.set(item.subject_id, getDisplayLabel(item, airingMap, episodeMap, today, airingTimeMap));
    }
    return map;
  }, [collections, airingMap, episodeMap, today, airingTimeMap]);

  // --- Pagination ---
  const totalPages = Math.max(1, Math.ceil(collections.length / PAGE_SIZE));
  const paged = useMemo(
    () => collections.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [collections, page],
  );

  // Keep shared values in sync for worklet access
  useEffect(() => { currentPageSV.value = page; }, [page, currentPageSV]);
  useEffect(() => { totalPagesSV.value = totalPages; }, [totalPages, totalPagesSV]);

  // Reset page when collection type or search changes
  useEffect(() => {
    setPage(1);
  }, [collectionType, searchQuery]);

  // Clamp page when totalPages shrinks
  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [totalPages, page]);

  async function refresh() {
    if (!username) return;
    setRefreshing(true);
    try {
      const [nextCollections, nextCalendar] = await Promise.all([
        loadCollections(collectionType, username, true),
        loadCalendar(true),
      ]);
      queryClient.setQueryData(["collections", collectionType, username], nextCollections);
      queryClient.setQueryData(["calendar"], nextCalendar);
      queryClient.invalidateQueries({ queryKey: ["totalep-backfill"] });
      queryClient.invalidateQueries({ queryKey: ["episode-totals"] });
      queryClient.invalidateQueries({ queryKey: ["anilist-airing-times"] });
      queryClient.invalidateQueries({ queryKey: ["aired-episodes"] });
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
  const collectionTaskStatus = collectionTask?.status === "failed"
    ? "同步失败"
    : collectionTask?.status === "running"
    ? "同步中"
    : "等待同步";

  if (checking) return <LoadingState label="检查登录状态" />;
  if (!loggedIn) return <LoadingState label="跳转登录" />;

  return (
    <View style={styles.screen}>
      <SegmentedControl
        options={COLLECTION_OPTIONS}
        value={collectionType}
        onChange={setCollectionType}
      />
      <SearchInput value={search} onChangeText={setSearch} placeholder={`搜索${CollectionTypeLabel[collectionType]}`} />

      {collectionTask ? (
        <View style={styles.taskBar}>
          <View style={styles.taskInfo}>
            <Text style={styles.taskTitle} numberOfLines={1}>
              {getCollectionTaskSummary(collectionTask)} · {collectionTaskStatus}
            </Text>
            {collectionTask.status === "failed" && collectionTask.lastError ? (
              <Text style={styles.taskError} numberOfLines={1}>{collectionTask.lastError}</Text>
            ) : null}
            {visibleCollectionTasks.length > 1 ? (
              <Text style={styles.taskMeta}>另有 {visibleCollectionTasks.length - 1} 个后台任务</Text>
            ) : null}
          </View>
          {collectionTask.status === "failed" ? (
            <Pressable style={styles.taskButton} onPress={() => void retryCollectionTask(collectionTask.id)}>
              <Text style={styles.taskButtonText}>重试</Text>
            </Pressable>
          ) : null}
          {collectionTask.status !== "running" ? (
            <Pressable style={styles.taskButton} onPress={() => void ignoreCollectionTask(collectionTask.id)}>
              <Text style={styles.taskButtonMuted}>忽略</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {collectionsQuery.isLoading ? (
        <LoadingState label="加载收藏" />
      ) : collectionsQuery.isError && !collectionsQuery.data ? (
        <ErrorState
          message={collectionsQuery.error instanceof Error ? collectionsQuery.error.message : "无法加载收藏"}
          onRetry={() => void collectionsQuery.refetch()}
        />
      ) : (
        <GestureDetector gesture={panGesture}>
          <Animated.View style={[animatedStyle, { flex: 1 }]}>
            <FlatList
              data={paged}
              keyExtractor={(item) => String(item.subject_id)}
              contentContainerStyle={paged.length ? styles.list : styles.emptyList}
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
                    {CollectionTypeLabel[collectionType]} · {collections.length}{collections.length !== (collectionsQuery.data?.total ?? 0) ? ` / ${collectionsQuery.data?.total ?? 0}` : ""}
                  </Text>
                  {collections.length > 0 && (
                    <Text style={styles.pageInfo}>
                      第 {page} / {totalPages} 页 · 共 {collections.length} 条
                    </Text>
                  )}
                </View>
              }
                ItemSeparatorComponent={() => <View style={styles.separator} />}
                ListEmptyComponent={<EmptyState title="没有匹配条目" detail="调整搜索词或切换收藏类型" />}
                renderItem={({ item }) => {
                  const subject = item.subject;
                  const title = subject.name_cn || subject.name;
                  const total = subject.total_episodes || subject.eps || 0;
                  const label = isWatching ? displayLabelMap.get(item.subject_id) ?? undefined : undefined;
                  return (
                    <SubjectCard
                      title={title}
                      subtitle={subject.name}
                      coverUrl={getPreferredSubjectCoverUrl(subject)}
                      label={label}
                      progress={`${item.ep_status}/${total || "?"} 集`}
                      meta={[
                        SubjectTypeLabel[subject.type] ?? "条目",
                        subject.date || "日期未知",
                        (subject.score ?? subject.rating?.score) ? `评分 ${(subject.score ?? subject.rating!.score).toFixed(1)}` : "暂无评分",
                      ]}
                      onPress={() => router.push(`/subject/${item.subject_id}`)}
                      onLongPress={() => void copyTitle(item)}
                    />
                  );
                }}
              />
            </Animated.View>
          </GestureDetector>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.background,
  },
  taskBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  taskInfo: {
    flex: 1,
    minWidth: 0,
  },
  taskTitle: {
    color: colors.text,
    fontSize: 13,
    fontWeight: "700",
  },
  taskError: {
    marginTop: 2,
    color: colors.danger,
    fontSize: 12,
  },
  taskMeta: {
    marginTop: 2,
    color: colors.muted,
    fontSize: 12,
  },
  taskButton: {
    minWidth: 48,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 10,
    borderRadius: 7,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.background,
  },
  taskButtonText: {
    color: colors.primary,
    fontSize: 13,
    fontWeight: "800",
  },
  taskButtonMuted: {
    color: colors.muted,
    fontSize: 13,
    fontWeight: "700",
  },
  list: {
    padding: 16,
    paddingTop: 4,
    paddingBottom: 28,
  },
  emptyList: {
    flexGrow: 1,
    padding: 16,
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
});
