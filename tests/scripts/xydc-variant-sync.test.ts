import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  projectXydcVariationFamily,
  syncXydcVariantFamilies,
} from "../../scripts/build-xydc-variant-data";
import { writeXydcVariantFamily, xydcVariantCachePath } from "../../scripts/lib/xydc-variant-cache";
import type { XydcVariantFamily } from "../../shared/xydc-variant-contract";

const inputAsin = "B0CHILD001";
const parentAsin = "B0PARENT01";
const now = new Date("2026-09-04T08:00:00.000Z");

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

function cacheFixture(initial: Record<string, XydcVariantFamily> = {}) {
  const records: Record<string, XydcVariantFamily> = { ...initial };
  return {
    records,
    cache: {
      async readMany(_country: string, asins: readonly string[]) {
        const found: Array<[string, XydcVariantFamily]> = [];
        for (const asin of asins) if (records[asin]) found.push([asin, records[asin]]);
        return Object.fromEntries(found);
      },
      async write(_country: string, family: XydcVariantFamily) {
        records[family.inputAsin] = family;
      },
    },
  };
}

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
  assert.equal(first[0].reasonCode, "PARTIAL_CHILD_INFO");
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

test("uses a fresh ready cache without a provider request and force refreshes it", async () => {
  const cached = projectXydcVariationFamily({ inputAsin, country: "US", raw: variationResponse(), fetchedAt: now.toISOString() });
  cached.status = "ready";
  cached.children = cached.children.map(child => ({ ...child, infoStatus: "ready", title: "Cached", imageUrl: null, price: null, currency: null, stars: null, productPageRatings: null }));
  const fixture = cacheFixture({ [inputAsin]: cached });
  let calls = 0;
  const callTool = async () => { calls += 1; return variationResponse(); };
  const hit = await syncXydcVariantFamilies({ asins: [inputAsin], country: "US", token: "fixture-token", now, cache: fixture.cache, callTool });
  assert.equal(calls, 0);
  assert.equal(hit[0].cacheState, "fresh");

  await syncXydcVariantFamilies({ asins: [inputAsin], country: "US", token: "fixture-token", force: true, now, cache: fixture.cache, callTool });
  assert.equal(calls, 1);
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
