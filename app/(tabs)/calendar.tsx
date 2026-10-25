import { useMemo, useState } from "react";
import {
  FlatList,
  RefreshControl,
  SectionList,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { router } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getCalendar } from "../../shared/api/client";
import type { CalendarItem, SubjectSmall } from "../../shared/api/types";
import { applyCalendarAiringOffsets, formatAiringOffsetDays } from "../../shared/airing-offset";
import { useAiringOffsets } from "../../src/hooks/useAiringOffsets";
import {
  getTodayBangumiWeekday,
  WEEKDAY_CN,
} from "../../shared/sort-collections";
import { buildSubjectKeywords } from "../../shared/pinyin-keywords";
import {
  getPreferredSubjectCoverUrl,
  readCachedValue,
  readCachedValueWithin,
  writeCachedSubjectPreviews,
  writeCachedValue,
} from "../../shared/storage/sqlite-cache";
import { useHeaderSearch } from "../../src/components/SearchInput";
import { SegmentedControl } from "../../src/components/SegmentedControl";
import {
  EmptyState,
  ErrorState,
  LoadingState,
} from "../../src/components/ScreenState";
import { SubjectCard } from "../../src/components/SubjectCard";
import { SwipePager } from "../../src/components/SwipePager";
import { useAlert } from "../../src/components/Dialog";
import { colors } from "../../src/theme/colors";
import { refreshQueryDataIfChanged } from "../../src/api/stale-cache-refresh";

const CACHE_MAX_AGE = 1000 * 60 * 60 * 24;
const LAST_WEEKDAY = 7;
const WEEKDAY_VALUES = [1, 2, 3, 4, 5, 6, 7];

function getWeekdayLabel(value: number) {
  return value === getTodayBangumiWeekday(Date.now())
    ? "今天"
    : WEEKDAY_CN[value].replace("星期", "周");
}

const WEEKDAY_OPTIONS = WEEKDAY_VALUES.map((value) => ({
  value,
  label: getWeekdayLabel(value),
}));

type EnrichedItem = SubjectSmall & { weekday: number };

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

