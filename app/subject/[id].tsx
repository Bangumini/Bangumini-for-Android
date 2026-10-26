import { useEffect, useMemo, useState } from "react";
import { Linking, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { router, useLocalSearchParams } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";

import { useSubjectDetailData } from "../../src/hooks/useSubjectDetailData";
import { applySubjectAiringOffset } from "../../shared/airing-offset";
import { CollectionTypeLabel } from "../../shared/api/types";
import type { CollectionType, Episode, PagedResponse, RelatedCharacter, RelatedPerson, Subject, SubjectRelation } from "../../shared/api/types";
import { getPreferredSubjectCoverUrl } from "../../shared/storage/sqlite-cache";
import {
  enqueueCompleteProgressTask,
  enqueueSetCollectionTypeTask,
  getCollectionTaskQueue,
  getOptimisticCollectionPatchForSubject,
  startCollectionTaskWorker,
  subscribeCollectionTaskQueue,
  type CollectionTask,
} from "../../src/api/collection-tasks";
import AiringOffsetControl from "../../src/components/AiringOffsetControl";
import CachedImage from "../../src/components/CachedImage";
import ImageViewer from "../../src/components/ImageViewer";
import { EmptyState, LoadingState } from "../../src/components/ScreenState";
import { useAiringOffsets } from "../../src/hooks/useAiringOffsets";
import { useAuth } from "../../src/hooks/useAuth";
import { colors } from "../../src/theme/colors";
import { useAlert } from "../../src/components/Dialog";
import { saveImageToGallery } from "../../src/utils/saveImage";
import { showToast } from "../../src/utils/toast";
import { getSubjectTitleForCopy } from "../../src/api/subject-title-copy";
import {
  getCrossSeasonEpisodeOffset,
  isCrossSeasonCountEnabled,
} from "../../src/api/cross-season-count";

function CopyText({ text, copyText, style, children }: { text: string; copyText?: () => Promise<string>; style?: object; children?: React.ReactNode }) {
  const alert = useAlert();
  const handleLongPress = async () => {
    const value = copyText ? await copyText() : text;
    await Clipboard.setStringAsync(value);
    alert("已复制", value);
  };
  return (
    <Pressable onLongPress={handleLongPress} delayLongPress={400}>
      {children ?? <Text style={style}>{text}</Text>}
    </Pressable>
  );
}

const COLLECTION_OPTIONS: CollectionType[] = [1, 2, 3, 4, 5];

function getTotalEpisodes(subject?: Subject | null, episodes?: PagedResponse<Episode> | null) {
  const normalCount = episodes?.data?.filter((episode) => episode.type === 0).length;
  if (normalCount) return normalCount;
  return subject?.total_episodes || subject?.eps || 0;
}

function getAirWeekdayLabel(weekday?: number, date?: string) {
  const labels = ["", "周一", "周二", "周三", "周四", "周五", "周六", "周日"];
  if (weekday && labels[weekday]) return labels[weekday];
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;

  const parsedDate = new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== date) return null;
  return labels[parsedDate.getUTCDay() || 7];
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

const SUMMARY_ORIGINAL_MARKER = "[简介原文]";

type SummaryBlock = { type: "paragraph" | "heading"; text: string };

function getSummaryBlocks(summary: string): SummaryBlock[] {
  const blocks: SummaryBlock[] = [];
  for (const rawParagraph of summary.split(/\n\s*\n/)) {
    const paragraph = rawParagraph.trim();
    if (!paragraph) continue;
    const parts = paragraph.split(SUMMARY_ORIGINAL_MARKER);
    parts.forEach((part, index) => {
      const text = part.trim();
      if (text) blocks.push({ type: "paragraph", text });
      if (index < parts.length - 1) {
        blocks.push({ type: "heading", text: "简介原文" });
      }
    });
  }
  return blocks;
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
  const { loggedIn, username } = useAuth();
  // 条目或身份变化时同步丢弃草稿，不能等 effect 才清理上一页的进度。
  return <SubjectDetailContent key={JSON.stringify([params.id, loggedIn ? username : null])} />;
}

function SubjectDetailContent() {
  const alert = useAlert();
  const params = useLocalSearchParams<{ id: string }>();
  const subjectId = Number(params.id);
  const queryClient = useQueryClient();
  const { loggedIn, username, checking } = useAuth();
  const airingOffsets = useAiringOffsets();
  const airingOffsetDays = airingOffsets[subjectId] ?? 0;
  const [targetEp, setTargetEp] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [viewerVisible, setViewerVisible] = useState(false);
  const [collectionTasks, setCollectionTasks] = useState<CollectionTask[]>([]);

  useEffect(() => {
    if (!checking && loggedIn) {
      startCollectionTaskWorker(queryClient);
    }
  }, [checking, loggedIn, queryClient]);

  const { data, loading, refreshing, refresh: handleRefresh } = useSubjectDetailData(
    subjectId, loggedIn && username ? username : null, queryClient,
  );
  const { subject, episodes, collection, persons, characters, relations, artistMap } = data;

  const songGroups = useMemo(() => {
    if (!relations) return null;
    const ops: SubjectRelation[] = [];
    const eds: SubjectRelation[] = [];
    const osts: SubjectRelation[] = [];
    const characterSongs: SubjectRelation[] = [];
    for (const r of relations) {
      if (r.relation === "片头曲") ops.push(r);
      else if (r.relation === "片尾曲") eds.push(r);
      else if (r.relation === "原声集") osts.push(r);
      else if (r.relation === "角色歌") characterSongs.push(r);
    }
    return { ops, eds, osts, characterSongs };
  }, [relations]);

  useEffect(() => {
    let cancelled = false;
    let readSerial = 0;
    const syncCollectionTasks = () => {
      const serial = ++readSerial;
      void getCollectionTaskQueue().then((tasks) => {
        if (!cancelled && serial === readSerial) setCollectionTasks(tasks);
      }).catch(() => {
        // 磁盘队列暂不可读时保留最后一次投影，不能清空用户的新目标。
      });
    };

    syncCollectionTasks();
    const unsubscribe = subscribeCollectionTaskQueue(syncCollectionTasks);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const totalEp = getTotalEpisodes(subject, episodes);
  const originalAirWeekdayLabel = getAirWeekdayLabel(subject?.air_weekday, subject?.date);
  // 仅生成放送日期的展示投影，不修改 Query cache、持久化数据或剧集进度。
  const airingSubject = subject?.type === 2
    ? applySubjectAiringOffset(subject, airingOffsetDays)
    : subject;
  const airWeekdayLabel = getAirWeekdayLabel(airingSubject?.air_weekday, airingSubject?.date);
  const previewEpisode = useMemo(
    () => episodes?.data
      ?.filter((episode) => episode.type === 0)
      .sort((a, b) => a.sort - b.sort)
      .find((episode) => getAirWeekdayLabel(undefined, episode.airdate) !== null),
    [episodes],
  );

  const [crossSeasonCount, setCrossSeasonCount] = useState(false);
  useEffect(() => {
    void isCrossSeasonCountEnabled().then(setCrossSeasonCount);
  }, []);

  // 跨季连续计数只影响展示层，提交给 API 的进度值不变。
  const episodeOffset = crossSeasonCount
    ? getCrossSeasonEpisodeOffset(episodes?.data ?? [])
    : 0;
  const displayedTotalEp = totalEp + episodeOffset;

  const subjectCollectionTasks = useMemo(
    () => collectionTasks.filter((task) => loggedIn && task.payload.username === username && task.payload.subjectId === subjectId),
    [collectionTasks, subjectId, username, loggedIn],
  );
  const optimisticCollectionPatch = useMemo(
    () => getOptimisticCollectionPatchForSubject(subjectId, subjectCollectionTasks),
    [subjectCollectionTasks, subjectId],
  );
  const activeCollectionTask = subjectCollectionTasks.find((task) => task.status === "pending" || task.status === "running");
  const failedCollectionTask = subjectCollectionTasks.find((task) => task.status === "failed");
  const currentEp = optimisticCollectionPatch?.ep_status ?? collection?.ep_status ?? 0;
  const currentCollectionType = optimisticCollectionPatch?.type ?? collection?.type;
  const displayEp = targetEp ?? currentEp;
  const isDirty = targetEp !== null && targetEp !== currentEp;
  const progress = displayedTotalEp > 0 ? (displayEp + episodeOffset) / displayedTotalEp : 0;
  const hasKnownTotalEp = totalEp > 0;
  const canDecreaseProgress = displayEp > 0;
  const canIncreaseProgress = !hasKnownTotalEp || displayEp < totalEp;

  useEffect(() => {
    setTargetEp(null);
  }, [currentEp, subjectId]);

  useEffect(() => {
    if (targetEp !== null && hasKnownTotalEp && targetEp > totalEp) {
      setTargetEp(totalEp);
    }
  }, [hasKnownTotalEp, targetEp, totalEp]);

  const summaryBlocks = useMemo(
    () => (subject?.summary ? getSummaryBlocks(subject.summary) : []),
    [subject?.summary],
  );

  function getTaskSubjectTitle() {
    return subject?.name_cn || subject?.name || `#${subjectId}`;
  }

  function rememberQueuedTask(task: CollectionTask | null) {
    if (!task) return;
    setCollectionTasks((prev) => [
      task,
      ...prev.filter((item) => item.id !== task.id),
    ]);
  }

  function confirmCanQueueProgress(): Promise<boolean> {
    if (currentCollectionType === 3) return Promise.resolve(true);

    return new Promise((resolve) => {
      const currentLabel = currentCollectionType ? CollectionTypeLabel[currentCollectionType] : null;
      alert(
        currentLabel ? "切换到「在看」？" : "收藏并切换到「在看」？",
        currentLabel
          ? `当前收藏状态为「${currentLabel}」，需要切换到「在看」才能更新进度`
          : "更新观看进度需要先将条目以「在看」状态收藏",
        [
          { text: "取消", style: "cancel", onPress: () => resolve(false) },
          { text: currentLabel ? "切换" : "收藏", onPress: () => resolve(true) },
        ],
      );
    });
  }

  function confirmMarkWatchedAfterSave(progressTarget: number): Promise<boolean> {
    if (progressTarget < totalEp || totalEp <= 0) return Promise.resolve(false);

    return new Promise((resolve) => {
      alert(
        "保存后标记为看过？",
        `观看进度将保存为 ${progressTarget + episodeOffset} / ${totalEp + episodeOffset} 集，是否在保存成功后标记为「看过」？`,
        [
          { text: "仅保存进度", style: "cancel", onPress: () => resolve(false) },
          { text: "保存并标记", onPress: () => resolve(true) },
        ],
      );
    });
  }

  async function changeCollectionType(type: CollectionType) {
    if (!loggedIn || !username) {
      router.push("/login");
      return;
    }
    if (currentCollectionType === type) return;

    setSaving(true);
    try {
      const queued = await enqueueSetCollectionTypeTask({
        username,
        subjectId,
        subjectTitle: getTaskSubjectTitle(),
        previousType: collection?.type,
        nextType: type,
      });
      if (!queued) throw new Error("无法创建后台任务");
      rememberQueuedTask(queued);
    } catch (error) {
      alert("任务创建失败", error instanceof Error ? error.message : "请稍后重试");
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

    const ok = await confirmCanQueueProgress();
    if (!ok) return;

    const progressTarget = targetEp;
    const markWatched = await confirmMarkWatchedAfterSave(progressTarget);

    setSaving(true);
    try {
      const queued = await enqueueCompleteProgressTask({
        username,
        subjectId,
        subjectTitle: getTaskSubjectTitle(),
        targetEp: progressTarget,
        totalEp,
        ensureWatching: currentCollectionType !== 3,
        markWatched,
        previousType: collection?.type,
      });
      if (!queued) throw new Error("无法创建后台任务");
      rememberQueuedTask(queued);
      setTargetEp(null);
    } catch (error) {
      alert("任务创建失败", error instanceof Error ? error.message : "请稍后重试");
    } finally {
      setSaving(false);
    }
  }

  if (!Number.isFinite(subjectId)) {
    return <EmptyState title="条目 ID 无效" />;
  }

  if (loading) {
    return <LoadingState label="加载条目详情" />;
  }

  if (!subject) {
    return <EmptyState title="没有找到条目" detail="可能已被删除或网络不可用" />;
  }

  return (
    <>
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={handleRefresh}
          tintColor={colors.primary} colors={[colors.primary]} />
      }>
      <View style={styles.hero}>
        <Pressable
          onPress={() => setViewerVisible(true)}
          onLongPress={() => {
            const url = getPreferredSubjectCoverUrl(subject);
            if (!url) return;
            alert("保存图片", "是否保存到相册？", [
              { text: "取消", style: "cancel" },
              {
                text: "保存",
                onPress: async () => {
                  try {
                    await saveImageToGallery(url);
                    showToast("已保存到 Bangumini 相册");
                  } catch (err: unknown) {
                    const message = err instanceof Error ? err.message : "保存失败";
                    showToast(message);
                  }
                },
              },
            ]);
          }}
        >
          <CachedImage uri={getPreferredSubjectCoverUrl(subject)} style={styles.cover} contentFit="cover" />
        </Pressable>
        <View style={styles.heroInfo}>
          <CopyText text={subject.name_cn || subject.name}
            copyText={async () => getSubjectTitleForCopy(subject.name_cn || subject.name)}>
            <Text style={styles.title}>{subject.name_cn || subject.name}</Text>
          </CopyText>
          {subject.name_cn ? (
            <CopyText text={subject.name}>
              <Text style={styles.subtitle}>{subject.name}</Text>
            </CopyText>
          ) : null}
          <View style={styles.metaGrid}>
            <CopyText text={`评分 ${subject.rating?.score ? subject.rating.score.toFixed(1) : "暂无"}`}>
              <Text style={styles.meta}>评分 {subject.rating?.score ? subject.rating.score.toFixed(1) : "暂无"}</Text>
            </CopyText>
            <CopyText text={`排名 #${subject.rank || subject.rating?.rank}`}>
              <Text style={styles.meta}>{subject.rank || subject.rating?.rank ? `排名 #${subject.rank || subject.rating?.rank}` : "暂无排名"}</Text>
            </CopyText>
            <CopyText text={subject.date || "日期未知"}>
              <Text style={styles.meta}>
                {subject.type === 2 ? "Bangumi 原始放送 " : ""}{subject.date || "日期未知"}
                {originalAirWeekdayLabel ? ` (${originalAirWeekdayLabel})` : ""}
              </Text>
            </CopyText>
            {subject.type === 2 && airingOffsetDays !== 0 ? (
              <Text style={[styles.meta, styles.correctedAirDate]} accessibilityLiveRegion="polite">
                修正后放送 {airingSubject?.date || "暂无日期，无法推算"}
                {airWeekdayLabel ? ` (${airWeekdayLabel})` : ""}
              </Text>
            ) : null}
          </View>
        </View>
      </View>

      <Section title="收藏状态">
        {checking ? <Text style={styles.muted}>检查登录状态</Text> : null}
        <View style={styles.optionRow}>
          {COLLECTION_OPTIONS.map((type) => {
            const active = currentCollectionType === type;
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
          <Text style={styles.progressText}>{displayEp + episodeOffset} / {displayedTotalEp || "?"}</Text>
          <Text style={[styles.muted, failedCollectionTask && !isDirty ? styles.dangerText : null]}>
            {isDirty
              ? "待提交"
              : activeCollectionTask
              ? "同步中"
              : failedCollectionTask
              ? "同步失败"
              : collection
              ? "已同步"
              : currentCollectionType
              ? "等待同步"
              : "未收藏"}
          </Text>
        </View>
        <View style={styles.progressTrack}>
          <View style={[styles.progressFill, { width: `${clamp(progress, 0, 1) * 100}%` }]} />
        </View>
        <View style={styles.stepRow}>
          <Pressable
            style={[styles.stepButton, (saving || !canDecreaseProgress) && styles.disabledButton]}
            disabled={saving || !canDecreaseProgress}
            onPress={() => setTargetEp(Math.max(0, displayEp - 1))}
          >
            <Text style={styles.stepText}>-</Text>
          </Pressable>
          <Pressable
            style={[styles.stepButton, (saving || !canIncreaseProgress) && styles.disabledButton]}
            disabled={saving || !canIncreaseProgress}
            onPress={() => setTargetEp(hasKnownTotalEp ? clamp(displayEp + 1, 0, totalEp) : displayEp + 1)}
          >
            <Text style={styles.stepText}>+</Text>
          </Pressable>
          <Pressable
            style={[styles.submitButton, (!isDirty || saving) && styles.disabledButton]}
            disabled={!isDirty || saving}
            onPress={() => void submitProgress()}
          >
            <Text style={styles.submitText}>{saving ? "创建中" : "提交"}</Text>
          </Pressable>
        </View>
      </Section>

      {subject.type === 2 ? (
        <AiringOffsetControl
          key={subjectId}
          subjectId={subjectId}
          appliedDays={airingOffsetDays}
          originalDate={subject.date}
          airWeekday={subject.air_weekday}
          previewEpisode={previewEpisode}
        />
      ) : null}

      <Section title="简介">
        {summaryBlocks.length ? (
          summaryBlocks.map((block, index) =>
            block.type === "heading" ? (
              <Text key={`heading-${index}`} style={[styles.sectionTitle, { marginTop: index > 0 ? 12 : 0 }]}>{block.text}</Text>
            ) : (
              <CopyText key={`para-${index}`} text={block.text}>
                <Text style={styles.paragraph}>{block.text}</Text>
              </CopyText>
            )
          )
        ) : (
          <Text style={styles.muted}>暂无简介</Text>
        )}
      </Section>

      <Section title="Staff">
        {persons.slice(0, 16).map((person: RelatedPerson) => (
          <CopyText key={`${person.id}-${person.relation}`} text={person.name}>
            <Text style={styles.line}>
              {person.relation} · {person.name}
            </Text>
          </CopyText>
        )) ?? <Text style={styles.muted}>加载中</Text>}
      </Section>

      <Section title="OP/ED/OST">
        {loading ? (
          <Text style={styles.muted}>加载中</Text>
        ) : songGroups ? (
          <>
            {songGroups.ops.length > 0 && (
              <View style={{ gap: 4 }}>
                <Text style={styles.muted}>片头曲 (OP)</Text>
                {songGroups.ops.map((r) => (
                  <CopyText key={r.id} text={r.name_cn || r.name}>
                    <Text style={styles.line}>{r.name_cn || r.name}{r.name_cn && r.name ? ` / ${r.name}` : ""}{artistMap[r.id] ? ` · ${artistMap[r.id]}` : ""}</Text>
                  </CopyText>
                ))}
              </View>
            )}
            {songGroups.eds.length > 0 && (
              <View style={{ gap: 4, marginTop: songGroups.ops.length > 0 ? 10 : 0 }}>
                <Text style={styles.muted}>片尾曲 (ED)</Text>
                {songGroups.eds.map((r) => (
                  <CopyText key={r.id} text={r.name_cn || r.name}>
                    <Text style={styles.line}>{r.name_cn || r.name}{r.name_cn && r.name ? ` / ${r.name}` : ""}{artistMap[r.id] ? ` · ${artistMap[r.id]}` : ""}</Text>
                  </CopyText>
                ))}
              </View>
            )}
            {songGroups.osts.length > 0 && (
              <View style={{ gap: 4, marginTop: songGroups.ops.length > 0 || songGroups.eds.length > 0 ? 10 : 0 }}>
                <Text style={styles.muted}>原声集 (OST)</Text>
                {songGroups.osts.map((r) => (
                  <CopyText key={r.id} text={r.name_cn || r.name}>
                    <Text style={styles.line}>{r.name_cn || r.name}{r.name_cn && r.name ? ` / ${r.name}` : ""}{artistMap[r.id] ? ` · ${artistMap[r.id]}` : ""}</Text>
                  </CopyText>
                ))}
              </View>
            )}
            {songGroups.characterSongs.length > 0 && (
              <View style={{ gap: 4, marginTop: songGroups.ops.length > 0 || songGroups.eds.length > 0 || songGroups.osts.length > 0 ? 10 : 0 }}>
                <Text style={styles.muted}>角色歌</Text>
                {songGroups.characterSongs.map((r) => (
                  <CopyText key={r.id} text={r.name_cn || r.name}>
                    <Text style={styles.line}>{r.name_cn || r.name}{r.name_cn && r.name ? ` / ${r.name}` : ""}{artistMap[r.id] ? ` · ${artistMap[r.id]}` : ""}</Text>
                  </CopyText>
                ))}
              </View>
            )}
          </>
        ) : (
          <Text style={styles.muted}>暂无</Text>
        )}
      </Section>

      <Section title="角色 / Cast">
        {characters.slice(0, 16).map((character: RelatedCharacter) => (
          <CopyText key={`${character.id}-${character.relation}`} text={character.name}>
            <Text style={styles.line}>
              {character.relation} · {character.name}
              {character.actors?.[0]?.name ? ` / ${character.actors[0].name}` : ""}
            </Text>
          </CopyText>
        )) ?? <Text style={styles.muted}>加载中</Text>}
      </Section>

      <Pressable style={styles.linkButton} onPress={() => void Linking.openURL(`https://bgm.tv/subject/${subjectId}`)}>
        <Text style={styles.linkText}>在浏览器中打开</Text>
      </Pressable>
    </ScrollView>
    <ImageViewer
      visible={viewerVisible}
      uri={getPreferredSubjectCoverUrl(subject) ?? ""}
      onClose={() => setViewerVisible(false)}
    />
    </>
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
  correctedAirDate: {
    color: colors.primary,
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
  dangerText: {
    color: colors.danger,
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
