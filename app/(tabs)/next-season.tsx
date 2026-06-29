import { useMemo, useState } from "react";
import { Alert, FlatList, Linking, RefreshControl, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { searchAnimeSubject } from "../../shared/api/client";
import { getNextSeason, getNextSeasonInfo, type NextSeasonItem } from "../../shared/api/anilist";
import { WEEKDAY_CN } from "../../shared/sort-collections";
import {
  readCachedValue,
  readCachedValueWithin,
  writeCachedValue,
} from "../../shared/storage/sqlite-cache";
import { formatAiringTime } from "../../src/utils/date";
import { SegmentedControl } from "../../src/components/SegmentedControl";
import { EmptyState, ErrorState, LoadingState } from "../../src/components/ScreenState";
import { SubjectCard } from "../../src/components/SubjectCard";
import { colors } from "../../src/theme/colors";

const CACHE_MAX_AGE = 1000 * 60 * 60 * 24;
const MATCH_CACHE_TTL = 1000 * 60 * 60 * 24 * 30; // 30 days
const MATCH_CONCURRENCY = 4;

type BangumiMatch = { bangumiId: number | null; nameCn: string | null };

interface SeasonEntry extends NextSeasonItem {
  weekday: number | null;
  nameCn: string | null;
  bangumiId: number | null;
}

const SEGMENTS = [
  { value: "all", label: "全部" },
  ...[1, 2, 3, 4, 5, 6, 7].map((day) => ({
    value: String(day),
    label: WEEKDAY_CN[day].replace("星期", "周"),
  })),
  { value: "tba", label: "TBA" },
];

function cacheKey() {
  const info = getNextSeasonInfo();
  return `next-season-base-${info.seasonYear}-${info.season}`;
}

function matchCacheKey(anilistId: number) {
  return `next-season-match-${anilistId}`;
}

function getWeekday(item: NextSeasonItem): number | null {
  if (item.airingAt) {
    const day = new Date(item.airingAt * 1000).getDay();
    return day === 0 ? 7 : day;
  }
  const { year, month, day } = item.startDate;
  if (!year || !month || !day) return null;
  const jsDay = new Date(year, month - 1, day).getDay();
  return jsDay === 0 ? 7 : jsDay;
}

function getStartDate(item: NextSeasonItem) {
  const { year, month, day } = item.startDate;
  if (!year || !month) return "日期未定";
  return `${year}-${String(month).padStart(2, "0")}-${String(day ?? 1).padStart(2, "0")}`;
}

async function fetchBangumiMatch(item: NextSeasonItem): Promise<BangumiMatch> {
  const result = await searchAnimeSubject(item.title.native);
  return {
    bangumiId: result?.id ?? null,
    nameCn: result?.name_cn ?? null,
  };
}

function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return Promise.resolve([]);
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (true) {
      const idx = nextIndex;
      if (idx >= items.length) return;
      nextIndex += 1;
      results[idx] = await worker(items[idx], idx);
    }
  }

  return Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => runWorker()),
  ).then(() => results);
}

async function loadNextSeason(force = false) {
  const key = cacheKey();
  if (!force) {
    const cached = await readCachedValueWithin<NextSeasonItem[]>(key, CACHE_MAX_AGE);
    if (cached) return cached;
    const stale = await readCachedValue<NextSeasonItem[]>(key);
    if (stale) {
      getNextSeason().then((data) => writeCachedValue(key, data)).catch(() => {});
      return stale;
    }
  }
  const data = await getNextSeason();
  await writeCachedValue(key, data);
  return data;
}

async function resolveBangumiMatches(
  items: NextSeasonItem[],
  refresh: boolean,
): Promise<{ entries: SeasonEntry[]; needsRefresh: boolean }> {
  const cachedMatches = await Promise.all(
    items.map((item) => readCachedValue<BangumiMatch>(matchCacheKey(item.id))),
  );

  const matches: Array<BangumiMatch | null> = new Array(items.length).fill(null);
  const pending: Array<{ index: number; item: NextSeasonItem; fallback: BangumiMatch | null }> = [];
  let needsRefresh = false;

  for (let i = 0; i < items.length; i++) {
    const cached = cachedMatches[i];
    if (cached) {
      matches[i] = cached;
    } else {
      needsRefresh = true;
      if (refresh) pending.push({ index: i, item: items[i], fallback: null });
    }
  }

  if (refresh && pending.length > 0) {
    const refreshed = await mapWithConcurrency(pending, MATCH_CONCURRENCY, async ({ item, fallback }) => {
      try {
        const match = await fetchBangumiMatch(item);
        await writeCachedValue(matchCacheKey(item.id), match);
        return match;
      } catch {
        return fallback;
      }
    });
    for (const [i, pendingItem] of pending.entries()) {
      matches[pendingItem.index] = refreshed[i] ?? matches[pendingItem.index];
    }
    needsRefresh = false;
  }

  const entries: SeasonEntry[] = items.map((item, i) => ({
    ...item,
    weekday: getWeekday(item),
    nameCn: matches[i]?.nameCn ?? null,
    bangumiId: matches[i]?.bangumiId ?? null,
  }));

  return { entries, needsRefresh };
}

