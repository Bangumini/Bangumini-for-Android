import { useMemo, useState } from "react";
import { Alert, FlatList, RefreshControl, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { getCalendar } from "../../shared/api/client";
import type { CalendarItem } from "../../shared/api/types";
import { getTodayBangumiWeekday, WEEKDAY_CN } from "../../shared/sort-collections";
import {
  getPreferredSubjectCoverUrl,
  readCachedValueWithin,
  writeCachedSubjectPreviews,
  writeCachedValue,
} from "../../shared/storage/sqlite-cache";
import { SegmentedControl } from "../../src/components/SegmentedControl";
import { EmptyState, ErrorState, LoadingState } from "../../src/components/ScreenState";
import { SubjectCard } from "../../src/components/SubjectCard";
import { colors } from "../../src/theme/colors";

const CACHE_MAX_AGE = 1000 * 60 * 60 * 24;
const WEEKDAY_OPTIONS = [1, 2, 3, 4, 5, 6, 7].map((value) => ({
  value,
  label: value === getTodayBangumiWeekday() ? "今天" : WEEKDAY_CN[value].replace("星期", "周"),
}));

async function loadCalendar(force = false) {
  if (!force) {
    const cached = await readCachedValueWithin<CalendarItem[]>("calendar", CACHE_MAX_AGE);
    if (cached) return cached;
  }
  const data = await getCalendar();
  await writeCachedValue("calendar", data);
  await writeCachedSubjectPreviews(data.flatMap((day) => day.items));
  return data;
}

export default function CalendarPage() {
  const queryClient = useQueryClient();
  const [weekday, setWeekday] = useState(getTodayBangumiWeekday());
  const [refreshing, setRefreshing] = useState(false);

  const calendarQuery = useQuery({
    queryKey: ["calendar"],
    queryFn: () => loadCalendar(),
  });

  const day = useMemo(
    () => calendarQuery.data?.find((item) => item.weekday.id === weekday),
    [calendarQuery.data, weekday],
  );

  async function refresh() {
    setRefreshing(true);
    try {
      const next = await loadCalendar(true);
      queryClient.setQueryData(["calendar"], next);
    } catch (error) {
      Alert.alert("刷新失败", error instanceof Error ? error.message : "请稍后重试");
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <View style={styles.screen}>
      <SegmentedControl options={WEEKDAY_OPTIONS} value={weekday} onChange={setWeekday} />
      <Text style={styles.heading}>{WEEKDAY_CN[weekday]}</Text>

      {calendarQuery.isLoading ? (
        <LoadingState label="加载日历" />
      ) : calendarQuery.isError && !calendarQuery.data ? (
        <ErrorState
          message={calendarQuery.error instanceof Error ? calendarQuery.error.message : "无法加载日历"}
          onRetry={() => void calendarQuery.refetch()}
        />
      ) : (
        <FlatList
          data={day?.items ?? []}
          keyExtractor={(item) => String(item.id)}
          contentContainerStyle={(day?.items.length ?? 0) ? styles.list : styles.emptyList}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={refresh}
              tintColor={colors.primary}
              colors={[colors.primary]}
            />
          }
          ItemSeparatorComponent={() => <View style={styles.separator} />}
          ListEmptyComponent={<EmptyState title="当天没有放送条目" />}
          renderItem={({ item }) => (
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
    paddingBottom: 8,
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
