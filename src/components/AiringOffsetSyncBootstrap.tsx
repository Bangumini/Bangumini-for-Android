import { useEffect, type ReactNode } from "react";
import { AppState, StyleSheet, View } from "react-native";

import { offsetSync } from "../api/airing-offset-sync";
import type { AiringOffsetSyncManager } from "../api/airing-offset-sync-types";
import { useAiringOffsetSync } from "../hooks/useAiringOffsetSync";
import { useAuth } from "../hooks/useAuth";
import { colors } from "../theme/colors";
import { ErrorState, LoadingState } from "./ScreenState";

/** 仅等待账号本地状态，不等网络；遮挡旧偏置，但始终保留导航以接收登录跳转。 */
export default function AiringOffsetSyncBootstrap({ children, manager = offsetSync }: { children: ReactNode; manager?: AiringOffsetSyncManager }) {
  const { checking, loggedIn, username } = useAuth();
  const status = useAiringOffsetSync(manager);
  const account = loggedIn && username ? username : null;
  useEffect(() => {
    if (!checking) void manager.setAccount(account).catch(() => {});
  }, [account, checking, manager]);
  useEffect(() => {
    manager.setAppActive(AppState.currentState === "active");
    const subscription = AppState.addEventListener("change", state => manager.setAppActive(state === "active"));
    return () => { subscription.remove(); manager.setAppActive(false); };
  }, [manager]);
  const blocked = !status.ready || status.account !== account;
  const localError = !checking && status.account === account && status.phase === "error";
  return <View style={styles.container}>
    <View testID="offset-sync-content" style={[styles.container, blocked && styles.hidden]}
      pointerEvents={blocked ? "none" : "auto"} accessibilityElementsHidden={blocked}
      importantForAccessibility={blocked ? "no-hide-descendants" : "auto"}>
      {children}
    </View>
    {blocked ? <View style={styles.overlay} accessibilityViewIsModal>
      {localError
        ? <ErrorState message={status.error ?? "无法恢复本账号的偏置"} onRetry={() => { void manager.setAccount(account).catch(() => {}); }} />
        : <LoadingState label="恢复本账号的偏置设置" />}
    </View> : null}
  </View>;
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  hidden: { opacity: 0 },
  overlay: { ...StyleSheet.absoluteFillObject, backgroundColor: colors.background },
});
