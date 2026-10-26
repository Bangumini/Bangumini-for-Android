const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
// webdav/react-native 使用官方 exports 子入口，AWS SDK 依赖也要求 Package Exports 支持。
config.resolver.unstable_enablePackageExports = true;
// 仅为 AWS/Smithy 选择 ESM，确保使用 RN runtimeConfig，而非含 Node 内置模块的 dist-cjs。
// 不能全局优先 module：URL polyfill 以 CJS 调用 punycode.ucs2，ESM 命名导出没有 ucs2。
const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const sdk = /^(?:@aws-sdk|@aws-crypto|@smithy)\//.test(moduleName);
  const scopedContext = sdk ? {
    ...context,
    mainFields: platform === "web"
      ? ["browser", "module", "main"]
      : ["react-native", "browser", "module", "main"],
  } : context;
  return defaultResolveRequest
    ? defaultResolveRequest(scopedContext, moduleName, platform)
    : context.resolveRequest(scopedContext, moduleName, platform);
};
module.exports = config;
