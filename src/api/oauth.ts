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
  return !!(await getItem(TOKEN_KEY));
}

export async function getAccessToken(): Promise<string> {
  const expiry = await getItem(EXPIRY_KEY);
  if (expiry && Date.now() > Number(expiry)) {
    const refreshed = await refreshAccessToken();
    if (refreshed) return refreshed;
    await clearToken();
    throw new Error("Not authenticated");
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

    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!res.ok) return null;

    const data = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };

    await persistTokenResponse(data);
    return data.access_token;
  } catch {
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
  const authorize = new URL(AUTHORIZE_URL);
  authorize.searchParams.set("client_id", CLIENT_ID);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("redirect_uri", redirectUri);

  const result = await WebBrowser.openAuthSessionAsync(authorize.toString(), redirectUri);
  if (result.type !== "success" || !result.url) {
    throw new Error("OAuth authorization was cancelled");
  }

  const callbackUrl = new URL(result.url);
  const error = callbackUrl.searchParams.get("error");
  if (error) throw new Error(error);

  const code = callbackUrl.searchParams.get("code");
  if (!code) throw new Error("OAuth callback missing code");

  await exchangeCodeForToken(code);
  return fetchAndCacheUsername();
}
