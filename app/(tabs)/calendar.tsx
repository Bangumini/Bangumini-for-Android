import { useEffect, useMemo, useRef, useState } from "react";
import { FlatList, RefreshControl, SectionList, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";

import { getCalendar } from "../../shared/api/client";
import type { CalendarItem, SubjectSmall } from "../../shared/api/types";
import { getTodayBangumiWeekday, WEEKDAY_CN } from "../../shared/sort-collections";
import { buildSubjectKeywords } from "../../shared/pinyin-keywords";
import {
  getPreferredSubjectCoverUrl,
  readCachedValue,
  readCachedValueWithin,
  writeCachedSubjectPreviews,
  writeCachedValue,
} from "../../shared/storage/sqlite-cache";
import { SearchInput } from "../../src/components/SearchInput";
import { SegmentedControl } from "../../src/components/SegmentedControl";
import { EmptyState, ErrorState, LoadingState } from "../../src/components/ScreenState";
import { SubjectCard } from "../../src/components/SubjectCard";
import { useAlert } from "../../src/components/Dialog";
import { colors } from "../../src/theme/colors";

const CACHE_MAX_AGE = 1000 * 60 * 60 * 24;
const FIRST_WEEKDAY = 1;
const LAST_WEEKDAY = 7;
const WEEKDAY_VALUES = [1, 2, 3, 4, 5, 6, 7];

function getWeekdayLabel(value: number) {
  return value === getTodayBangumiWeekday() ? "今天" : WEEKDAY_CN[value].replace("星期", "周");
}

const WEEKDAY_OPTIONS = WEEKDAY_VALUES.map((value) => ({
  value,
  label: getWeekdayLabel(value),
}));

type EnrichedItem = SubjectSmall & { weekday: number };

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

function matchesSearch(item: EnrichedItem, query: string) {
  if (!query) return true;
  const haystack = [
    item.name,
    item.name_cn,
    ...buildSubjectKeywords(item.name_cn, item.name),
  ].join(" ").toLowerCase();
  return haystack.includes(query);
}

type CalendarSection = { title: string; weekday: number; data: SubjectSmall[] };

export default function CalendarPage() {
  const alert = useAlert();
  const queryClient = useQueryClient();
  const [weekday, setWeekday] = useState(getTodayBangumiWeekday());
  const [search, setSearch] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  const translateX = useSharedValue(0);
  const fadeAnim = useSharedValue(1);
  const currentWeekdaySV = useSharedValue(weekday);

  const goToPrevWeekday = () => {
    setWeekday((current) => Math.max(FIRST_WEEKDAY, current - 1));
  };

  const goToNextWeekday = () => {
    setWeekday((current) => Math.min(LAST_WEEKDAY, current + 1));
  };

  const panGesture = Gesture.Pan()
    .activeOffsetX([-10, 10])
    .failOffsetY([-10, 10])
    .onUpdate((e) => {
      translateX.value = e.translationX;
    })
    .onEnd((e) => {
      "worklet";
      const threshold = 40;
      if (e.translationX > threshold && currentWeekdaySV.value > FIRST_WEEKDAY) {
        translateX.value = withTiming(0, { duration: 180 });
        fadeAnim.value = withSequence(
          withTiming(0, { duration: 80 }),
          withTiming(1, { duration: 120 }),
        );
        currentWeekdaySV.value -= 1;
        runOnJS(goToPrevWeekday)();
      } else if (e.translationX < -threshold && currentWeekdaySV.value < LAST_WEEKDAY) {
        translateX.value = withTiming(0, { duration: 180 });
        fadeAnim.value = withSequence(
          withTiming(0, { duration: 80 }),
          withTiming(1, { duration: 120 }),
        );
        currentWeekdaySV.value += 1;
        runOnJS(goToNextWeekday)();
      } else {
        translateX.value = withSpring(0, { damping: 20, stiffness: 300 });
      }
    });

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
    opacity: fadeAnim.value,
  }));

  const calendarQuery = useQuery({
    queryKey: ["calendar"],
    queryFn: () => loadCalendar(),
  });

  const bgRefreshedRef = useRef(false);

  useEffect(() => {
    if (!calendarQuery.data || bgRefreshedRef.current) return;
    bgRefreshedRef.current = true;

    let cancelled = false;

    getCalendar()
      .then(async (data) => {
        if (cancelled) return;
        await writeCachedValue("calendar", data);
        await writeCachedSubjectPreviews(data.flatMap((day) => day.items));

        const current = queryClient.getQueryData<CalendarItem[]>(["calendar"]);
        if (current && JSON.stringify(current) !== JSON.stringify(data)) {
          queryClient.setQueryData(["calendar"], data);
        }
      })
      .catch(() => {});

    return () => { cancelled = true; };
  }, [calendarQuery.data]);

  const searchQuery = search.trim().toLowerCase();
  const isSearching = !!searchQuery;

  const allItems = useMemo((): EnrichedItem[] => {
    if (!calendarQuery.data) return [];
    const items: EnrichedItem[] = [];
    for (const day of calendarQuery.data) {
      for (const item of day.items) {
        items.push({ ...item, weekday: day.weekday.id });
      }
    }
    return items;
  }, [calendarQuery.data]);

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

  const day = useMemo(
    () => calendarQuery.data?.find((item) => item.weekday.id === weekday),
    [calendarQuery.data, weekday],
  );

  const dayItems = day?.items ?? [];

  useEffect(() => { currentWeekdaySV.value = weekday; }, [weekday, currentWeekdaySV]);

  async function refresh() {
    setRefreshing(true);
    try {
      const next = await loadCalendar(true);
      queryClient.setQueryData(["calendar"], next);
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
      meta={[
        item.air_date || "日期未知",
        item.rating?.score ? `评分 ${item.rating.score.toFixed(1)}` : "暂无评分",
        item.rank ? `#${item.rank}` : "无排名",
      ]}
      onPress={() => router.push(`/subject/${item.id}`)}
    />
  );

  return (
    <View style={styles.screen}>
      <SegmentedControl options={WEEKDAY_OPTIONS} value={weekday} onChange={setWeekday} />
      <SearchInput value={search} onChangeText={setSearch} placeholder="搜索本周放送" />

      {calendarQuery.isLoading ? (
        <LoadingState label="加载日历" />
      ) : calendarQuery.isError && !calendarQuery.data ? (
        <ErrorState
          message={calendarQuery.error instanceof Error ? calendarQuery.error.message : "无法加载日历"}
          onRetry={() => void calendarQuery.refetch()}
        />
      ) : isSearching ? (
        <SectionList
          sections={searchSections}
          keyExtractor={(item) => String(item.id)}
          contentContainerStyle={searchSections.length ? styles.list : styles.emptyList}
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
          ListEmptyComponent={<EmptyState title="没有匹配条目" detail="调整搜索词或切换星期" />}
          renderItem={renderItem}
          stickySectionHeadersEnabled={false}
        />
      ) : (
        <GestureDetector gesture={panGesture}>
          <Animated.View style={[animatedStyle, { flex: 1 }]}>
            <FlatList
              data={dayItems}
              keyExtractor={(item) => String(item.id)}
              contentContainerStyle={dayItems.length ? styles.list : styles.emptyList}
              refreshControl={
                <RefreshControl
                  refreshing={refreshing}
                  onRefresh={refresh}
                  tintColor={colors.primary}
                  colors={[colors.primary]}
                />
              }
              ListHeaderComponent={
                dayItems.length > 0 ? (
                  <View style={styles.headerRow}>
                    <Text style={styles.count}>共 {dayItems.length} 条</Text>
                  </View>
                ) : null
              }
              ItemSeparatorComponent={() => <View style={styles.separator} />}
              ListEmptyComponent={<EmptyState title="当天没有放送条目" />}
              renderItem={renderItem}
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
