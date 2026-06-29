import { useEffect, useState } from "react";
import { Alert, Linking, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";

import { cleanupExpiredCache } from "../../shared/storage/sqlite-cache";
import {
  setCopySubjectTitleWithSeason,
  shouldCopySubjectTitleWithSeason,
} from "../../src/api/subject-title-copy";
import { useAuth } from "../../src/hooks/useAuth";
import { colors } from "../../src/theme/colors";

function SettingsRow({ title, detail, children }: { title: string; detail?: string; children?: React.ReactNode }) {
  return (
    <View style={styles.row}>
      <View style={styles.rowText}>
        <Text style={styles.rowTitle}>{title}</Text>
        {detail ? <Text style={styles.rowDetail}>{detail}</Text> : null}
      </View>
      {children}
    </View>
  );
}

export default function SettingsPage() {
  const queryClient = useQueryClient();
  const { checking, loggedIn, username, loginWithToken, logout, refresh } = useAuth();
  const [token, setToken] = useState("");
  const [copyWithSeason, setCopyWithSeason] = useState(true);
  const [savingToken, setSavingToken] = useState(false);

  useEffect(() => {
    void shouldCopySubjectTitleWithSeason().then(setCopyWithSeason);
  }, []);

  async function updateToken() {
    if (!token.trim()) return;
    setSavingToken(true);
    try {
      await loginWithToken(token.trim());
      setToken("");
      Alert.alert("已更新", "Access Token 已保存");
    } catch (error) {
      Alert.alert("更新失败", error instanceof Error ? error.message : "请检查 token");
    } finally {
      setSavingToken(false);
    }
  }

  async function toggleCopyWithSeason(value: boolean) {
    setCopyWithSeason(value);
    await setCopySubjectTitleWithSeason(value);
  }

  async function clearExpiredCache() {
    try {
      const expiredImages = await cleanupExpiredCache();
      Alert.alert("清理完成", `已清理过期缓存${expiredImages.length ? `，图片记录 ${expiredImages.length} 条` : ""}`);
    } catch (error) {
      Alert.alert("清理失败", error instanceof Error ? error.message : "请稍后重试");
    }
  }

  async function signOut() {
    await logout();
    queryClient.clear();
    router.replace("/login");
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>账号</Text>
        <SettingsRow
          title={loggedIn ? "已登录" : "未登录"}
          detail={checking ? "检查中" : username || "需要登录后同步收藏"}
        >
          {!loggedIn ? (
            <Pressable style={styles.smallButton} onPress={() => router.push("/login")}>
              <Text style={styles.smallButtonText}>登录</Text>
            </Pressable>
          ) : null}
        </SettingsRow>

        <TextInput
          value={token}
          onChangeText={setToken}
          placeholder="更新 Access Token"
          placeholderTextColor={colors.subtle}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.input}
        />
        <Pressable
          disabled={!token.trim() || savingToken}
          style={[styles.primaryButton, (!token.trim() || savingToken) && styles.disabled]}
          onPress={() => void updateToken()}
        >
          <Text style={styles.primaryText}>{savingToken ? "保存中" : "保存 Token"}</Text>
        </Pressable>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>偏好</Text>
        <SettingsRow title="复制条目名保留季名" detail="关闭后会尝试去掉第 2 季、Season 2 等后缀">
          <Switch
            value={copyWithSeason}
            onValueChange={(value) => void toggleCopyWithSeason(value)}
            thumbColor={copyWithSeason ? colors.primary : colors.muted}
            trackColor={{ false: colors.chip, true: colors.primaryMuted }}
          />
        </SettingsRow>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>缓存</Text>
        <Pressable style={styles.secondaryButton} onPress={() => void clearExpiredCache()}>
          <Text style={styles.secondaryText}>清理过期缓存</Text>
        </Pressable>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>关于</Text>
        <SettingsRow title="Bangumini Mobile" detail="Android 移植版 0.1.0" />
        <Pressable style={styles.secondaryButton} onPress={() => void Linking.openURL("https://github.com/")}>
          <Text style={styles.secondaryText}>打开项目主页</Text>
        </Pressable>
      </View>

      {loggedIn ? (
        <Pressable style={styles.dangerButton} onPress={() => void signOut()}>
          <Text style={styles.dangerText}>退出登录</Text>
        </Pressable>
      ) : null}
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
  section: {
    gap: 12,
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
  row: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  rowText: {
    flex: 1,
    gap: 3,
  },
  rowTitle: {
    color: colors.text,
    fontSize: 15,
    fontWeight: "700",
  },
  rowDetail: {
    color: colors.muted,
    fontSize: 13,
    lineHeight: 18,
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
  primaryButton: {
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 7,
    backgroundColor: colors.primary,
  },
  primaryText: {
    color: "#071210",
    fontWeight: "800",
  },
  secondaryButton: {
    height: 42,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 7,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.primary,
  },
  secondaryText: {
    color: colors.primary,
    fontWeight: "800",
  },
  smallButton: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 7,
    backgroundColor: colors.primary,
  },
  smallButtonText: {
    color: "#071210",
    fontWeight: "800",
  },
  dangerButton: {
    height: 46,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 7,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.danger,
  },
  dangerText: {
    color: colors.danger,
    fontWeight: "800",
  },
  disabled: {
    opacity: 0.5,
  },
});
