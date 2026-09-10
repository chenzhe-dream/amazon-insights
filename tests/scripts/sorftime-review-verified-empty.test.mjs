import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import { deriveAsinModuleStatus } from "../../scripts/lib/asin-data-status.mjs";
import { readCachedDataExport } from "../../scripts/lib/sync-cache.mjs";
import { shouldReuseSorftimeReviewRecord } from "../../scripts/build-sorftime-review-analysis.mjs";

const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const asin = "B0G5N593D6";
const readyEmpty = {
  asin,
  marketplace: "US",
  sampledReviews: 0,
  mentionTopics: 0,
  fetchedAt: "2026-08-23",
  status: "ready",
  statusMessage: "Sorftime product_detail 已确认该 ASIN 评论数为 0",
  blocks: [],
};

test("ready-empty review cache requires current non-conflicting zero evidence", () => {
  assert.equal(shouldReuseSorftimeReviewRecord({
    record: readyEmpty,
    ratingRecord: { asin, marketplace: "US", fetchedAt: "2026-09-02", status: "ready", rating: 4.4, reviewCount: 941 },
    catalog: { rating: 4.4, reviews: 941 },
    asin,
    marketplace: "US",
    forceRefresh: false,
  }), false);
});

test("verified zero reviews bypasses review provider tools without schema degradation", async (t) => {
  const provider = await fakeSorftimeProvider("schema");
  t.after(provider.close);
  const result = await runProductionReviewScript(t, provider.endpoint, {
    asin,
    marketplace: "US",
    fetchedAt: "2026-08-23",
    status: "ready",
    rating: 4.8,
    reviewCount: 0,
  });

  assert.deepEqual({
    exitCode: result.exitCode,
    toolCalls: provider.toolCalls(),
    hasMcpSchema: result.stderr.includes("MCP_SCHEMA"),
    hasProviderDiagnostic: result.stderr.includes("@@provider-diagnostic@@"),
    record: result.records[asin],
  }, {
    exitCode: 0,
    toolCalls: [],
    hasMcpSchema: false,
    hasProviderDiagnostic: false,
    record: {
      asin,
      marketplace: "US",
      sampledReviews: 0,
      mentionTopics: 0,
      fetchedAt: "2026-08-23",
      status: "ready",
      statusMessage: "Sorftime product_detail 已确认该 ASIN 评论数为 0",
      blocks: [],
    },
  });
  assert.equal(deriveAsinModuleStatus(asin, statusSources(result.records)).reviews, "ready");
});

for (const forceRefresh of [false, true]) {
  test(`stale ready-empty review cache becomes error through ${forceRefresh ? "provider-error retention" : "normal cache-hit"} path`, async (t) => {
    const provider = await fakeSorftimeProvider("schema");
    t.after(provider.close);
    const result = await runProductionReviewScript(t, provider.endpoint, {
      asin,
      marketplace: "US",
      fetchedAt: "2026-09-02",
      status: "ready",
      rating: 4.4,
      reviewCount: 941,
    }, {
      existingRecord: readyEmpty,
      catalog: { rating: 4.4, reviews: 941 },
      forceRefresh,
    });

    assert.deepEqual(provider.toolCalls().sort(), ["product_customers_say", "product_reviews"]);
    assert.equal(result.records[asin]?.status, "error");
  });
}

for (const includeReusableSibling of [false, true]) {
  test(`review no-key invalidation persists for ${includeReusableSibling ? "mixed" : "single"} ASIN cache`, async (t) => {
    const siblingAsin = "B0G5N593D7";
    const sibling = {
      asin: siblingAsin,
      marketplace: "US",
      sampledReviews: 1,
      mentionTopics: 1,
      fetchedAt: "2026-08-23",
      status: "ready",
      blocks: [{ key: "positives", label: "好评", rows: [] }],
    };
    const provider = await fakeSorftimeProvider("schema");
    t.after(provider.close);
    const result = await runProductionReviewScript(t, provider.endpoint, null, {
      asins: includeReusableSibling ? [asin, siblingAsin] : [asin],
      ratingRecords: {
        [asin]: { asin, marketplace: "US", fetchedAt: "2026-09-02", status: "ready", rating: 4.4, reviewCount: 941 },
        ...(includeReusableSibling ? { [siblingAsin]: { asin: siblingAsin, marketplace: "US", fetchedAt: "2026-09-02", status: "ready", rating: 4.6, reviewCount: 120 } } : {}),
      },
      existingRecords: {
        [asin]: readyEmpty,
        ...(includeReusableSibling ? { [siblingAsin]: sibling } : {}),
      },
      catalogRecords: [
        { asin, rating: 4.4, reviews: 941 },
        ...(includeReusableSibling ? [{ asin: siblingAsin, rating: 4.6, reviews: 120 }] : []),
      ],
      forceRefresh: false,
      hasProviderKey: false,
    });

    assert.deepEqual(provider.toolCalls(), []);
    assert.equal(result.records[asin]?.status, "error");
    if (includeReusableSibling) assert.deepEqual(result.records[siblingAsin], sibling);
  });
}

