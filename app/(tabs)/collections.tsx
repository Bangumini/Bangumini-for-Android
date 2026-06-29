import { useEffect, useMemo, useState } from "react";
import { Alert, FlatList, RefreshControl, StyleSheet, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { router } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { getAllUserCollections, getCalendar } from "../../shared/api/client";
import type { CalendarItem, CollectionType, PagedResponse, UserCollection } from "../../shared/api/types";
import { CollectionTypeLabel, SubjectTypeLabel } from "../../shared/api/types";
import { buildSubjectKeywords } from "../../shared/pinyin-keywords";
import { getDisplayLabel, getTodayBangumiWeekday, sortCollections } from "../../shared/sort-collections";
import {
  getPreferredSubjectCoverUrl,
  readCachedSubject,
  readCachedValueWithin,
  writeCachedSubjectPreviews,
  writeCachedValue,
} from "../../shared/storage/sqlite-cache";
import { getSubjectTitleForCopy } from "../../src/api/subject-title-copy";
import { SearchInput } from "../../src/components/SearchInput";
import { SegmentedControl } from "../../src/components/SegmentedControl";
import { EmptyState, ErrorState, LoadingState } from "../../src/components/ScreenState";
import { SubjectCard } from "../../src/components/SubjectCard";
import { useAuth } from "../../src/hooks/useAuth";
import { colors } from "../../src/theme/colors";

const CACHE_MAX_AGE = 1000 * 60 * 60 * 24;
const EMPTY_AIRING_MAP = new Map<number, number>();
const EMPTY_AIRING_TIME_MAP = new Map<number, { airingAt: number; episode: number }>();

const COLLECTION_OPTIONS: Array<{ value: CollectionType; label: string }> = [
  { value: 3, label: "在看" },
  { value: 1, label: "想看" },
  { value: 2, label: "看过" },
  { value: 4, label: "搁置" },
  { value: 5, label: "抛弃" },
];

async function loadCollections(type: CollectionType, username: string, force = false) {
  const cacheKey = `collections-${type}-${username}`;
  if (!force) {
    const cached = await readCachedValueWithin<PagedResponse<UserCollection>>(cacheKey, CACHE_MAX_AGE);
    if (cached) {
      await fillMissingTotalEpisodes(cached.data);
      return cached;
    }
  }

  const data = await getAllUserCollections({ username, type });
  await writeCachedValue(cacheKey, data);
  await writeCachedSubjectPreviews(data.data.map((collection) => collection.subject));
  await fillMissingTotalEpisodes(data.data);
  return data;
}

async function fillMissingTotalEpisodes(collections: UserCollection[]) {
  for (const collection of collections) {
    const s = collection.subject;
    if (!s.total_episodes && !s.eps) {
      const cached = await readCachedSubject(s.id);
      if (cached?.total_episodes) s.total_episodes = cached.total_episodes;
      if (cached?.eps) s.eps = cached.eps;
    }
  }
}

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
  const queryClient = useQueryClient();
  const { checking, loggedIn, username } = useAuth();
  const [collectionType, setCollectionType] = useState<CollectionType>(3);
  const [search, setSearch] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (!checking && !loggedIn) router.replace("/login");
  }, [checking, loggedIn]);

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
  const query = search.trim().toLowerCase();

  const collections = useMemo(() => {
    const data = collectionsQuery.data?.data ?? [];
    const sorted = sortCollections(data, calendarQuery.data ?? [], today, EMPTY_AIRING_MAP, EMPTY_AIRING_TIME_MAP);
    return sorted.filter((collection) => matchesSearch(collection, query));
  }, [calendarQuery.data, collectionsQuery.data?.data, query, today]);

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
    } catch (error) {
      Alert.alert("刷新失败", error instanceof Error ? error.message : "请稍后重试");
    } finally {
      setRefreshing(false);
    }
  }

  async function copyTitle(collection: UserCollection) {
    const title = collection.subject.name_cn || collection.subject.name;
    await Clipboard.setStringAsync(await getSubjectTitleForCopy(title));
    Alert.alert("已复制", title);
  }

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

      {collectionsQuery.isLoading ? (
        <LoadingState label="加载收藏" />
      ) : collectionsQuery.isError && !collectionsQuery.data ? (
        <ErrorState
          message={collectionsQuery.error instanceof Error ? collectionsQuery.error.message : "无法加载收藏"}
          onRetry={() => void collectionsQuery.refetch()}
        />
      ) : (
        <FlatList
          data={collections}
          keyExtractor={(item) => String(item.subject_id)}
          contentContainerStyle={collections.length ? styles.list : styles.emptyList}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={refresh}
              tintColor={colors.primary}
              colors={[colors.primary]}
            />
          }
          ListHeaderComponent={
            <Text style={styles.count}>
              {CollectionTypeLabel[collectionType]} · {collections.length} / {collectionsQuery.data?.total ?? 0}
            </Text>
          }
          ItemSeparatorComponent={() => <View style={styles.separator} />}
          ListEmptyComponent={<EmptyState title="没有匹配条目" detail="调整搜索词或切换收藏类型" />}
          renderItem={({ item }) => {
            const subject = item.subject;
            const title = subject.name_cn || subject.name;
            const total = subject.total_episodes || subject.eps || 0;
            const label = getDisplayLabel(item, airingMap, EMPTY_AIRING_MAP, today);
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
                  subject.rating?.score ? `评分 ${subject.rating.score.toFixed(1)}` : "暂无评分",
                ]}
                onPress={() => router.push(`/subject/${item.subject_id}`)}
                onLongPress={() => void copyTitle(item)}
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
    marginBottom: 10,
    color: colors.muted,
    fontSize: 13,
    fontWeight: "600",
  },
});
