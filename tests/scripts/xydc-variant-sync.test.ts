import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

import {
  projectXydcVariationFamily,
  syncXydcVariantFamilies,
  retryFailedXydcVariantFamilies,
} from "../../scripts/build-xydc-variant-data";
import {
  createXydcVariantCache,
  readXydcVariantFamily,
  writeXydcVariantFamily,
  xydcVariantCachePath,
} from "../../scripts/lib/xydc-variant-cache";
import { readXydcOrderDisplaySnapshot } from "../../scripts/lib/xydc-order-display-cache";
import { readXydcRepairStatuses } from "../../scripts/lib/xydc-repair-readiness";
import { xydcOrderCachePath } from "../../scripts/lib/xydc-order-cache";
import { getXydcOrderWindow } from "../../shared/xydc-order-summary";
import type { XydcVariantFamily } from "../../shared/xydc-variant-contract";

const inputAsin = "B0CHILD001";
const parentAsin = "B0PARENT01";
const now = new Date("2026-09-04T08:00:00.000Z");

test("bounded recovery retries only a failed discovery and leaves ready children untouched", async () => {
  const good = cachedRelationship(inputAsin);
  const failedAsin = "B0FAILED01";
  const failed: XydcVariantFamily = { ...good, inputAsin: failedAsin, parentAsin: failedAsin,
    status: "unavailable", reasonCode: "RPC_ERROR", children: [] };
  const fixture = cacheFixture({ [inputAsin]: good, [failedAsin]: failed });
  const calls: string[] = [];
  const result = await retryFailedXydcVariantFamilies({ asins: [inputAsin, failedAsin], country: "US", token: "fixture", now,
    cache: fixture.cache, callTool: async ({ args }) => { calls.push(String(args.asin)); throw new Error("RPC_ERROR"); },
  }, [good, failed]);
  assert.deepEqual(calls, [failedAsin]);
  assert.deepEqual(fixture.records[inputAsin], good);
  assert.ok(result.some(family => family.status === "unavailable"));
});

