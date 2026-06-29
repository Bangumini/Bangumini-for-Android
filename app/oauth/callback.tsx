import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";

import { colors } from "../../src/theme/colors";

export default function OAuthCallbackPage() {
  const [timedOut, setTimedOut] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (mounted.current) setTimedOut(true);
    }, 30000);
    return () => clearTimeout(timer);
  }, []);

  const goBack = useCallback(() => {
    router.back();
  }, []);

  if (timedOut) {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>授权超时</Text>
        <Text style={styles.hint}>请返回重试</Text>
        <Text style={styles.link} onPress={goBack}>
          返回登录
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <ActivityIndicator size="large" color={colors.primary} />
      <Text style={styles.title}>正在登录</Text>
      <Text style={styles.hint}>请稍候...</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
    backgroundColor: colors.background,
  },
  title: {
    color: colors.text,
    fontSize: 18,
    fontWeight: "700",
  },
  hint: {
    color: colors.muted,
    fontSize: 14,
  },
  link: {
    color: colors.primary,
    fontSize: 15,
    fontWeight: "600",
    marginTop: 8,
  },
});
