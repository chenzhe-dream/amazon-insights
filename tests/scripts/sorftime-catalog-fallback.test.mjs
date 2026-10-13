import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";

import { syncCatalogAsinsFromSorftime } from "../../scripts/build-catalog-from-sorftime.mjs";
import { buildCatalogEntryFromSorftime } from "../../scripts/lib/sorftime-catalog-fallback.mjs";
import { callSorftimeTool } from "../../scripts/lib/sorftime-mcp-client.mjs";

const asin = "B0TEST0001";

test("projects only locally evidenced Sorftime product-detail fields", () => {
  const entry = buildCatalogEntryFromSorftime({
    asin,
    marketplace: "US",
    detail: {
      asin,
      title: "Magnetic Power Bank",
      main_image: JSON.stringify([
        "https://m.media-amazon.com/images/I/main.jpg",
        "https://m.media-amazon.com/images/I/secondary.jpg",
      ]),
      fba_fee: 4.2,
      package_size_cm: "10 x 8 x 2",
      node_id: "123",
      subcategory: "Power Banks (Rank: 12)",
      top_category: "Electronics (Rank: 2)",
    },
  });

  assert.equal(entry.catalogSource, "sorftime-fallback");
  assert.equal(entry.synced, false);
  assert.equal(entry.title, "Magnetic Power Bank");
  assert.equal(entry.brand, "品牌暂缺（Sorftime 未验证）");
  assert.equal(entry.image, "https://m.media-amazon.com/images/I/main.jpg");
  assert.equal(entry.packageSize, "10 x 8 x 2 cm");
  assert.equal(entry.rankCategory, "Electronics");
  assert.equal(entry.subRankCategory, "Power Banks");
  assert.equal(entry.buyBoxSeller, "暂缺（SellerSprite）");
  assert.equal(entry.fulfillment, "暂缺（SellerSprite）");
  assert.match(entry.specifications.join("\n"), /Sorftime FBA 费用估算：\$4\.20/);
});

test("projects verified profile fields while keeping unknown fields unavailable", () => {
  const entry = buildCatalogEntryFromSorftime({
    asin,
    marketplace: "US",
    detail: {
      asin,
      title: "Fixture product",
      brand: "Verified brand",
      price: 29.99,
      star_rating: 4.5,
      review_count: 120,
      parent_asin: "B0PARENT01",
      online_date: "2026-01-02",
      a_plus: true,
      unrelated_vendor_field: { secret: "must-not-persist" },
    },
  });

  assert.equal(entry.brand, "Verified brand");
  assert.equal(entry.price, 29.99);
  assert.equal(entry.rating, 4.5);
  assert.equal(entry.reviews, 120);
  assert.equal(entry.launch, "—");
  assert.equal(entry.variants, "—");
  assert.equal(entry.buyBoxSeller, "暂缺（SellerSprite）");
  assert.equal(entry.packageWeight, "—");
  assert.equal(entry.catalogFieldSources.brand, "sorftime");
  assert.equal(JSON.stringify(entry).includes("must-not-persist"), false);
});

const publicDetails = JSON.parse(fs.readFileSync(new URL('../fixtures/sorftime/balance-board-product-details.json', import.meta.url), 'utf8'));

