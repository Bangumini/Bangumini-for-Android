import { useCallback, useEffect, useState } from "react";

import {
	clearToken,
	fetchAndCacheUsername,
	fetchTokenExpiry,
	getAccessToken,
	getUsername,
	isLoggedIn,
	setToken as saveToken,
} from "../api/oauth";

export type AuthState = {
	checking: boolean;
	loggedIn: boolean;
	username: string;
	refresh: () => Promise<void>;
	loginWithToken: (token: string) => Promise<string>;
	logout: () => Promise<void>;
};

export function useAuth(): AuthState {
	const [checking, setChecking] = useState(true);
	const [loggedIn, setLoggedIn] = useState(false);
	const [username, setUsername] = useState("");

	const refresh = useCallback(async () => {
		setChecking(true);
		try {
			const hasToken = await isLoggedIn();
			if (!hasToken) {
				setLoggedIn(false);
				setUsername("");
				setChecking(false);
				return;
			}

			// 主动验证 token 有效性，触发自动续期
			try {
				await getAccessToken();
			} catch {
				// getAccessToken 抛出 "Not authenticated" 说明 token 完全无效
				console.warn("[auth] token validation failed, clearing session");
				await clearToken();
				setLoggedIn(false);
				setUsername("");
				setChecking(false);
				return;
			}

			setLoggedIn(true);
			const cachedUsername = await getUsername();
			setUsername(cachedUsername);
			if (!cachedUsername) {
				setUsername(await fetchAndCacheUsername());
			}
		} catch (error) {
			console.warn("[auth] failed to restore session", error);
			setLoggedIn(false);
			setUsername("");
		} finally {
			setChecking(false);
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const loginWithToken = useCallback(async (token: string) => {
		await saveToken(token);

		// 尝试通过 token_status 获取过期时间
		const expiry = await fetchTokenExpiry(token);
		if (expiry) {
			const { setItem } = await import("expo-secure-store");
			await setItem("bangumi_expires_at", String(expiry));
		}

		const nextUsername = await fetchAndCacheUsername();
		setLoggedIn(true);
		setUsername(nextUsername);
		return nextUsername;
	}, []);

	const logout = useCallback(async () => {
		try {
			await clearToken();
		} finally {
			setLoggedIn(false);
			setUsername("");
		}
	}, []);

	return { checking, loggedIn, username, refresh, loginWithToken, logout };
}
