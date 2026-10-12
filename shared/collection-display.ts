export type CachedCollectionSnapshotReadiness = {
  username: string | null | undefined;
  hasCachedCollections: boolean;
};

/**
 * 判断是否可以提交本地收藏快照。
 *
 * 播出和剧集数据只会丰富排序结果，不应阻塞已有收藏首屏；缺失时排序会回退到
 * 收藏自身的进度、总集数和播出日字段，网络数据完成后再替换为更完整的结果。
 */
export function canRenderCachedCollectionsSnapshot({
  username,
  hasCachedCollections,
}: CachedCollectionSnapshotReadiness): boolean {
  return Boolean(username && hasCachedCollections);
}