test('replays current public balance-board profiles with explicit field provenance', () => {
  const entries = publicDetails.map(response => buildCatalogEntryFromSorftime({ asin: response.data.asin, marketplace: 'US', detail: response }));
  assert.equal(entries[0].packageSize, '76.2 x 30.48 x 14.61 cm');
  assert.equal(entries[0].packageWeight, '4627 g');
  assert.equal(entries[0].buyBoxSeller, 'ZUKAM Direct');
  assert.equal(entries[0].fulfillment, 'Amazon 配送（FBA）');
  assert.equal(entries[0].variants, '3个变体');
  assert.equal(entries[0].subRankCategory, 'Balance Boards');
  assert.equal(entries[0].rankCategory, 'Sports & Outdoors');
  assert.equal(entries[2].fulfillment, '卖家自配送（FBM）');
  assert.equal(entries[2].specifications.some(value => value.includes('FBA 费用估算')), false);
  assert.equal(entries[3].launch, '2026-07-13');
  assert.equal(entries[3].packageWeight, '—');
  assert.equal(entries[3].catalogFieldSources.packageWeight, undefined);
  for (const entry of entries) {
    assert.equal(entry.synced, false);
    assert.equal(entry.catalogProfileVersion, 1);
    assert.equal(entry.format, '—');
    assert.equal(entry.catalogFieldSources.format, undefined);
    assert.equal(entry.catalogFieldSources.launch, 'sorftime');
    assert.equal(entry.productDimensions, undefined);
  }
});

test('rejects malformed and cross-market profile identities and non-sentinel negatives', () => {
  for (const detail of [{ asin: false }, { asin: 'broken' }, { asin, amz_site: 'UK' }, { asin, marketplace: {} }, { asin, fba_fee: -2 }, { asin, weight_g: -2 }]) {
    assert.throws(() => buildCatalogEntryFromSorftime({ asin, marketplace: 'US', detail }), TypeError);
  }
  for (const detail of [{ isError: true }, { error: { code: 'tool-error' } }, { doc: {}, data: {} }, { code: 'MCP_TOOL_ERROR', message: 'tool failed' }]) {
    assert.throws(() => buildCatalogEntryFromSorftime({ asin, marketplace: 'US', detail }), TypeError);
  }
});

test("accepts a partial evidenced response and uses explicit unavailable values", () => {
  const entry = buildCatalogEntryFromSorftime({ asin, marketplace: "US", detail: { asin } });

  assert.equal(entry.title, asin);
  assert.equal(entry.image, "");
  assert.equal(entry.rankCategory, "类目名称暂缺");
  assert.equal(entry.subRankCategory, "类目名称暂缺");
  assert.equal(entry.fulfillment, "暂缺（SellerSprite）");
});

test("rejects ASIN mismatch and invalid evidenced field types", () => {
  assert.throws(
    () => buildCatalogEntryFromSorftime({ asin, marketplace: "US", detail: { asin: "B0OTHER001" } }),
    /ASIN/,
  );

  for (const detail of [
    null,
    [],
    { asin, title: [] },
    { asin, main_image: {} },
    { asin, fba_fee: "4.2" },
    { asin, package_size_cm: 10 },
    { asin, node_id: {} },
    { asin, subcategory: [] },
    { asin, top_category: false },
  ]) {
    assert.throws(
      () => buildCatalogEntryFromSorftime({ asin, marketplace: "US", detail }),
      /schema/,
    );
  }
});

