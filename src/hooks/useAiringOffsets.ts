import { useEffect, useSyncExternalStore } from "react";

import {
  getAiringOffsetsSnapshot,
  initializeAiringOffsets,
  subscribeAiringOffsets,
} from "../api/airing-offset";

export function useAiringOffsets(): Readonly<Record<number, number>> {
  const offsets = useSyncExternalStore(
    subscribeAiringOffsets,
    getAiringOffsetsSnapshot,
    getAiringOffsetsSnapshot,
  );
  useEffect(() => { void initializeAiringOffsets(); }, []);
  return offsets;
}
