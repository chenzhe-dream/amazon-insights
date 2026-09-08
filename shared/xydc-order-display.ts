import {
  XydcOrderSnapshotSchema,
  type XydcOrderSnapshot,
  type XydcOrderWindow,
} from "./xydc-order-contract";
import { isFreshXydcOrderCache } from "./xydc-order-freshness";
import { matchesXydcOrderSnapshot, summarizeXydcOrders } from "./xydc-order-summary";
import type { XydcVariantFamily } from "./xydc-variant-contract";

function isNonfutureTimestamp(value: string | null, nowMs: number) {
  if (value === null) return true;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp <= nowMs;
}

function newest(candidates: readonly XydcOrderSnapshot[]) {
  return [...candidates].sort((left, right) =>
    right.window.endMonth.localeCompare(left.window.endMonth)
      || Date.parse(right.fetchedAt) - Date.parse(left.fetchedAt)
      || JSON.stringify(left).localeCompare(JSON.stringify(right)),
  )[0];
}

export function selectXydcOrderDisplaySnapshot(
  candidates: readonly unknown[],
  family: XydcVariantFamily,
  window: XydcOrderWindow,
  now: Date,
): XydcOrderSnapshot | null {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) return null;
  const valid = candidates.flatMap(candidate => {
    const parsed = XydcOrderSnapshotSchema.safeParse(candidate);
    if (!parsed.success) return [];
    const snapshot = parsed.data;
    if (snapshot.window.endMonth > window.endMonth
      || !matchesXydcOrderSnapshot(snapshot, family, snapshot.window)
      || !isNonfutureTimestamp(snapshot.fetchedAt, nowMs)
      || !isNonfutureTimestamp(snapshot.sourceUpdatedAt, nowMs)
      || snapshot.children.some(child => !isNonfutureTimestamp(child.fetchedAt, nowMs))) return [];
    return [snapshot];
  });
  const complete = valid.filter(snapshot => summarizeXydcOrders(snapshot).complete);
  const currentComplete = complete.filter(snapshot => snapshot.window.endMonth === window.endMonth);
  const selected = newest(currentComplete)
    ?? newest(complete)
    ?? newest(valid.filter(snapshot => snapshot.window.endMonth === window.endMonth));
  if (!selected) return null;
  return {
    ...selected,
    cacheState: selected.window.endMonth !== window.endMonth || !isFreshXydcOrderCache(selected, now)
      ? "stale"
      : selected.cacheState,
  };
}
