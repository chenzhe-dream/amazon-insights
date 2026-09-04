import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

import {
  projectXydcVariationFamily,
  syncXydcVariantFamilies,
} from "../../scripts/build-xydc-variant-data";
import { createXydcVariantCache, writeXydcVariantFamily, xydcVariantCachePath } from "../../scripts/lib/xydc-variant-cache";
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

test("marks children with a legal but incomplete info row unavailable instead of ready", async () => {
  const family = await syncXydcVariantFamilies({
    asins: [inputAsin], country: "US", token: "fixture-token", now, cache: cacheFixture().cache,
    callTool: async ({ toolName }) => toolName === "get_asin_variations"
      ? variationResponse([{ asin: inputAsin, attributes: [{ dimension: "Color", value: "Red" }] }])
      : [{ asin: inputAsin, title: "Title", imageUrl: "https://images.example.test/product.jpg" }],
  });
  assert.equal(family[0].status, "partial");
  assert.equal(family[0].children[0].infoStatus, "unavailable");
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
  const fixture = JSON.stringify({
    get_asin_variations: variationResponse([{ asin: inputAsin, attributes: [{ dimension: "Color", value: "Red" }] }]),
    get_asin_info: infoResponse([inputAsin]),
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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
