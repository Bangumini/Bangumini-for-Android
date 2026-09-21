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

export class AuthSessionExpiredError extends Error {
	constructor() {
		super("登录状态已过期，请重新登录");
		this.name = "AuthSessionExpiredError";
	}
}

export class AuthRefreshUnavailableError extends Error {
	constructor() {
		super("登录状态暂时无法续期，请稍后重试");
		this.name = "AuthRefreshUnavailableError";
	}
}

class NotAuthenticatedError extends Error {
	constructor() {
		super("Not authenticated");
		this.name = "NotAuthenticatedError";
	}
}

type AuthSessionExpiredListener = () => void;

const authSessionExpiredListeners = new Set<AuthSessionExpiredListener>();
let authSessionRevision = 0;
let authSessionGeneration = 0;
let credentialMutationQueue: Promise<void> = Promise.resolve();

function mutateCredentials<T>(mutation: () => Promise<T>): Promise<T> {
	const result = credentialMutationQueue.then(mutation, mutation);
	credentialMutationQueue = result.then(
		() => undefined,
		() => undefined,
	);
	return result;
}

async function readCredentialSnapshot() {
	return mutateCredentials(async () => {
		const [token, refreshToken, expiry] = await Promise.all([
			getItem(TOKEN_KEY),
			getItem(REFRESH_KEY),
			getItem(EXPIRY_KEY),
		]);
		return {
			revision: authSessionRevision,
			sessionGeneration: authSessionGeneration,
			token,
			refreshToken,
			expiry,
		};
	});
}

async function removeStoredCredentials() {
	await Promise.all([
		removeItem(TOKEN_KEY),
		removeItem(REFRESH_KEY),
		removeItem(EXPIRY_KEY),
		removeItem(USERNAME_KEY),
	]);
}

export function subscribeAuthSessionExpired(
	listener: AuthSessionExpiredListener,
) {
	authSessionExpiredListeners.add(listener);
	return () => {
		authSessionExpiredListeners.delete(listener);
	};
}

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
	try {
		await getAccessToken();
		return true;
	} catch (error) {
		if (error instanceof AuthSessionExpiredError) return false;
		if (error instanceof NotAuthenticatedError) return false;
		if (error instanceof AuthRefreshUnavailableError) return true;
		throw error;
	}
}

export type AccessTokenOptions = {
	forceRefresh?: boolean;
	rejectedToken?: string;
	rejectedSessionId?: number;
};

export async function getAccessToken(
	options: AccessTokenOptions = {},
): Promise<string> {
	const snapshot = await readCredentialSnapshot();
	if (
		options.forceRefresh &&
		((options.rejectedToken && snapshot.token !== options.rejectedToken) ||
			(options.rejectedSessionId !== undefined &&
				snapshot.sessionGeneration !== options.rejectedSessionId))
	) {
		if (!snapshot.token) throw new NotAuthenticatedError();
		return snapshot.token;
	}

	if (
		options.forceRefresh ||
		(snapshot.expiry && Date.now() > Number(snapshot.expiry))
	) {
		const refreshed = await refreshAccessToken(snapshot.revision);
		if (refreshed) return refreshed;
		await invalidateAuthSession(
			snapshot.token ?? undefined,
			snapshot.sessionGeneration,
		);
		throw new AuthSessionExpiredError();
	}

	if (!snapshot.token) throw new NotAuthenticatedError();
	return snapshot.token;
}

export type AccessTokenContext = {
	token: string;
	sessionId: number;
};

export async function getAccessTokenContext(
	options: AccessTokenOptions = {},
): Promise<AccessTokenContext> {
	const token = await getAccessToken(options);
	const snapshot = await readCredentialSnapshot();
	if (!snapshot.token) throw new NotAuthenticatedError();
	return {
		token: snapshot.token === token ? token : snapshot.token,
		sessionId: snapshot.sessionGeneration,
	};
}

export async function getUsername(): Promise<string> {
	return mutateCredentials(async () => (await getItem(USERNAME_KEY)) ?? "");
}

export async function setToken(token: string) {
	await mutateCredentials(async () => {
		authSessionRevision += 1;
		authSessionGeneration += 1;
		await removeStoredCredentials();
		await setItem(TOKEN_KEY, token.trim());
	});
}

export async function setTokenExpiry(token: string, expiry: number) {
	await mutateCredentials(async () => {
		if ((await getItem(TOKEN_KEY)) !== token) return;
		await setItem(EXPIRY_KEY, String(expiry));
	});
}

