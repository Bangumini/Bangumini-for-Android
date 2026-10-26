import { normalizeOffsetSyncConfig, type OffsetSyncConfig } from "../../shared/offset-sync-config";

type SecureConfigDeps = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  deleteItem(key: string): Promise<void>;
  hash(value: string): Promise<string>;
  randomId(): string;
};
type Manifest = { version: 1; generation: string; count: number };

/** 配置与凭证全部进入安全存储；分块并最后切换索引，避免超长值或半次保存破坏旧配置。 */
export function createOffsetSyncConfigStore(deps: SecureConfigDeps) {
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = queue.then(operation, operation);
    queue = next.catch(() => {});
    return next;
  };
  const prefix = async (account: string) => `bangumini_offset_sync.${await deps.hash(account)}`;
  const parseManifest = (raw: string | null): Manifest | null => {
    if (raw === null) return null;
    const value = JSON.parse(raw) as Manifest;
    if (value?.version !== 1 || typeof value.generation !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.generation) || !Number.isInteger(value.count) || value.count < 1 || value.count > 64) {
      throw new Error("无效的安全配置索引");
    }
    return value;
  };
  const removeChunks = async (key: string, manifest: Manifest) => {
    await Promise.allSettled(Array.from({ length: manifest.count }, (_, index) => deps.deleteItem(`${key}.${manifest.generation}.${index}`)));
  };
  return {
    get(account: string): Promise<OffsetSyncConfig | null> {
      return serial(async () => {
        try {
          const key = await prefix(account);
          const manifest = parseManifest(await deps.getItem(`${key}.head`));
          if (!manifest) return null;
          const chunks = await Promise.all(Array.from({ length: manifest.count }, (_, index) => deps.getItem(`${key}.${manifest.generation}.${index}`)));
          if (chunks.some(chunk => chunk === null)) throw new Error("安全配置不完整");
          const parsed = JSON.parse(chunks.join("")) as { version: number; config: OffsetSyncConfig };
          if (parsed?.version !== 1) throw new Error("不支持的安全配置版本");
          return normalizeOffsetSyncConfig(parsed.config);
        } catch { throw new Error("无法读取安全存储中的同步配置，请重新保存配置或断开同步"); }
      });
    },
    set(account: string, input: OffsetSyncConfig): Promise<void> {
      return serial(async () => {
        const config = normalizeOffsetSyncConfig(input);
        const text = JSON.stringify({ version: 1, config });
        const characters = Array.from(text);
        if (characters.length > 384 * 64) throw new Error("同步配置过长，请缩短地址、目录或凭证");
        const chunks = Array.from({ length: Math.ceil(characters.length / 384) }, (_, index) => characters.slice(index * 384, (index + 1) * 384).join(""));
        let key: string;
        let old: Manifest | null = null;
        const manifest: Manifest = { version: 1, generation: deps.randomId(), count: chunks.length };
        try {
          key = await prefix(account);
          try { old = parseManifest(await deps.getItem(`${key}.head`)); } catch { /* 允许显式保存修复损坏的索引。 */ }
          for (let index = 0; index < chunks.length; index++) await deps.setItem(`${key}.${manifest.generation}.${index}`, chunks[index]);
          await deps.setItem(`${key}.head`, JSON.stringify(manifest));
        } catch {
          // 旧索引保持不变；新分块无法提交时只是不可见，不会被当成半份配置读取。
          throw new Error("同步配置保存失败，原配置未改变；请检查手机安全存储后重试");
        }
        if (old) await removeChunks(key!, old);
      });
    },
    delete(account: string): Promise<void> {
      return serial(async () => {
        try {
          const key = await prefix(account);
          let old: Manifest | null = null;
          try { old = parseManifest(await deps.getItem(`${key}.head`)); } catch { /* 损坏的索引也能断开。 */ }
          await deps.deleteItem(`${key}.head`);
          if (old) await removeChunks(key, old);
        } catch { throw new Error("无法删除安全存储中的同步配置，请重试"); }
      });
    },
  };
}
