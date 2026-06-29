import { Pressable, StyleSheet, Text, View } from "react-native";

import { colors } from "../theme/colors";
import CachedImage from "./CachedImage";

type SubjectCardProps = {
  title: string;
  subtitle?: string | null;
  coverUrl?: string | null;
  meta?: string[];
  label?: string | null;
  progress?: string | null;
  onPress?: () => void;
  onLongPress?: () => void;
};

export function SubjectCard({
  title,
  subtitle,
  coverUrl,
  meta = [],
  label,
  progress,
  onPress,
  onLongPress,
}: SubjectCardProps) {
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      style={({ pressed }) => [styles.card, pressed && styles.pressed]}
    >
      <CachedImage uri={coverUrl} style={styles.cover} />
      <View style={styles.body}>
        <View style={styles.titleRow}>
          <Text style={styles.title} numberOfLines={2}>{title}</Text>
          {label ? <Text style={styles.label} numberOfLines={1}>{label}</Text> : null}
        </View>
        {subtitle ? <Text style={styles.subtitle} numberOfLines={1}>{subtitle}</Text> : null}
        {progress ? <Text style={styles.progress} numberOfLines={1}>{progress}</Text> : null}
        {meta.length > 0 ? (
          <View style={styles.metaRow}>
            {meta.slice(0, 3).map((item) => (
              <Text key={item} style={styles.meta} numberOfLines={1}>{item}</Text>
            ))}
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    minHeight: 116,
    flexDirection: "row",
    gap: 12,
    padding: 12,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  pressed: {
    opacity: 0.78,
  },
  cover: {
    width: 68,
    height: 92,
    borderRadius: 6,
    overflow: "hidden",
  },
  body: {
    flex: 1,
    gap: 6,
    minWidth: 0,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
  },
  title: {
    flex: 1,
    color: colors.text,
    fontSize: 16,
    lineHeight: 21,
    fontWeight: "700",
  },
  label: {
    maxWidth: 112,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    overflow: "hidden",
    color: colors.primary,
    backgroundColor: colors.primaryMuted,
    fontSize: 12,
    fontWeight: "700",
  },
  subtitle: {
    color: colors.muted,
    fontSize: 13,
  },
  progress: {
    color: colors.warning,
    fontSize: 13,
    fontWeight: "600",
  },
  metaRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  meta: {
    maxWidth: 112,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 5,
    overflow: "hidden",
    color: colors.muted,
    backgroundColor: colors.chip,
    fontSize: 12,
  },
});
