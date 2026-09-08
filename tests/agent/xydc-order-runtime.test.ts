import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readGeneratedRuntimeAnalysisData } from "../../app/lib/runtime-analysis-data-server";
import { RuntimeAnalysisDataSnapshotSchema } from "../../app/lib/runtime-analysis-data";
import { xydcOrderCachePath } from "../../scripts/lib/xydc-order-cache";
import { getXydcOrderWindow } from "../../shared/xydc-order-summary";
import type { XydcOrderSnapshot } from "../../shared/xydc-order-contract";
import type { XydcVariantFamily } from "../../shared/xydc-variant-contract";

const now = new Date("2026-09-08T09:00:00.000Z");

function variant(inputAsin: string, parentAsin: string, children: readonly string[]): XydcVariantFamily {
  return {
    inputAsin, country: "US", parentAsin, dimensions: [],
    children: children.map(asin => ({
      asin, attributes: [], title: null, imageUrl: null, price: null, currency: null,
      stars: null, productPageRatings: null, listingDate: null, infoStatus: "pending",
    })),
    sourceUpdatedAt: null, fetchedAt: now.toISOString(), status: "partial",
    reasonCode: "PARTIAL_CHILD_INFO", cacheState: "fresh",
  };
}

function orderSnapshot(family: XydcVariantFamily, at = now): XydcOrderSnapshot {
  const window = getXydcOrderWindow(at);
  return {
    version: 1, source: "xydc", aggregation: "children", country: family.country,
    parentAsin: family.parentAsin, childAsins: family.children.map(child => child.asin), window,
    children: family.children.map(child => ({
      asin: child.asin,
      trends: window.months.map(date => ({ date, orders: 1 })),
      fetchedAt: at.toISOString(), reasonCode: null,
    })),
    sourceUpdatedAt: null, fetchedAt: at.toISOString(), cacheState: "fresh", reasonCode: null,
  };
}

test("historic runtime payloads default the independent order member", () => {
  const snapshot = RuntimeAnalysisDataSnapshotSchema.parse({
    catalog: [], keywords: { analysisByAsin: {}, enrichmentByKeyword: {} },
    reviews: { analysisByAsin: {}, ratingByAsin: {} }, salesTrend: { trendByAsin: {} },
    fba: { feeByAsin: {} }, listing: { contentByAsin: {} }, category: { trendByNode: {} },
    childSales: { rowsByAsin: {} }, priceStrategy: { strategyByAsin: {} },
    imageRemarks: { remarksByAsin: {}, outcomesByAsin: {} }, variants: { families: [] },
  });
  assert.deepEqual(snapshot.variantOrders, { families: [] });
});

