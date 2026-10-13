import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import {
  hasCatalogRatingReviewConflict,
  positiveMoneyOrNull,
} from "../../scripts/lib/commerce-data-validity.mjs";
import { buildPriceStrategyUiExport, buildStrategy } from "../../scripts/build-sorftime-price-strategy.mjs";
import {
  buildSorftimeRatingRecord,
  shouldReuseSorftimeRatingRecord,
} from "../../scripts/build-sorftime-rating.mjs";
import { readCachedDataExport } from "../../scripts/lib/sync-cache.mjs";

const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

test("positive commerce money rejects zero, negative, non-finite, and string values", () => {
  for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "4.25"]) {
    assert.equal(positiveMoneyOrNull(value), null);
  }
  assert.equal(positiveMoneyOrNull(4.25), 4.25);
});

test("zero rating and reviews conflict only with positive catalog evidence", () => {
  assert.equal(hasCatalogRatingReviewConflict(0, 0, { rating: 4.2, reviews: 42 }), true);
  assert.equal(hasCatalogRatingReviewConflict(0, 0, { rating: 0, reviews: 0 }), false);
  assert.equal(hasCatalogRatingReviewConflict(4.2, 0, { rating: 4.2, reviews: 42 }), false);
});

test("price strategy rejects an invalid current price but retains a positive currentPrice", () => {
  assert.equal(buildStrategy({ price: 0, coupon: 0, prices: [{ value: 19.99 }] }), null);
  const strategy = buildStrategy({ price: 19.99, coupon: 0, prices: [] });
  assert.equal(strategy.currentPrice, 19.99);
});

test("rating generator marks catalog-conflicting zero records empty but preserves verified zero reviews", () => {
  assert.equal(buildSorftimeRatingRecord({
    asin: "B0TEST0001", marketplace: "US", fetchedAt: "2026-09-02", rating: 0, reviewCount: 0,
    catalog: { rating: 4.2, reviews: 42 },
  }).status, "empty");
  assert.equal(buildSorftimeRatingRecord({
    asin: "B0TEST0001", marketplace: "US", fetchedAt: "2026-09-02", rating: 4.2, reviewCount: 0,
    catalog: { rating: 4.2, reviews: 42 },
  }).status, "ready");
});

test("rating generator keeps absent or string zero metrics empty but accepts numeric zero", () => {
  for (const value of [null, undefined, "", "0"]) {
    const record = buildSorftimeRatingRecord({
      asin: "B0TEST0002", marketplace: "US", fetchedAt: "2026-09-02", rating: value, reviewCount: value,
      catalog: { rating: 0, reviews: 0 },
    });
    assert.deepEqual(
      { status: record.status, rating: record.rating, reviewCount: record.reviewCount },
      { status: "empty", rating: null, reviewCount: null },
      String(value),
    );
  }
  assert.equal(buildSorftimeRatingRecord({
    asin: "B0TEST0002", marketplace: "US", fetchedAt: "2026-09-02", rating: 0, reviewCount: 0,
    catalog: { rating: 0, reviews: 0 },
  }).status, "ready");
});

test("rating cache rejects scoped zero records that conflict with positive catalog evidence", () => {
  const record = {
    asin: "B0TEST0001",
    marketplace: "US",
    fetchedAt: "2026-09-02",
    status: "ready",
    rating: 0,
    reviewCount: 0,
  };
  for (const [catalog, expected] of [
    [{ rating: 4.4, reviews: 0 }, false],
    [{ rating: 0, reviews: 941 }, false],
    [{ rating: 0, reviews: 0 }, true],
  ]) {
    assert.equal(shouldReuseSorftimeRatingRecord({
      record,
      catalog,
      asin: record.asin,
      marketplace: record.marketplace,
      forceRefresh: false,
    }), expected);
  }
});

