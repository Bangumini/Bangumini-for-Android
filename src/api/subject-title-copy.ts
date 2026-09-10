import { stripSubjectTitleSeason } from "../../shared/subject-title-season";
import { getPreference, setPreference } from "./preferences";

export { stripSubjectTitleSeason } from "../../shared/subject-title-season";

export const COPY_SUBJECT_TITLE_WITH_SEASON_STORAGE_KEY = "bangumini_copy_subject_title_with_season";

export async function shouldCopySubjectTitleWithSeason() {
  const value = await getPreference(COPY_SUBJECT_TITLE_WITH_SEASON_STORAGE_KEY);
  return value !== "false";
}

export async function setCopySubjectTitleWithSeason(enabled: boolean) {
  await setPreference(COPY_SUBJECT_TITLE_WITH_SEASON_STORAGE_KEY, String(enabled));
}

export async function getSubjectTitleForCopy(title: string) {
  return (await shouldCopySubjectTitleWithSeason()) ? title : stripSubjectTitleSeason(title);
}