test("runtime returns current and prior complete snapshots derived from authorized input variants without writing on repeated GET reads", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "xydc-order-runtime-"));
  const requested = ["B000000001", "B000000002", "B000000003"];
  const authorized = variant(requested[0]!, "B0PARENT01", ["B0CHILD001", "B0CHILD002"]);
  const oldWindow = variant(requested[1]!, "B0PARENT02", ["B0CHILD003"]);
  const unrelated = variant("B000000099", "B0PARENT99", ["B0CHILD099"]);
  const currentSnapshot = orderSnapshot(authorized);
  const staleWindowSnapshot = orderSnapshot(oldWindow, new Date("2026-08-31T23:59:59.999Z"));
  const unrelatedSnapshot = orderSnapshot(unrelated);
  const previousRoot = process.env.AGENT_DATA_ROOT;
  try {
    for (const [family, snapshot] of [
      [authorized, currentSnapshot], [oldWindow, staleWindowSnapshot], [unrelated, unrelatedSnapshot],
    ] as const) {
      const cachePath = xydcOrderCachePath(dataRoot, family, snapshot.window);
      await mkdir(path.dirname(cachePath), { recursive: true });
      await writeFile(cachePath, JSON.stringify(snapshot));
    }
    process.env.AGENT_DATA_ROOT = dataRoot;

    const countryDirectory = path.dirname(xydcOrderCachePath(dataRoot, authorized, currentSnapshot.window));
    const beforeNames = await readdir(countryDirectory);
    const beforeFiles = await Promise.all(beforeNames.map(async name => ({
      name,
      contents: await readFile(path.join(countryDirectory, name), "utf8"),
      modifiedAt: (await stat(path.join(countryDirectory, name))).mtimeMs,
    })));
    const result = readGeneratedRuntimeAnalysisData(requested, "US", {
      now,
      readVariantFamilies: () => [authorized, oldWindow],
    });
    const repeated = readGeneratedRuntimeAnalysisData(requested, "US", {
      now,
      readVariantFamilies: () => [authorized, oldWindow],
    });

    assert.deepEqual(result.variantOrders.families, [currentSnapshot, { ...staleWindowSnapshot, cacheState: "stale" }]);
    assert.deepEqual(repeated.variantOrders, result.variantOrders);
    const afterNames = await readdir(countryDirectory);
    const afterFiles = await Promise.all(afterNames.map(async name => ({
      name,
      contents: await readFile(path.join(countryDirectory, name), "utf8"),
      modifiedAt: (await stat(path.join(countryDirectory, name))).mtimeMs,
    })));
    assert.deepEqual(afterFiles, beforeFiles);
    const serialized = JSON.stringify(result.variantOrders);
    assert.equal(serialized.includes("B0PARENT99"), false);
    assert.equal(serialized.includes("xydc-orders"), false);
    assert.equal(serialized.includes("cost_credits"), false);
  } finally {
    if (previousRoot === undefined) delete process.env.AGENT_DATA_ROOT;
    else process.env.AGENT_DATA_ROOT = previousRoot;
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("runtime looks up the authorized country-parent child union without changing variant families", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "xydc-order-runtime-union-"));
  const requested = ["B000000001", "B000000002", "B000000003"];
  const first = variant(requested[0]!, "B0PARENT01", ["B0CHILD001"]);
  const second = variant(requested[1]!, "B0PARENT01", ["B0CHILD002"]);
  const union = variant(requested[0]!, "B0PARENT01", ["B0CHILD001", "B0CHILD002"]);
  const unionSnapshot = orderSnapshot(union);
  const cachePath = xydcOrderCachePath(dataRoot, union, unionSnapshot.window);
  const previousRoot = process.env.AGENT_DATA_ROOT;
  try {
    await mkdir(path.dirname(cachePath), { recursive: true });
    await writeFile(cachePath, JSON.stringify(unionSnapshot));
    process.env.AGENT_DATA_ROOT = dataRoot;

    const result = readGeneratedRuntimeAnalysisData(requested, "US", {
      now,
      readVariantFamilies: () => [first, second],
    });
    assert.deepEqual(result.variants.families, [first, second]);
    assert.deepEqual(result.variantOrders.families, [unionSnapshot]);

    const subset = readGeneratedRuntimeAnalysisData(requested, "US", {
      now,
      readVariantFamilies: () => [first],
    });
    assert.deepEqual(subset.variantOrders.families, []);
  } finally {
    if (previousRoot === undefined) delete process.env.AGENT_DATA_ROOT;
    else process.env.AGENT_DATA_ROOT = previousRoot;
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("runtime rejects current-top snapshots with future child timestamps and marks expired complete data stale", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "xydc-order-runtime-child-age-"));
  const requested = ["B000000001", "B000000002", "B000000003"];
  const authorized = variant(requested[0]!, "B0PARENT01", ["B0CHILD001"]);
  const previousRoot = process.env.AGENT_DATA_ROOT;
  try {
    process.env.AGENT_DATA_ROOT = dataRoot;
    for (const [caseName, childAt] of [
      ["expired", new Date("2026-09-07T08:59:59.999Z")],
      ["future", new Date("2026-09-08T09:00:00.001Z")],
    ] as const) {
      const snapshot = orderSnapshot(authorized);
      snapshot.children[0] = { ...snapshot.children[0]!, fetchedAt: childAt.toISOString() };
      const cachePath = xydcOrderCachePath(path.join(dataRoot, caseName), authorized, snapshot.window);
      await mkdir(path.dirname(cachePath), { recursive: true });
      await writeFile(cachePath, JSON.stringify(snapshot));
      process.env.AGENT_DATA_ROOT = path.join(dataRoot, caseName);

      const result = readGeneratedRuntimeAnalysisData(requested, "US", {
        now,
        readVariantFamilies: () => [authorized],
      });
      if (caseName === "expired") {
        assert.deepEqual(result.variantOrders.families, [{ ...snapshot, cacheState: "stale" }], caseName);
      } else {
        assert.deepEqual(result.variantOrders.families, [], caseName);
      }
    }
  } finally {
    if (previousRoot === undefined) delete process.env.AGENT_DATA_ROOT;
    else process.env.AGENT_DATA_ROOT = previousRoot;
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("missing or malformed order caches are an empty optional runtime member", () => {
  const requested = ["B000000001", "B000000002", "B000000003"];
  const snapshot = readGeneratedRuntimeAnalysisData(requested, "US", {
    now,
    readVariantFamilies: () => [variant(requested[0]!, "B0PARENT01", ["B0CHILD001"])],
    readOrderFamilies: () => [],
  });
  assert.deepEqual(snapshot.variantOrders, { families: [] });
});
