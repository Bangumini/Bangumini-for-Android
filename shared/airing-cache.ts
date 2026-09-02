import type { AiringLookupResult } from "./api/anilist";
import type { AiringObservation } from "./airing-schedule";

export const AIRING_RECORD_MAX_AGE = 14 * 24 * 60 * 60 * 1000;
export const AIRING_NEGATIVE_CACHE_MAX_AGE = 24 * 60 * 60 * 1000;

export type AiringCacheRecord =
	| {
			status: "scheduled";
			airingAt: number;
			episode: number;
			fetchedAt: number;
	  }
	| { status: "no_schedule" | "not_found"; fetchedAt: number };

export function isAiringCacheRecord(
	value: unknown,
): value is AiringCacheRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<AiringCacheRecord>;
	if (typeof record.fetchedAt !== "number") return false;
	if (record.status === "not_found" || record.status === "no_schedule") {
		return true;
	}
	return (
		record.status === "scheduled" &&
		typeof record.airingAt === "number" &&
		typeof record.episode === "number"
	);
}

export function isAiringRecordUsable(
	record: AiringCacheRecord,
	nowMs: number,
): boolean {
	const maxAge =
		record.status === "scheduled"
			? AIRING_RECORD_MAX_AGE
			: AIRING_NEGATIVE_CACHE_MAX_AGE;
	return nowMs - record.fetchedAt <= maxAge;
}

export function shouldRefreshAiringRecord(
	record: AiringCacheRecord | undefined,
	nowMs: number,
): boolean {
	if (!record) return true;
	if (record.status !== "scheduled") {
		return nowMs - record.fetchedAt >= AIRING_NEGATIVE_CACHE_MAX_AGE;
	}
	return (
		nowMs >= record.airingAt * 1000 ||
		nowMs - record.fetchedAt >= AIRING_RECORD_MAX_AGE
	);
}

export function applyAiringLookupResult(
	previous: AiringCacheRecord | undefined,
	result: AiringLookupResult,
	fetchedAt: number,
): AiringCacheRecord | undefined {
	if (result.status === "network_error") return previous;
	if (result.status === "scheduled") {
		return { status: "scheduled", ...result.value, fetchedAt };
	}
	return { status: result.status, fetchedAt };
}

export function toAiringObservation(
	record: AiringCacheRecord,
): AiringObservation | null {
	if (record.status !== "scheduled") return null;
	return {
		airingAt: record.airingAt,
		episode: record.episode,
		fetchedAt: record.fetchedAt,
	};
}
