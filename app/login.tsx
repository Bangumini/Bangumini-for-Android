import { useState } from "react";
import { ActivityIndicator, Alert, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { router } from "expo-router";

import { loginWithBrowser } from "../src/api/oauth";
import { useAuth } from "../src/hooks/useAuth";
import { colors } from "../src/theme/colors";

export default function LoginPage() {
  const { loginWithToken } = useAuth();
  const [token, setTokenValue] = useState("");
  const [loading, setLoading] = useState(false);

  async function completeLogin(action: () => Promise<string>) {
    setLoading(true);
    try {
      await action();
      router.replace("/collections");
    } catch (error) {
      Alert.alert("登录失败", error instanceof Error ? error.message : "请稍后重试");
    } finally {
      setLoading(false);
    }
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={styles.screen}
    >
      <View style={styles.panel}>
        <Text style={styles.title}>Bangumini</Text>
        <Text style={styles.subtitle}>使用 Bangumi 账号同步收藏和观看进度</Text>

        <Pressable
          disabled={loading}
          onPress={() => completeLogin(loginWithBrowser)}
          style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed, loading && styles.disabled]}
        >
          {loading ? (
            <View style={styles.loadingRow}>
              <ActivityIndicator size="small" color="#071210" />
              <Text style={styles.primaryText}>请在浏览器中完成授权</Text>
            </View>
          ) : (
            <Text style={styles.primaryText}>通过浏览器授权登录</Text>
          )}
        </Pressable>

        <View style={styles.divider} />

        <TextInput
          value={token}
          onChangeText={setTokenValue}
          placeholder="Access Token"
          placeholderTextColor={colors.subtle}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          editable={!loading}
          style={styles.input}
        />

        <Pressable
          disabled={loading || !token.trim()}
          onPress={() => completeLogin(() => loginWithToken(token.trim()))}
          style={({ pressed }) => [
            styles.secondaryButton,
            pressed && styles.pressed,
            (loading || !token.trim()) && styles.disabled,
          ]}
        >
          <Text style={styles.secondaryText}>手动登录</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    justifyContent: "center",
    padding: 20,
    backgroundColor: colors.background,
  },
  panel: {
    gap: 14,
    padding: 18,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  title: {
    color: colors.text,
    fontSize: 28,
    fontWeight: "800",
  },
  subtitle: {
    marginBottom: 8,
    color: colors.muted,
    fontSize: 15,
    lineHeight: 21,
  },
  loadingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  primaryButton: {
    minHeight: 46,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 7,
    backgroundColor: colors.primary,
  },
  primaryText: {
    color: "#071210",
    fontSize: 16,
    fontWeight: "800",
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
  },
  input: {
    minHeight: 46,
    paddingHorizontal: 12,
    borderRadius: 7,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    color: colors.text,
    backgroundColor: colors.background,
  },
  secondaryButton: {
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 7,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.primary,
  },
  secondaryText: {
    color: colors.primary,
    fontSize: 15,
    fontWeight: "700",
  },
  pressed: {
    opacity: 0.75,
  },
  disabled: {
    opacity: 0.5,
  },
});