function matchesSearch(item: EnrichedItem, query: string) {
  if (!query) return true;
  const haystack = [
    item.name,
    item.name_cn,
    ...buildSubjectKeywords(item.name_cn, item.name),
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(query);
}

type CalendarSection = { title: string; weekday: number; data: SubjectSmall[] };

export default function CalendarPage() {
  const alert = useAlert();
  const queryClient = useQueryClient();
  const airingOffsets = useAiringOffsets();
  const [weekday, setWeekday] = useState(() =>
    getTodayBangumiWeekday(Date.now()),
  );
  const [search, setSearch] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  useHeaderSearch({
    value: search,
    onChangeText: setSearch,
    placeholder: "搜索本周放送",
  });

  const calendarQuery = useQuery({
    queryKey: ["calendar"],
    queryFn: async () => {
      const cached = await readCachedValueWithin<CalendarItem[]>("calendar", CACHE_MAX_AGE)
        ?? await readCachedValue<CalendarItem[]>("calendar");
      const local = queryClient.getQueryData<CalendarItem[]>(["calendar"]) ?? cached;
      if (!local) return loadCalendar(true);
      // 与收藏页共享同一个后台任务；不能在 effect 里另起未被完成屏障跟踪的刷新。
      void refreshQueryDataIfChanged({
        queryClient, queryKey: ["calendar"], refreshKey: "calendar",
        currentData: local, refresh: () => loadCalendar(true),
      });
      return local;
    },
  });

  // 偏置仅作为展示投影，源排期仍按原样缓存与后台刷新。
  const calendar = useMemo(
    () => calendarQuery.data && applyCalendarAiringOffsets(calendarQuery.data, airingOffsets),
    [calendarQuery.data, airingOffsets],
  );

  const searchQuery = search.trim().toLowerCase();
  const isSearching = !!searchQuery;

  const allItems = useMemo((): EnrichedItem[] => {
    if (!calendar) return [];
    const items: EnrichedItem[] = [];
    for (const day of calendar) {
      for (const item of day.items) {
        items.push({ ...item, weekday: day.weekday.id });
      }
    }
    return items;
  }, [calendar]);

  const searchedItems = useMemo(() => {
    if (!isSearching) return [];
    return allItems
      .filter((item) => matchesSearch(item, searchQuery))
      .sort((a, b) => a.weekday - b.weekday);
  }, [allItems, isSearching, searchQuery]);

  const searchSections = useMemo((): CalendarSection[] => {
    if (!isSearching) return [];
    const grouped = new Map<number, SubjectSmall[]>();
    for (const item of searchedItems) {
      const list = grouped.get(item.weekday) ?? [];
      list.push(item);
      grouped.set(item.weekday, list);
    }
    return [...grouped]
      .sort(([a], [b]) => a - b)
      .map(([w, data]) => ({
        title: `${WEEKDAY_CN[w]} · 共 ${data.length} 部`,
        weekday: w,
        data,
      }));
  }, [searchedItems, isSearching]);

  async function refresh() {
    setRefreshing(true);
    try {
      await refreshQueryDataIfChanged({
        queryClient, queryKey: ["calendar"], refreshKey: "calendar",
        currentData: queryClient.getQueryData<CalendarItem[]>(["calendar"]) ?? [],
        refresh: async () => {
          try { return await loadCalendar(true); }
          catch (error) {
            alert("刷新失败", error instanceof Error ? error.message : "请稍后重试");
            throw error;
          }
        },
      });
    } catch (error) {
      alert("刷新失败", error instanceof Error ? error.message : "请稍后重试");
    } finally {
      setRefreshing(false);
    }
  }

  const renderItem = ({ item }: { item: SubjectSmall }) => (
    <SubjectCard
      title={item.name_cn || item.name}
      subtitle={item.name}
      coverUrl={getPreferredSubjectCoverUrl(item)}
      badges={airingOffsets[item.id]
        ? [{ text: `手动${formatAiringOffsetDays(airingOffsets[item.id])}` }]
        : undefined}
      meta={[
        item.air_date || "日期未知",
        item.rating?.score
          ? `评分 ${item.rating.score.toFixed(1)}`
          : "暂无评分",
        item.rank ? `#${item.rank}` : "无排名",
      ]}
      onPress={() => router.push(`/subject/${item.id}`)}
    />
  );

  return (
    <View style={styles.screen}>
      <SegmentedControl
        options={WEEKDAY_OPTIONS}
        value={weekday}
        onChange={setWeekday}
      />
      {calendarQuery.isLoading ? (
        <LoadingState label="加载日历" />
      ) : calendarQuery.isError && !calendarQuery.data ? (
        <ErrorState
          message={
            calendarQuery.error instanceof Error
              ? calendarQuery.error.message
              : "无法加载日历"
          }
          onRetry={() => void calendarQuery.refetch()}
        />
      ) : isSearching ? (
        <SectionList
          sections={searchSections}
          keyExtractor={(item) => String(item.id)}
          contentContainerStyle={
            searchSections.length ? styles.list : styles.emptyList
          }
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={refresh}
              tintColor={colors.primary}
              colors={[colors.primary]}
            />
          }
          renderSectionHeader={({ section }) => (
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>{section.title}</Text>
            </View>
          )}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
          ListEmptyComponent={
            <EmptyState title="没有匹配条目" detail="调整搜索词或切换星期" />
          }
          renderItem={renderItem}
          stickySectionHeadersEnabled={false}
        />
      ) : (
        <SwipePager
          page={weekday}
          pageCount={LAST_WEEKDAY}
          onPageChange={setWeekday}
          renderPage={(pageValue) => {
            const pageDay = calendar?.find(
              (item) => item.weekday.id === pageValue,
            );
            const pageItems = pageDay?.items ?? [];

            return (
              <FlatList
                data={pageItems}
                keyExtractor={(item) => String(item.id)}
                contentContainerStyle={
                  pageItems.length ? styles.list : styles.emptyList
                }
                refreshControl={
                  <RefreshControl
                    refreshing={refreshing}
                    onRefresh={refresh}
                    tintColor={colors.primary}
                    colors={[colors.primary]}
                  />
                }
                ListHeaderComponent={
                  pageItems.length > 0 ? (
                    <View style={styles.headerRow}>
                      <Text style={styles.count}>共 {pageItems.length} 条</Text>
                    </View>
                  ) : null
                }
                ItemSeparatorComponent={() => <View style={styles.separator} />}
                ListEmptyComponent={<EmptyState title="当天没有放送条目" />}
                renderItem={renderItem}
              />
            );
          }}
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
  sectionHeader: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 6,
    backgroundColor: colors.background,
  },
  sectionTitle: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "800",
  },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 10,
    paddingHorizontal: 1,
  },
  count: {
    color: colors.muted,
    fontSize: 13,
    fontWeight: "600",
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
