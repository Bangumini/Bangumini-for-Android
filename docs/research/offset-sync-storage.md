# 个人 offset 同步：WebDAV / Cloudflare R2 SDK 核查

> 本文记录实施前的资料核查。手机端后续已接入 WebDAV / S3；当前配置方法、跨端协议与验证范围见 [个人放送日期偏置同步协议](../offset-sync-protocol.md)，下文的“未安装依赖”等描述仅指本次前期调研。

## 范围与结论

- 移动端为 Expo `~52.0.47`、React Native `0.76.9`；桌面端为 React 19 / Tauri 2。
- **有现成 npm 客户端：WebDAV 用 `webdav`，R2 用 `@aws-sdk/client-s3`。两者提供远端文件/对象访问，不是个人 offset 的端到端多端冲突同步引擎。** 下述官方 API 展示的是读写操作；offset 合并、删除语义、离线重试与冲突处理仍需应用定义，不能由“上传 JSON”推导为已经实现同步。[1][6][7]
- 资料来自项目官方仓库或官方文档；下文区分官方支持声明、源码核查与尚未完成的运行验证。

## WebDAV：明确有 React Native 支持，不只是浏览器推测

- 官方 README 的 **React-Native support** 明确写明：从 **5.6.0** 起提供专用 RN build，可显式 `import { createClient } from "webdav/react-native"`。同页提醒 Metro 可能不能正确解析入口，并给出 Babel alias 示例。因此不能笼统声称“官方只支持 Node/browser，RN 完全未声明支持”。[1]
- 本次读取的 `master/package.json` 版本字段为 **5.11.0**，同时有 `exports` 的 `browser` / `react-native` 条件、`./web` / `./react-native` 子路径，以及顶层 `react-native` 字段。该版本是仓库快照信息，**没有核验 npm 当前发布版或锁定候选版本**。[2]
- transport：`source/request.ts` 使用 `@buttercup/fetch`，并为 browser/RN 排除 Node HTTP agent 分支；Webpack 分别生成 `dist/web`、`dist/react-native`，设置不同 `TARGET` 并替换 `node-fetch` 入口。不是应把 Node 默认入口直接塞给 Metro 的证据。[3]
- XML/base64 并非空白依赖：源码使用 `fast-xml-parser` 的 `XMLParser` / `XMLBuilder`，以及 `base-64` 的 encode/decode。**没有证据要求为该库一概额外安装 DOM XML 或全局 base64 polyfill**；需要验证的是选定版本的 RN 入口、fetch/响应体和依赖在 Expo 52 / RN 0.76.9 下的实际行为，按实际缺失项补齐，而非照搬浏览器 polyfill 清单。[4]
- 桌面 React 前端有官方 browser build（也可显式 `webdav/web`）；README 不支持浏览器 streams。**browser 支持不等于已验证 Tauri 2 WebView 的跨域、CSP 与服务器配置**。[1][2]

## R2：直接使用 S3 客户端

- Cloudflare 官方明确 R2 提供 **S3-compatible API**，已有 S3 代码可通过更换 endpoint 接入，并直接示范 `@aws-sdk/client-s3`。[6]
- 官方示例配置：`region: "auto"`、`endpoint: "https://<ACCOUNT_ID>.r2.cloudflarestorage.com"`，以及 `credentials: { accessKeyId, secretAccessKey }`；使用 R2 生成的 **Access Key ID / Secret Access Key**，不是把普通 Cloudflare API bearer token 当成 S3 密钥。对象操作提供 `Bucket` / `Key`，可使用 `GetObjectCommand` / `PutObjectCommand`。[6][7]
- AWS 官方 RN 入门文档直接安装并使用 `@aws-sdk/client-s3` / `S3Client`；该包的官方 `package.json` 描述包含 **Node.js, Browser and React Native**，并有 RN runtimeConfig 映射。因此它是有官方 RN 支持依据的候选，不只是 Node SDK。[5][8]
- **RN 仍有配套要求**：AWS SDK v3 仓库 README 列出 `react-native-get-random-values`、`react-native-url-polyfill`、`web-streams-polyfill`，要求在使用 SDK 前导入，并提醒 Metro 启用 Package Exports Support。AWS RN 入门示例展示了前两项；应结合选定 SDK/polyfill 版本确认第三项及其导入路径，不把旧示例视为 Expo 52 零配置保证。[5][9]
- AWS RN 教程的 Cognito 是连接 AWS S3 的认证示例，**不是 R2 的必要认证步骤**；R2 按 Cloudflare 示例提供其 S3 credentials。实际凭证不应写入源码或随应用分发。[5][6][7]

