// 排期缓存策略回归测试（零网络、零依赖）
import assert from "node:assert/strict";
import {
	AIRING_NEGATIVE_CACHE_MAX_AGE,
	AIRING_RECORD_MAX_AGE,
	applyAiringLookupResult,
	isAiringRecordUsable,
	shouldRefreshAiringRecord,
} from "../shared/airing-cache.ts";

const now = Date.UTC(2026, 7, 22, 0, 0);
const future = {
	status: "scheduled",
	airingAt: (now + 60_000) / 1000,
	episode: 8,
	fetchedAt: now - 60_000,
};
assert.equal(isAiringRecordUsable(future, now), true);
assert.equal(shouldRefreshAiringRecord(future, now), false);
assert.equal(
	shouldRefreshAiringRecord(future, now + 60_000),
	true,
	"scheduled 的 airingAt 过期后必须进入刷新状态",
);

const staleTemplate = {
	...future,
	fetchedAt: now - AIRING_RECORD_MAX_AGE + 1,
};
assert.equal(isAiringRecordUsable(staleTemplate, now), true);
assert.equal(
	applyAiringLookupResult(
		staleTemplate,
		{ status: "network_error", retryable: true, message: "offline" },
		now,
	),
	staleTemplate,
	"网络错误不得覆盖已有 scheduled 模板",
);

const negative = { status: "not_found", fetchedAt: now };
assert.equal(shouldRefreshAiringRecord(negative, now), false);
assert.equal(
	shouldRefreshAiringRecord(negative, now + AIRING_NEGATIVE_CACHE_MAX_AGE),
	true,
	"负缓存 24 小时后必须刷新",
);
assert.deepEqual(
	applyAiringLookupResult(undefined, { status: "no_schedule" }, now),
	{ status: "no_schedule", fetchedAt: now },
);

process.stdout.write("airing cache: 全部通过 ✓\n");
