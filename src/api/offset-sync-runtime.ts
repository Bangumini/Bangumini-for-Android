// 必须在 SDK 初始化前补齐 RN 的 URL、UTF-8、Web Streams、Blob 与安全随机数。
import "react-native-url-polyfill/auto";
import "fast-text-encoding";
import "web-streams-polyfill";
import { getRandomValues } from "expo-crypto";

// 新版 Smithy 读 Blob 会直接调用 arrayBuffer；RN 0.76 仅提供原生 FileReader。
// readAsArrayBuffer 在这个 RN 版本也未实现，必须通过受支持的 Data URL 读取。
if (typeof Blob === "function" && typeof Blob.prototype.arrayBuffer !== "function" && typeof FileReader === "function") {
  Object.defineProperty(Blob.prototype, "arrayBuffer", {
    configurable: true,
    writable: true,
    value: function (this: Blob): Promise<ArrayBuffer> {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error ?? new Error("无法读取二进制响应"));
        reader.onabort = () => reject(new Error("二进制响应读取已取消"));
        reader.onloadend = () => {
          try {
            if (reader.readyState !== 2 || typeof reader.result !== "string" || !reader.result.startsWith("data:") || reader.result.indexOf(",") < 0) {
              throw new Error("二进制响应读取失败");
            }
            const decoded = atob(reader.result.slice(reader.result.indexOf(",") + 1));
            const bytes = new Uint8Array(decoded.length);
            for (let index = 0; index < decoded.length; index++) bytes[index] = decoded.charCodeAt(index);
            resolve(bytes.buffer);
          } catch (error) { reject(error); }
        };
        reader.readAsDataURL(this);
      });
    },
  });
}

if (!globalThis.crypto?.getRandomValues) {
  const crypto = globalThis.crypto ?? ({} as Crypto);
  Object.defineProperty(crypto, "getRandomValues", { value: getRandomValues, configurable: true });
  if (!globalThis.crypto) Object.defineProperty(globalThis, "crypto", { value: crypto, configurable: true });
}
