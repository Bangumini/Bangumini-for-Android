import type { Episode } from "./api/types";

/**
 * Bangumi 的 `ep` 是当前条目内编号，`sort` 是同类剧集的连续编号。
 * 两者的差值即当前季度在整部系列中的集数偏移。
 */
export function getCrossSeasonEpisodeOffset(episodes: Episode[]) {
	const firstMainEpisode = episodes
		.filter(
			(episode) =>
				episode.type === 0 &&
				Number.isFinite(episode.ep) &&
				Number.isFinite(episode.sort),
		)
		.sort((left, right) => left.ep - right.ep)[0];

	if (!firstMainEpisode) return 0;
	return Math.max(0, firstMainEpisode.sort - firstMainEpisode.ep);
}
