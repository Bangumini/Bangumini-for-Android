import { useEffect, useState } from "react";
import { FlatList, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { useQuery } from "@tanstack/react-query";

import { searchSubjects } from "../../shared/api/client";
import type { SearchResponse } from "../../shared/api/types";
import { SubjectTypeLabel } from "../../shared/api/types";
import {
  getPreferredSubjectCoverUrl,
  readCachedValueWithin,
  writeCachedSubjectPreviews,
  writeCachedValue,
} from "../../shared/storage/sqlite-cache";
import { SearchInput } from "../../src/components/SearchInput";
import { SegmentedControl } from "../../src/components/SegmentedControl";
import { EmptyState, ErrorState, LoadingState } from "../../src/components/ScreenState";
import { SubjectCard } from "../../src/components/SubjectCard";
import { colors } from "../../src/theme/colors";

const SEARCH_CACHE_MAX_AGE = 1000 * 60 * 10;
const TYPE_OPTIONS = [
  { value: 0, label: "全部" },
  { value: 2, label: "动画" },
  { value: 1, label: "书籍" },
  { value: 4, label: "游戏" },
  { value: 3, label: "音乐" },
  { value: 6, label: "三次元" },
];

function useDebouncedValue(value: string, delayMs: number) {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [delayMs, value]);

  return debounced;
}

async function loadSearch(keyword: string, type: number) {
  const cacheKey = `search-${type}-${keyword}`;
  const cached = await readCachedValueWithin<SearchResponse>(cacheKey, SEARCH_CACHE_MAX_AGE);
  if (cached) return cached;

  const data = await searchSubjects({
    keyword,
    sort: "rank",
    type: type ? [type] : undefined,
    limit: 30,
  });
  await writeCachedValue(cacheKey, data);
  await writeCachedSubjectPreviews(data.data);
  return data;
}

export default function SearchPage() {
  const [keyword, setKeyword] = useState("");
  const [type, setType] = useState(2);
  const debouncedKeyword = useDebouncedValue(keyword.trim(), 300);

  const searchQuery = useQuery({
    queryKey: ["search", debouncedKeyword, type],
    enabled: debouncedKeyword.length > 0,
    queryFn: () => loadSearch(debouncedKeyword, type),
  });

  const subjects = searchQuery.data?.data ?? [];

  return (
    <View style={styles.screen}>
      <SearchInput value={keyword} onChangeText={setKeyword} placeholder="搜索条目" />
      <SegmentedControl options={TYPE_OPTIONS} value={type} onChange={setType} />

      {!debouncedKeyword ? (
        <EmptyState title="输入关键词开始搜索" detail="支持中文名、原名和拼音" />
      ) : searchQuery.isLoading ? (
        <LoadingState label="搜索中" />
      ) : searchQuery.isError && !searchQuery.data ? (
        <ErrorState
          message={searchQuery.error instanceof Error ? searchQuery.error.message : "搜索失败"}
          onRetry={() => void searchQuery.refetch()}
        />
      ) : (
        <FlatList
          data={subjects}
          keyExtractor={(item) => String(item.id)}
          contentContainerStyle={subjects.length ? styles.list : styles.emptyList}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
          ListEmptyComponent={<EmptyState title="没有搜索结果" detail="换个关键词或类型试试" />}
          renderItem={({ item }) => (
            <SubjectCard
              title={item.name_cn || item.name}
              subtitle={item.name}
              coverUrl={getPreferredSubjectCoverUrl(item)}
              meta={[
                SubjectTypeLabel[item.type] ?? "条目",
                item.date || "日期未知",
                item.rating?.score ? `评分 ${item.rating.score.toFixed(1)}` : "暂无评分",
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
