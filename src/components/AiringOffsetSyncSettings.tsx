import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Switch, Text, TextInput, View } from "react-native";

import { DEFAULT_OFFSET_SYNC_PREFIX, normalizeOffsetSyncConfig, type OffsetSyncConfig } from "../../shared/offset-sync-config";
import { formatAiringOffsetDays } from "../../shared/airing-offset";
import { offsetSync } from "../api/airing-offset-sync";
import type { AiringOffsetSyncManager } from "../api/airing-offset-sync-types";
import { useAiringOffsetSync } from "../hooks/useAiringOffsetSync";
import { colors } from "../theme/colors";

function emptyConfig(): OffsetSyncConfig {
  return { provider: "webdav", prefix: DEFAULT_OFFSET_SYNC_PREFIX, autoSync: true, url: "", username: "", password: "" };
}

function Field({ label, value, onChange, secret = false, url = false }: {
  label: string; value: string; onChange: (value: string) => void; secret?: boolean; url?: boolean;
}) {
  return <View style={styles.field}>
    <Text style={styles.label}>{label}</Text>
    <TextInput accessibilityLabel={label} value={value} onChangeText={onChange}
      secureTextEntry={secret} autoCorrect={false} autoCapitalize="none" autoComplete="off"
      keyboardType={url ? "url" : "default"} placeholderTextColor={colors.subtle} style={styles.input} />
  </View>;
}

function Action({ label, disabled = false, selected, onPress, danger = false }: {
  label: string; disabled?: boolean; selected?: boolean; onPress: () => void; danger?: boolean;
}) {
  return <Pressable accessibilityLabel={label} accessibilityRole="button"
    accessibilityState={{ disabled, ...(selected === undefined ? {} : { selected }) }} disabled={disabled}
    onPress={onPress} style={[styles.button, selected && styles.selected, disabled && styles.disabled]}>
    <Text style={[styles.buttonText, danger && styles.danger]}>{label}</Text>
  </Pressable>;
}

function Toggle({ label, value, onChange, disabled = false, title = false }: {
  label: string; value: boolean; onChange: (value: boolean) => void; disabled?: boolean; title?: boolean;
}) {
  return <View style={styles.toggle}>
    <Text accessibilityRole={title ? "header" : undefined} style={title ? styles.title : styles.label}>{label}</Text>
    <Switch accessibilityLabel={label} accessibilityRole="switch" accessibilityState={{ checked: value, disabled }}
      value={value} disabled={disabled} onValueChange={onChange} trackColor={{ false: colors.border, true: colors.primaryMuted }}
      thumbColor={value ? colors.primary : colors.muted} style={styles.switch} />
  </View>;
}

function sameConfig(left: OffsetSyncConfig, right: OffsetSyncConfig) {
  const a = left as unknown as Record<string, unknown>;
  const b = right as unknown as Record<string, unknown>;
  return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => a[key] === b[key]);
}

type Result = { message: string; apply?: () => void };

function describeDays(days: number) {
  return `${formatAiringOffsetDays(days)}（${days > 0 ? "+" : ""}${days} 天）`;
}