## 条件写入与 WebDAV 网关的边界

- R2 官方兼容性表明确支持 `PutObject` 的 **`If-Match` / `If-None-Match`**；并明确这些条件与提交写入在同一操作中，针对已提交 bucket 状态**原子检查**。多个客户端对不存在的 key 同时以 `If-None-Match: *` 写入时，最多一个成功，其余返回 `412 PreconditionFailed`。这是可用于防止覆盖的存储原语，**不是 offset 冲突合并策略本身**。[10]
- R2 的上述官方接入端点是 S3 API，**不是原生 WebDAV 服务地址**。rclone 官方支持 `rclone serve webdav remote:path`，可将 remote 另行暴露为 WebDAV；这是自建网关，不是 R2 自带 WebDAV。[6][11]
- rclone 文档说明默认 ETag 来自对象 **ModTime + Size**，也可用 `--etag-hash` 选择 hash。**不能据此认定 WebDAV 网关的 ETag/条件写会保持 R2 底层原子 CAS 保证**；本次未取得这种透传保证的官方证据。因此若直接接 R2，单独使用 S3 访问适配器比额外部署 WebDAV 网关更直接。[10][11]

### 可部署的 R2 → WebDAV Worker 参考

- [abersheeran/r2-webdav](https://github.com/abersheeran/r2-webdav) 的官方 README 描述以 Cloudflare Workers 为 R2 提供 WebDAV；使用名为 `bucket` 的 Wrangler R2 binding，并通过 `USERNAME` / `PASSWORD` 两项 secrets 配置认证。[12]
- 项目 `package.json` 标记 `private: true`；这是**网关部署项目，不是可以直接安装到 Android/React 的 npm 客户端 SDK**，也不是现成的 Bangumi 账号隔离或 offset 冲突同步系统。正式多用户使用需要调整鉴权、按账号实施路径访问隔离，并审查并发写入正确性；不能仅靠客户端约定目录隔离。[12]
- README 宣称支持 Class 1/2（含 LOCK），**本次未独立验证其协议实现、锁行为或底层 R2 条件写原子性**。核查范围仅 README / package.json，不能将支持声明当作运行验证结论。[12]

## 验证状态

仅完成第一手文档和源码核查；**未安装依赖、未修改应用代码或桌面仓库，未做 Expo/Metro 构建、真机接入或并发写入验证，也未运行应用测试**。上述官方支持声明不构成 Expo 52 / RN 0.76.9 或 Tauri 2 的已验证兼容性结论。

## 官方来源

1. [webdav-client README：环境、RN、browser、文件 API](https://github.com/perry-mitchell/webdav-client/blob/master/README.md#react-native-support)
2. [webdav-client package.json：版本与入口](https://github.com/perry-mitchell/webdav-client/blob/master/package.json)
3. [请求实现](https://github.com/perry-mitchell/webdav-client/blob/master/source/request.ts)、[构建与平台入口](https://github.com/perry-mitchell/webdav-client/blob/master/webpack.config.cjs)、[@buttercup/fetch README](https://github.com/buttercup/fetch/blob/master/README.md)
4. [XML 实现](https://github.com/perry-mitchell/webdav-client/blob/master/source/tools/xml.ts)、[base64 实现](https://github.com/perry-mitchell/webdav-client/blob/master/source/tools/encode.ts)
5. [AWS SDK v3：Getting started in React Native](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/getting-started-react-native.html)
6. [Cloudflare R2：S3 API 入门及 SDK 示例](https://developers.cloudflare.com/r2/get-started/s3/)
7. [Cloudflare R2：AWS SDK for JavaScript v3 示例](https://developers.cloudflare.com/r2/examples/aws/aws-sdk-js-v3/)
8. [AWS 官方 client-s3 package.json](https://github.com/aws/aws-sdk-js-v3/blob/main/clients/client-s3/package.json)
9. [AWS SDK v3 README：RN polyfills 与 Metro 要求](https://github.com/aws/aws-sdk-js-v3/blob/main/README.md#getting-started)
10. [Cloudflare R2：S3 API compatibility，含条件写入原子性说明](https://developers.cloudflare.com/r2/api/s3/api/)
11. [rclone serve webdav：remote 网关与 ETag](https://rclone.org/commands/rclone_serve_webdav/)
12. [r2-webdav 官方 README](https://github.com/abersheeran/r2-webdav#readme)、[package.json](https://github.com/abersheeran/r2-webdav/blob/main/package.json)
