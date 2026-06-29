import { useMemo, useState } from "react";
import { Alert, FlatList, Linking, RefreshControl, StyleSheet, Text, View } from "react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { getNextSeason, getNextSeasonInfo, type NextSeasonItem } from "../../shared/api/anilist";
import { WEEKDAY_CN } from "../../shared/sort-collections";
import { readCachedValueWithin, writeCachedValue } from "../../shared/storage/sqlite-cache";
import { formatAiringTime } from "../../src/utils/date";
import { SegmentedControl } from "../../src/components/SegmentedControl";
import { EmptyState, ErrorState, LoadingState } from "../../src/components/ScreenState";
import { SubjectCard } from "../../src/components/SubjectCard";
import { colors } from "../../src/theme/colors";

const CACHE_MAX_AGE = 1000 * 60 * 60 * 24;
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

async function loadNextSeason(force = false) {
  const key = cacheKey();
  if (!force) {
    const cached = await readCachedValueWithin<NextSeasonItem[]>(key, CACHE_MAX_AGE);
    if (cached) return cached;
  }
  const data = await getNextSeason();
  await writeCachedValue(key, data);
  return data;
}

function getWeekday(item: NextSeasonItem) {
  if (item.airingAt) {
    const day = new Date(item.airingAt * 1000).getDay();
    return day === 0 ? 7 : day;
  }
  const { year, month, day } = item.startDate;
  if (!year || !month || !day) return 0;
  const jsDay = new Date(year, month - 1, day).getDay();
  return jsDay === 0 ? 7 : jsDay;
}

function getStartDate(item: NextSeasonItem) {
  const { year, month, day } = item.startDate;
  if (!year || !month) return "日期未定";
  return `${year}-${String(month).padStart(2, "0")}-${String(day ?? 1).padStart(2, "0")}`;
}

export default function NextSeasonPage() {
  const queryClient = useQueryClient();
  const [segment, setSegment] = useState("all");
  const [refreshing, setRefreshing] = useState(false);
  const seasonInfo = getNextSeasonInfo();

  const nextSeasonQuery = useQuery({
    queryKey: ["next-season", seasonInfo.seasonYear, seasonInfo.season],
    queryFn: () => loadNextSeason(),
  });

  const items = useMemo(() => {
    const data = nextSeasonQuery.data ?? [];
    if (segment === "all") return data;
    if (segment === "tba") return data.filter((item) => getWeekday(item) === 0);
    return data.filter((item) => getWeekday(item) === Number(segment));
  }, [nextSeasonQuery.data, segment]);

  async function refresh() {
    setRefreshing(true);
    try {
      const next = await loadNextSeason(true);
      queryClient.setQueryData(["next-season", seasonInfo.seasonYear, seasonInfo.season], next);
    } catch (error) {
      Alert.alert("刷新失败", error instanceof Error ? error.message : "请稍后重试");
    } finally {
      setRefreshing(false);
    }
  }

  function openAniList(id: number) {
    void Linking.openURL(`https://anilist.co/anime/${id}`);
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
              title={item.title.native || item.title.romaji}
              subtitle={item.title.romaji}
              coverUrl={item.cover}
              label={getWeekday(item) ? WEEKDAY_CN[getWeekday(item)].replace("星期", "周") : "TBA"}
              meta={[
                item.format,
                getStartDate(item),
                item.airingAt ? formatAiringTime(item.airingAt) : "播出时间未定",
              ]}
              progress={item.episodes ? `预计 ${item.episodes} 集` : null}
              onPress={() => openAniList(item.id)}
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