for (const fixture of [
  {
    name: "nonzero review count",
    providerMode: "schema",
    causeCode: "MCP_SCHEMA",
    rating: { status: "ready", reviewCount: 1 },
  },
  {
    name: "unknown review count",
    providerMode: "rpc",
    causeCode: "MCP_RPC",
    rating: { status: "ready", reviewCount: null },
  },
  {
    name: "unverified zero review count",
    providerMode: "http",
    causeCode: "HTTP_5XX",
    rating: { status: "error", reviewCount: 0 },
  },
  {
    name: "mismatched zero-review evidence",
    providerMode: "schema",
    causeCode: "MCP_SCHEMA",
    rating: { asin: "B0OTHER001", status: "ready", reviewCount: 0 },
  },
  {
    name: "valid JSON with an invalid reviews consumer shape",
    providerMode: "consumer-shape",
    causeCode: "MCP_SCHEMA",
    operation: "product_reviews",
    boundary: "consumer-shape",
    rating: { status: "ready", reviewCount: 1 },
  },
]) {
  test(`${fixture.name} remains fail-closed through the review provider`, async (t) => {
    const provider = await fakeSorftimeProvider(fixture.providerMode);
    t.after(provider.close);
    const result = await runProductionReviewScript(t, provider.endpoint, {
      asin,
      marketplace: "US",
      fetchedAt: "2026-08-23",
      rating: 4.8,
      ...fixture.rating,
    });

    assert.deepEqual(provider.toolCalls().sort(), ["product_customers_say", "product_reviews"]);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, new RegExp(fixture.causeCode));
    if (fixture.operation) {
      assert.match(result.stderr, new RegExp(`"operation":"${fixture.operation}"`));
      assert.match(result.stderr, new RegExp(`"boundary":"${fixture.boundary}"`));
    }
    assert.equal(result.records[asin]?.status, "error");
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /fixture-secret/i);
  });
}

test("empty Customers Say does not discard available reviews or overwrite a successful sibling", async (t) => {
  const provider = await fakeSorftimeProvider("empty-summary-with-reviews");
  t.after(provider.close);
  const sibling = { ...readyEmpty, asin: "B0SIBLING1", sampledReviews: 5, blocks: [] };
  const result = await runProductionReviewScript(t, provider.endpoint, {
    asin, marketplace: "US", fetchedAt: "2026-09-10", status: "ready", rating: 4.5, reviewCount: 100,
  }, { existingRecords: { [sibling.asin]: sibling } });
  assert.equal(result.exitCode, 0);
  assert.equal(result.records[asin].status, "ready");
  assert.equal(result.records[asin].sampledReviews, 1);
  assert.equal(result.records[asin].mentionTopics, 0);
  assert.deepEqual(result.records[sibling.asin], sibling);
  assert.doesNotMatch(result.stderr, /MCP_SCHEMA/);
});

test("explicit no-review text remains a missing sample rather than inventing zero total reviews", async (t) => {
  const provider = await fakeSorftimeProvider("no-review-records");
  t.after(provider.close);
  const sibling = { ...readyEmpty, asin: "B0SIBLING1", sampledReviews: 5, blocks: [] };
  const result = await runProductionReviewScript(t, provider.endpoint, {
    asin, marketplace: "US", fetchedAt: "2026-09-10", status: "ready", rating: 4.5, reviewCount: 100,
  }, { existingRecords: { [sibling.asin]: sibling } });
  assert.equal(result.exitCode, 0);
  assert.equal(result.records[asin].status, "pending");
  assert.equal(deriveAsinModuleStatus(asin, statusSources(result.records)).reviews, "missing");
  assert.deepEqual(result.records[sibling.asin], sibling);
  assert.doesNotMatch(result.stderr, /MCP_SCHEMA/);
});

async function runProductionReviewScript(t, endpoint, ratingRecord, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "sorftime-review-empty-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const scriptsDirectory = path.join(directory, "scripts");
  const libraryDirectory = path.join(scriptsDirectory, "lib");
  const appDirectory = path.join(directory, "app");
  await mkdir(libraryDirectory, { recursive: true });
  await mkdir(appDirectory, { recursive: true });
  await copyFile(
    path.join(root, "scripts", "build-sorftime-review-analysis.mjs"),
    path.join(scriptsDirectory, "build-sorftime-review-analysis.mjs"),
  );
  await copyFile(
    path.join(root, "scripts", "lib", "catalog-sync.mjs"),
    path.join(libraryDirectory, "catalog-sync.mjs"),
  );
  const fixtureAsins = options.asins ?? [asin];
  const catalogRecords = options.catalogRecords ?? [{
    asin,
    productFamily: "generic",
    title: "Fixture product",
    rankCategory: "Fixture",
    subRankCategory: "Fixture",
    sellingPoints: [],
    ...options.catalog,
  }];
  await writeFile(path.join(appDirectory, "competitor-data.ts"),
    `export const refreshedCatalog = ${JSON.stringify(catalogRecords, null, 2)};\n`, "utf8");
  await writeFile(path.join(appDirectory, "sorftime-rating-data.ts"),
    `export const sorftimeRatingData = ${JSON.stringify(options.ratingRecords ?? { [asin]: ratingRecord }, null, 2)};\n`,
    "utf8");
  await writeFile(path.join(appDirectory, "sorftime-review-analysis-data.ts"),
    `export const sorftimeReviewAnalysisData = ${JSON.stringify(options.existingRecords ?? (options.existingRecord ? { [asin]: options.existingRecord } : {}), null, 2)};\n`,
    "utf8");
  const loaderPath = path.join(directory, "production-import-loader.mjs");
  await writeFile(loaderPath, productionImportLoader(), "utf8");

  const outcome = await spawnReviewScript({
    directory,
    endpoint,
    loaderPath,
    forceRefresh: options.forceRefresh ?? true,
    asins: fixtureAsins,
    hasProviderKey: options.hasProviderKey ?? true,
  });
  return {
    ...outcome,
    records: readCachedDataExport(
      path.join(appDirectory, "sorftime-review-analysis-data.ts"),
      "sorftimeReviewAnalysisData",
    ),
  };
}

