import AsyncStorage from "@react-native-async-storage/async-storage";

const CACHE_PREFIX = "bangumini-http-";

export async function readCache<T>(key: string): Promise<T | null> {
  try {
    const raw = await AsyncStorage.getItem(`${CACHE_PREFIX}${key}`);
    if (!raw) return null;
    const cached = JSON.parse(raw) as { data: T; cachedAt: number };
    return cached.data ?? null;
  } catch {
    return null;
  }
}

export async function writeCache<T>(key: string, data: T) {
  await AsyncStorage.setItem(
    `${CACHE_PREFIX}${key}`,
    JSON.stringify({ data, cachedAt: Date.now() }),
  );
}

export async function clearCache(key: string) {
  await AsyncStorage.removeItem(`${CACHE_PREFIX}${key}`);
}
