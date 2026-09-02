// 同一 UTC 时刻在不同设备时区下必须得到相同分组。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
	deriveAiredEpisodeCount,
	deriveAiringSchedule,
	getNextEpisodeAiringAt,
} from "../shared/airing-schedule.ts";
import { sortCollections } from "../shared/sort-collections.ts";

if (process.env.AIRING_TZ_CHILD) {
	const subject = {
		id: 1,
		name: "深夜档",
		name_cn: "深夜档",
		date: "2026-08-01",
		eps: 12,
		total_episodes: 12,
		air_weekday: 5,
	};
	const collection = { subject_id: 1, subject, ep_status: 7 };
	const episodes = [
		{ ep: 7, airdate: "2026-08-14" },
		{ ep: 8, airdate: "2026-08-21" },
	];
	const observation = {
		airingAt: Date.UTC(2026, 7, 21, 16, 30) / 1000,
		episode: 8,
		fetchedAt: Date.UTC(2026, 7, 21, 16, 0),
	};
	const nowMs = Date.UTC(2026, 7, 21, 16, 29);
	const schedule = deriveAiringSchedule(undefined, episodes, observation);
	const airedEp = deriveAiredEpisodeCount(episodes, schedule, nowMs);
	const nextAiringAt = getNextEpisodeAiringAt(episodes, schedule, nowMs);
	const result = sortCollections([collection], [], {
		nowMs,
		airedEpMap: new Map([[1, airedEp]]),
		airingSignalMap: new Map([[1, observation]]),
		nextAiringAtMap: new Map([[1, nextAiringAt]]),
	})[0];
	process.stdout.write(
		JSON.stringify({ group: result.group, airedEp: result.airedEp }),
	);
} else {
	const zones = [
		"Asia/Tokyo",
		"Asia/Shanghai",
		"America/Los_Angeles",
		"Europe/Berlin",
	];
	const results = zones.map((TZ) => {
		const child = spawnSync(
			process.execPath,
			["--experimental-strip-types", fileURLToPath(import.meta.url)],
			{
				env: { ...process.env, TZ, AIRING_TZ_CHILD: "1" },
				encoding: "utf8",
			},
		);
		assert.equal(child.status, 0, `${TZ}: ${child.stderr}`);
		return child.stdout.trim();
	});
	assert.equal(new Set(results).size, 1, results.join("\n"));
	process.stdout.write("airing timezones: 全部通过 ✓\n");
}
