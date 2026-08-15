import { NativeModules, Platform } from "react-native";
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
		releaseUrl:
			"https://github.com/Bangumini/Bangumini-for-Android/releases/latest",
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

/**
 * 查询「安装未知应用」权限是否已授权（Android 8.0+ per-app 授权）。
 * 旧版本无此概念，视为已授权。
 */
export async function canRequestPackageInstalls(): Promise<boolean> {
	if (Platform.OS !== "android") return true;

	const { BanguminiMedia } = NativeModules;
	return (await BanguminiMedia.canRequestPackageInstalls()) === true;
}

/**
 * 运行时实际的 applicationId（dev 构建带 .dev 后缀）。
 * 授权引导和 FileProvider authority 都必须用它，不能硬编码正式包名。
 */
async function getPackageName(): Promise<string> {
	const { BanguminiMedia } = NativeModules;
	return (await BanguminiMedia.getPackageName()) as string;
}

export async function installApk(fileUri: string): Promise<void> {
	if (Platform.OS !== "android") return;

	const packageName = await getPackageName();

	const contentUri = fileUri.replace(
		FileSystem.cacheDirectory!,
		`content://${packageName}.fileprovider/apk/`,
	);

	await IntentLauncher.startActivityAsync("android.intent.action.VIEW", {
		data: contentUri,
		type: "application/vnd.android.package-archive",
		flags: 1, // FLAG_GRANT_READ_URI_PERMISSION
	});
}

export async function openInstallPermissionSettings(): Promise<void> {
	if (Platform.OS !== "android") return;

	const packageName = await getPackageName();

	await IntentLauncher.startActivityAsync(
		"android.settings.MANAGE_UNKNOWN_APP_SOURCES",
		{
			data: `package:${packageName}`,
		},
	);
}