test("info transport failures retain their reason in real cache and bounded recovery clears it", async () => {
  for (const [reason, expected] of [["TIMEOUT", "timeout"], ["RPC_ERROR", "connector-failed"]] as const) {
    const root = await mkdtemp(path.join(os.tmpdir(), "xydc-info-failure-"));
    try {
      const cache = createXydcVariantCache(root);
      const input = { asins: [inputAsin], country: "US", token: "fixture", now, cache };
      const failed = await syncXydcVariantFamilies({ ...input, callTool: async ({ toolName }) => {
        if (toolName === "get_asin_variations") return variationResponse();
        throw new Error(reason);
      } });
      assert.equal(failed[0]?.reasonCode, reason);
      assert.equal((await readXydcVariantFamily(root, "US", inputAsin))?.reasonCode, reason);
      assert.deepEqual(await readXydcRepairStatuses([inputAsin], "US", { dataRoot: root, now }), [{ asin: inputAsin, status: expected }]);
      const calls: string[] = [];
      const recovered = await retryFailedXydcVariantFamilies({ ...input, callTool: async ({ toolName, args }) => {
        calls.push(toolName);
        return infoResponse(args.asins as string[]);
      } }, failed);
      assert.deepEqual(calls, ["get_asin_info"]);
      assert.equal(recovered[0]?.status, "ready");
      assert.equal(recovered[0]?.reasonCode, null);
      assert.equal((await readXydcVariantFamily(root, "US", inputAsin))?.reasonCode, null);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test("cancellation during the final variation request is propagated without writing failure cache", async () => {
  const fixture = cacheFixture();
  const controller = new AbortController();
  await assert.rejects(() => syncXydcVariantFamilies({ asins: [inputAsin], country: "US", token: "fixture", now,
    cache: fixture.cache, signal: controller.signal,
    callTool: async () => { controller.abort(new Error("cancelled")); throw controller.signal.reason; },
  }), /cancelled/);
  assert.equal(fixture.writes.length, 0);
});

test("discovered parents are checkpointed before a later request exhausts recovery", async () => {
  const fixture = cacheFixture();
  const controller = new AbortController();
  await assert.rejects(() => syncXydcVariantFamilies({ asins: [inputAsin, "B0FAILED01"], country: "US", token: "fixture", now,
    cache: fixture.cache, signal: controller.signal, callTool: async ({ args }) => {
      if (args.asin === inputAsin) return variationResponse();
      controller.abort(new Error("budget exhausted")); throw controller.signal.reason;
    },
  }), /budget exhausted/);
  assert.equal(fixture.records[inputAsin]?.children.length, 2);
  assert.equal(fixture.records["B0FAILED01"], undefined);
});

test("forced discovery cannot replace ready cache before details or a later parent cancels", async () => {
  for (const laterParent of [false, true]) {
    const prior = cachedRelationship(inputAsin);
    const fixture = cacheFixture({ [inputAsin]: prior });
    const controller = new AbortController();
    await assert.rejects(() => syncXydcVariantFamilies({ asins: laterParent ? [inputAsin, "B0FAILED01"] : [inputAsin],
      country: "US", token: "fixture", now, force: true, cache: fixture.cache, signal: controller.signal,
      callTool: async ({ toolName, args }) => {
        if (toolName === "get_asin_variations" && args.asin === inputAsin) return variationResponse();
        controller.abort(new Error("cancelled")); throw controller.signal.reason;
      },
    }), /cancelled/);
    assert.deepEqual(fixture.records[inputAsin], prior);
  }
});

test("variant collection stops before a paid call when its job lifetime is cancelled", async () => {
  const controller = new AbortController();
  controller.abort(new Error("fixture cancelled"));
  let calls = 0;
  const input = { asins: [inputAsin], country: "US", token: "fixture", now, signal: controller.signal,
    cache: { readMany: async () => ({}), write: async () => {} },
    callTool: async () => { calls += 1; throw new Error("fixture"); } };
  await syncXydcVariantFamilies(input).catch(() => {});
  assert.equal(calls, 0);
});

function variationResponse(children = [
  { asin: "B0CHILD001", attributes: [{ dimension: "Color", value: "Red" }] },
  { asin: "B0CHILD002", attributes: [{ dimension: "Color", value: "Blue" }] },
]) {
  return {
    parentAsin,
    dimensions: ["Color", "Color"],
    children: [...children, children[0]],
    sourceUpdatedAt: "2026-09-04T07:00:00.000Z",
    providerBody: { mustNotEscape: true },
  };
}

function infoResponse(asins: readonly string[]) {
  return asins.map(asin => ({
    asin,
    title: `Title ${asin}`,
    imageUrl: "https://images.example.test/product.jpg",
    price: "12.50",
    currency: "USD",
    stars: "4.5",
    productPageRatings: "42",
    providerBody: { mustNotEscape: true },
  }));
}

function realVariationResponse() {
  return {
    status: 200,
    cost_credits: 1,
    data: {
      asin: parentAsin,
      country: "US",
      parentAsin,
      childAsins: [inputAsin, "B0CHILD002"],
      lastUpdatedTime: "2026-09-04T07:00:00.000Z",
      variationDimensions: [
        { dimension: "Color", options: ["Red", "Blue"] },
        { dimension: "Size", options: ["Small"] },
      ],
      variationDistribution: [
        { asin: inputAsin, attributes: [{ dimension: "Color", value: "Red" }, { dimension: "Size", value: "Small" }] },
        { asin: "B0CHILD002", attributes: [{ dimension: "Color", value: "Blue" }, { dimension: "Size", value: "Small" }] },
      ],
    },
  };
}

function realInfoResponse() {
  return {
    status: 200,
    cost_credits: 1,
    data: {
      entities: [
        {
          asin: inputAsin,
          title: "First real child",
          bigPicUrl: "https://images.example.test/big.jpg",
          smallPicUrl: "https://images.example.test/small.jpg",
          price: "12.50",
          currency: "USD",
          ratings: "42",
          stars: "4.5",
          amazonUrl: "https://www.amazon.com/dp/B0CHILD001",
          country: "US",
        },
        {
          asin: "B0CHILD002",
          title: "Second real child",
          bigPicUrl: null,
          smallPicUrl: "https://images.example.test/second-small.jpg",
          price: "9.99",
          currency: "USD",
          ratings: "7",
          stars: "4",
          amazonUrl: "https://www.amazon.com/dp/B0CHILD002",
          country: "US",
        },
      ],
    },
  };
}

function cacheFixture(initial: Record<string, XydcVariantFamily> = {}) {
  const records: Record<string, XydcVariantFamily> = { ...initial };
  const writes: XydcVariantFamily[] = [];
  return {
    records,
    writes,
    cache: {
      async readMany(_country: string, asins: readonly string[]) {
        const found: Array<[string, XydcVariantFamily]> = [];
        for (const asin of asins) if (records[asin]) found.push([asin, records[asin]]);
        return Object.fromEntries(found);
      },
      async write(_country: string, family: XydcVariantFamily) {
        writes.push(family);
        records[family.inputAsin] = family;
      },
    },
  };
}

function cachedRelationship(
  asin: string,
  status: "ready" | "partial" = "ready",
  fetchedAt = "2026-09-03T08:00:00.000Z",
) {
  const family = projectXydcVariationFamily({
    inputAsin: asin,
    country: "US",
    raw: variationResponse(),
    fetchedAt,
  });
  family.status = status;
  family.reasonCode = status === "ready" ? null : "PARTIAL_CHILD_INFO";
  family.children = family.children.map(child => ({
    ...child,
    title: status === "ready" ? "Preserved child" : null,
    imageUrl: status === "ready" ? "https://images.example.test/preserved.jpg" : null,
    price: status === "ready" ? 12.5 : null,
    currency: status === "ready" ? "USD" : null,
    stars: status === "ready" ? 4.5 : null,
    productPageRatings: status === "ready" ? 42 : null,
    infoStatus: status === "ready" ? "ready" : "pending",
  }));
  return family;
}

test("missing token preserves ready and partial relationship evidence regardless of force", async () => {
  for (const [token, force, status] of [
    ["", false, "ready"],
    ["   ", true, "ready"],
    ["", true, "partial"],
    ["\t", false, "partial"],
  ] as const) {
    const prior = cachedRelationship(inputAsin, status);
    const before = structuredClone(prior);
    const fixture = cacheFixture({ [inputAsin]: prior });
    let toolCalls = 0;
    const result = await syncXydcVariantFamilies({
      asins: [inputAsin], country: " us ", token, force, now, cache: fixture.cache,
      callTool: async () => { toolCalls += 1; throw new Error("unexpected provider call"); },
    });
    assert.deepEqual(result, [{ ...before, cacheState: "stale" }]);
    assert.deepEqual(fixture.records[inputAsin], before);
    assert.deepEqual(fixture.writes, []);
    assert.equal(toolCalls, 0);
  }
});

test("missing token preserves eligible cache hits while persisting unavailable misses", async () => {
  const miss = "B0MISSING1";
  const prior = cachedRelationship(inputAsin, "ready");
  const fixture = cacheFixture({ [inputAsin]: prior });
  const result = await syncXydcVariantFamilies({
    asins: [inputAsin, miss], country: "US", token: " ", force: true, now, cache: fixture.cache,
    callTool: async () => { throw new Error("unexpected provider call"); },
  });
  assert.equal(result.find(family => family.inputAsin === inputAsin)?.cacheState, "stale");
  assert.equal(result.find(family => family.inputAsin === miss)?.reasonCode, "NOT_CONFIGURED");
  assert.deepEqual(fixture.records[inputAsin], prior);
  assert.deepEqual(fixture.writes.map(family => family.inputAsin), [miss]);
});

test("missing token does not reuse invalid or unsafe cached relationship candidates", async () => {
  const cases: Array<[string, XydcVariantFamily]> = [
    ["country", { ...cachedRelationship(inputAsin), country: "DE" }],
    ["input", { ...cachedRelationship(inputAsin), inputAsin: "B0OTHER001" }],
    ["status", { ...cachedRelationship(inputAsin), status: "unavailable", reasonCode: "NOT_FOUND" }],
    ["future", cachedRelationship(inputAsin, "ready", "2099-01-01T00:00:00.000Z")],
    ["no relationship", { ...cachedRelationship(inputAsin), children: [] }],
  ];
  for (const [, candidate] of cases) {
    const fixture = cacheFixture({ [inputAsin]: candidate });
    const result = await syncXydcVariantFamilies({
      asins: [inputAsin], country: "US", token: "", now, cache: fixture.cache,
      callTool: async () => { throw new Error("unexpected provider call"); },
    });
    assert.equal(result[0]?.reasonCode, "NOT_CONFIGURED");
    assert.equal(fixture.writes.length, 1);
  }
});

test("missing credential keeps variant cache bytes and annual order display readable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xydc-missing-token-"));
  const prior = cachedRelationship(inputAsin, "ready");
  const cache = createXydcVariantCache(root);
  const orderWindow = getXydcOrderWindow(now);
  const variantPath = xydcVariantCachePath(root, "US", inputAsin);
  const orderPath = xydcOrderCachePath(root, prior, orderWindow);
  try {
    await cache.write("US", prior);
    await mkdir(path.dirname(orderPath), { recursive: true });
    await writeFile(orderPath, JSON.stringify({
      version: 1, source: "xydc", aggregation: "children", country: "US", parentAsin: prior.parentAsin,
      childAsins: prior.children.map(child => child.asin), window: orderWindow,
      children: prior.children.map(child => ({
        asin: child.asin, trends: orderWindow.months.map(date => ({ date, orders: 10 })),
        fetchedAt: prior.fetchedAt, reasonCode: null,
      })),
      sourceUpdatedAt: prior.sourceUpdatedAt, fetchedAt: prior.fetchedAt, cacheState: "fresh", reasonCode: null,
    }));
    const before = await readFile(variantPath);
    const [preserved] = await syncXydcVariantFamilies({
      asins: [inputAsin], country: "US", token: "", force: true, now, cache,
      callTool: async () => { throw new Error("unexpected provider call"); },
    });
    assert.equal(readXydcOrderDisplaySnapshot(root, preserved, orderWindow, now)?.children[0]?.trends.length, 12);
    assert.deepEqual(await readFile(variantPath), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("projects the real XiYou variation and info contracts without materializing unlisted children", async () => {
  const rawVariations = realVariationResponse();
  const family = await syncXydcVariantFamilies({
    asins: [inputAsin], country: "US", token: "fixture-token", now, cache: cacheFixture().cache,
    callTool: async ({ toolName }) => toolName === "get_asin_variations" ? rawVariations : realInfoResponse(),
  });
  assert.equal(family[0].status, "ready");
  assert.equal(family[0].parentAsin, parentAsin);
  assert.equal(family[0].sourceUpdatedAt, rawVariations.data.lastUpdatedTime);
  assert.deepEqual(family[0].dimensions, ["Color", "Size"]);
  assert.deepEqual(family[0].children.map(child => child.asin), rawVariations.data.childAsins);
  assert.deepEqual(family[0].children[0].attributes, rawVariations.data.variationDistribution[0].attributes);
  assert.equal(family[0].children[0].imageUrl, "https://images.example.test/big.jpg");
  assert.equal(family[0].children[1].imageUrl, "https://images.example.test/second-small.jpg");
  assert.equal(family[0].children[0].productPageRatings, 42);
  assert.equal(family[0].children[1].productPageRatings, 7);
  assert.equal(JSON.stringify(family).includes("cost_credits"), false);
  assert.equal(JSON.stringify(family).includes("amazonUrl"), false);

  const unlistedDistribution = structuredClone(rawVariations);
  unlistedDistribution.data.variationDistribution.push({ asin: "B0EXTRA001", attributes: [] });
  assert.throws(
    () => projectXydcVariationFamily({ inputAsin, country: "US", raw: unlistedDistribution, fetchedAt: now.toISOString() }),
    /SCHEMA_INVALID/,
  );
  const failedStatus = structuredClone(rawVariations);
  failedStatus.status = 500;
  assert.throws(
    () => projectXydcVariationFamily({ inputAsin, country: "US", raw: failedStatus, fetchedAt: now.toISOString() }),
    /SCHEMA_INVALID/,
  );

  const missingStatus = { data: structuredClone(rawVariations.data) };
  assert.throws(
    () => projectXydcVariationFamily({ inputAsin, country: "US", raw: missingStatus, fetchedAt: now.toISOString() }),
    /SCHEMA_INVALID/,
  );

  const mismatchedAsin = structuredClone(rawVariations);
  mismatchedAsin.data.asin = "B0OTHER001";
  assert.throws(
    () => projectXydcVariationFamily({ inputAsin, country: "US", raw: mismatchedAsin, fetchedAt: now.toISOString() }),
    /SCHEMA_INVALID/,
  );

  const unrelatedFamily = structuredClone(rawVariations);
  unrelatedFamily.data.childAsins = ["B0CHILD002"];
  unrelatedFamily.data.variationDistribution = unrelatedFamily.data.variationDistribution.filter(
    child => child.asin === "B0CHILD002",
  );
  assert.throws(
    () => projectXydcVariationFamily({ inputAsin, country: "US", raw: unrelatedFamily, fetchedAt: now.toISOString() }),
    /SCHEMA_INVALID/,
  );

  const mismatchedCountry = structuredClone(rawVariations);
  mismatchedCountry.data.country = "CA";
  assert.throws(
    () => projectXydcVariationFamily({ inputAsin, country: "US", raw: mismatchedCountry, fetchedAt: now.toISOString() }),
    /SCHEMA_INVALID/,
  );
});

test("rejects a non-success real XiYou info payload without retaining its body", async () => {
  const failedInfo = realInfoResponse();
  failedInfo.status = 500;
  const family = await syncXydcVariantFamilies({
    asins: [inputAsin], country: "US", token: "fixture-token", now, cache: cacheFixture().cache,
    callTool: async ({ toolName }) => toolName === "get_asin_variations" ? realVariationResponse() : failedInfo,
  });
  assert.equal(family[0].status, "partial");
  assert.equal(family[0].reasonCode, "SCHEMA_INVALID");
  assert.equal(JSON.stringify(family).includes("cost_credits"), false);
});

test("rejects real XiYou info rows whose country differs from the request", async () => {
  const wrongCountry = realInfoResponse();
  wrongCountry.data.entities[0].country = "CA";
  const family = await syncXydcVariantFamilies({
    asins: [inputAsin], country: "US", token: "fixture-token", now, cache: cacheFixture().cache,
    callTool: async ({ toolName }) => toolName === "get_asin_variations" ? realVariationResponse() : wrongCountry,
  });
  assert.equal(family[0].status, "partial");
  assert.equal(family[0].reasonCode, "SCHEMA_INVALID");
  assert.equal(family[0].children[0].title, null);
});

test("normalizes blank optional fields from a real XiYou info row without discarding ready siblings", async () => {
  const partiallyMissing = realInfoResponse();
  Object.assign(partiallyMissing.data.entities[1] as Record<string, unknown>, {
    title: "",
    bigPicUrl: "",
    smallPicUrl: "",
    price: "",
    currency: "",
    stars: "",
    ratings: "",
  });
  const family = await syncXydcVariantFamilies({
    asins: [inputAsin], country: "US", token: "fixture-token", now, cache: cacheFixture().cache,
    callTool: async ({ toolName }) => toolName === "get_asin_variations" ? realVariationResponse() : partiallyMissing,
  });
  assert.equal(family[0].status, "partial");
  assert.equal(family[0].reasonCode, "PARTIAL_CHILD_INFO");
  assert.equal(family[0].children[0].infoStatus, "ready");
  assert.equal(family[0].children[1].infoStatus, "unavailable");
  assert.equal(family[0].children[1].title, null);
  assert.equal(family[0].children[1].imageUrl, null);
  assert.equal(family[0].children[1].productPageRatings, null);
});

test("projects a child input into its real parent with deduplicated children and provider-safe fields", () => {
  const family = projectXydcVariationFamily({
    inputAsin,
    country: "us",
    raw: variationResponse(),
    fetchedAt: now.toISOString(),
  });

  assert.equal(family.parentAsin, parentAsin);
  assert.deepEqual(family.dimensions, ["Color"]);
  assert.deepEqual(family.children.map(child => child.asin), ["B0CHILD001", "B0CHILD002"]);
  assert.equal(family.children[0].listingDate, null);
  assert.equal("providerBody" in family, false);
  assert.equal("providerBody" in family.children[0], false);
});

test("hydrates globally deduplicated children in batches and checkpoints a partial family for resume", async () => {
  const children = Array.from({ length: 21 }, (_, index) => ({
    asin: `B0CHILD${String(index).padStart(3, "0")}`,
    attributes: [{ dimension: "Color", value: `C${index}` }],
  }));
  const fixture = cacheFixture();
  const calls: Array<{ toolName: string; args: Record<string, unknown> }> = [];
  const callTool = async ({ toolName, args }: { toolName: string; args: Record<string, unknown> }) => {
    calls.push({ toolName, args });
    if (toolName === "get_asin_variations") return variationResponse(children);
    if ((args.asins as string[]).length === 1) throw new Error("fixture second batch fails");
    return infoResponse(args.asins as string[]);
  };

  const first = await syncXydcVariantFamilies({
    asins: [inputAsin], country: "US", token: "fixture-token", now, cache: fixture.cache, callTool,
  });

  assert.equal(calls.filter(call => call.toolName === "get_asin_variations").length, 1);
  assert.deepEqual(calls.filter(call => call.toolName === "get_asin_info").map(call => (call.args.asins as string[]).length), [20, 1]);
  assert.equal(first[0].status, "partial");
  assert.equal(first[0].reasonCode, "RPC_ERROR");
  assert.equal(first[0].children[0].price, 12.5);
  assert.equal(first[0].children[0].stars, 4.5);
  assert.equal(first[0].children[0].productPageRatings, 42);

  calls.length = 0;
  const resumed = await syncXydcVariantFamilies({
    asins: [inputAsin], country: "US", token: "fixture-token", now, cache: fixture.cache,
    callTool: async ({ toolName, args }) => {
      calls.push({ toolName, args });
      return toolName === "get_asin_info" ? infoResponse(args.asins as string[]) : variationResponse(children);
    },
  });
  assert.equal(calls.filter(call => call.toolName === "get_asin_variations").length, 0);
  assert.deepEqual(calls.filter(call => call.toolName === "get_asin_info").map(call => call.args.asins), [["B0CHILD020"]]);
  assert.equal(resumed[0].status, "ready");
});

test("uses a fresh ready cache without a provider request and force rehydrates every current child", async () => {
  const cached = projectXydcVariationFamily({ inputAsin, country: "US", raw: variationResponse(), fetchedAt: now.toISOString() });
  cached.status = "ready";
  cached.children = cached.children.map(child => ({ ...child, infoStatus: "ready", title: "Cached", imageUrl: null, price: null, currency: null, stars: null, productPageRatings: null }));
  const fixture = cacheFixture({ [inputAsin]: cached });
  const calls: Array<{ toolName: string; args: Record<string, unknown> }> = [];
  const callTool = async ({ toolName, args }: { toolName: "get_asin_variations" | "get_asin_info"; args: Record<string, unknown> }) => {
    calls.push({ toolName, args });
    return toolName === "get_asin_variations" ? variationResponse() : infoResponse(args.asins as string[]);
  };
  const hit = await syncXydcVariantFamilies({ asins: [inputAsin], country: "US", token: "fixture-token", now, cache: fixture.cache, callTool });
  assert.deepEqual(calls, []);
  assert.equal(hit[0].cacheState, "fresh");

  const refreshed = await syncXydcVariantFamilies({ asins: [inputAsin], country: "US", token: "fixture-token", force: true, now, cache: fixture.cache, callTool });
  assert.deepEqual(calls, [
    { toolName: "get_asin_variations", args: { asin: inputAsin, country: "US" } },
    { toolName: "get_asin_info", args: { asins: ["B0CHILD001", "B0CHILD002"], country: "US" } },
  ]);
  assert.ok(refreshed[0]?.children.every(child => child.title !== "Cached" && child.infoStatus === "ready"));
});

test("merges input siblings under one parent, creates a single-product family, and degrades to stale cache", async () => {
  const sibling = "B0CHILD002";
  const fixture = cacheFixture();
  const merged = await syncXydcVariantFamilies({
    asins: [inputAsin, sibling], country: "US", token: "fixture-token", now, cache: fixture.cache,
    callTool: async ({ toolName, args }) => toolName === "get_asin_variations"
      ? variationResponse([{ asin: inputAsin, attributes: [{ dimension: "Color", value: "Red" }] }, { asin: sibling, attributes: [{ dimension: "Color", value: "Blue" }] }])
      : infoResponse(args.asins as string[]),
  });
  assert.equal(merged.length, 1);
  assert.equal(merged[0].children.length, 2);

  const single = projectXydcVariationFamily({
    inputAsin, country: "US", fetchedAt: now.toISOString(),
    raw: variationResponse([{ asin: inputAsin, attributes: [] }]),
  });
  assert.equal(single.children.length, 1);

  const prior = { ...merged[0], fetchedAt: "2026-09-03T08:00:00.000Z", sourceUpdatedAt: "2026-09-03T07:00:00.000Z" };
  const stale = cacheFixture({ [inputAsin]: prior });
  const fallback = await syncXydcVariantFamilies({
    asins: [inputAsin], country: "US", token: "fixture-token", now, force: true, cache: stale.cache,
    callTool: async () => { throw new Error("fixture provider failure"); },
  });
  assert.equal(fallback[0].cacheState, "stale");
  assert.equal(fallback[0].fetchedAt, prior.fetchedAt);
});

test("merges a failed parent input with a ready child family independently of input order", async () => {
  const parent = "B0PARENT09";
  const child = "B0CHILD009";
  const relationship = {
    parentAsin: parent,
    dimensions: ["Color"],
    children: [
      { asin: parent, attributes: [{ dimension: "Color", value: "Parent" }] },
      { asin: child, attributes: [{ dimension: "Color", value: "Child" }] },
    ],
    sourceUpdatedAt: "2026-09-04T07:00:00.000Z",
  };
  const run = async (asins: string[]) => await syncXydcVariantFamilies({
    asins, country: "US", token: "fixture-token", now, cache: cacheFixture().cache,
    callTool: async ({ toolName, args }) => {
      if (toolName === "get_asin_variations") {
        if (args.asin === parent) throw new Error("fixture parent failure");
        return relationship;
      }
      return infoResponse(args.asins as string[]);
    },
  });
  const parentFirst = await run([parent, child]);
  const childFirst = await run([child, parent]);
  assert.deepEqual(parentFirst, childFirst);
  assert.equal(parentFirst.length, 1);
  assert.equal(parentFirst[0]?.parentAsin, parent);
  assert.equal(parentFirst[0]?.status, "ready");
  assert.equal(parentFirst[0]?.reasonCode, null);
  assert.equal(parentFirst[0]?.sourceUpdatedAt, relationship.sourceUpdatedAt);
  assert.equal(parentFirst[0]?.fetchedAt, now.toISOString());
  assert.equal(parentFirst[0]?.cacheState, "fresh");
  assert.deepEqual(parentFirst[0]?.children.map(childInfo => childInfo.asin), [parent, child]);
  assert.ok(parentFirst[0]?.children.every(childInfo => childInfo.infoStatus === "ready"));
});

test("keeps stale relationship provenance ahead of a newer empty failure in either input order", async () => {
  const parent = "B0PARENT09";
  const child = "B0CHILD009";
  const oldFetchedAt = "2026-09-03T08:00:00.000Z";
  const staleReady = projectXydcVariationFamily({
    inputAsin: child, country: "US", fetchedAt: oldFetchedAt,
    raw: {
      parentAsin: parent, dimensions: ["Color"], sourceUpdatedAt: null,
      children: [{ asin: child, attributes: [{ dimension: "Color", value: "Blue" }] }],
    },
  });
  staleReady.status = "ready";
  staleReady.reasonCode = null;
  staleReady.children = staleReady.children.map(childInfo => ({
    ...childInfo, title: "Cached", imageUrl: "https://images.example.test/cached.jpg", price: 1, currency: "USD", stars: 4, productPageRatings: 1, infoStatus: "ready",
  }));
  const run = async (asins: string[]) => await syncXydcVariantFamilies({
    asins, country: "US", token: "fixture-token", force: true, now,
    cache: cacheFixture({ [child]: staleReady }).cache,
    callTool: async () => { throw new Error("fixture provider failure"); },
  });
  const parentFirst = await run([parent, child]);
  const childFirst = await run([child, parent]);
  assert.deepEqual(parentFirst, childFirst);
  assert.equal(parentFirst.length, 1);
  assert.equal(parentFirst[0]?.status, "ready");
  assert.equal(parentFirst[0]?.reasonCode, null);
  assert.equal(parentFirst[0]?.cacheState, "stale");
  assert.equal(parentFirst[0]?.fetchedAt, oldFetchedAt);
  assert.equal(parentFirst[0]?.sourceUpdatedAt, null);
});

test("keeps two failed variation inputs unavailable", async () => {
  const parent = "B0PARENT09";
  const child = "B0CHILD009";
  const families = await syncXydcVariantFamilies({
    asins: [parent, child], country: "US", token: "fixture-token", now, cache: cacheFixture().cache,
    callTool: async () => { throw new Error("fixture provider failure"); },
  });
  assert.equal(families.length, 2);
  assert.ok(families.every(family => family.status === "unavailable" && family.reasonCode === "RPC_ERROR"));
});

test("failed Windows replacement removes only the temporary file and preserves an old cache target", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xydc-cache-"));
  const family = projectXydcVariationFamily({ inputAsin, country: "US", raw: variationResponse(), fetchedAt: now.toISOString() });
  const target = xydcVariantCachePath(root, "US", inputAsin);
  const old = "old-cache-must-survive";
  const base = await import("node:fs/promises");
  await base.mkdir(path.dirname(target), { recursive: true });
  await base.writeFile(target, old, "utf8");
  try {
    await assert.rejects(writeXydcVariantFamily(root, "US", family, {
      mkdir: base.mkdir,
      readFile: base.readFile,
      open: base.open,
      rename: async () => { throw Object.assign(new Error("locked"), { code: "EPERM" }); },
      unlink: base.unlink,
      platform: "win32",
      sleep: async () => undefined,
    }));
    assert.equal(await readFile(target, "utf8"), old);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a variation failure with no old cache remains unavailable and is not reused as a ready cache", async () => {
  const fixture = cacheFixture();
  let calls = 0;
  const input = {
    asins: [inputAsin], country: "US", token: "fixture-token", now, cache: fixture.cache,
    callTool: async () => { calls += 1; throw new Error("fixture provider failure"); },
  };
  const first = await syncXydcVariantFamilies(input);
  const second = await syncXydcVariantFamilies(input);
  assert.equal(first[0].status, "unavailable");
  assert.equal(first[0].reasonCode, "RPC_ERROR");
  assert.equal(second[0].status, "unavailable");
  assert.equal(calls, 2);
  assert.equal(fixture.records[inputAsin]?.status, "unavailable");
});

test("rejects invalid variation and info rows as schema-invalid without retaining provider bodies", async () => {
  const invalidVariation = await syncXydcVariantFamilies({
    asins: [inputAsin], country: "US", token: "fixture-token", now, cache: cacheFixture().cache,
    callTool: async () => ({
      parentAsin, dimensions: ["Color"],
      children: [
        { asin: inputAsin, attributes: [{ dimension: "Color", value: "Red" }] },
        { asin: "invalid", attributes: [] },
      ],
      providerBody: "invalid-variation-body",
    }),
  });
  assert.equal(invalidVariation[0].status, "unavailable");
  assert.equal(invalidVariation[0].reasonCode, "SCHEMA_INVALID");
  assert.equal(JSON.stringify(invalidVariation).includes("invalid-variation-body"), false);

  const invalidInfo = await syncXydcVariantFamilies({
    asins: [inputAsin], country: "US", token: "fixture-token", now, cache: cacheFixture().cache,
    callTool: async ({ toolName }) => toolName === "get_asin_variations"
      ? variationResponse([{ asin: inputAsin, attributes: [{ dimension: "Color", value: "Red" }] }])
      : [{ asin: inputAsin, title: "Title", imageUrl: "https://images.example.test/product.jpg", price: "not-a-number", currency: "USD", stars: "4", productPageRatings: "2", providerBody: "invalid-info-body" }],
  });
  assert.equal(invalidInfo[0].status, "partial");
  assert.equal(invalidInfo[0].reasonCode, "SCHEMA_INVALID");
  assert.equal(JSON.stringify(invalidInfo).includes("invalid-info-body"), false);
});

test("retains legal partial info fields while marking the child and family partial", async () => {
  const family = await syncXydcVariantFamilies({
    asins: [inputAsin], country: "US", token: "fixture-token", now, cache: cacheFixture().cache,
    callTool: async ({ toolName }) => toolName === "get_asin_variations"
      ? variationResponse([{ asin: inputAsin, attributes: [{ dimension: "Color", value: "Red" }] }])
      : [{ asin: inputAsin, title: "Title", imageUrl: "https://images.example.test/product.jpg", price: "12.50", stars: "4.5", productPageRatings: "42" }],
  });
  assert.equal(family[0].status, "partial");
  assert.equal(family[0].reasonCode, "PARTIAL_CHILD_INFO");
  assert.equal(family[0].children[0].infoStatus, "unavailable");
  assert.equal(family[0].children[0].title, "Title");
  assert.equal(family[0].children[0].imageUrl, "https://images.example.test/product.jpg");
  assert.equal(family[0].children[0].price, 12.5);
  assert.equal(family[0].children[0].stars, 4.5);
  assert.equal(family[0].children[0].productPageRatings, 42);
  assert.deepEqual(family[0].children[0].attributes, [{ dimension: "Color", value: "Red" }]);
  assert.equal(family[0].children[0].currency, null);
});

test("accumulates complementary legal partial info without erasing prior child evidence", async () => {
  const prior = projectXydcVariationFamily({ inputAsin, country: "US", raw: variationResponse([{ asin: inputAsin, attributes: [{ dimension: "Color", value: "Red" }] }]), fetchedAt: now.toISOString() });
  prior.children = prior.children.map(child => ({
    ...child,
    title: "Cached title",
    imageUrl: "https://images.example.test/cached.jpg",
    infoStatus: "unavailable",
  }));
  const calls: string[] = [];
  const family = await syncXydcVariantFamilies({
    asins: [inputAsin], country: "US", token: "fixture-token", now, cache: cacheFixture({ [inputAsin]: prior }).cache,
    callTool: async ({ toolName }) => {
      calls.push(toolName);
      if (toolName === "get_asin_variations") throw new Error("partial relationship should resume from cache");
      return [{ asin: inputAsin, title: null, imageUrl: null, price: "12.50", currency: "USD", stars: "4.5", productPageRatings: "42" }];
    },
  });
  assert.deepEqual(calls, ["get_asin_info"]);
  assert.equal(family[0].status, "ready");
  assert.deepEqual(family[0].children[0], {
    asin: inputAsin,
    attributes: [{ dimension: "Color", value: "Red" }],
    title: "Cached title",
    imageUrl: "https://images.example.test/cached.jpg",
    price: 12.5,
    currency: "USD",
    stars: 4.5,
    productPageRatings: 42,
    listingDate: null,
    infoStatus: "ready",
  });
});

test("force restores the old ready family as stale when child enrichment fails", async () => {
  const oldFetchedAt = "2026-09-03T08:00:00.000Z";
  const prior = projectXydcVariationFamily({ inputAsin, country: "US", raw: variationResponse(), fetchedAt: oldFetchedAt });
  prior.status = "ready";
  prior.reasonCode = null;
  prior.children = prior.children.map(child => ({
    ...child,
    title: `Old ${child.asin}`,
    imageUrl: "https://images.example.test/old.jpg",
    price: 1,
    currency: "USD",
    stars: 4,
    productPageRatings: 1,
    infoStatus: "ready",
  }));
  const fixture = cacheFixture({ [inputAsin]: prior });
  const calls: Array<{ toolName: string; args: Record<string, unknown> }> = [];
  const family = await syncXydcVariantFamilies({
    asins: [inputAsin], country: "US", token: "fixture-token", force: true, now, cache: fixture.cache,
    callTool: async ({ toolName, args }) => {
      calls.push({ toolName, args });
      if (toolName === "get_asin_variations") return variationResponse([{ asin: inputAsin, attributes: [{ dimension: "Color", value: "New" }] }]);
      throw new Error("fixture info failure");
    },
  });
  assert.deepEqual(calls, [
    { toolName: "get_asin_variations", args: { asin: inputAsin, country: "US" } },
    { toolName: "get_asin_info", args: { asins: [inputAsin], country: "US" } },
  ]);
  assert.equal(family[0].cacheState, "stale");
  assert.equal(family[0].fetchedAt, oldFetchedAt);
  assert.equal(family[0].status, "ready");
  assert.equal(family[0].children.length, 2);
  assert.equal(family[0].children[0].title, "Old B0CHILD001");
  assert.equal(fixture.records[inputAsin]?.cacheState, "stale");
  assert.equal(fixture.records[inputAsin]?.children[0]?.title, "Old B0CHILD001");
});

test("force restores the old ready family as stale when child enrichment is schema-invalid", async () => {
  const prior = projectXydcVariationFamily({ inputAsin, country: "US", raw: variationResponse([{ asin: inputAsin, attributes: [{ dimension: "Color", value: "Old" }] }]), fetchedAt: "2026-09-03T08:00:00.000Z" });
  prior.status = "ready";
  prior.reasonCode = null;
  prior.children = prior.children.map(child => ({
    ...child,
    title: "Old title",
    imageUrl: "https://images.example.test/old.jpg",
    price: 1,
    currency: "USD",
    stars: 4,
    productPageRatings: 1,
    infoStatus: "ready",
  }));
  const fixture = cacheFixture({ [inputAsin]: prior });
  const family = await syncXydcVariantFamilies({
    asins: [inputAsin], country: "US", token: "fixture-token", force: true, now, cache: fixture.cache,
    callTool: async ({ toolName }) => toolName === "get_asin_variations"
      ? variationResponse([{ asin: inputAsin, attributes: [{ dimension: "Color", value: "New" }] }])
      : [{ asin: inputAsin, title: "Invalid", imageUrl: "https://images.example.test/invalid.jpg", price: true, currency: "USD", stars: "4", productPageRatings: "1" }],
  });
  assert.equal(family[0].cacheState, "stale");
  assert.equal(family[0].status, "ready");
  assert.equal(family[0].children[0].title, "Old title");
  assert.equal(fixture.records[inputAsin]?.cacheState, "stale");
});

test("rejects cache entries whose family country differs from the normalized path country", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xydc-cache-country-"));
  const family = projectXydcVariationFamily({ inputAsin, country: "CA", raw: variationResponse(), fetchedAt: now.toISOString() });
  const target = xydcVariantCachePath(root, "US", inputAsin);
  try {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(family)}\n`, "utf8");
    assert.equal(await readXydcVariantFamily(root, " us ", inputAsin), undefined);

    const old = await readFile(target, "utf8");
    await assert.rejects(writeXydcVariantFamily(root, "US", family));
    assert.equal(await readFile(target, "utf8"), old);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("treats null fields as incomplete and rejects boolean, blank, URL, and range-invalid info values", async () => {
  const complete = {
    asin: inputAsin, title: "Title", imageUrl: "https://images.example.test/product.jpg",
    price: "12.50", currency: "USD", stars: "4.5", productPageRatings: "42",
  };
  const run = async (row: Record<string, unknown>) => await syncXydcVariantFamilies({
    asins: [inputAsin], country: "US", token: "fixture-token", now, cache: cacheFixture().cache,
    callTool: async ({ toolName }) => toolName === "get_asin_variations"
      ? variationResponse([{ asin: inputAsin, attributes: [{ dimension: "Color", value: "Red" }] }])
      : [row],
  });
  const nullField = await run({ ...complete, price: null });
  assert.equal(nullField[0].status, "partial");
  assert.equal(nullField[0].children[0].infoStatus, "unavailable");

  for (const invalid of [
    { ...complete, price: true },
    { ...complete, price: Number.NaN },
    { ...complete, price: "   " },
    { ...complete, imageUrl: "not-a-url" },
    { ...complete, imageUrl: false },
    { ...complete, stars: "5.1" },
    { ...complete, productPageRatings: "1.5" },
    { ...complete, title: 42 },
    { ...complete, currency: false },
  ]) {
    const family = await run(invalid);
    assert.equal(family[0].status, "partial");
    assert.equal(family[0].reasonCode, "SCHEMA_INVALID");
  }
});

test("a schema-invalid info batch only marks the families containing that batch's children", async () => {
  const firstInput = "B0FAMILY01";
  const secondInput = "B0FAMILY02";
  const cachedInput = "B0FAMILY03";
  const childFor = (asin: string) => ({ asin, attributes: [{ dimension: "Color", value: asin }] });
  const familyFor = (asin: string) => ({
    parentAsin: asin, dimensions: ["Color"], children: [childFor(asin)], sourceUpdatedAt: "2026-09-04T07:00:00.000Z",
  });
  const cached = projectXydcVariationFamily({ inputAsin: cachedInput, country: "US", raw: familyFor(cachedInput), fetchedAt: now.toISOString() });
  cached.status = "ready";
  cached.reasonCode = null;
  cached.children = cached.children.map(child => ({
    ...child, title: "Cached", imageUrl: "https://images.example.test/cached.jpg", price: 1, currency: "USD", stars: 4, productPageRatings: 1, infoStatus: "ready",
  }));
  const fixture = cacheFixture({ [cachedInput]: cached });
  const calls: string[][] = [];
  const families = await syncXydcVariantFamilies({
    asins: [firstInput, secondInput, cachedInput], country: "US", token: "fixture-token", now, batchSize: 1, cache: fixture.cache,
    callTool: async ({ toolName, args }) => {
      if (toolName === "get_asin_variations") return familyFor(args.asin as string);
      const asins = args.asins as string[];
      calls.push(asins);
      return asins[0] === firstInput
        ? [{ asin: firstInput, title: "First", imageUrl: "https://images.example.test/first.jpg", price: "1", currency: "USD", stars: "4", productPageRatings: "1" }]
        : [{ asin: secondInput, title: "Second", imageUrl: "https://images.example.test/second.jpg", price: true, currency: "USD", stars: "4", productPageRatings: "1" }];
    },
  });
  assert.deepEqual(calls, [[firstInput], [secondInput]]);
  const byInput = new Map(families.map(family => [family.inputAsin, family]));
  assert.equal(byInput.get(firstInput)?.status, "ready");
  assert.equal(byInput.get(secondInput)?.status, "partial");
  assert.equal(byInput.get(secondInput)?.reasonCode, "SCHEMA_INVALID");
  assert.equal(byInput.get(secondInput)?.children[0]?.infoStatus, "unavailable");
  assert.equal(byInput.get(cachedInput)?.status, "ready");
  assert.equal(fixture.records[firstInput]?.children[0]?.infoStatus, "ready");
  assert.equal(fixture.records[cachedInput]?.children[0]?.title, "Cached");
});

test("a schema-invalid partial resumes to ready without requesting variations again", async () => {
  const fixture = cacheFixture();
  const relation = () => variationResponse([{ asin: inputAsin, attributes: [{ dimension: "Color", value: "Red" }] }]);
  const first = await syncXydcVariantFamilies({
    asins: [inputAsin], country: "US", token: "fixture-token", now, cache: fixture.cache,
    callTool: async ({ toolName }) => toolName === "get_asin_variations"
      ? relation()
      : [{ asin: inputAsin, title: "Title", imageUrl: "https://images.example.test/product.jpg", price: true, currency: "USD", stars: "4", productPageRatings: "1" }],
  });
  assert.equal(first[0].status, "partial");
  assert.equal(first[0].reasonCode, "SCHEMA_INVALID");

  let variationCalls = 0;
  const resumed = await syncXydcVariantFamilies({
    asins: [inputAsin], country: "US", token: "fixture-token", now, cache: fixture.cache,
    callTool: async ({ toolName }) => {
      if (toolName === "get_asin_variations") variationCalls += 1;
      return [{ asin: inputAsin, title: "Title", imageUrl: "https://images.example.test/product.jpg", price: "1", currency: "USD", stars: "4", productPageRatings: "1" }];
    },
  });
  assert.equal(variationCalls, 0);
  assert.equal(resumed[0].status, "ready");
  assert.equal(resumed[0].reasonCode, null);
  assert.equal(fixture.records[inputAsin]?.status, "ready");
  assert.equal(fixture.records[inputAsin]?.reasonCode, null);
});

test("a schema-invalid shared-child batch preserves another input family's ready child evidence", async () => {
  const firstInput = "B0SHARED01";
  const secondInput = "B0SHARED02";
  const sharedChild = "B0SHARED99";
  const relationship = {
    parentAsin: "B0PARENT99", dimensions: ["Color"],
    children: [{ asin: sharedChild, attributes: [{ dimension: "Color", value: "Red" }] }],
    sourceUpdatedAt: "2026-09-04T07:00:00.000Z",
  };
  const ready = projectXydcVariationFamily({ inputAsin: firstInput, country: "US", raw: relationship, fetchedAt: now.toISOString() });
  ready.status = "ready";
  ready.reasonCode = null;
  ready.children = ready.children.map(child => ({
    ...child, title: "Keep", imageUrl: "https://images.example.test/keep.jpg", price: 1, currency: "USD", stars: 4, productPageRatings: 1, infoStatus: "ready",
  }));
  const partial = projectXydcVariationFamily({ inputAsin: secondInput, country: "US", raw: relationship, fetchedAt: now.toISOString() });
  partial.children = partial.children.map(child => ({ ...child, infoStatus: "unavailable" }));
  const fixture = cacheFixture({ [firstInput]: ready, [secondInput]: partial });
  let variationCalls = 0;
  await syncXydcVariantFamilies({
    asins: [firstInput, secondInput], country: "US", token: "fixture-token", now, cache: fixture.cache,
    callTool: async ({ toolName }) => {
      if (toolName === "get_asin_variations") variationCalls += 1;
      return [{ asin: sharedChild, title: "Bad", imageUrl: "https://images.example.test/bad.jpg", price: true, currency: "USD", stars: "4", productPageRatings: "1" }];
    },
  });
  assert.equal(variationCalls, 0);
  assert.equal(fixture.records[firstInput]?.status, "ready");
  assert.equal(fixture.records[firstInput]?.children[0]?.infoStatus, "ready");
  assert.equal(fixture.records[firstInput]?.children[0]?.title, "Keep");
  assert.equal(fixture.records[secondInput]?.status, "partial");
  assert.equal(fixture.records[secondInput]?.reasonCode, "SCHEMA_INVALID");
  assert.equal(fixture.records[secondInput]?.children[0]?.infoStatus, "unavailable");
});

test("continues after a schema-invalid info batch to checkpoint the next independent batch", async () => {
  const firstInput = "B0BATCH001";
  const secondInput = "B0BATCH002";
  const familyFor = (asin: string) => ({
    parentAsin: asin, dimensions: ["Color"], children: [{ asin, attributes: [{ dimension: "Color", value: asin }] }], sourceUpdatedAt: "2026-09-04T07:00:00.000Z",
  });
  const batches: string[][] = [];
  const fixture = cacheFixture();
  const families = await syncXydcVariantFamilies({
    asins: [firstInput, secondInput], country: "US", token: "fixture-token", now, batchSize: 1, cache: fixture.cache,
    callTool: async ({ toolName, args }) => {
      if (toolName === "get_asin_variations") return familyFor(args.asin as string);
      const asins = args.asins as string[];
      batches.push(asins);
      return asins[0] === firstInput
        ? [{ asin: firstInput, title: "Bad", imageUrl: "https://images.example.test/bad.jpg", price: true, currency: "USD", stars: "4", productPageRatings: "1" }]
        : [{ asin: secondInput, title: "Good", imageUrl: "https://images.example.test/good.jpg", price: "1", currency: "USD", stars: "4", productPageRatings: "1" }];
    },
  });
  const byInput = new Map(families.map(family => [family.inputAsin, family]));
  assert.deepEqual(batches, [[firstInput], [secondInput]]);
  assert.equal(byInput.get(firstInput)?.status, "partial");
  assert.equal(byInput.get(firstInput)?.reasonCode, "SCHEMA_INVALID");
  assert.equal(byInput.get(secondInput)?.status, "ready");
  assert.equal(fixture.records[secondInput]?.children[0]?.infoStatus, "ready");
});

test("persists a stale fallback unchanged after a forced provider failure", async () => {
  const prior = projectXydcVariationFamily({ inputAsin, country: "US", raw: variationResponse(), fetchedAt: "2026-09-03T08:00:00.000Z" });
  prior.status = "ready";
  prior.reasonCode = null;
  prior.sourceUpdatedAt = "2026-09-03T07:00:00.000Z";
  prior.children = prior.children.map(child => ({ ...child, title: "Old", infoStatus: "ready" }));
  const root = await mkdtemp(path.join(os.tmpdir(), "xydc-stale-"));
  const cache = createXydcVariantCache(root);
  try {
    await cache.write("US", prior);
    const families = await syncXydcVariantFamilies({
      asins: [inputAsin], country: "US", token: "fixture-token", force: true, now, cache,
      callTool: async () => { throw new Error("fixture provider failure"); },
    });
    const reread = await cache.readMany("US", [inputAsin]);
    assert.equal(families[0].cacheState, "stale");
    assert.equal(reread[inputAsin].cacheState, "stale");
    assert.equal(reread[inputAsin].fetchedAt, prior.fetchedAt);
    assert.equal(reread[inputAsin].sourceUpdatedAt, prior.sourceUpdatedAt);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows npm CLI executes offline fixture enrichment and writes the scoped cache", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xydc-cli-"));
  const fixturePath = path.join(root, "fixture.json");
  const cachePath = xydcVariantCachePath(root, "US", inputAsin);
  const orderWindow = getXydcOrderWindow(new Date());
  const orderResponse = (asin: string) => ({
    status: 200,
    cost_credits: 2,
    data: {
      asin,
      country: "US",
      dateRangeNotice: "fixture notice",
      trends: orderWindow.months.map(date => ({ date, orders: 10 })),
    },
  });
  const fixture = JSON.stringify({
    get_asin_variations: variationResponse([{ asin: inputAsin, attributes: [{ dimension: "Color", value: "Red" }] }]),
    get_asin_info: infoResponse([inputAsin]),
    get_asin_order_trends: { [inputAsin]: orderResponse(inputAsin) },
  });
  const fs = await import("node:fs/promises");
  await fs.writeFile(fixturePath, fixture, "utf8");
  try {
    const child = spawn(
      process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : "npm",
      process.platform === "win32" ? ["/d", "/s", "/c", "npm run variant:xydc:sync"] : ["run", "variant:xydc:sync"],
      {
      cwd: path.resolve(import.meta.dirname, "..", ".."),
      env: {
        ...process.env,
        NODE_ENV: "test",
        AGENT_DATA_ROOT: root,
        XYDC_ASINS: inputAsin,
        XYDC_COUNTRY: "US",
        XYDC_MCP_TOKEN: "fixture-token",
        XYDC_FIXTURE_PATH: fixturePath,
      },
      stdio: "ignore",
      windowsHide: true,
      },
    );
    const [code] = await once(child, "exit") as [number | null];
    assert.equal(code, 0);
    const cached = JSON.parse(await readFile(cachePath, "utf8"));
    assert.equal(cached.status, "ready");
    assert.equal(cached.children[0].infoStatus, "ready");
    const orderCache = JSON.parse(await readFile(xydcOrderCachePath(root, cached, orderWindow), "utf8"));
    assert.equal(orderCache.children[0].trends.length, 12);
    assert.equal(JSON.stringify(orderCache).includes("cost_credits"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
