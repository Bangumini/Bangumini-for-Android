# 个人放送日期偏置同步协议 v1

## 范围与共享 seam

[shared/airing-offset-sync.ts](../shared/airing-offset-sync.ts) 是手机与桌面可复用的纯模型：校验文档、比较记录、三路合并；不访问网络、存储、时钟、账号状态或 UI，不生成 revision。不依赖 Node 专用接口。controller 负责串行任务、持久化、冲突交互和条件上传。

同步的是个人的逐条目日期偏置，不是 Bangumi 收藏、剧集数据或全站排期。没有另建服务端账号系统：使用用户自己的 WebDAV / S3 存储，Bangumi `username` 仅用于本机账号隔离和远端对象命名，**不是昵称**，也不是对共享存储的访问授权。存储凭证不能写入文档。

远端路径由 [shared/offset-sync-config.ts](../shared/offset-sync-config.ts) 的 `offsetSyncObjectKey` 统一生成：

```text
<prefix>/accounts/<encodeURIComponent(username)>/airing-offsets.v1.json
```

例如 prefix 为 `bangumini`、username 为 `alice`：`bangumini/accounts/alice/airing-offsets.v1.json`。不要对用户名改大小写或替换成昵称；URL adapter 还需正确处理路径编码，避免重复解释编码字符。

## 文档 schema

```json
{
  "schemaVersion": 1,
  "kind": "bangumini-airing-offsets",
  "account": "alice",
  "records": {
    "616808": {
      "days": -7,
      "revision": "phone-6f2e3c-new-edit",
      "updatedAt": 1770000000000
    },
    "12345": {
      "days": 0,
      "revision": "desktop-bae927-restore-default",
      "updatedAt": 1770000001000
    }
  }
}
```

约束：

- `schemaVersion` 必须是数字 `1`，`kind` 必须精确等于 `bangumini-airing-offsets`。
- `account` 必须与调用者传入的当前 Bangumi username **精确匹配**。不 trim、不忽略大小写、不按昵称匹配。
- `records` 是普通对象，最多 **10000** 条记录。key 是正安全整数 subjectId 的规范十进制字符串：范围 `1..9007199254740991`，不接受前导零、小数、指数、空白、负数或 `__proto__` / `constructor` 等名称。
- `days` 是 `[-365, 365]` 的整数。**0 是“恢复默认”的永久 tombstone**，不能从同步记录中清理掉。UI 展示映射可以省略零值，但不能反向据此重建同步记录。
- `revision` 是非空字符串，长度不超过 128（JavaScript UTF-16 code units）；每次实际编辑产生新的不可复用标识，包括改回原值、恢复默认。没有词典序大小或跨设备先后含义。
- `updatedAt` 是非负安全整数，约定 Unix 毫秒，仅供展示；不决定编辑先后、修改意图或冲突胜负。时钟漂移不能吞掉另一端的改动。
- 原始 JSON 的 **UTF-8 字节数最多 2 MiB（2097152）**，含空白。`MAX_OFFSET_SYNC_BYTES` 为共享常量。创建上传文档时，也检查序列化后的 UTF-8 大小。
- 坏 JSON、未知 schema、字段缺失/未知、账号不符、数组、非法记录、超量或超限，一律抛错并**整体拒绝**。不得过滤坏条目后把剩余内容覆盖回云端。未来新增字段应升级 schema，并先升级客户端。
- 只复制白名单字段与规范数字 key，不执行远端属性，不向对象原型写入数据。创建文档复制输入记录，形成独立上传快照。

## 公开 interface

