import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Animated,
  Easing,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useNavigation } from "expo-router";

import { colors } from "../theme/colors";

const COLLAPSED_WIDTH = 40;
const EXPANDED_WIDTH = 248;
const ANIMATION_DURATION = 180;

type SearchInputProps = {
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
};

type HeaderSearchOptions = Omit<SearchInputProps, "placeholder"> & {
  placeholder?: string;
};

type HeaderSearchProps = SearchInputProps;

function HeaderSearch({ value, onChangeText, placeholder }: HeaderSearchProps) {
  const [searchValue, setSearchValue] = useState(value);

  return (
    <SearchInput
      value={searchValue}
      onChangeText={(nextValue) => {
        setSearchValue(nextValue);
        onChangeText(nextValue);
      }}
      placeholder={placeholder}
    />
  );
}

/** 将搜索输入放到页面导航栏右侧，并在展开时自动聚焦。 */
export function useHeaderSearch({
  value,
  onChangeText,
  placeholder = "搜索",
}: HeaderSearchOptions) {
  const navigation = useNavigation();
  const initialValueRef = useRef(value);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <HeaderSearch
          value={initialValueRef.current}
          onChangeText={onChangeText}
          placeholder={placeholder}
        />
      ),
    });
  }, [navigation, onChangeText, placeholder]);
}

export function SearchInput({
  value,
  onChangeText,
  placeholder = "搜索",
}: SearchInputProps) {
  const inputRef = useRef<TextInput>(null);
  const blurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [width] = useState(
    () => new Animated.Value(value ? EXPANDED_WIDTH : COLLAPSED_WIDTH),
  );
  const [inputVisible, setInputVisible] = useState(Boolean(value));

  useEffect(() => {
    if (!inputVisible) return;
    const focusTimer = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(focusTimer);
  }, [inputVisible]);

  useEffect(() => {
    return () => {
      if (blurTimerRef.current) clearTimeout(blurTimerRef.current);
      width.stopAnimation();
    };
  }, [width]);

  function expand() {
    if (blurTimerRef.current) clearTimeout(blurTimerRef.current);
    setInputVisible(true);
    width.stopAnimation();
    Animated.timing(width, {
      toValue: EXPANDED_WIDTH,
      duration: ANIMATION_DURATION,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }

  function collapse() {
    width.stopAnimation();
    Animated.timing(width, {
      toValue: COLLAPSED_WIDTH,
      duration: ANIMATION_DURATION,
      easing: Easing.in(Easing.cubic),
      useNativeDriver: false,
    }).start(({ finished }) => {
      if (finished) setInputVisible(false);
    });
  }

  function handleBlur() {
    blurTimerRef.current = setTimeout(() => {
      blurTimerRef.current = null;
      if (!inputRef.current?.isFocused()) collapse();
    }, 80);
  }

  function handleFocus() {
    if (blurTimerRef.current) {
      clearTimeout(blurTimerRef.current);
      blurTimerRef.current = null;
    }
  }

  if (!inputVisible) {
    return (
      <Animated.View style={[styles.animatedContainer, { width }]}>
        <Pressable
          accessibilityLabel={`打开${placeholder}`}
          accessibilityRole="button"
          hitSlop={8}
          onPress={expand}
          style={styles.iconButton}
        >
          <Ionicons name="search-outline" size={22} color={colors.text} />
        </Pressable>
      </Animated.View>
    );
  }

  return (
    <Animated.View style={[styles.animatedContainer, { width }]}>
      <View style={styles.container}>
        <Ionicons name="search-outline" size={18} color={colors.subtle} />
        <TextInput
          ref={inputRef}
          value={value}
          onChangeText={onChangeText}
          onBlur={handleBlur}
          onFocus={handleFocus}
          placeholder={placeholder}
          placeholderTextColor={colors.subtle}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          style={styles.input}
        />
        {value ? (
          <Pressable
            accessibilityLabel="清空搜索"
            accessibilityRole="button"
            onPress={() => onChangeText("")}
            hitSlop={8}
            style={styles.actionButton}
          >
            <Ionicons name="close-circle" size={18} color={colors.subtle} />
          </Pressable>
        ) : null}
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  animatedContainer: {
    height: 40,
    overflow: "hidden",
    marginRight: 4,
  },
  iconButton: {
    width: COLLAPSED_WIDTH,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 20,
  },
  container: {
    width: EXPANDED_WIDTH,
    minHeight: 40,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  input: {
    flex: 1,
    minWidth: 0,
    color: colors.text,
    fontSize: 15,
    paddingVertical: 6,
  },
  actionButton: {
    width: 24,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
  },
});
