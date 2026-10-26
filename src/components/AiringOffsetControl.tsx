import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import {
  MAX_AIRING_OFFSET_DAYS,
  formatAiringOffsetDays,
  isValidAiringOffsetDays,
  shiftAiringDate,
  shiftAiringWeekday,
} from "../../shared/airing-offset";
import { setAiringOffsetDays } from "../api/airing-offset";
import { colors } from "../theme/colors";

type Props = {
  subjectId: number;
  appliedDays: number;
  originalDate?: string;
  airWeekday?: number;
  previewEpisode?: { sort: number; airdate: string };
};

function hasValidDate(date: string | undefined): date is string {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const timestamp = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === date;
}

function weekdayLabel(weekday: number | undefined) {
  return weekday ? ["", "周一", "周二", "周三", "周四", "周五", "周六", "周日"][weekday] : undefined;
}

export default function AiringOffsetControl({
  subjectId, appliedDays, originalDate, airWeekday, previewEpisode,
}: Props) {
  const [draft, setDraft] = useState({ subjectId, base: appliedDays, value: String(appliedDays) });
  const [feedback, setFeedback] = useState<{ error: boolean; text: string; days?: number } | null>(null);
  const [savingSubject, setSavingSubject] = useState<number | null>(null);
  const active = useRef({ subjectId, mounted: true, request: 0 });
  active.current.subjectId = subjectId;
  useEffect(() => {
    const state = active.current;
    state.mounted = true;
    return () => { state.mounted = false; };
  }, []);
  const saving = savingSubject === subjectId;
  // 条目或已应用值变化时重置基准，避免返回旧值后复活旧草稿。
  if (draft.subjectId !== subjectId || draft.base !== appliedDays) {
    setDraft({ subjectId, base: appliedDays, value: String(appliedDays) });
    if (draft.subjectId !== subjectId || (!saving && feedback?.days !== appliedDays)) setFeedback(null);
  }
  const value = draft.subjectId === subjectId && draft.base === appliedDays ? draft.value : String(appliedDays);
  const days = /^-?\d+$/.test(value.trim()) ? Number(value) : NaN;
  const valid = isValidAiringOffsetDays(days);
  const dirty = !valid || days !== appliedDays;
  const dateAvailable = hasValidDate(originalDate);
  const episodeAvailable = hasValidDate(previewEpisode?.airdate);
  const previewWeekday = valid ? weekdayLabel(shiftAiringWeekday(airWeekday, days)) : undefined;

  function updateDraft(next: string) {
    if (saving) return;
    setDraft({ subjectId, base: appliedDays, value: next });
    setFeedback(null);
  }

  async function save(next: number) {
    if (saving) return;
    const request = ++active.current.request;
    setSavingSubject(subjectId);
    setFeedback(null);
    const isCurrent = () => active.current.mounted && active.current.subjectId === subjectId && active.current.request === request;
    try {
      await setAiringOffsetDays(subjectId, next);
      if (isCurrent()) {
        setDraft(current => ({ ...current, value: String(next) }));
        setFeedback({ error: false, text: next === 0 ? "已恢复默认" : "已保存", days: next });
      }
    } catch {
      if (isCurrent()) setFeedback({ error: true, text: "保存失败，本机存储不可用；原设置未改变" });
    } finally {
      if (active.current.mounted && active.current.request === request) setSavingSubject(null);
    }
  }

  function button(label: string, disabled: boolean, onPress: () => void, primary = false) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ disabled: disabled || saving, busy: saving }}
        disabled={disabled || saving}
        onPress={onPress}
        style={({ pressed }) => [styles.button, (disabled || saving) && styles.disabled, pressed && styles.pressed]}
      >
        <Text style={[styles.buttonText, primary && styles.primary]}>{label}</Text>
      </Pressable>
    );
  }

  return (
    <View style={styles.panel} accessibilityLabel="条目放送日期偏置">
      <View style={styles.heading}>
        <Text style={styles.title}>放送日期偏置</Text>
        <Text style={styles.primary} accessibilityLabel={`已应用：${formatAiringOffsetDays(appliedDays)}`}>
          {formatAiringOffsetDays(appliedDays)}
        </Text>
      </View>
      <Text style={styles.label}>偏置天数（负数提前，正数延后）</Text>
      <TextInput
        accessibilityLabel="偏置天数（负数提前，正数延后）"
        accessibilityHint={`请输入负${MAX_AIRING_OFFSET_DAYS}至${MAX_AIRING_OFFSET_DAYS}之间的整数天`}
        value={value}
        onChangeText={updateDraft}
        editable={!saving}
        // 默认键盘保留负号输入，不能使用 Android 上缺少负号的 number-pad。
        keyboardType="default"
        autoCorrect={false}
        autoCapitalize="none"
        selectTextOnFocus
        style={[styles.input, !valid && styles.invalid, saving && styles.disabled]}
        selectionColor={colors.primary}
      />
      {!valid && <Text accessibilityRole="alert" style={styles.error}>请输入 -{MAX_AIRING_OFFSET_DAYS} 至 {MAX_AIRING_OFFSET_DAYS} 之间的整数天</Text>}
      <View style={styles.actions}>
        {button("提前1天", !valid || days <= -MAX_AIRING_OFFSET_DAYS, () => updateDraft(String(days - 1)))}
        {button("延后1天", !valid || days >= MAX_AIRING_OFFSET_DAYS, () => updateDraft(String(days + 1)))}
      </View>
      <Text style={styles.muted}>
        {dateAvailable
          ? `首播：${originalDate} → ${valid ? shiftAiringDate(originalDate, days) : "—"}`
          : episodeAvailable && previewEpisode
            ? `第 ${previewEpisode.sort} 集：${previewEpisode.airdate} → ${valid ? shiftAiringDate(previewEpisode.airdate, days) : "—"}`
            : "暂无放送日期"}
      </Text>
      <View style={styles.actions}>
        {button("保存", !valid, () => { void save(days); }, true)}
        {button("恢复默认", false, () => { void save(0); })}
      </View>
      <View accessibilityLiveRegion="polite">
        {saving ? <Text style={styles.muted}>保存中…</Text> : dirty ? <Text style={styles.muted}>未保存</Text> : null}
        {feedback && <Text accessibilityRole={feedback.error ? "alert" : undefined} style={feedback.error ? styles.error : styles.success}>{feedback.text}</Text>}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { padding: 16, gap: 12, borderWidth: 1, borderColor: colors.border, borderRadius: 12, backgroundColor: colors.surface },
  heading: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 8 },
  title: { color: colors.text, fontSize: 16, fontWeight: "600" },
  label: { color: colors.text, fontSize: 14 },
  muted: { color: colors.muted, fontSize: 14, lineHeight: 21 },
  primary: { color: colors.primary },
  input: { minHeight: 48, paddingHorizontal: 12, paddingVertical: 10, borderWidth: 1, borderColor: colors.border, borderRadius: 8, backgroundColor: colors.surfaceAlt, color: colors.text, fontSize: 16 },
  invalid: { borderColor: colors.danger },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  button: { minHeight: 48, paddingVertical: 12, paddingHorizontal: 16, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.border, borderRadius: 8, backgroundColor: colors.surfaceAlt },
  buttonText: { color: colors.text, fontSize: 14, fontWeight: "500" },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.7 },
  error: { color: colors.danger, fontSize: 14, lineHeight: 21 },
  success: { color: colors.success, fontSize: 14, lineHeight: 21 },
});