function statusSources(reviews) {
  return {
    catalogAsins: [],
    keywords: {},
    reviews,
    sales: {},
    childSales: {},
    priceStrategies: {},
    fbaFees: {},
    listing: {},
    imageRemarks: {},
    categoryTrends: {},
    traffic: {},
    vocSource: "",
  };
}

function spawnReviewScript({ directory, endpoint, loaderPath, forceRefresh, asins, hasProviderKey }) {
  return new Promise((resolve, reject) => {
    const args = [
      "--experimental-loader",
      pathToFileURL(loaderPath).href,
      path.join(directory, "scripts", "build-sorftime-review-analysis.mjs"),
    ];
    if (forceRefresh) args.push("--force");
    const child = spawn(process.execPath, args, {
      cwd: directory,
      env: {
        ...process.env,
        NODE_ENV: "test",
        SORFTIME_MCP_KEY: hasProviderKey ? "fixture-secret" : "",
        SORFTIME_MCP_ENDPOINT: endpoint,
        SORFTIME_ASINS: asins.join(","),
        SORFTIME_MARKETPLACE: "US",
        AGENT_SYNC_JOB_ID: "verified-empty-fixture-job",
        AGENT_SYNC_STAGE_ID: "reviews",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}

function productionImportLoader() {
  return `import path from "node:path";
import { pathToFileURL } from "node:url";

const root = ${JSON.stringify(root)};
const mapped = new Map([
  ["sorftime-review-transform.mjs", "scripts/lib/sorftime-review-transform.mjs"],
  ["sorftime-mcp-client.mjs", "scripts/lib/sorftime-mcp-client.mjs"],
  ["sync-cache.mjs", "scripts/lib/sync-cache.mjs"],
  ["commerce-data-validity.mjs", "scripts/lib/commerce-data-validity.mjs"],
  ["sellersprite-mcp-client.mjs", "scripts/lib/sellersprite-mcp-client.mjs"],
  ["product-family.mjs", "scripts/lib/product-family.mjs"],
  ["selling-point-zh.mjs", "scripts/lib/selling-point-zh.mjs"],
  ["specification-zh.mjs", "scripts/lib/specification-zh.mjs"],
]);

export async function resolve(specifier, context, nextResolve) {
  const filename = specifier.split("/").at(-1);
  if (specifier.startsWith(".") && mapped.has(filename)) {
    return { url: pathToFileURL(path.join(root, mapped.get(filename))).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
`;
}

async function fakeSorftimeProvider(mode) {
  const calls = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    calls.push(payload?.params?.name ?? "unknown");
    if (mode === "http") {
      response.writeHead(503, { "content-type": "application/json" });
      response.end("{}");
      return;
    }
    const result = mode === "no-review-records"
      ? { jsonrpc: "2.0", id: payload.id, result: { content: [{ type: "text", text:
          payload.params.name === "product_customers_say" ? "No relevant data." : "No reviews found.",
        }] } }
      : mode === "empty-summary-with-reviews"
      ? { jsonrpc: "2.0", id: payload.id, result: { content: [{ type: "text", text:
          payload.params.name === "product_customers_say" ? "No relevant data." : JSON.stringify({ data: [
            { title: "Useful light", content: "The lamp is bright and easy to use.", star_rating: 5 },
          ] }),
        }] } }
      : mode === "schema"
      ? { jsonrpc: "2.0", id: payload.id, result: { content: [{ type: "text", text: "not-json" }] } }
      : mode === "consumer-shape"
        ? {
            jsonrpc: "2.0",
            id: payload.id,
            result: {
              content: [{
                type: "text",
                text: JSON.stringify(payload?.params?.name === "product_customers_say"
                  ? { data: { details: [] } }
                  : { data: { items: ["consumer-shape-body-sentinel"] } }),
              }],
            },
          }
      : mode === "rpc"
        ? { jsonrpc: "2.0", id: payload.id, error: { code: -32000, message: "fixture failure" } }
        : { jsonrpc: "2.0", id: payload.id, result: {} };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(result));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    endpoint: `http://127.0.0.1:${address.port}/mcp`,
    toolCalls: () => calls,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