function AccountSettings({ manager, account }: { manager: AiringOffsetSyncManager; account: string }) {
  const status = useAiringOffsetSync(manager);
  const [draft, setDraft] = useState<OffsetSyncConfig>(emptyConfig);
  const [saved, setSaved] = useState<OffsetSyncConfig | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const mounted = useRef(false);
  const lock = useRef(false);
  const current = useCallback(() => mounted.current && manager.getSnapshot().account === account && manager.getSnapshot().ready, [manager, account]);
  useEffect(() => {
    let active = true;
    mounted.current = true;
    void manager.getConfig().then(config => {
      if (!active || !current()) return;
      const base = config ? normalizeOffsetSyncConfig(config) : null;
      setDraft(base ?? emptyConfig());
      setSaved(base);
      setLoaded(true);
    }).catch(() => {
      if (!active || !current()) return;
      setLoaded(true);
      setFeedback("读取安全配置失败，请重新进入设置后重试。");
    });
    return () => { active = false; mounted.current = false; };
  }, [manager, account, current]);

  let normalized: OffsetSyncConfig | null = null;
  try { normalized = normalizeOffsetSyncConfig(draft); } catch { /* 只显示固定提示，不渲染可能含密钥的异常对象。 */ }
  const dirty = !normalized || !saved || !sameConfig(normalized, saved);
  const busy = !loaded || pending !== null || status.phase === "syncing";
  function update(patch: Partial<OffsetSyncConfig>) {
    setDraft(previous => ({ ...previous, ...patch } as OffsetSyncConfig));
    setFeedback(null);
  }
  function selectProvider(provider: OffsetSyncConfig["provider"]) {
    if (busy || draft.provider === provider) return;
    setDraft(provider === "webdav" ? { ...emptyConfig(), prefix: draft.prefix, autoSync: draft.autoSync }
      : { provider: "s3", prefix: draft.prefix, autoSync: draft.autoSync, endpoint: "", region: "auto", bucket: "", accessKeyId: "", secretAccessKey: "", forcePathStyle: true });
    setFeedback(null);
  }
  async function run(label: string, work: () => Promise<Result>) {
    // ref 同步上锁，防止 React 提交 disabled 之前的重复点击。
    if (lock.current || busy || !current() || manager.getSnapshot().phase === "syncing") return;
    lock.current = true;
    setPending(label);
    setFeedback(null);
    try {
      const result = await work();
      if (current()) { result.apply?.(); setFeedback(result.message); }
    } catch {
      if (current()) setFeedback(`${label}失败，请检查配置或网络后重试。`);
    } finally {
      lock.current = false;
      if (current()) setPending(null);
    }
  }
  function save() {
    const config = normalized;
    if (!config) return;
    void run("保存配置", async () => {
      await manager.saveConfig(config);
      return { message: "配置已保存。", apply: () => setSaved(config) };
    });
  }
  function test() {
    const config = normalized;
    if (!config) return;
    void run("读取连接", async () => {
      const result = await manager.testConnection(config);
      return { message: result.exists ? "已成功读取偏置文件；只读测试未验证写权限。"
        : "连接可用，未找到偏置文件；未验证写权限。" };
    });
  }
  if (!loaded) return <Text accessibilityLiveRegion="polite" style={styles.detail}>正在读取当前账号安全配置…</Text>;
  return <View style={styles.form}>
    <Text style={styles.detail}>存储地址必须使用 HTTPS；密码和密钥仅保存在本机安全存储中。</Text>
    <View style={styles.actions}>
      <Action label="WebDAV" selected={draft.provider === "webdav"} disabled={busy} onPress={() => selectProvider("webdav")} />
      <Action label="S3" selected={draft.provider === "s3"} disabled={busy} onPress={() => selectProvider("s3")} />
    </View>
    {draft.provider === "webdav" ? <>
      <Field label="WebDAV 地址" value={draft.url} url onChange={url => update({ url })} />
      <Field label="WebDAV 用户名" value={draft.username} secret onChange={username => update({ username })} />
      <Field label="WebDAV 密码" value={draft.password} secret onChange={password => update({ password })} />
    </> : <>
      <Field label="S3 Endpoint" value={draft.endpoint} url onChange={endpoint => update({ endpoint })} />
      <Field label="S3 Region" value={draft.region} onChange={region => update({ region })} />
      <Field label="S3 Bucket" value={draft.bucket} onChange={bucket => update({ bucket })} />
      <Field label="S3 Access Key ID" value={draft.accessKeyId} secret onChange={accessKeyId => update({ accessKeyId })} />
      <Field label="S3 Secret Access Key" value={draft.secretAccessKey} secret onChange={secretAccessKey => update({ secretAccessKey })} />
      <Field label="S3 Session Token（可选）" value={draft.sessionToken ?? ""} secret onChange={sessionToken => update({ sessionToken })} />
      <Toggle label="S3 forcePathStyle" value={draft.forcePathStyle} onChange={forcePathStyle => update({ forcePathStyle })} />
    </>}
    <Field label="存储目录前缀" value={draft.prefix} onChange={prefix => update({ prefix })} />
    <Toggle label="自动同步" value={draft.autoSync} onChange={autoSync => update({ autoSync })} />
    {dirty ? <Text style={styles.warning}>草稿未保存；请先保存后再立即同步。</Text> : null}
    <View style={styles.actions}>
      <Action label="保存配置" disabled={busy || !normalized || !dirty} onPress={save} />
      <Action label="测试读取连接（只读）" disabled={busy || !normalized} onPress={test} />
      <Action label="立即同步" disabled={busy || !status.configured || dirty} onPress={() => {
        if (dirty || !status.configured) return;
        void run("立即同步", async () => { await manager.syncNow(); return { message: "同步请求已完成，请查看同步状态。" }; });
      }} />
      <Action label="断开同步" danger disabled={busy || !status.configured} onPress={() => {
        void run("断开同步", async () => {
          await manager.disconnect();
          return { message: "已断开同步；本地偏置和远端文件均保留。", apply: () => { setSaved(null); setDraft(emptyConfig()); } };
        });
      }} />
    </View>
    <View accessibilityLiveRegion="polite" style={styles.form}>
      <Text style={styles.detail}>{status.phase === "syncing" ? "同步中…" : status.configured ? "已配置同步" : "尚未配置同步"}</Text>
      <Text style={styles.detail}>{status.lastSyncedAt === null ? "上次成功：暂无" : `上次成功：${new Date(status.lastSyncedAt).toLocaleString()}`}</Text>
      {status.error ? <Text style={styles.error}>{status.error}</Text> : null}
      <Text style={styles.detail}>冲突：{status.conflicts.length} 条</Text>
      {status.conflicts.length ? <Text style={styles.warning}>未解决的冲突不会默认覆盖；其他条目仍可同步。</Text> : null}
    </View>
    {status.conflicts.map(conflict => <View key={conflict.subjectId} style={styles.conflict}>
      <Text style={styles.label}>条目 {conflict.subjectId}</Text>
      <Text style={styles.detail}>本机：{describeDays(conflict.local.days)}</Text>
      <Text style={styles.detail}>远端：{describeDays(conflict.remote.days)}</Text>
      <View style={styles.actions}>
        {(["local", "remote"] as const).map(choice => <Action key={choice}
          label={`条目 ${conflict.subjectId}：${choice === "local" ? "保留本机" : "使用远端"}`}
          disabled={busy || dirty || !status.configured} onPress={() => {
            if (dirty || !status.configured) return;
            void run("解决冲突", async () => {
              await manager.resolveConflict(conflict.subjectId, choice);
              return { message: "已提交冲突选择，同步器将重新同步。" };
            });
          }} />)}
      </View>
    </View>)}
    {pending ? <Text accessibilityLiveRegion="polite" style={styles.detail}>{pending}中…</Text> : null}
    {feedback ? <Text accessibilityLiveRegion="polite" style={styles.detail}>{feedback}</Text> : null}
  </View>;
}

