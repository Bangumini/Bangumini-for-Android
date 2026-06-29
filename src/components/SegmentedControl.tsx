import { Pressable, ScrollView, StyleSheet, Text } from "react-native";

import { colors } from "../theme/colors";

export type SegmentOption<T extends string | number> = {
  value: T;
  label: string;
};

type SegmentedControlProps<T extends string | number> = {
  options: Array<SegmentOption<T>>;
  value: T;
  onChange: (value: T) => void;
};

export function SegmentedControl<T extends string | number>({
  options,
  value,
  onChange,
}: SegmentedControlProps<T>) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.container}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <Pressable
            key={String(option.value)}
            onPress={() => onChange(option.value)}
            style={[styles.segment, active && styles.activeSegment]}
          >
            <Text style={[styles.label, active && styles.activeLabel]} numberOfLines={1}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  segment: {
    minWidth: 58,
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 7,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  activeSegment: {
    borderColor: colors.primary,
    backgroundColor: colors.primaryMuted,
  },
  label: {
    color: colors.muted,
    fontSize: 14,
    fontWeight: "600",
  },
  activeLabel: {
    color: colors.primary,
  },
});