```typescript
export type OffsetSyncRecord = { days: number; revision: string; updatedAt: number };
export type OffsetSyncRecords = Readonly<Record<string, OffsetSyncRecord>>;
export type OffsetSyncDocument = {
  schemaVersion: 1;
  kind: 'bangumini-airing-offsets';
  account: string;
  records: OffsetSyncRecords;
};
export type OffsetSyncConflict = {
  subjectId: number;
  local: OffsetSyncRecord;
  remote: OffsetSyncRecord;
};
export const MAX_OFFSET_SYNC_BYTES = 2 * 1024 * 1024;
export function parseOffsetSyncDocument(raw: string, account: string): OffsetSyncDocument;
export function createOffsetSyncDocument(account: string, records: OffsetSyncRecords): OffsetSyncDocument;
export function sameOffsetSyncRecord(a: OffsetSyncRecord | undefined, b: OffsetSyncRecord | undefined): boolean;
export function sameOffsetSyncRecords(a: OffsetSyncRecords, b: OffsetSyncRecords): boolean;
export function mergeOffsetSyncRecords(
  base: OffsetSyncRecords, local: OffsetSyncRecords, remote: OffsetSyncRecords,
): { local: OffsetSyncRecords; remote: OffsetSyncRecords; base: OffsetSyncRecords; conflicts: OffsetSyncConflict[] };
```

`sameOffsetSyncRecord(s)` 比较全部三个字段，不依赖对象引用或 key 顺序；缺失与 `days: 0` 不等。它用于同步快照比较，**不是** UI 的 days 投影比较。merge 验证输入记录，不修改输入，不承诺输出引用恒等。

## 纯三路合并

`base` 是该账号、该存储目标上此前确认的共同基线，不是“上次下载的全部内容”。每个 subjectId 独立处理，不同条目自动合并。

1. 某一端缺失 key 表示“不知道/没有新修改”，该端以旧 base 为参考；不代表删除。双方缺失旧 base 项也仍保留它。404 在 controller 中映射为空 records，不能清空本地；HTTP 200 空 body 是坏 JSON，不等于 404。
2. 两端 `days` 相同，不冲突；存在真实远端记录时选远端完整版本，让 revision/显示时间也收敛。远端 key 缺失时不能假借旧 base 的元数据抹掉本地新 revision。
3. 修改检测使用 `days + revision`，不使用 `updatedAt`。一端相对 base 未修改，则采用另一端修改；因此 `A → B → A` 只要 revision 更新，仍算新的编辑意图。
4. 两端相对 base 都修改，且 `days` 不同，返回冲突：`local` 保留本地值，`remote` 保留远端值；**该项 base 保留旧 base**（首次无 base 则继续缺失）。其余无冲突项在三个输出中收敛。
5. 首次没有 base 时，本地明确 `days: 0` 与远端旧非零值必须冲突，不能因“0 是默认值”自动选择远端。

输出是**候选结果**：`remote` 可用于不覆盖冲突值地上传无冲突改动，`local` 可用于保留本地冲突值的本机状态，`base` 只推进无冲突项。controller 必须等远端条件写入成功（或确认无须写入）后，才能提交相应共同基线；失败、412、账号/目标切换时不能提前推进。本地在上传期间再次编辑时，可以记录已确认的远端基线，但必须保留较新的本地记录作为待同步意图，不能用旧上传值回滚它。合并后的并集若超文档限制，创建文档会拒绝；不得截断或丢 tombstone。

### 冲突选择的基线规则

对用户看到的冲突保存 `{subjectId, local, remote}` 快照。选择时将**这一项** `base[subjectId]` 设为**所见 remote**，随后保留 local 或采纳所见 remote；不能把所有冲突的基线推进，更不能设为刚下载但用户没看过的另一个远端版本。

- 保留 local：local 与新 base 不同，向同一 remote 重试可作为单边改动上传。
- 采纳 remote：本地采用所见 remote；若它与当前远端一致，正常收敛。
- 选择是针对所见版本的意图。controller 必须核对本地记录仍与冲突快照一致；本地已再次编辑时，先重算冲突，不能套用过时选择。
- **每次选择都生成新 revision，包括采纳 remote。** 不能复用所见 remote 的 revision，否则未展示的新远端值会被误判为单边更新并静默采纳。
- 选择本身与普通偏置编辑一样，本机持久化后立即生效，再后台尝试同步；网络失败保留这个用户意图，明确提示“已保存在本机，但远端同步未完成”，而不是宣称已完成云同步。这不是提前提交网络合并候选。
- 示例：旧 base=1、local=2、所见 remote=3。保留本地后 base=3/local=新 revision 的2；采纳远端后 base=3/local=新 revision 的3。两种情况下若重读到 remote=4，都必须再次冲突，而不能自动改用4。