function SyncSection({ manager }: { manager: AiringOffsetSyncManager }) {
  const status = useAiringOffsetSync(manager);
  const [changing, setChanging] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const mounted = useRef(false);
  const lock = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  async function toggle(enabled: boolean) {
    if (lock.current || !status.ready || !status.account || enabled === status.enabled) return;
    const account = status.account;
    lock.current = true;
    setChanging(true);
    setFailure(null);
    try { await manager.setEnabled(enabled); }
    catch {
      const latest = manager.getSnapshot();
      if (mounted.current && latest.account === account) {
        // 开关可能已保存，仅配置恢复失败；以 manager 已脱敏状态为准，不误报开关失败。
        setFailure(latest.enabled && latest.error ? null : latest.error ?? "同步开关保存失败，请重试。");
      }
    } finally {
      lock.current = false;
      if (mounted.current) setChanging(false);
    }
  }
  return <>
    <Toggle title label="同步" value={status.enabled} disabled={changing || !status.account || !status.ready}
      onChange={enabled => { void toggle(enabled); }} />
    {!status.account ? <Text style={styles.detail}>请登录后配置同步；未登录时不会上传。</Text>
      : !status.ready ? <Text accessibilityLiveRegion="polite" style={styles.detail}>正在恢复当前账号同步配置…</Text>
        : status.enabled ? <AccountSettings manager={manager} account={status.account} /> : null}
    {failure ? <Text accessibilityLiveRegion="polite" style={styles.error}>{failure}</Text> : null}
  </>;
}

export default function AiringOffsetSyncSettings({ manager = offsetSync }: { manager?: AiringOffsetSyncManager }) {
  const status = useAiringOffsetSync(manager);
  // 切账号或 manager 立即重建开关和表单，旧请求不能锁住新账号或展示旧凭证。
  const [identity, setIdentity] = useState({ manager, version: 0 });
  if (identity.manager !== manager) setIdentity({ manager, version: identity.version + 1 });
  return <View style={styles.card}>
    <SyncSection key={JSON.stringify([identity.version, status.account])} manager={manager} />
  </View>;
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, borderRadius: 8, padding: 14, gap: 12 },
  title: { color: colors.text, fontSize: 17, fontWeight: "800" },
  detail: { color: colors.muted, fontSize: 13, lineHeight: 20 },
  form: { gap: 12 },
  field: { gap: 6 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  button: { minHeight: 48, minWidth: 48, paddingHorizontal: 14, paddingVertical: 12, justifyContent: "center", alignItems: "center", backgroundColor: colors.surfaceAlt, borderRadius: 7, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  buttonText: { color: colors.primary, fontSize: 14, fontWeight: "800" },
  selected: { backgroundColor: colors.primaryMuted, borderColor: colors.primary },
  disabled: { opacity: 0.45 },
  danger: { color: colors.danger },
  warning: { color: colors.warning, fontSize: 13, lineHeight: 20 },
  error: { color: colors.danger, fontSize: 13, lineHeight: 20 },
  conflict: { borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, borderRadius: 7, padding: 12, gap: 8 },
  toggle: { minHeight: 48, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  switch: { minHeight: 48, minWidth: 48 },
  label: { color: colors.text, fontSize: 14 },
  input: { minHeight: 48, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, borderRadius: 7, paddingHorizontal: 12, paddingVertical: 10, color: colors.text, backgroundColor: colors.background },
});
