import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
	type ReactNode,
} from "react";

import {
	clearToken,
	fetchAndCacheUsername,
	fetchTokenExpiry,
	getUsername,
	isLoggedIn,
	setToken as saveToken,
	setTokenExpiry,
	subscribeAuthSessionExpired,
} from "../api/oauth";

export type AuthState = {
	checking: boolean;
	loggedIn: boolean;
	username: string;
	sessionExpired: boolean;
	acknowledgeSessionExpired: () => void;
	refresh: () => Promise<void>;
	loginWithToken: (token: string) => Promise<string>;
	logout: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
	const [checking, setChecking] = useState(true);
	const [loggedIn, setLoggedIn] = useState(false);
	const [username, setUsername] = useState("");
	const [sessionExpired, setSessionExpired] = useState(false);
	const authOperationRef = useRef(0);

	const acknowledgeSessionExpired = useCallback(() => {
		setSessionExpired(false);
	}, []);

	useEffect(
		() =>
			subscribeAuthSessionExpired(() => {
				authOperationRef.current += 1;
				setChecking(false);
				setLoggedIn(false);
				setUsername("");
				setSessionExpired(true);
			}),
		[],
	);

	const refresh = useCallback(async () => {
		const operation = authOperationRef.current + 1;
		authOperationRef.current = operation;
		setChecking(true);
		try {
			const hasToken = await isLoggedIn();
			if (authOperationRef.current !== operation) return;
			if (!hasToken) {
				setLoggedIn(false);
				setUsername("");
				return;
			}

			const cachedUsername = await getUsername();
			if (authOperationRef.current !== operation) return;
			const nextUsername = cachedUsername || (await fetchAndCacheUsername());
			if (authOperationRef.current !== operation) return;

			setLoggedIn(true);
			setSessionExpired(false);
			setUsername(nextUsername);
		} catch (error) {
			if (authOperationRef.current !== operation) return;
			console.warn("[auth] failed to restore session", error);
			setLoggedIn(false);
			setUsername("");
		} finally {
			if (authOperationRef.current === operation) setChecking(false);
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const loginWithToken = useCallback(async (token: string) => {
		const operation = authOperationRef.current + 1;
		authOperationRef.current = operation;
		await saveToken(token);

		// 尝试通过 token_status 获取过期时间
		const expiry = await fetchTokenExpiry(token);
		if (expiry) {
			await setTokenExpiry(token, expiry);
		}

		const nextUsername = await fetchAndCacheUsername();
		if (authOperationRef.current === operation) {
			setLoggedIn(true);
			setSessionExpired(false);
			setUsername(nextUsername);
		}
		return nextUsername;
	}, []);

	const logout = useCallback(async () => {
		const operation = authOperationRef.current + 1;
		authOperationRef.current = operation;
		try {
			await clearToken();
		} finally {
			if (authOperationRef.current === operation) {
				setLoggedIn(false);
				setSessionExpired(false);
				setUsername("");
			}
		}
	}, []);

	const value = useMemo<AuthState>(
		() => ({
			checking,
			loggedIn,
			username,
			sessionExpired,
			acknowledgeSessionExpired,
			refresh,
			loginWithToken,
			logout,
		}),
		[
			checking,
			loggedIn,
			username,
			sessionExpired,
			acknowledgeSessionExpired,
			refresh,
			loginWithToken,
			logout,
		],
	);

	return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
	const auth = useContext(AuthContext);
	if (!auth) throw new Error("useAuth must be used within AuthProvider");
	return auth;
}