for (const includeReusableSibling of [false, true]) {
  test(`rating no-key invalidation persists for ${includeReusableSibling ? "mixed" : "single"} ASIN cache`, async (t) => {
    const rejectedAsin = "B0TEST0001";
    const siblingAsin = "B0TEST0002";
    const rejected = {
      asin: rejectedAsin, marketplace: "US", fetchedAt: "2026-09-02",
      status: "ready", rating: 0, reviewCount: 0,
    };
    const sibling = {
      asin: siblingAsin, marketplace: "US", fetchedAt: "2026-09-02",
      status: "ready", rating: 4.6, reviewCount: 120,
    };
    const result = await runRatingScriptWithoutKey(t, {
      asins: includeReusableSibling ? [rejectedAsin, siblingAsin] : [rejectedAsin],
      catalog: [
        { asin: rejectedAsin, rating: 4.4, reviews: 941 },
        ...(includeReusableSibling ? [{ asin: siblingAsin, rating: 4.6, reviews: 120 }] : []),
      ],
      existing: {
        [rejectedAsin]: rejected,
        ...(includeReusableSibling ? { [siblingAsin]: sibling } : {}),
      },
    });

    assert.equal(result.exitCode, 1, result.stderr);
    assert.notEqual(result.records[rejectedAsin]?.status, "ready");
    assert.equal(result.records[rejectedAsin]?.status, "error");
    if (includeReusableSibling) assert.deepEqual(result.records[siblingAsin], sibling);
  });
}

test("price strategy UI export preserves machine-readable ready status and current price", () => {
  const source = buildPriceStrategyUiExport({
    records: {
      B0TEST0001: {
        asin: "B0TEST0001", marketplace: "US", fetchedAt: "2026-09-02", source: "Sorftime",
        status: "ready", currentPrice: 19.99, anchor: "price", promotion: "none", psychology: "none", evidence: "fixture",
      },
    },
    marketplace: "US",
    fetchedAt: "2026-09-02",
  });
  assert.match(source, /"status": "ready"/);
  assert.match(source, /"currentPrice": 19\.99/);
});

async function runRatingScriptWithoutKey(t, { asins, catalog, existing }) {
  const directory = await mkdtemp(path.join(tmpdir(), "sorftime-rating-no-key-"));
  t.after(() => {
    const resolved = path.resolve(directory);
    assert.ok(resolved.startsWith(path.resolve(tmpdir()) + path.sep));
    return rm(resolved, { recursive: true, force: true });
  });
  await mkdir(path.join(directory, "scripts"), { recursive: true });
  await mkdir(path.join(directory, "app"), { recursive: true });
  await copyFile(
    path.join(root, "scripts", "build-sorftime-rating.mjs"),
    path.join(directory, "scripts", "build-sorftime-rating.mjs"),
  );
  await writeFile(path.join(directory, "app", "competitor-data.ts"),
    `export const refreshedCatalog = ${JSON.stringify(catalog, null, 2)};\n`, "utf8");
  await writeFile(path.join(directory, "app", "sorftime-rating-data.ts"),
    `export const sorftimeRatingData = ${JSON.stringify(existing, null, 2)};\n`, "utf8");
  const loaderPath = path.join(directory, "production-import-loader.mjs");
  await writeFile(path.join(directory, "no-key-client.mjs"),
    `export function readSorftimeKey() { return null; }
export async function callSorftimeTool() { throw new Error("Unexpected provider call in no-key fixture"); }\n`, "utf8");
  await writeFile(loaderPath, `import path from "node:path";
import { pathToFileURL } from "node:url";
const root = ${JSON.stringify(root)};
const mapped = new Map([
  ["sync-cache.mjs", "scripts/lib/sync-cache.mjs"],
  ["commerce-data-validity.mjs", "scripts/lib/commerce-data-validity.mjs"],
  ["generated-app-data-path.mjs", "scripts/lib/generated-app-data-path.mjs"],
  ["sorftime-profile-normalize.mjs", "scripts/lib/sorftime-profile-normalize.mjs"],
]);
export async function resolve(specifier, context, nextResolve) {
  const filename = specifier.split("/").at(-1);
  if (specifier === "./lib/sorftime-mcp-client.mjs") {
    return { url: new URL("./no-key-client.mjs", import.meta.url).href, shortCircuit: true };
  }
  if (specifier.startsWith(".") && mapped.has(filename)) {
    return { url: pathToFileURL(path.join(root, mapped.get(filename))).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}\n`, "utf8");
  let stderr = "";
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--experimental-loader", pathToFileURL(loaderPath).href,
      path.join(directory, "scripts", "build-sorftime-rating.mjs"),
    ], {
      cwd: directory,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: directory, TMP: directory,
        NODE_ENV: "test", SORFTIME_MCP_KEY: "", SORFTIME_ASINS: asins.join(","), SORFTIME_MARKETPLACE: "US" },
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", resolve);
  });
  return {
    exitCode,
    stderr,
    records: readCachedDataExport(path.join(directory, "app", "sorftime-rating-data.ts"), "sorftimeRatingData"),
  };
}
