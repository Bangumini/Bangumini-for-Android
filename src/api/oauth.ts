import * as AuthSession from "expo-auth-session";
import * as SecureStore from "expo-secure-store";
import * as WebBrowser from "expo-web-browser";

const TOKEN_KEY = "bangumi_token";
const REFRESH_KEY = "bangumi_refresh_token";
const EXPIRY_KEY = "bangumi_expires_at";
const USERNAME_KEY = "bangumi_username";

const CLIENT_ID = "bgm602569f1d18f7f061";
const CLIENT_SECRET = "29dbdbd38d77fa4b23d32a05a7c9ebce";
const AUTHORIZE_URL = "https://bgm.tv/oauth/authorize";
const TOKEN_URL = "https://bgm.tv/oauth/access_token";

WebBrowser.maybeCompleteAuthSession();

async function getItem(key: string) {
	return SecureStore.getItemAsync(key);
}

async function setItem(key: string, value: string) {
	await SecureStore.setItemAsync(key, value);
}

async function removeItem(key: string) {
	await SecureStore.deleteItemAsync(key);
}

export function getRedirectUri() {
	return AuthSession.makeRedirectUri({
		scheme: "bangumini",
		path: "oauth/callback",
	});
}

export async function isLoggedIn(): Promise<boolean> {
	const token = await getItem(TOKEN_KEY);
	if (!token) return false;

	// 检查 token 是否过期，如果过期则尝试刷新
	const expiry = await getItem(EXPIRY_KEY);
	if (expiry && Date.now() > Number(expiry)) {
		const refreshed = await refreshAccessToken();
		// 刷新失败时不直接清除 token，让 API 调用自行判断
		// （token 过期时间可能有容差，refresh_token 也可能过期）
		return !!refreshed || !!token;
	}

	return true;
}

export async function getAccessToken(): Promise<string> {
	const expiry = await getItem(EXPIRY_KEY);
	if (expiry && Date.now() > Number(expiry)) {
		const refreshed = await refreshAccessToken();
		if (refreshed) return refreshed;
		// 刷新失败不立即清除 token — token 过期时间可能有容差
		// 且 refresh_token 也可能过期，此时应保留旧 token 让 API 自行返回 401
	}

	const token = await getItem(TOKEN_KEY);
	if (!token) throw new Error("Not authenticated");
	return token;
}

export async function getUsername(): Promise<string> {
	return (await getItem(USERNAME_KEY)) ?? "";
}

export async function setToken(token: string) {
	await setItem(TOKEN_KEY, token.trim());
}

export async function clearToken() {
	await Promise.all([
		removeItem(TOKEN_KEY),
		removeItem(REFRESH_KEY),
		removeItem(EXPIRY_KEY),
		removeItem(USERNAME_KEY),
	]);
}

export async function fetchAndCacheUsername(): Promise<string> {
	const token = await getItem(TOKEN_KEY);
	if (!token) return "";

	try {
		const res = await fetch("https://api.bgm.tv/v0/me", {
			headers: {
				Authorization: `Bearer ${token}`,
				"User-Agent": "Bangumini-for-Android/1.0",
			},
		});

		if (!res.ok) return "";

		const data = (await res.json()) as { username?: string };
		if (data.username) {
			await setItem(USERNAME_KEY, data.username);
			return data.username;
		}
	} catch {
		return "";
	}

	return "";
}

export async function refreshAccessToken(): Promise<string | null> {
	const refresh = await getItem(REFRESH_KEY);
	if (!refresh) return null;

	try {
		const body = new URLSearchParams();
		body.append("grant_type", "refresh_token");
		body.append("client_id", CLIENT_ID);
		body.append("client_secret", CLIENT_SECRET);
		body.append("refresh_token", refresh);
		body.append("redirect_uri", getRedirectUri());

		const res = await fetch(TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: body.toString(),
		});

		if (!res.ok) {
			console.warn("[oauth] refresh token failed, status:", res.status);
			return null;
		}

		const data = (await res.json()) as {
			access_token: string;
			refresh_token?: string;
			expires_in?: number;
		};

		await persistTokenResponse(data);
		return data.access_token;
	} catch (e) {
		console.warn("[oauth] refresh token error:", e);
		return null;
	}
}

async function persistTokenResponse(data: {
	access_token: string;
	refresh_token?: string;
	expires_in?: number;
}) {
	await setItem(TOKEN_KEY, data.access_token);
	if (data.refresh_token) await setItem(REFRESH_KEY, data.refresh_token);
	if (data.expires_in) {
		await setItem(EXPIRY_KEY, String(Date.now() + data.expires_in * 1000));
	}
}

async function exchangeCodeForToken(code: string) {
	const redirectUri = getRedirectUri();
	const body = new URLSearchParams();
	body.append("grant_type", "authorization_code");
	body.append("client_id", CLIENT_ID);
	body.append("client_secret", CLIENT_SECRET);
	body.append("code", code);
	body.append("redirect_uri", redirectUri);

	const res = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: body.toString(),
	});

	if (!res.ok) {
		const message = await res.text();
		throw new Error(`OAuth token exchange failed: ${message}`);
	}

	const data = (await res.json()) as {
		access_token: string;
		refresh_token?: string;
		expires_in?: number;
	};
	await persistTokenResponse(data);
	return data.access_token;
}

export async function loginWithBrowser() {
	const redirectUri = getRedirectUri();
	let authorize: URL;
	try {
		authorize = new URL(AUTHORIZE_URL);
	} catch {
		throw new Error("Invalid authorization URL");
	}
	authorize.searchParams.set("client_id", CLIENT_ID);
	authorize.searchParams.set("response_type", "code");
	authorize.searchParams.set("redirect_uri", redirectUri);

	const result = await WebBrowser.openAuthSessionAsync(
		authorize.toString(),
		redirectUri,
	);
	if (result.type !== "success" || !result.url) {
		throw new Error("OAuth authorization was cancelled");
	}

	let callbackUrl: URL;
	try {
		callbackUrl = new URL(result.url);
	} catch {
		throw new Error("Invalid callback URL from OAuth");
	}
	const error = callbackUrl.searchParams.get("error");
	if (error) throw new Error(error);

	const code = callbackUrl.searchParams.get("code");
	if (!code) throw new Error("OAuth callback missing code");

	await exchangeCodeForToken(code);
	return fetchAndCacheUsername();
}

/**
 * 通过 /oauth/token_status 查询 token 的过期时间，
 * 用于手动输入 token 时也能获取 expires_at 信息
 */
export async function fetchTokenExpiry(token: string): Promise<number | null> {
	try {
		const body = new URLSearchParams();
		body.append("access_token", token);

		const res = await fetch("https://bgm.tv/oauth/token_status", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: body.toString(),
		});

		if (!res.ok) return null;

		const data = (await res.json()) as { expires?: number };
		if (data.expires) {
			// expires 是 Unix 时间戳（秒），转换为毫秒
			return data.expires * 1000;
		}
		return null;
	} catch {
		return null;
	}
}