## 强 ETag 条件 CAS

WebDAV 与 S3 adapter 必须使用同一乐观并发语义，不能退化为无条件覆盖：

1. GET 并记录**强 ETag**。已有对象缺 ETag 或只有 `W/` 弱 ETag 时，停止写入并报错；ETag 是不透明串，不用 `updatedAt`、Last-Modified 或客户端哈希替代。
2. 解析、验证账号，使用当前本地快照和共同 base 合并。
3. 已有对象 PUT 使用 `If-Match: <GET 所得强 ETag>`；404 后首次创建使用 `If-None-Match: *`，不能使用“先 HEAD 再无条件 PUT”。
4. 收到 **412 Precondition Failed**：丢弃这轮候选提交，重新 GET、重新验证、基于尚未丢失的本地意图和旧共同 base 重算。不得盲重发旧 body，不得清除冲突。重试需有上限，超限保留本地数据并报错。
5. 条件写成功再提交相应候选基线/状态；如需下一次写入，使用该成功版本的强 ETag 或重新 GET。写成功但缺强 ETag 时不可继续无条件写入。

本机持久化必须隔离账号与存储目标；切换账号/目标、停用同步后，旧异步任务不能向当前账号发布结果。同步失败不能影响已成功保存的个人偏置。

## 迁移与 UI 发布

当前本机已有偏置迁移到**首次已登录账号**：保留原 `bangumini_airing_offsets` 备份，生成有效记录和 revision，持久化账号归属/迁移标识后才算完成。后续账号不能再次继承同一份旧偏置；写入失败不能标记迁移成功。不得因远端新建、404、坏文档或登录切换抹掉旧数据。同步 tombstone 不能沿用旧展示格式中“零值删除”的存储策略。

`offsetMap` 只反映条目有效非零 days。controller 发布前比较 days 投影；纯 revision/updatedAt 变化、等值远端回读、重复同步、重复恢复默认均不能创建并发布新的等值 `offsetMap`。元数据与同步状态可独立更新。模型本身不发布 UI，也不把偏置写入原始 API 缓存。

## 手机端配置

入口：**设置 → 同步**。总开关默认关闭，开启后才展开存储配置；先登录 Bangumi，再选择一种存储。开关按本设备的 Bangumi username 持久化，独立于自动同步选项和凭证；旧账号没有开关字段时也视为关闭，不会因已有自动同步配置而自行启用。每个 Bangumi username 有独立配置与本地偏置，开关不写入远端文档。协议不是共享存储的 ACL：使用别人的共用 Bucket / WebDAV 账号并不能保证其他持有同一凭证的人看不到文件。

### WebDAV

- 地址填写服务器提供的 HTTPS WebDAV 根地址；用户名、密码单独填写，不能嵌入 URL。
- 目录前缀是相对根地址的目录，默认 `bangumini`。不要把 `airing-offsets.v1.json` 作为根地址。
- 服务器需要支持 GET、MKCOL、PUT、强 ETag 和符合 HTTP 语义的条件写入。弱/缺 ETag 会报错并停止写入，不退化成覆盖上传。

### S3 / Cloudflare R2

- Endpoint 填 S3 API 地址，Bucket 单独填写，不是公开访问域名。
- R2 示例：`https://<ACCOUNT_ID>.r2.cloudflarestorage.com`，Region 填 `auto`，默认启用 `forcePathStyle`。
- Access Key ID / Secret Access Key 使用存储服务生成的 S3 凭证，不是普通 Cloudflare API Bearer Token；临时 S3 凭证可额外填写 Session Token。不要把真实凭证放入仓库或协议文档。
- 对象需要读写权限，服务必须真正支持 `If-Match` / `If-None-Match`。部分 S3 服务对没有列举权限的凭证会将不存在对象返回为403而不是404；这种情况下需要调整权限，不能将403当作空文件覆盖。