export default function NextSeasonPage() {
  const queryClient = useQueryClient();
  const [segment, setSegment] = useState("all");
  const [refreshing, setRefreshing] = useState(false);
  const seasonInfo = getNextSeasonInfo();

  const nextSeasonQuery = useQuery({
    queryKey: ["next-season", seasonInfo.seasonYear, seasonInfo.season],
    queryFn: async () => {
      const items = await loadNextSeason();
      // Use cached matches first (refresh=false), background refresh later
      const { entries, needsRefresh } = await resolveBangumiMatches(items, false);
      // If some matches are missing and we're online, try to fetch them
      if (needsRefresh) {
        resolveBangumiMatches(items, true).then((refreshed) => {
          queryClient.setQueryData(
            ["next-season", seasonInfo.seasonYear, seasonInfo.season],
            refreshed.entries,
          );
        }).catch(() => {});
      }
      return entries;
    },
    staleTime: CACHE_MAX_AGE,
    gcTime: CACHE_MAX_AGE * 2,
  });

  const allEntries = nextSeasonQuery.data ?? [];

  const items = useMemo(() => {
    if (segment === "all") return allEntries;
    if (segment === "tba") return allEntries.filter((item) => !item.weekday);
    return allEntries.filter((item) => item.weekday === Number(segment));
  }, [allEntries, segment]);

  async function refresh() {
    setRefreshing(true);
    try {
      const baseItems = await loadNextSeason(true);
      const { entries } = await resolveBangumiMatches(baseItems, true);
      queryClient.setQueryData(["next-season", seasonInfo.seasonYear, seasonInfo.season], entries);
    } catch (error) {
      Alert.alert("刷新失败", error instanceof Error ? error.message : "请稍后重试");
    } finally {
      setRefreshing(false);
    }
  }

  function openItem(item: SeasonEntry) {
    if (item.bangumiId) {
      router.push(`/subject/${item.bangumiId}`);
    } else {
      void Linking.openURL(`https://anilist.co/anime/${item.id}`);
    }
  }

  return (
    <View style={styles.screen}>
      <Text style={styles.heading}>{seasonInfo.label}</Text>
      <SegmentedControl options={SEGMENTS} value={segment} onChange={setSegment} />

      {nextSeasonQuery.isLoading ? (
        <LoadingState label="加载下季度新番" />
      ) : nextSeasonQuery.isError && !nextSeasonQuery.data ? (
        <ErrorState
          message={nextSeasonQuery.error instanceof Error ? nextSeasonQuery.error.message : "无法加载 AniList"}
          onRetry={() => void nextSeasonQuery.refetch()}
        />
      ) : (
        <FlatList
          data={items}
          keyExtractor={(item) => String(item.id)}
          contentContainerStyle={items.length ? styles.list : styles.emptyList}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={refresh}
              tintColor={colors.primary}
              colors={[colors.primary]}
            />
          }
          ItemSeparatorComponent={() => <View style={styles.separator} />}
          ListEmptyComponent={<EmptyState title="该分组暂无条目" />}
          renderItem={({ item }) => (
            <SubjectCard
              title={item.nameCn ?? item.title.native}
              subtitle={item.title.romaji}
              coverUrl={item.cover?.replace(/^http:/, "https:")}
              label={item.weekday ? WEEKDAY_CN[item.weekday].replace("星期", "周") : "TBA"}
              meta={[
                item.format,
                getStartDate(item),
                item.airingAt ? formatAiringTime(item.airingAt) : "播出时间未定",
              ]}
              progress={item.episodes ? `预计 ${item.episodes} 集` : null}
              onPress={() => openItem(item)}
            />
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.background,
  },
  heading: {
    paddingHorizontal: 16,
    paddingTop: 12,
    color: colors.text,
    fontSize: 20,
    fontWeight: "800",
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
});