export async function clearToken() {
	await mutateCredentials(async () => {
		authSessionRevision += 1;
		authSessionGeneration += 1;
		await removeStoredCredentials();
	});
}

export async function invalidateAuthSession(
	expectedToken?: string,
	expectedSessionId?: number,
) {
	let invalidated = false;
	await mutateCredentials(async () => {
		const currentToken = await getItem(TOKEN_KEY);
		if (expectedToken && currentToken !== expectedToken) return;
		if (
			expectedSessionId !== undefined &&
			authSessionGeneration !== expectedSessionId
		) {
			return;
		}
		if (!currentToken) return;

		authSessionRevision += 1;
		authSessionGeneration += 1;
		await removeStoredCredentials();
		invalidated = true;
	});

	if (invalidated) {
		authSessionExpiredListeners.forEach((listener) => listener());
	}
	return invalidated;
}

export async function fetchAndCacheUsername(): Promise<string> {
	const { token } = await readCredentialSnapshot();
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
			let cached = false;
			await mutateCredentials(async () => {
				if ((await getItem(TOKEN_KEY)) !== token) return;
				await setItem(USERNAME_KEY, data.username!);
				cached = true;
			});
			return cached ? data.username : "";
		}
	} catch {
		return "";
	}

	return "";
}

type AccessTokenRefreshFlight = {
	revision: number;
	refreshToken: string;
	promise: Promise<string | null>;
};

let accessTokenRefreshFlight: AccessTokenRefreshFlight | null = null;

export async function refreshAccessToken(
	expectedRevision?: number,
): Promise<string | null> {
	const snapshot = await readCredentialSnapshot();
	if (
		expectedRevision !== undefined &&
		snapshot.revision !== expectedRevision
	) {
		return snapshot.token;
	}
	if (!snapshot.refreshToken) return null;

	let currentRefresh = accessTokenRefreshFlight;
	if (
		!currentRefresh ||
		currentRefresh.revision !== snapshot.revision ||
		currentRefresh.refreshToken !== snapshot.refreshToken
	) {
		currentRefresh = {
			revision: snapshot.revision,
			refreshToken: snapshot.refreshToken,
			promise: performAccessTokenRefresh(
				snapshot.revision,
				snapshot.refreshToken,
			),
		};
		accessTokenRefreshFlight = currentRefresh;
	}

	try {
		return await currentRefresh.promise;
	} finally {
		if (accessTokenRefreshFlight === currentRefresh) {
			accessTokenRefreshFlight = null;
		}
	}
}

async function performAccessTokenRefresh(
	refreshRevision: number,
	refreshToken: string,
): Promise<string | null> {

	try {
		const body = new URLSearchParams();
		body.append("grant_type", "refresh_token");
		body.append("client_id", CLIENT_ID);
		body.append("client_secret", CLIENT_SECRET);
		body.append("refresh_token", refreshToken);
		body.append("redirect_uri", getRedirectUri());

		const res = await fetch(TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: body.toString(),
		});

		if (!res.ok) {
			console.warn("[oauth] refresh token failed, status:", res.status);
			if (res.status === 400 || res.status === 401) return null;
			throw new AuthRefreshUnavailableError();
		}

		const data = (await res.json()) as {
			access_token: string;
			refresh_token?: string;
			expires_in?: number;
		};

		const persisted = await persistTokenResponse(data, refreshRevision);
		return persisted ? data.access_token : getItem(TOKEN_KEY);
	} catch (e) {
		if (e instanceof AuthRefreshUnavailableError) throw e;
		console.warn("[oauth] refresh token error:", e);
		throw new AuthRefreshUnavailableError();
	}
}

async function persistTokenResponse(
	data: {
		access_token: string;
		refresh_token?: string;
		expires_in?: number;
	},
	expectedRevision?: number,
) {
	return mutateCredentials(async () => {
		if (
			expectedRevision !== undefined &&
			authSessionRevision !== expectedRevision
		) {
			return false;
		}

		if (expectedRevision === undefined) {
			authSessionGeneration += 1;
			await removeStoredCredentials();
		}
		await setItem(TOKEN_KEY, data.access_token);
		if (data.refresh_token) await setItem(REFRESH_KEY, data.refresh_token);
		if (data.expires_in) {
			await setItem(EXPIRY_KEY, String(Date.now() + data.expires_in * 1000));
		} else {
			await removeItem(EXPIRY_KEY);
		}
		authSessionRevision += 1;
		return true;
	});
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