总开关开启且已保存配置后，自动同步会在启动、回到前台及本机修改偏置后触发，并对失败做有上限的退避重试；关闭自动同步时仍可点击“立即同步”。关闭总开关则收起配置并取消同步、连接测试和重试，禁止所有远端读写入口，但保留配置、偏置、基线和本地编辑能力；再次开启按原配置继续。不填写配置也能先开启总开关，此时仅展开表单，不访问远端。不定时轮询或实时推送，另一端始终停留在前台时，需手动同步或再次回到前台获取变化。离线不阻止本地保存。

“测试读取连接”只 GET，不会创建目录、写文件或确认写权限；404仅表示当前路径未读到文件。冲突在设置页逐条选择本机/远端，无冲突条目仍能正常合并。断开只移除本机当前账号配置，不删除本地偏置或远端文件。

配置中的密码和密钥由 `expo-secure-store` 保存，大配置分块写入、最后切换清单，避免较小的原生单项大小限制和部分写入；不会放进 AsyncStorage、同步文档、公开同步状态或原始错误日志。展示数据和同步基线使用账号隔离的本地快照；新账号必须完成本地恢复才能显示页面，不等待网络；恢复期间以不透明遮罩屏蔽页面交互与无障碍读取，保持导航挂载，避免登录跳转失败或路由重置。切换账号与存储目标会取消过时网络轮次。

## React Native 运行时兼容

- `metro.config.js` 启用 Package Exports，并**仅针对 `@aws-sdk/`、`@aws-crypto/`、`@smithy/` 包**优先选择 `module`，以使用 RN runtimeConfig。其他依赖保持 Expo 默认解析顺序。不能全局把 `module` 放在 `main` 前：URL polyfill 通过 CommonJS 读取 `punycode.ucs2`，误选 ESM 入口后 `new URL(...)` 会抛 `Cannot read property 'decode' of undefined`。
- `src/api/offset-sync-runtime.ts` 在 SDK 初始化前加载 URL、UTF-8 和 Streams polyfill，安全随机数使用 `expo-crypto`。新版 Smithy 还直接调用 `Blob.arrayBuffer()`；RN 0.76 缺少此方法，通过原生 `FileReader.readAsDataURL` 补齐。不能使用同样未实现的 `FileReader.readAsArrayBuffer`。已有可用方法不会被覆盖。
- 修改 Metro 配置后，开发模式需重新启动并清缓存：`npx expo start --clear`；已安装的 release APK 则需重新构建。

## 验证

```sh
npm run test:offset-sync
npm test
npm run typecheck
npm run lint
npx expo export --platform android
```

测试通过公开接口、真实 React 组件、真实 SDK 到模拟 HTTP 边界覆盖：账号迁移、整体拒绝、UTF-8/条数限制、prototype key 防护、tombstone、三路合并、revision 改回原值、同值不重发展示映射、冲突重算、CAS失败重读、上传期间再次修改、账号/前后台切换、自动重试、原生配置分块原子提交、凭证脱敏、只读测试、S3签名、强ETag及RN缺失全局API的polyfill。

`scripts/test-offset-sync-native-runtime.mjs` 直接加载项目 Metro 配置，构建 Android dev / production 产物，在没有 Buffer、TextEncoder / TextDecoder、Blob.arrayBuffer 的独立 JS 上下文中执行。只替换原生桥与 HTTP，覆盖真实 URL polyfill 的普通/Unicode/OAuth URL 解析，以及两个真实 SDK 的 UTF-8、条件写与 S3 签名、RN Blob 读回。`--url-only` 可运行最小 URL 回归，避免 Node 原生 URL 或 CommonJS SDK 入口掩盖 Metro 问题。

该上下文测试不是 Hermes 引擎或真机测试；构建导出与模拟测试也不是实际网络服务兼容性的保证，仍需用户在真机上联调具体 WebDAV / S3 服务。桌面端未修改，可复用本文协议及 `shared/` 中的纯模型。
