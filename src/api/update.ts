import Constants from "expo-constants";

export interface UpdateInfo {
  hasUpdate: boolean;
  currentVersion: string;
  latestVersion: string;
  downloadUrl?: string;
  releaseUrl: string;
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
