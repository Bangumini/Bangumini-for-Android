import { useEffect, useMemo, useState } from "react";
import { Alert, Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import {
  getEpisodes,
  getSubject,
  getSubjectCharacters,
  getSubjectPersons,
  getUserCollection,
  patchSubjectEpisodes,
  postUserCollection,
} from "../../shared/api/client";
import { CollectionTypeLabel } from "../../shared/api/types";
import type { CollectionType, Episode, PagedResponse, RelatedCharacter, RelatedPerson, Subject, UserCollection } from "../../shared/api/types";
import {
  deleteCachedCollection,
  getPreferredSubjectCoverUrl,
  readCachedCharactersWithin,
  readCachedCollectionWithin,
  readCachedEpisodesWithin,
  readCachedPersonsWithin,
  readCachedSubject,
  readCachedSubjectDeepWithin,
  writeCachedCharacters,
  writeCachedCollection,
  writeCachedEpisodes,
  writeCachedPersons,
  writeCachedSubject,
} from "../../shared/storage/sqlite-cache";
import CachedImage from "../../src/components/CachedImage";
import { EmptyState, LoadingState } from "../../src/components/ScreenState";
import { useAuth } from "../../src/hooks/useAuth";
import { colors } from "../../src/theme/colors";

const DETAIL_CACHE_MAX_AGE = 1000 * 60 * 60 * 24;
const EPISODE_CACHE_MAX_AGE = 1000 * 60 * 30;
const COLLECTION_OPTIONS: CollectionType[] = [1, 2, 3, 4, 5];

function isNotFoundError(error: unknown) {
  return error instanceof Error && error.message.includes("Bangumi API error 404");
}

async function loadSubject(subjectId: number, force = false) {
  if (!force) {
    const cached = await readCachedSubjectDeepWithin(subjectId, DETAIL_CACHE_MAX_AGE);
    if (cached) return cached;
  }

  const subject = await getSubject(subjectId);

  // air_weekday is not returned by /v0/subjects/{id}, but the calendar API
  // (loaded on the collections page) writes it to the SQLite subject cache.
  // Backfill from cache so the merge in writeCachedSubject preserves it.
  if (subject.air_weekday == null) {
    const cached = await readCachedSubject(subjectId);
    if (cached?.air_weekday != null) subject.air_weekday = cached.air_weekday;
  }

  return writeCachedSubject(subject);
}

async function loadCollection(username: string, subjectId: number, force = false) {
  if (!username) return null;
  if (!force) {
    const cached = await readCachedCollectionWithin(username, subjectId, DETAIL_CACHE_MAX_AGE);
    if (cached) return cached;
  }

  try {
    const collection = await getUserCollection(username, subjectId);
    await writeCachedCollection(username, collection);
    return collection;
  } catch (error) {
    if (isNotFoundError(error)) {
      await deleteCachedCollection(username, subjectId);
      return null;
    }
    throw error;
  }
}

async function loadEpisodes(subjectId: number, force = false) {
  if (!force) {
    const cached = await readCachedEpisodesWithin(subjectId, EPISODE_CACHE_MAX_AGE);
    if (cached) return cached;
  }
  const episodes = await getEpisodes(subjectId);
  await writeCachedEpisodes(subjectId, episodes);
  return episodes;
}

async function loadPersons(subjectId: number) {
  const cached = await readCachedPersonsWithin(subjectId, DETAIL_CACHE_MAX_AGE);
  if (cached) return cached;
  const persons = await getSubjectPersons(subjectId);
  await writeCachedPersons(subjectId, persons);
  return persons;
}

async function loadCharacters(subjectId: number) {
  const cached = await readCachedCharactersWithin(subjectId, DETAIL_CACHE_MAX_AGE);
  if (cached) return cached;
  const characters = await getSubjectCharacters(subjectId);
  await writeCachedCharacters(subjectId, characters);
  return characters;
}

function getTotalEpisodes(subject?: Subject | null, episodes?: PagedResponse<Episode> | null) {
  const normalCount = episodes?.data?.filter((episode) => episode.type === 0).length;
  if (normalCount) return normalCount;
  return subject?.total_episodes || subject?.eps || 0;
}

function getAirWeekdayLabel(weekday?: number) {
  const labels = ["", "周一", "周二", "周三", "周四", "周五", "周六", "周日"];
  return weekday ? labels[weekday] : null;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

export default function SubjectDetailPage() {
  const params = useLocalSearchParams<{ id: string }>();
  const subjectId = Number(params.id);
  const queryClient = useQueryClient();
  const { loggedIn, username, checking } = useAuth();
  const [targetEp, setTargetEp] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  const subjectQuery = useQuery({
    queryKey: ["subject", subjectId],
    enabled: Number.isFinite(subjectId),
    queryFn: () => loadSubject(subjectId),
  });

  const episodesQuery = useQuery({
    queryKey: ["episodes", subjectId],
    enabled: Number.isFinite(subjectId),
    queryFn: () => loadEpisodes(subjectId),
  });

  const collectionQuery = useQuery({
    queryKey: ["collection", username, subjectId],
    enabled: loggedIn && !!username && Number.isFinite(subjectId),
    queryFn: () => loadCollection(username, subjectId),
  });

  const personsQuery = useQuery({
    queryKey: ["persons", subjectId],
    enabled: Number.isFinite(subjectId),
    queryFn: () => loadPersons(subjectId),
  });

  const charactersQuery = useQuery({
    queryKey: ["characters", subjectId],
    enabled: Number.isFinite(subjectId),
    queryFn: () => loadCharacters(subjectId),
  });

  const subject = subjectQuery.data;
  const episodes = episodesQuery.data;
  const collection = collectionQuery.data;
  const totalEp = getTotalEpisodes(subject, episodes);
  const currentEp = collection?.ep_status ?? 0;
  const displayEp = targetEp ?? currentEp;
  const isDirty = targetEp !== null && targetEp !== currentEp;
  const progress = totalEp > 0 ? displayEp / totalEp : 0;

  useEffect(() => {
    setTargetEp(null);
  }, [collection?.ep_status, subjectId]);

  const summaryBlocks = useMemo(
    () => subject?.summary?.split(/\n\s*\n/).map((item) => item.trim()).filter(Boolean) ?? [],
    [subject?.summary],
  );

  async function refreshCollection() {
    if (!username) return null;
    const next = await loadCollection(username, subjectId, true);
    queryClient.setQueryData(["collection", username, subjectId], next);
    await queryClient.invalidateQueries({ queryKey: ["collections"] });
    return next;
  }

  async function changeCollectionType(type: CollectionType) {
    if (!loggedIn || !username) {
      router.push("/login");
      return;
    }

    setSaving(true);
    try {
      await postUserCollection(subjectId, { type });
      const next = await refreshCollection();
      if (next) await writeCachedCollection(username, next);
    } catch (error) {
      Alert.alert("保存失败", error instanceof Error ? error.message : "请稍后重试");
    } finally {
      setSaving(false);
    }
  }

  async function submitProgress() {
    if (!loggedIn || !username) {
      router.push("/login");
      return;
    }
    if (!isDirty || targetEp === null) return;

    setSaving(true);
    try {
      if (!collection || collection.type !== 3) {
        await postUserCollection(subjectId, { type: 3 });
      }

      const episodePayload = episodes ?? await loadEpisodes(subjectId, true);
      const from = Math.min(currentEp, targetEp);
      const to = Math.max(currentEp, targetEp);
      const ids = episodePayload.data
        .slice()
        .sort((a, b) => a.sort - b.sort)
        .filter((episode) => episode.type === 0)
        .slice(from, to)
        .map((episode) => episode.id);

      if (ids.length === 0 && from !== to) {
        throw new Error("剧集列表尚未准备好");
      }

      if (ids.length > 0) {
        await patchSubjectEpisodes(subjectId, {
          episode_id: ids,
          type: targetEp > currentEp ? 2 : 0,
        });
      }

      const next = await refreshCollection();
      if (next) await writeCachedCollection(username, next);
      setTargetEp(null);

      if (targetEp >= totalEp && totalEp > 0) {
        Alert.alert("标记为看过？", `进度已达 ${totalEp} 集，是否把收藏状态改为「看过」？`, [
          { text: "暂不", style: "cancel" },
          { text: "标记", onPress: () => void changeCollectionType(2) },
        ]);
      }
    } catch (error) {
      Alert.alert("进度保存失败", error instanceof Error ? error.message : "请稍后重试");
    } finally {
      setSaving(false);
    }
  }

  if (!Number.isFinite(subjectId)) {
    return <EmptyState title="条目 ID 无效" />;
  }

  if (subjectQuery.isLoading) {
    return <LoadingState label="加载条目详情" />;
  }

  if (!subject) {
    return <EmptyState title="没有找到条目" detail="可能已被删除或网络不可用" />;
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.hero}>
        <CachedImage uri={getPreferredSubjectCoverUrl(subject)} style={styles.cover} contentFit="cover" />
        <View style={styles.heroInfo}>
          <Text style={styles.title}>{subject.name_cn || subject.name}</Text>
          {subject.name_cn ? <Text style={styles.subtitle}>{subject.name}</Text> : null}
          <View style={styles.metaGrid}>
            <Text style={styles.meta}>评分 {subject.rating?.score ? subject.rating.score.toFixed(1) : "暂无"}</Text>
            <Text style={styles.meta}>{subject.rating?.rank ? `排名 #${subject.rating.rank}` : "暂无排名"}</Text>
            <Text style={styles.meta}>{subject.date || "日期未知"}</Text>
            {getAirWeekdayLabel(subject.air_weekday) ? (
              <Text style={styles.meta}>{getAirWeekdayLabel(subject.air_weekday)}</Text>
            ) : null}
          </View>
        </View>
      </View>

      <Section title="收藏状态">
        {checking ? <Text style={styles.muted}>检查登录状态</Text> : null}
        <View style={styles.optionRow}>
          {COLLECTION_OPTIONS.map((type) => {
            const active = collection?.type === type;
            return (
              <Pressable
                key={type}
                disabled={saving}
                onPress={() => void changeCollectionType(type)}
                style={[styles.option, active && styles.activeOption]}
              >
                <Text style={[styles.optionText, active && styles.activeOptionText]}>
                  {CollectionTypeLabel[type]}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </Section>

      <Section title="观看进度">
        <View style={styles.progressHeader}>
          <Text style={styles.progressText}>{displayEp} / {totalEp || "?"}</Text>
          <Text style={styles.muted}>{isDirty ? "待提交" : collection ? "已同步" : "未收藏"}</Text>
        </View>
        <View style={styles.progressTrack}>
          <View style={[styles.progressFill, { width: `${clamp(progress, 0, 1) * 100}%` }]} />
        </View>
        <View style={styles.stepRow}>
          <Pressable
            style={styles.stepButton}
            disabled={saving}
            onPress={() => setTargetEp(clamp(displayEp - 1, 0, Math.max(totalEp, displayEp)))}
          >
            <Text style={styles.stepText}>-</Text>
          </Pressable>
          <Pressable
            style={styles.stepButton}
            disabled={saving}
            onPress={() => setTargetEp(clamp(displayEp + 1, 0, Math.max(totalEp, displayEp + 1)))}
          >
            <Text style={styles.stepText}>+</Text>
          </Pressable>
          <Pressable
            style={[styles.submitButton, (!isDirty || saving) && styles.disabledButton]}
            disabled={!isDirty || saving}
            onPress={() => void submitProgress()}
          >
            <Text style={styles.submitText}>{saving ? "保存中" : "提交"}</Text>
          </Pressable>
        </View>
      </Section>

      <Section title="简介">
        {summaryBlocks.length ? (
          summaryBlocks.map((block, index) => (
            <Text key={`${index}-${block.slice(0, 12)}`} style={styles.paragraph}>{block}</Text>
          ))
        ) : (
          <Text style={styles.muted}>暂无简介</Text>
        )}
      </Section>

      <Section title="Staff">
        {personsQuery.data?.slice(0, 16).map((person: RelatedPerson) => (
          <Text key={`${person.id}-${person.relation}`} style={styles.line}>
            {person.relation} · {person.name}
          </Text>
        )) ?? <Text style={styles.muted}>加载中</Text>}
      </Section>

      <Section title="角色 / Cast">
        {charactersQuery.data?.slice(0, 16).map((character: RelatedCharacter) => (
          <Text key={`${character.id}-${character.relation}`} style={styles.line}>
            {character.relation} · {character.name}
            {character.actors?.[0]?.name ? ` / ${character.actors[0].name}` : ""}
          </Text>
        )) ?? <Text style={styles.muted}>加载中</Text>}
      </Section>

      <Pressable style={styles.linkButton} onPress={() => void Linking.openURL(`https://bgm.tv/subject/${subjectId}`)}>
        <Text style={styles.linkText}>在浏览器中打开</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.background,
  },
  content: {
    padding: 16,
    paddingBottom: 36,
    gap: 16,
  },
  hero: {
    flexDirection: "row",
    gap: 14,
  },
  cover: {
    width: 124,
    height: 176,
    borderRadius: 8,
    overflow: "hidden",
  },
  heroInfo: {
    flex: 1,
    gap: 10,
    minWidth: 0,
  },
  title: {
    color: colors.text,
    fontSize: 22,
    lineHeight: 28,
    fontWeight: "800",
  },
  subtitle: {
    color: colors.muted,
    fontSize: 14,
    lineHeight: 20,
  },
  metaGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  meta: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 5,
    overflow: "hidden",
    color: colors.muted,
    backgroundColor: colors.chip,
    fontSize: 12,
  },
  section: {
    gap: 10,
    padding: 14,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  sectionTitle: {
    color: colors.text,
    fontSize: 17,
    fontWeight: "800",
  },
  optionRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  option: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 7,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.background,
  },
  activeOption: {
    borderColor: colors.primary,
    backgroundColor: colors.primaryMuted,
  },
  optionText: {
    color: colors.muted,
    fontWeight: "700",
  },
  activeOptionText: {
    color: colors.primary,
  },
  progressHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  progressText: {
    color: colors.text,
    fontSize: 18,
    fontWeight: "800",
  },
  progressTrack: {
    height: 9,
    borderRadius: 5,
    overflow: "hidden",
    backgroundColor: colors.chip,
  },
  progressFill: {
    height: "100%",
    borderRadius: 5,
    backgroundColor: colors.primary,
  },
  stepRow: {
    flexDirection: "row",
    gap: 10,
  },
  stepButton: {
    width: 48,
    height: 42,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 7,
    backgroundColor: colors.chip,
  },
  stepText: {
    color: colors.text,
    fontSize: 24,
    fontWeight: "800",
  },
  submitButton: {
    flex: 1,
    height: 42,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 7,
    backgroundColor: colors.primary,
  },
  submitText: {
    color: "#071210",
    fontSize: 15,
    fontWeight: "800",
  },
  disabledButton: {
    opacity: 0.5,
  },
  paragraph: {
    color: colors.text,
    fontSize: 15,
    lineHeight: 23,
  },
  line: {
    color: colors.text,
    fontSize: 14,
    lineHeight: 21,
  },
  muted: {
    color: colors.muted,
    fontSize: 14,
  },
  linkButton: {
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 7,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.primary,
  },
  linkText: {
    color: colors.primary,
    fontSize: 15,
    fontWeight: "800",
  },
});
