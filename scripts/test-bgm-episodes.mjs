// BGM 完整剧集分页回归测试（零网络、零依赖）
import assert from "node:assert/strict";
import { getAllEpisodes, setFetchFunction } from "../shared/api/client.ts";

const requestedOffsets = [];
setFetchFunction(async (url) => {
	let parsed;
	try {
		parsed = new URL(String(url));
	} catch {
		throw new Error(`测试收到无效 URL: ${String(url)}`);
	}
	const offset = Number(parsed.searchParams.get("offset") ?? 0);
	requestedOffsets.push(offset);
	const total = 205;
	const count = Math.min(100, total - offset);
	const data = Array.from({ length: count }, (_, index) => ({
		id: offset + index + 1,
		subject_id: 1,
		name: "",
		name_cn: "",
		type: 0,
		sort: offset + index + 1,
		ep: offset + index + 1,
		airdate: "2026-01-01",
		duration: "",
		status: "Air",
	}));
	return new Response(JSON.stringify({ data, total, limit: 100, offset }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
});

const result = await getAllEpisodes(1);
assert.equal(result.data.length, 205, "长篇动画不得被截断到前 100 集");
assert.deepEqual(requestedOffsets, [0, 100, 200]);
assert.equal(result.data.at(-1).ep, 205);

process.stdout.write("BGM episode pagination: 全部通过 ✓\n");
