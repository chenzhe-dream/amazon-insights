import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { asinsNeedingXydcRepair, readXydcRepairStatuses } from "../../scripts/lib/xydc-repair-readiness";
import { writeXydcVariantFamily } from "../../scripts/lib/xydc-variant-cache";
import { writeXydcOrderSnapshot } from "../../scripts/lib/xydc-order-cache";
import { getXydcOrderWindow } from "../../shared/xydc-order-summary";
import type { XydcVariantFamily } from "../../shared/xydc-variant-contract";

test("Xiyou repair reuses complete current zero orders and selects missing or partial families", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xydc-repair-"));
  const now = new Date("2026-09-10T10:00:00Z");
  const window = getXydcOrderWindow(now);
  const asin = "B000000001";
  const family: XydcVariantFamily = {
    inputAsin: asin, parentAsin: asin, country: "US", dimensions: [],
    children: [{ asin, attributes: [], title: null, imageUrl: null, price: null, currency: null,
      stars: null, productPageRatings: null, listingDate: null, infoStatus: "ready" }],
    sourceUpdatedAt: null, fetchedAt: now.toISOString(), status: "ready", reasonCode: null, cacheState: "fresh",
  };
  try {
    await writeXydcVariantFamily(root, "US", family);
    assert.deepEqual(await asinsNeedingXydcRepair([asin], "US", { dataRoot: root, now }), [asin]);
    for (const [reasonCode, expected] of [["TIMEOUT", "timeout"], ["RPC_ERROR", "connector-failed"], ["NOT_FOUND", "upstream-empty"]] as const) {
      await writeXydcOrderSnapshot(root, family, {
        version: 1, source: "xydc", aggregation: "children", country: "US", parentAsin: asin,
        childAsins: [asin], window, children: [{ asin, trends: [], fetchedAt: now.toISOString(), reasonCode }],
        sourceUpdatedAt: null, fetchedAt: now.toISOString(), cacheState: "fresh", reasonCode: "PARTIAL_DATA",
      });
      assert.deepEqual(await readXydcRepairStatuses([asin], "US", { dataRoot: root, now }), [{ asin, status: expected }]);
    }
    await writeXydcOrderSnapshot(root, family, {
      version: 1, source: "xydc", aggregation: "children", country: "US", parentAsin: asin,
      childAsins: [asin], window, children: [{ asin, trends: window.months.map(date => ({ date, orders: 0 })),
        fetchedAt: now.toISOString(), reasonCode: null }], sourceUpdatedAt: null,
      fetchedAt: now.toISOString(), cacheState: "fresh", reasonCode: null,
    });
    assert.deepEqual(await asinsNeedingXydcRepair([asin, "B000000002"], "US", { dataRoot: root, now }), ["B000000002"]);
    assert.deepEqual(await asinsNeedingXydcRepair([asin], "US", { dataRoot: root, now: new Date("2026-10-10T10:00:00Z") }), [asin]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Xiyou readiness uses the CLI default data root and preserves unavailable causes", async () => {
  const codeRoot = await mkdtemp(path.join(os.tmpdir(), "xydc-repair-default-"));
  const now = new Date("2026-09-10T10:00:00Z");
  const asins = ["B000000001", "B000000002", "B000000003"];
  try {
    for (const [index, reasonCode] of (["TIMEOUT", "RPC_ERROR", "NOT_FOUND"] as const).entries()) {
      await writeXydcVariantFamily(path.join(codeRoot, "data"), "US", { inputAsin: asins[index]!, parentAsin: asins[index]!, country: "US", dimensions: [], children: [], sourceUpdatedAt: null, fetchedAt: now.toISOString(), status: "unavailable", reasonCode, cacheState: "fresh" });
    }
    assert.deepEqual(await asinsNeedingXydcRepair(asins, "US", { codeRoot, env: {}, now }), asins);
    assert.deepEqual(await readXydcRepairStatuses(asins, "US", { codeRoot, env: {}, now }), [
      { asin: asins[0], status: "timeout" }, { asin: asins[1], status: "connector-failed" }, { asin: asins[2], status: "upstream-empty" },
    ]);
  } finally { await rm(codeRoot, { recursive: true, force: true }); }
});
