import type { QueryClient, QueryKey } from "@tanstack/react-query";

/** 组合查询成员变化时，按条目复用已有数据，避免把新组合当成完全冷缓存。 */
export function readCachedQueryMap<T>(
	client: QueryClient,
	queryKeys: readonly QueryKey[],
	subjectIds: readonly number[],
	getValueUpdatedAt?: (value: T) => number,
): Map<number, T> | undefined {
	const ids = new Set(subjectIds);
	const queries = queryKeys
		.flatMap((queryKey) => client.getQueryCache().findAll({ queryKey }))
		.sort((left, right) => left.state.dataUpdatedAt - right.state.dataUpdatedAt);
	const result = new Map<number, T>();
	const versions = new Map<number, number>();
	for (const query of queries) {
		if (!(query.state.data instanceof Map)) continue;
		for (const [subjectId, value] of query.state.data as Map<number, T>) {
			if (!ids.has(subjectId)) continue;
			// 慢组合的完成时间不代表每条记录的新鲜度，排期优先比较自身 fetchedAt。
			const updatedAt = getValueUpdatedAt?.(value) ?? query.state.dataUpdatedAt;
			if (updatedAt >= (versions.get(subjectId) ?? Number.NEGATIVE_INFINITY)) {
				result.set(subjectId, value);
				versions.set(subjectId, updatedAt);
			}
		}
	}
	return result.size > 0 ? result : undefined;
}
