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

export async function checkForUpdate(): Promise<UpdateInfo> {
  const currentVersion = Constants.expoConfig?.version ?? "0.0.0";
  const repo = "Bangumini/Bangumini-for-Android";

  const resp = await fetch(
    `https://api.github.com/repos/${repo}/releases/latest`,
    { headers: { Accept: "application/vnd.github+json" } },
  );

  if (!resp.ok) {
    throw new Error(`GitHub API error ${resp.status}`);
  }

  const release: {
    tag_name: string;
    html_url: string;
    assets: Array<{ name: string; browser_download_url: string }>;
  } = await resp.json();

  const latestVersion = release.tag_name.replace(/^v/, "");
  const hasUpdate = compareVersions(latestVersion, currentVersion) > 0;

  const apkAsset = release.assets?.find(
    (a) => a.name?.endsWith(".apk") && !a.name?.includes("debug"),
  );

  return {
    hasUpdate,
    currentVersion,
    latestVersion,
    downloadUrl: apkAsset?.browser_download_url,
    releaseUrl: release.html_url,
  };
}
