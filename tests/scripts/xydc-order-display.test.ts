import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readXydcOrderDisplaySnapshot } from "../../scripts/lib/xydc-order-display-cache";
import { isFreshXydcOrderCache as collectorIsFresh, xydcOrderCachePath } from "../../scripts/lib/xydc-order-cache";
import { selectXydcOrderDisplaySnapshot } from "../../shared/xydc-order-display";
import { isFreshXydcOrderCache as sharedIsFresh } from "../../shared/xydc-order-freshness";
import type { XydcOrderSnapshot, XydcOrderWindow } from "../../shared/xydc-order-contract";
import { getXydcOrderWindow } from "../../shared/xydc-order-summary";
import type { XydcVariantFamily } from "../../shared/xydc-variant-contract";

const now = new Date("2026-10-09T12:00:00.000Z");
const requested = getXydcOrderWindow(now);
const family: XydcVariantFamily = {
  inputAsin: "B000000001", country: "US", parentAsin: "B000000010", dimensions: [],
  children: [{
    asin: "B000000001", attributes: [], title: null, imageUrl: null, price: null,
    currency: null, stars: null, productPageRatings: null, listingDate: null, infoStatus: "pending",
  }],
  sourceUpdatedAt: null, fetchedAt: "2026-09-08T07:00:00.000Z", status: "partial",
  reasonCode: "PARTIAL_CHILD_INFO", cacheState: "stale",
};

function snapshot(window: XydcOrderWindow, fetchedAt = "2026-09-08T07:00:00.000Z"): XydcOrderSnapshot {
  return {
    version: 1, source: "xydc", aggregation: "children", country: "US", parentAsin: family.parentAsin,
    childAsins: ["B000000001"], window,
    children: [{
      asin: "B000000001", trends: window.months.map(date => ({ date, orders: 10 })),
      fetchedAt, reasonCode: null,
    }],
    sourceUpdatedAt: null, fetchedAt, cacheState: "fresh", reasonCode: null,
  };
}

const prior = snapshot(getXydcOrderWindow(new Date("2026-09-08T12:00:00.000Z")));

test("returns a prior complete annual snapshot as stale without rewriting provenance", () => {
  const selected = selectXydcOrderDisplaySnapshot([prior], family, requested, now);
  assert.equal(selected?.window.endMonth, "2026-08");
  assert.equal(selected?.fetchedAt, prior.fetchedAt);
  assert.equal(selected?.sourceUpdatedAt, prior.sourceUpdatedAt);
  assert.equal(selected?.cacheState, "stale");
});

test("prefers a complete current window and falls back past an incomplete current candidate", () => {
  const current = snapshot(requested, "2026-10-09T11:00:00.000Z");
  assert.equal(selectXydcOrderDisplaySnapshot([prior, current], family, requested, now)?.window.endMonth, "2026-09");
  assert.equal(selectXydcOrderDisplaySnapshot([{ ...current, children: [] }, prior], family, requested, now)?.window.endMonth, "2026-08");
});

test("uses a current partial snapshot only when no complete history exists", () => {
  const current = { ...snapshot(requested), children: [] };
  const selected = selectXydcOrderDisplaySnapshot([current], family, requested, now);
  assert.equal(selected?.window.endMonth, requested.endMonth);
  assert.equal(selected?.cacheState, "stale");
});

test("treats a complete all-zero snapshot as complete display data", () => {
  const zero = snapshot(requested, "2026-10-09T11:00:00.000Z");
  zero.children[0] = { ...zero.children[0]!, trends: requested.months.map(date => ({ date, orders: 0 })) };
  assert.equal(selectXydcOrderDisplaySnapshot([zero, prior], family, requested, now)?.window.endMonth, requested.endMonth);
});

