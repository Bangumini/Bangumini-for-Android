import AsyncStorage from "@react-native-async-storage/async-storage";

export async function getPreference(key: string): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(key);
  } catch {
    return null;
  }
}

export async function setPreference(key: string, value: string) {
  await AsyncStorage.setItem(key, value);
}

export async function removePreference(key: string) {
  await AsyncStorage.removeItem(key);
}
