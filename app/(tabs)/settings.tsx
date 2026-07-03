import { useEffect, useState } from "react";
import { Linking, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import Constants from "expo-constants";

import { cleanupExpiredCache } from "../../shared/storage/sqlite-cache";
import {
  setCopySubjectTitleWithSeason,
  shouldCopySubjectTitleWithSeason,
} from "../../src/api/subject-title-copy";
import { checkForUpdate } from "../../src/api/update";
import { useAuth } from "../../src/hooks/useAuth";
import { useAlert } from "../../src/components/Dialog";
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
  const alert = useAlert();
  const queryClient = useQueryClient();
  const { checking, loggedIn, username, loginWithToken, logout, refresh } = useAuth();
  const [token, setToken] = useState("");
  const [copyWithSeason, setCopyWithSeason] = useState(true);
  const [savingToken, setSavingToken] = useState(false);

  const [updateStatus, setUpdateStatus] = useState<
    "idle" | "checking" | "up-to-date" | "available" | "error"
  >("idle");
  const [latestVersion, setLatestVersion] = useState("");

  const appVersion = Constants.expoConfig?.version ?? "0.1.0";

  useEffect(() => {
    void shouldCopySubjectTitleWithSeason().then(setCopyWithSeason);
  }, []);

  async function updateToken() {
    if (!token.trim()) return;
    setSavingToken(true);
    try {
      await loginWithToken(token.trim());
      setToken("");
      alert("已更新", "Access Token 已保存");
    } catch (error) {
      alert("更新失败", error instanceof Error ? error.message : "请检查 token");
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
      alert("清理完成", `已清理过期缓存${expiredImages.length ? `，图片记录 ${expiredImages.length} 条` : ""}`);
    } catch (error) {
      alert("清理失败", error instanceof Error ? error.message : "请稍后重试");
    }
  }

  async function signOut() {
    await logout();
    queryClient.clear();
    router.replace("/login");
  }

  async function handleCheckUpdate() {
    setUpdateStatus("checking");
    try {
      const info = await checkForUpdate();
      if (info.hasUpdate) {
        setLatestVersion(info.latestVersion);
        setUpdateStatus("available");
      } else {
        setUpdateStatus("up-to-date");
      }
    } catch {
      setUpdateStatus("error");
    }
  }

  function handleDownload() {
    void Linking.openURL("https://github.com/Bangumini/Bangumini-for-Android/releases/latest");
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
        <Text style={styles.sectionTitle}>版本更新</Text>
        <SettingsRow
          title={`当前版本 v${appVersion}`}
          detail={updateStatus === "available" ? `新版本 v${latestVersion}` : undefined}
        />
        {updateStatus === "idle" && (
          <Pressable style={styles.secondaryButton} onPress={() => void handleCheckUpdate()}>
            <Text style={styles.secondaryText}>检查更新</Text>
          </Pressable>
        )}
        {updateStatus === "checking" && (
          <View style={styles.secondaryButton}>
            <Text style={styles.secondaryText}>检查中...</Text>
          </View>
        )}
        {updateStatus === "up-to-date" && (
          <>
            <Text style={styles.updateHint}>已是最新版本</Text>
            <Pressable style={styles.secondaryButton} onPress={() => void handleCheckUpdate()}>
              <Text style={styles.secondaryText}>重新检查</Text>
            </Pressable>
          </>
        )}
        {updateStatus === "available" && (
          <Pressable style={styles.primaryButton} onPress={() => void handleDownload()}>
            <Text style={styles.primaryText}>下载更新</Text>
          </Pressable>
        )}
        {updateStatus === "error" && (
          <>
            <Text style={styles.updateError}>检查失败，请稍后重试</Text>
            <Pressable style={styles.secondaryButton} onPress={() => void handleCheckUpdate()}>
              <Text style={styles.secondaryText}>重试</Text>
            </Pressable>
          </>
        )}
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>关于</Text>
        <SettingsRow title="Bangumini-for-Android" detail={`v${appVersion}`} />
        <Pressable style={styles.secondaryButton} onPress={() => void Linking.openURL("https://github.com/Bangumini/Bangumini-for-Android")}>
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
  updateHint: {
    color: colors.muted,
    fontSize: 14,
    textAlign: "center",
  },
  updateError: {
    color: colors.danger,
    fontSize: 14,
    textAlign: "center",
  },
});