test("dispatches at most one governed catalog product_detail request per missing ASIN", async () => {
  const asins = ["B0TEST0001", "B0TEST0002", "B0TEST0003"];
  const physicalAttempts = [];
  const appended = [];
  let pendingStubCalls = 0;
  let fetches = 0;
  const resourceGovernor = {
    async run(input) {
      physicalAttempts.push({
        attemptKind: input.attemptKind,
        stageId: input.stageId,
        logicalOperationKey: input.logicalOperationKey,
        dispatchKey: input.dispatchKey,
      });
      return await input.operation();
    },
  };
  const fetchImpl = async (_url, init) => {
    fetches += 1;
    const body = JSON.parse(String(init.body));
    const requestedAsin = body.params.arguments.asin;
    return new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { data: { asin: requestedAsin, title: `Fixture ${requestedAsin}` } },
    }));
  };
  const env = {
    NODE_ENV: "test",
    AGENT_SYNC_STAGE_ID: "catalog",
    AGENT_SYNC_JOB_ID: "catalog-fallback-governance",
    SORFTIME_MCP_ENDPOINT: "http://127.0.0.1:1/mcp",
  };

  const result = await syncCatalogAsinsFromSorftime({
    asins,
    marketplace: "US",
    key: "fixture-key",
    appendEntry: entry => appended.push(entry),
    ensurePendingStub: () => { pendingStubCalls += 1; },
    callTool: (key, toolName, args) => callSorftimeTool(key, toolName, args, {
      env,
      organizationId: "catalog-fallback-organization",
      jobId: "catalog-fallback-governance",
      resourceGovernor,
      fetchImpl,
    }),
  });

  assert.deepEqual(result, { added: asins, failed: [] });
  assert.equal(appended.length, asins.length);
  assert.equal(pendingStubCalls, 0);
  assert.equal(fetches, asins.length);
  assert.equal(physicalAttempts.length, asins.length);
  assert.equal(physicalAttempts.every(item => item.stageId === "catalog"), true);
  assert.equal(physicalAttempts.every(item => item.attemptKind === "initial"), true);
  assert.equal(new Set(physicalAttempts.map(item => item.logicalOperationKey)).size, asins.length);
  assert.equal(new Set(physicalAttempts.map(item => item.dispatchKey)).size, asins.length);
});

test("isolates a Sorftime catalog failure to its ASIN and continues the bounded batch", async () => {
  const asins = ["B0TEST0001", "B0TEST0002", "B0TEST0003"];
  const appended = [];
  let calls = 0;
  const result = await syncCatalogAsinsFromSorftime({
    asins,
    marketplace: "US",
    key: "fixture-key",
    appendEntry: entry => appended.push(entry),
    ensurePendingStub: () => {},
    callTool: async (_key, _toolName, { asin: requestedAsin }) => {
      calls += 1;
      if (requestedAsin === asins[1]) throw new Error("fixture unavailable");
      return { data: { asin: requestedAsin, title: `Fixture ${requestedAsin}` } };
    },
  });

  assert.equal(calls, asins.length);
  assert.deepEqual(result.added, [asins[0], asins[2]]);
  assert.deepEqual(result.failed, [{ asin: asins[1], reason: "fixture unavailable" }]);
  assert.deepEqual(appended.map(entry => entry.asin), [asins[0], asins[2]]);
});

test("retains every product-detail gallery under the current six-ASIN job scope", async () => {
  const asins = [
    "B086ZLGLV3",
    "B095NXXP8C",
    "B0C4DGFFCM",
    "B0CBV5DC7Y",
    "B0CDW797MM",
    "B0DJ7225F3",
  ];
  const jobId = "32695ae9-5c7b-416b-86ac-1f34db864632";
  const retained = [];

  const result = await syncCatalogAsinsFromSorftime({
    asins,
    marketplace: "US",
    key: "fixture-key",
    jobId,
    appendEntry: () => true,
    writeEvidence: evidence => retained.push(evidence),
    callTool: async (_key, _toolName, { asin }) => ({
      data: {
        asin,
        main_image: JSON.stringify([
          `https://img.test/${asin}/main.jpg`,
          `https://img.test/${asin}/aux-1.jpg`,
          `https://img.test/${asin}/aux-2.jpg`,
        ]),
        a_plus: true,
      },
    }),
  });

  assert.deepEqual(result, { added: asins, failed: [] });
  assert.equal(retained.length, asins.length);
  for (const [index, evidence] of retained.entries()) {
    const asin = asins[index];
    assert.equal(evidence.jobId, jobId);
    assert.equal(evidence.asin, asin);
    assert.equal(evidence.marketplace, "US");
    assert.equal(evidence.operation, "product_detail");
    assert.equal(evidence.source, "Sorftime");
    assert.deepEqual(evidence.data.galleryImages, [
      `https://img.test/${asin}/main.jpg`,
      `https://img.test/${asin}/aux-1.jpg`,
      `https://img.test/${asin}/aux-2.jpg`,
    ]);
  }
});
