import { getPreference, setPreference } from "./preferences";

export const COPY_SUBJECT_TITLE_WITH_SEASON_STORAGE_KEY = "bangumini_copy_subject_title_with_season";

export async function shouldCopySubjectTitleWithSeason() {
  const value = await getPreference(COPY_SUBJECT_TITLE_WITH_SEASON_STORAGE_KEY);
  return value !== "false";
}

export async function setCopySubjectTitleWithSeason(enabled: boolean) {
  await setPreference(COPY_SUBJECT_TITLE_WITH_SEASON_STORAGE_KEY, String(enabled));
}

export function stripSubjectTitleSeason(title: string) {
  const stripped = title
    .replace(/\s*(?:第\s*[0-9一二两三四五六七八九十百]+\s*[季期部]|[0-9一二两三四五六七八九十百]+\s*期)$/i, "")
    .replace(/\s+(?:[0-9]+(?:st|nd|rd|th)?\s+season|season\s*[0-9]+)$/i, "")
    .trim();

  return stripped || title;
}

export async function getSubjectTitleForCopy(title: string) {
  return (await shouldCopySubjectTitleWithSeason()) ? title : stripSubjectTitleSeason(title);
}