test("rejects mismatched identity, child sets, duplicate children, future windows, and malformed payloads", () => {
  const futureWindow = getXydcOrderWindow(new Date("2026-11-09T12:00:00.000Z"));
  assert.equal(selectXydcOrderDisplaySnapshot([{ ...prior, country: "DE" }], family, requested, now), null);
  assert.equal(selectXydcOrderDisplaySnapshot([{ ...prior, childAsins: ["B000000002"] }], family, requested, now), null);
  assert.equal(selectXydcOrderDisplaySnapshot([{ ...prior, childAsins: ["B000000001", "B000000001"] }], family, requested, now), null);
  assert.equal(selectXydcOrderDisplaySnapshot([snapshot(futureWindow)], family, requested, now), null);
  assert.equal(selectXydcOrderDisplaySnapshot([{ version: 1 }], family, requested, now), null);
});

test("rejects future snapshot, child, and source timestamps", () => {
  const future = "2099-01-01T00:00:00.000Z";
  assert.equal(selectXydcOrderDisplaySnapshot([{ ...prior, fetchedAt: future }], family, requested, now), null);
  assert.equal(selectXydcOrderDisplaySnapshot([{ ...prior, children: [{ ...prior.children[0]!, fetchedAt: future }] }], family, requested, now), null);
  assert.equal(selectXydcOrderDisplaySnapshot([{ ...prior, sourceUpdatedAt: future }], family, requested, now), null);
});

test("uses a stable content tie-breaker and never mutates candidates", () => {
  const first = snapshot(prior.window);
  const second = snapshot(prior.window);
  first.children[0]!.trends[0] = { date: prior.window.months[0]!, orders: 11 };
  second.children[0]!.trends[0] = { date: prior.window.months[0]!, orders: 22 };
  const candidates = [first, second] as const;
  const before = structuredClone(candidates);
  const forward = selectXydcOrderDisplaySnapshot(candidates, family, requested, now);
  const reverse = selectXydcOrderDisplaySnapshot([...candidates].reverse(), family, requested, now);
  assert.deepEqual(forward, reverse);
  assert.deepEqual(candidates, before);
  assert.equal(first.cacheState, "fresh");
  assert.equal(second.cacheState, "fresh");
});

test("discovers only canonical family files and tolerates malformed optional candidates", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "xydc-order-display-"));
  const current = snapshot(requested, "2026-10-09T11:00:00.000Z");
  const oldPath = xydcOrderCachePath(dataRoot, family, prior.window);
  const currentPath = xydcOrderCachePath(dataRoot, family, current.window);
  try {
    await mkdir(path.dirname(oldPath), { recursive: true });
    await writeFile(oldPath, JSON.stringify(prior));
    await writeFile(path.join(path.dirname(oldPath), `copy-${path.basename(currentPath)}`), JSON.stringify(current));
    await writeFile(currentPath, "{malformed");
    assert.equal(readXydcOrderDisplaySnapshot(dataRoot, family, requested, now)?.window.endMonth, prior.window.endMonth);

    await writeFile(currentPath, JSON.stringify({ ...current, country: "DE" }));
    assert.equal(readXydcOrderDisplaySnapshot(dataRoot, family, requested, now)?.window.endMonth, prior.window.endMonth);

    await writeFile(currentPath, JSON.stringify(current));
    assert.equal(readXydcOrderDisplaySnapshot(dataRoot, family, requested, now)?.window.endMonth, current.window.endMonth);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("collector and display share one 24-hour freshness predicate", () => {
  const current = snapshot(requested, "2026-10-08T12:00:00.000Z");
  current.children[0] = { ...current.children[0]!, fetchedAt: current.fetchedAt };
  assert.equal(collectorIsFresh, sharedIsFresh);
  assert.equal(sharedIsFresh(current, now), true);
  assert.equal(sharedIsFresh({ ...current, fetchedAt: "2026-10-08T11:59:59.999Z" }, now), false);
  assert.equal(sharedIsFresh({ ...current, fetchedAt: "2026-10-09T12:00:00.001Z" }, now), false);
  assert.equal(sharedIsFresh({ ...current, children: [] }, now), false);
});
