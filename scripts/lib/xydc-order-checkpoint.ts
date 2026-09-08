import fs from "node:fs/promises";
import { XydcOrderChildSchema, type XydcOrderChild, type XydcOrderWindow } from "../../shared/xydc-order-contract";
import type { XydcVariantFamily } from "../../shared/xydc-variant-contract";
import { isCurrentXydcOrderTimestamp, writeXydcOrderJson, xydcOrderCachePath } from "./xydc-order-cache";

function identity(family: XydcVariantFamily, window: XydcOrderWindow, asin: string) {
  if (!family.children.some(child => child.asin === asin)) throw new Error("Invalid checkpoint child");
  return { country: family.country, parentAsin: family.parentAsin, childAsins: family.children.map(child => child.asin).sort(), window, asin };
}
function checkpointPath(root: string, family: XydcVariantFamily, window: XydcOrderWindow, asin: string) {
  return xydcOrderCachePath(root, family, window).replace(/\.json$/, `.${asin}.checkpoint.json`);
}
export function completeXydcChild(child: XydcOrderChild, window: XydcOrderWindow) {
  return child.reasonCode === null && child.trends.length === 12 && new Set(child.trends.map(trend => trend.date)).size === 12
    && window.months.every(month => child.trends.some(trend => trend.date === month));
}
export async function readXydcOrderCheckpoint(root: string, family: XydcVariantFamily, window: XydcOrderWindow, asin: string, now: Date) {
  try {
    const value = JSON.parse(await fs.readFile(checkpointPath(root, family, window, asin), "utf8"));
    const child = XydcOrderChildSchema.parse(value.child);
    return value.version === 1 && JSON.stringify(value.identity) === JSON.stringify(identity(family, window, asin))
      && child.asin === asin && completeXydcChild(child, window) && isCurrentXydcOrderTimestamp(child.fetchedAt, now) ? child : undefined;
  } catch { return undefined; }
}
export async function writeXydcOrderCheckpoint(root: string, family: XydcVariantFamily, window: XydcOrderWindow, child: XydcOrderChild, observedAt = new Date()) {
  const parsed = XydcOrderChildSchema.parse(child);
  if (!completeXydcChild(parsed, window)) throw new Error("Incomplete checkpoint");
  const bound = identity(family, window, child.asin);
  await writeXydcOrderJson(checkpointPath(root, family, window, child.asin), { version: 1, identity: bound, child: parsed }, undefined,
    previous => {
      const old = previous as { version?: number; identity?: unknown; child?: unknown };
      const prior = XydcOrderChildSchema.safeParse(old?.child);
      return old?.version === 1 && JSON.stringify(old.identity) === JSON.stringify(bound) && prior.success
        && completeXydcChild(prior.data, window) && Date.parse(prior.data.fetchedAt) <= observedAt.getTime()
        && Date.parse(prior.data.fetchedAt) > Date.parse(parsed.fetchedAt);
    });
}
