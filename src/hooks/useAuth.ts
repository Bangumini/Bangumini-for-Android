import { useCallback, useEffect, useState } from "react";

import {
  clearToken,
  fetchAndCacheUsername,
  getUsername,
  isLoggedIn,
  setToken,
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
      setLoggedIn(hasToken);
      if (hasToken) {
        const cachedUsername = await getUsername();
        setUsername(cachedUsername);
        if (!cachedUsername) {
          setUsername(await fetchAndCacheUsername());
        }
      } else {
        setUsername("");
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
    await setToken(token);
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
