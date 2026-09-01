import assert from "node:assert/strict";
import test from "node:test";

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

test("keeps unproven and SellerSprite-only fields unavailable", () => {
  const entry = buildCatalogEntryFromSorftime({
    asin,
    marketplace: "US",
    detail: {
      asin,
      title: "Fixture product",
      brand: "must-not-project",
      price: 29.99,
      star_rating: 4.5,
      review_count: 120,
      parent_asin: "B0PARENT01",
      online_date: "2026-01-02",
      a_plus: true,
      unrelated_vendor_field: { secret: "must-not-persist" },
    },
  });

  assert.equal(entry.brand, "品牌暂缺（Sorftime 未验证）");
  assert.equal(entry.price, null);
  assert.equal(entry.rating, null);
  assert.equal(entry.reviews, null);
  assert.equal(entry.launch, "—");
  assert.equal(entry.variants, "—");
  assert.equal(entry.buyBoxSeller, "暂缺（SellerSprite）");
  assert.equal(entry.packageWeight, "—");
  assert.equal(JSON.stringify(entry).includes("must-not-project"), false);
  assert.equal(JSON.stringify(entry).includes("must-not-persist"), false);
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
