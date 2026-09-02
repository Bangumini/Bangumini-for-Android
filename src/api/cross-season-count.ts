import { getPreference, setPreference } from "./preferences";

export { getCrossSeasonEpisodeOffset } from "../../shared/cross-season-count";

export const CROSS_SEASON_COUNT_STORAGE_KEY = "bangumini_cross_season_count";

export async function isCrossSeasonCountEnabled() {
  const value = await getPreference(CROSS_SEASON_COUNT_STORAGE_KEY);
  return value === "true";
}

export async function setCrossSeasonCountEnabled(enabled: boolean) {
  await setPreference(CROSS_SEASON_COUNT_STORAGE_KEY, String(enabled));
}
