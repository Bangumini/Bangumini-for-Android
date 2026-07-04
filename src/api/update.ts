import { Platform } from "react-native";
import Constants from "expo-constants";
import * as FileSystem from "expo-file-system";
import * as IntentLauncher from "expo-intent-launcher";

export interface UpdateInfo {
  hasUpdate: boolean;
  currentVersion: string;
  latestVersion: string;
  downloadUrl?: string;
  releaseUrl: string;
}

export interface DownloadProgress {
  totalBytesWritten: number;
  totalBytesExpectedToWrite: number;
}

export function compareVersions(a: string, b: string): number {
  const partsA = a.split(".").map(Number);
  const partsB = b.split(".").map(Number);

  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const nA = partsA[i] ?? 0;
    const nB = partsB[i] ?? 0;
    if (nA > nB) return 1;
    if (nA < nB) return -1;
  }
  return 0;
}

const LATEST_JSON_URL =
  "https://github.com/Bangumini/Bangumini-for-Android/releases/latest/download/latest.json";

interface LatestJson {
  version: string;
  url: string;
}

export async function checkForUpdate(): Promise<UpdateInfo> {
  const currentVersion = Constants.expoConfig?.version ?? "0.0.0";

  const resp = await fetch(LATEST_JSON_URL);

  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}`);
  }

  const data: LatestJson = await resp.json();

  const latestVersion = data.version;
  const hasUpdate = compareVersions(latestVersion, currentVersion) > 0;

  return {
    hasUpdate,
    currentVersion,
    latestVersion,
    downloadUrl: data.url,
    releaseUrl: "https://github.com/Bangumini/Bangumini-for-Android/releases/latest",
  };
}

export async function downloadApk(
  url: string,
  onProgress?: (progress: DownloadProgress) => void,
): Promise<string> {
  const fileUri = FileSystem.cacheDirectory + "update.apk";

  const downloadResumable = FileSystem.createDownloadResumable(
    url,
    fileUri,
    {},
    onProgress,
  );

  const result = await downloadResumable.downloadAsync();
  if (!result?.uri) {
    throw new Error("Download failed");
  }

  return fileUri;
}

const FILE_PROVIDER_AUTHORITY = "dev.raycast.bangumini.fileprovider";

export async function installApk(fileUri: string): Promise<void> {
  if (Platform.OS !== "android") return;

  const contentUri = fileUri.replace(
    FileSystem.cacheDirectory!,
    `content://${FILE_PROVIDER_AUTHORITY}/apk/`,
  );

  await IntentLauncher.startActivityAsync("android.intent.action.VIEW", {
    data: contentUri,
    type: "application/vnd.android.package-archive",
    flags: 1, // FLAG_GRANT_READ_URI_PERMISSION
  });
}

export async function openInstallPermissionSettings(): Promise<void> {
  if (Platform.OS !== "android") return;

  await IntentLauncher.startActivityAsync("android.settings.MANAGE_UNKNOWN_APP_SOURCES", {
    data: "package:dev.raycast.bangumini",
  });
}
