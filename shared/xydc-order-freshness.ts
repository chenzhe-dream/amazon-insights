import type { XydcOrderSnapshot } from "./xydc-order-contract";

export function isCurrentXydcOrderTimestamp(
  fetchedAt: string,
  now: Date,
  maxAgeMs = 86_400_000,
) {
  const age = now.getTime() - Date.parse(fetchedAt);
  return Number.isFinite(age) && age >= 0 && age <= maxAgeMs;
}

export function isFreshXydcOrderCache(
  snapshot: XydcOrderSnapshot | undefined,
  now: Date,
  maxAgeMs = 86_400_000,
) {
  if (!snapshot || snapshot.cacheState !== "fresh" || snapshot.reasonCode !== null) return false;
  if (!isCurrentXydcOrderTimestamp(snapshot.fetchedAt, now, maxAgeMs)) return false;
  if (snapshot.children.length !== snapshot.childAsins.length) return false;
  const expectedMonths = new Set(snapshot.window.months);
  return snapshot.children.every(child => isCurrentXydcOrderTimestamp(child.fetchedAt, now, maxAgeMs)
    && child.reasonCode === null
    && child.trends.length === snapshot.window.months.length
    && child.trends.every(trend => expectedMonths.has(trend.date)));
}
