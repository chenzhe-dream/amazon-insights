import assert from "node:assert/strict";
import test from "node:test";

import { syncCatalogAsinsFromSorftime } from "../../scripts/build-catalog-from-sorftime.mjs";
import { buildScopedSorftimeModuleResult } from "../../scripts/lib/scoped-sorftime-fallbacks.mjs";

test("same-job catalog evidence supplies five truthful module fallbacks with normal-result precedence", async () => {
  const asin = "B086ZLGLV3";
  const jobId = "p1-six-asin-job";
  const retained = [];
  const calls = [];
  const normalListing = { status: "ready", source: "SellerSprite", marker: "normal-wins" };

  await syncCatalogAsinsFromSorftime({
    asins: [asin],
    marketplace: "US",
    key: "fixture-key",
    jobId,
    retainFallbackModules: true,
    appendEntry: () => true,
    writeEvidence: evidence => retained.push(evidence),
    callTool: async (_key, toolName) => {
      calls.push(toolName);
      if (toolName === "product_detail") return { data: {
        asin,
        title: "Fixture product",
        main_image: ["https://img.test/main.jpg", "https://img.test/aux.jpg"],
        a_plus: true,
        fba_fee: 4.2,
        package_size_cm: "10 x 8 x 2",
        price: 29.99,
        coupon: 10,
        node_id: "12345",
        subcategory: "Power Banks (Rank: 12)",
        top_category: "Electronics (Rank: 2)",
      } };
      if (toolName === "category_trend") return { data: ["2026-07=1200", "2026-08=1300"] };
      if (toolName === "product_variations") return { data: [
        { Asin: "B086ZLGLA1", Property: "Color: Black", SalesAmount: 80, ItemTotal: 2 },
        { Asin: "B086ZLGLB2", Property: "Color: White", SalesAmount: 40, ItemTotal: 2 },
      ] };
      throw new Error(`unexpected ${toolName}`);
    },
  });

  assert.deepEqual(calls, ["product_detail", "category_trend", "product_variations"]);
  const evidenceByOperation = Object.fromEntries(retained.map(item => [item.operation, item]));
  assert.deepEqual(Object.keys(evidenceByOperation).sort(), [
    "category_trend_sales_count",
    "product_detail",
    "product_variations",
  ]);

  const fba = buildScopedSorftimeModuleResult({ module: "fba", evidenceByOperation });
  const listing = buildScopedSorftimeModuleResult({ module: "listing", evidenceByOperation });
  const price = buildScopedSorftimeModuleResult({ module: "price_strategy", evidenceByOperation });
  const category = buildScopedSorftimeModuleResult({ module: "category", evidenceByOperation });
  const childSales = buildScopedSorftimeModuleResult({ module: "child_sales", evidenceByOperation });

  assert.equal(fba.status, "ready");
  assert.equal(fba.fbaFee, 4.2);
  assert.deepEqual(listing.galleryImages, ["https://img.test/main.jpg", "https://img.test/aux.jpg"]);
  assert.equal(price.status, "ready");
  assert.equal(price.currentPrice, 29.99);
  assert.equal(category.status, "ready");
  assert.equal(category.volume.length, 2);
  assert.equal(childSales.status, "ready");
  assert.deepEqual(childSales.rows.map(row => row.sales), [80, 40]);
  for (const result of [fba, listing, price, category, childSales]) {
    assert.equal(result.source, "Sorftime");
    assert.equal(result.asin, asin);
    assert.equal(result.marketplace, "US");
    assert.equal(result.provenance.jobId, jobId);
    assert.ok(result.fetchedAt);
  }

  assert.equal(buildScopedSorftimeModuleResult({
    module: "listing",
    normalResult: normalListing,
    evidenceByOperation,
  }), normalListing);
});

test("verified-empty variations differ from missing or mismatched evidence", () => {
  const base = {
    schemaVersion: 1,
    jobId: "job-one",
    marketplace: "US",
    asin: "B086ZLGLV3",
    fetchedAt: "2026-09-01T08:00:00.000Z",
    source: "Sorftime",
    provenance: { connector: "sorftime", tool: "product_variations", stageId: "catalog" },
  };
  const empty = buildScopedSorftimeModuleResult({
    module: "child_sales",
    evidenceByOperation: {
      product_variations: {
        ...base,
        operation: "product_variations",
        data: { rows: [], verifiedComplete: true },
      },
    },
  });
  assert.equal(empty.status, "empty");
  assert.equal(empty.verifiedEmpty, true);
  assert.equal(buildScopedSorftimeModuleResult({ module: "child_sales", evidenceByOperation: {} }), null);
  assert.equal(buildScopedSorftimeModuleResult({
    module: "child_sales",
    evidenceByOperation: {
      product_variations: {
        ...base,
        jobId: "another-job",
        operation: "product_variations",
        data: { rows: [], verifiedComplete: true },
      },
    },
    expectedScope: { jobId: "job-one", marketplace: "US", asin: "B086ZLGLV3" },
  }), null);
});
