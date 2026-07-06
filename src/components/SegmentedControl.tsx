import { useCallback, useEffect, useRef } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

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
  const scrollRef = useRef<ScrollView>(null);
  const containerWidthRef = useRef(0);
  const segmentLayoutsRef = useRef(new Map<T, { x: number; width: number }>());

  const scrollActiveIntoView = useCallback((targetValue: T) => {
    const layout = segmentLayoutsRef.current.get(targetValue);
    const containerWidth = containerWidthRef.current;
    if (!layout || containerWidth <= 0) return;

    const x = Math.max(0, layout.x - (containerWidth - layout.width) / 2);
    scrollRef.current?.scrollTo({ x, animated: true });
  }, []);

  useEffect(() => {
    scrollActiveIntoView(value);
  }, [scrollActiveIntoView, value]);

  return (
    <View style={styles.wrapper}>
      <ScrollView
        ref={scrollRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.container}
        bounces={false}
        onLayout={(event) => {
          containerWidthRef.current = event.nativeEvent.layout.width;
          scrollActiveIntoView(value);
        }}
      >
        {options.map((option, index) => {
          const active = option.value === value;
          const isLast = index === options.length - 1;
          return (
            <Pressable
              key={String(option.value)}
              onPress={() => onChange(option.value)}
              onLayout={(event) => {
                segmentLayoutsRef.current.set(option.value, event.nativeEvent.layout);
                if (active) scrollActiveIntoView(option.value);
              }}
              style={[styles.segment, active && styles.activeSegment, !isLast && styles.segmentGap]}
            >
              <Text style={[styles.label, active && styles.activeLabel]} numberOfLines={1}>
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    flex: 0,
  },
  container: {
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
  segmentGap: {
    marginRight: 8,
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
