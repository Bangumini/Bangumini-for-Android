import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";

import {
  readAiringOffsetAccountState, setAiringOffsetAccount, subscribeAiringOffsetState, updateAiringOffsetAccountState,
} from "./airing-offset";
import { createAiringOffsetSyncManager } from "./airing-offset-sync-manager";
import { createOffsetSyncConfigStore } from "./offset-sync-config-store";
import { createOffsetSyncStorage, OffsetSyncPreconditionError, offsetSyncStorageErrorMessage } from "./offset-sync-storage";

const configs = createOffsetSyncConfigStore({
  getItem: SecureStore.getItemAsync,
  setItem: SecureStore.setItemAsync,
  deleteItem: SecureStore.deleteItemAsync,
  hash: account => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, account),
  randomId: Crypto.randomUUID,
});

/** 偏置同步与收藏 worker 分离；不向 Bangumi 上传个人日期修正或存储凭证。 */
export const offsetSync = createAiringOffsetSyncManager({
  setAccount: setAiringOffsetAccount,
  readLocal: readAiringOffsetAccountState,
  updateLocal: updateAiringOffsetAccountState,
  subscribeLocal: subscribeAiringOffsetState,
  configs,
  createStorage: createOffsetSyncStorage,
  isPreconditionError: error => error instanceof OffsetSyncPreconditionError,
  formatStorageError: offsetSyncStorageErrorMessage,
  newRevision: Crypto.randomUUID,
});
