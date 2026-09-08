import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { AgentServiceClient, AgentServiceRequest } from "../../app/lib/agent-service-client";
import {
  createRuntimeAnalysisDataHandler,
  readGeneratedRuntimeAnalysisData,
} from "../../app/lib/runtime-analysis-data-server";
import { buildStageOutputView } from "../../app/lib/stage-output-view";
import { sifListingTrafficMeta } from "../../app/sif-listing-traffic-data";
import { RuntimeAnalysisDataSnapshotSchema } from "../../app/lib/runtime-analysis-data";
import { xydcVariantCachePath } from "../../scripts/lib/xydc-variant-cache";
import type { XydcVariantFamily } from "../../shared/xydc-variant-contract";

const projectId = "10000000-0000-4000-8000-000000000001";
const organizationId = "10000000-0000-4000-8000-000000000002";
const userId = "10000000-0000-4000-8000-000000000003";
const asins = ["B000000001", "B000000002", "B000000003"];

function familyFixture(inputAsin: string, country: string): XydcVariantFamily {
  return {
    inputAsin,
    country,
    parentAsin: "B000000010",
    dimensions: ["Color"],
    children: [],
    sourceUpdatedAt: "2026-09-04T00:00:00.000Z",
    fetchedAt: "2026-09-04T00:00:00.000Z",
    status: "ready",
    reasonCode: null,
    cacheState: "fresh",
  };
}

function projectBody() {
  return {
    project: {
      id: projectId,
      organizationId,
      name: "test",
      marketplace: "US" as const,
      asins,
      createdBy: userId,
      currentRunId: null,
      createdAt: "2026-08-31T00:00:00.000Z",
      updatedAt: "2026-08-31T00:00:00.000Z",
    },
  };
}

function agentClient(
  implementation: (request: AgentServiceRequest) => Promise<{ status: number; headers: Headers; body: unknown }>,
) {
  return implementation as unknown as AgentServiceClient;
}

test("runtime snapshot preserves project authorization and filters the requested ASINs", async () => {
  const requests: AgentServiceRequest[] = [];
  const snapshotCountries: string[] = [];
  const readSnapshot = (requestedAsins: readonly string[], country: string) => {
    snapshotCountries.push(country);
    return {
    catalog: requestedAsins.map(asin => ({ asin })),
    keywords: { analysisByAsin: {}, enrichmentByKeyword: {} },
    reviews: { analysisByAsin: { [requestedAsins[0]!]: { status: "ready" } }, ratingByAsin: {} },
    salesTrend: { trendByAsin: {} },
    fba: { feeByAsin: { [requestedAsins[0]!]: { status: "ready" } } },
    listing: { contentByAsin: {} },
    category: { trendByNode: {} },
    childSales: { rowsByAsin: {} },
    priceStrategy: { strategyByAsin: {} },
    imageRemarks: { remarksByAsin: {}, outcomesByAsin: {} },
    variants: { families: [] },
  };
  };
  const handler = createRuntimeAnalysisDataHandler({
    client: agentClient(async request => {
      requests.push(request);
      return { status: 200, headers: new Headers(), body: projectBody() };
    }),
    readSnapshot,
  });
  const result = await handler(new Request(
    `http://app.local/api/runtime-analysis-data?projectId=${projectId}&asins=${asins.join(",")}&country=CA`,
    { headers: { cookie: "session=opaque" } },
  ));
  const body = await result.json() as { catalog: Array<{ asin: string }>; variantOrders: { families: unknown[] } };

  assert.equal(result.status, 200);
  assert.deepEqual(body.catalog.map(item => item.asin), asins);
  assert.deepEqual(requests.map(request => ({ method: request.method, path: request.path })), [{
    method: "GET",
    path: `/v1/projects/${projectId}`,
  }]);
  assert.equal(new Headers(requests[0]?.headers).get("cookie"), "session=opaque");
  assert.equal(new Headers(requests[0]?.headers).get("origin"), "http://app.local");
  assert.deepEqual(snapshotCountries, ["US"]);
  assert.deepEqual(body.variantOrders, { families: [] });
  assert.equal(JSON.stringify(body).includes("formal-stack.env"), false);
  assert.equal(JSON.stringify(body).includes("cookie"), false);
});

for (const upstreamStatus of [401, 404] as const) {
  test(`runtime snapshot preserves upstream ${upstreamStatus}`, async () => {
    const handler = createRuntimeAnalysisDataHandler({
      client: agentClient(async () => ({
        status: upstreamStatus,
        headers: new Headers(),
        body: { error: "denied" },
      })),
      readSnapshot: () => { throw new Error("must not read files"); },
    });
    const result = await handler(new Request(
      `http://app.local/api/runtime-analysis-data?projectId=${projectId}&asins=${asins.join(",")}`,
    ));

    assert.equal(result.status, upstreamStatus);
    assert.deepEqual(await result.json(), { error: "denied" });
  });
}

test("runtime snapshot rejects an ASIN scope mismatch before reading files", async () => {
  let reads = 0;
  const handler = createRuntimeAnalysisDataHandler({
    client: agentClient(async () => ({ status: 200, headers: new Headers(), body: projectBody() })),
    readSnapshot: () => { reads += 1; throw new Error("unexpected"); },
  });
  const result = await handler(new Request(
    `http://app.local/api/runtime-analysis-data?projectId=${projectId}&asins=B000000004,B000000005,B000000006`,
  ));

  assert.equal(result.status, 409);
  assert.equal(reads, 0);
});

test("verified done and partial stage outputs both overlay runtime fallbacks", () => {
  const fallbackFee = { status: "ready", fbaFee: 4.25 };
  const doneFee = { status: "ready", fbaFee: 8.75 };
  const fallbacks = {
    keywordAnalysisByAsin: {},
    keywordEnrichmentByKeyword: {},
    reviewAnalysisByAsin: {},
    ratingByAsin: {},
    salesTrendByAsin: {},
    fbaFeeByAsin: { [asins[0]!]: fallbackFee },
    listingContentByAsin: {},
    categoryTrendByNode: {},
    childSalesByAsin: {},
    priceStrategyByAsin: {},
    imageRemarksByAsin: {},
    imageRemarkOutcomesByAsin: {},
    trafficData: { overview: {}, monthlyTrend: {}, meta: sifListingTrafficMeta },
  };
  const done = buildStageOutputView({
    fba: { stage: "fba", stageStatus: "done", data: { feeByAsin: { [asins[0]!]: doneFee } } },
  } as never, fallbacks);
  const partial = buildStageOutputView({
    fba: {
      stage: "fba", stageStatus: "partial", data: { feeByAsin: { [asins[0]!]: doneFee } },
      gap: { state: "partial", reasonCode: "UPSTREAM_EMPTY" },
    },
  } as never, fallbacks);

  assert.equal(done.fbaFeeByAsin[asins[0]!], doneFee);
  assert.equal(partial.fbaFeeByAsin[asins[0]!], doneFee);
});

test("runtime snapshot carries the three published late-stage maps", () => {
  const snapshot = RuntimeAnalysisDataSnapshotSchema.parse({
    catalog: [], keywords: { analysisByAsin: {}, enrichmentByKeyword: {} }, reviews: { analysisByAsin: {}, ratingByAsin: {} },
    salesTrend: { trendByAsin: {} }, fba: { feeByAsin: {} }, listing: { contentByAsin: {} }, category: { trendByNode: {} },
    childSales: { rowsByAsin: { B000000001: [] } }, priceStrategy: { strategyByAsin: { B000000001: { anchor: "value" } } },
    imageRemarks: { remarksByAsin: { B000000001: [{ remark: "image" }] }, outcomesByAsin: { B000000001: [{ status: "ready" }] } },
    variants: { families: [] },
  });
  assert.deepEqual(snapshot.imageRemarks.outcomesByAsin.B000000001, [{ status: "ready" }]);
});

test("runtime snapshot accepts historic payloads without variants", () => {
  const snapshot = RuntimeAnalysisDataSnapshotSchema.parse({
    catalog: [], keywords: { analysisByAsin: {}, enrichmentByKeyword: {} }, reviews: { analysisByAsin: {}, ratingByAsin: {} },
    salesTrend: { trendByAsin: {} }, fba: { feeByAsin: {} }, listing: { contentByAsin: {} }, category: { trendByNode: {} },
    childSales: { rowsByAsin: {} }, priceStrategy: { strategyByAsin: {} },
    imageRemarks: { remarksByAsin: {}, outcomesByAsin: {} },
  });

  assert.deepEqual(snapshot.variants, { families: [] });
});

test("runtime snapshot returns only variant families bound to requested input ASINs", () => {
  const snapshot = readGeneratedRuntimeAnalysisData(asins, "US", {
    readVariantFamilies: (requested, country) => requested.map(inputAsin => familyFixture(inputAsin, country)),
  });

  assert.deepEqual(snapshot.variants.families.map(item => item.inputAsin), asins);
  assert.equal(snapshot.variants.families.some(item => item.inputAsin === "B000000099"), false);
});

test("production variant reader accepts only requested cache files with matching input ASIN and country", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "xydc-runtime-reader-"));
  const scopedAsins = ["B000000001", "B000000002", "B000000003", "B000000004"];
  const previousDataRoot = process.env.AGENT_DATA_ROOT;
  try {
    await mkdir(path.dirname(xydcVariantCachePath(dataRoot, "US", scopedAsins[0]!)), { recursive: true });
    await writeFile(xydcVariantCachePath(dataRoot, "US", scopedAsins[0]!), JSON.stringify(familyFixture(scopedAsins[0]!, "US")));
    await writeFile(xydcVariantCachePath(dataRoot, "US", scopedAsins[1]!), JSON.stringify(familyFixture("B000000099", "US")));
    await writeFile(xydcVariantCachePath(dataRoot, "US", scopedAsins[2]!), JSON.stringify(familyFixture(scopedAsins[2]!, "CA")));
    await writeFile(xydcVariantCachePath(dataRoot, "US", scopedAsins[3]!), "{");
    await writeFile(xydcVariantCachePath(dataRoot, "US", "B000000005"), JSON.stringify(familyFixture("B000000005", "US")));
    process.env.AGENT_DATA_ROOT = dataRoot;

    const snapshot = readGeneratedRuntimeAnalysisData(scopedAsins, "US");

    assert.deepEqual(snapshot.variants.families.map(item => item.inputAsin), [scopedAsins[0]]);
    assert.equal(snapshot.variants.families.some(item => item.inputAsin === "B000000005"), false);
  } finally {
    if (previousDataRoot === undefined) delete process.env.AGENT_DATA_ROOT;
    else process.env.AGENT_DATA_ROOT = previousDataRoot;
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("production generated reader stays inside the requested scope without exposing source paths", () => {
  const requested = ["B07VY9Q95Q", "B088TY63YB", "B0924QGCDW"];
  const requestedSet = new Set(requested);
  const snapshot = readGeneratedRuntimeAnalysisData(requested, "US");
  const asinMaps = [
    snapshot.keywords.analysisByAsin,
    snapshot.reviews.analysisByAsin,
    snapshot.reviews.ratingByAsin,
    snapshot.salesTrend.trendByAsin,
    snapshot.fba.feeByAsin,
    snapshot.listing.contentByAsin,
  ];

  assert.ok(
    snapshot.catalog.length + asinMaps.reduce((count, map) => count + Object.keys(map).length, 0) > 0,
    "the production boundary assertion must exercise at least one generated record",
  );

  assert.equal(snapshot.catalog.every(item => {
    const asin = item && typeof item === "object" && !Array.isArray(item)
      ? (item as { asin?: unknown }).asin
      : null;
    return typeof asin === "string" && requestedSet.has(asin);
  }), true);
  assert.equal(asinMaps.every(map => Object.keys(map).every(asin => requestedSet.has(asin))), true);
  for (const rawTrend of Object.values(snapshot.category.trendByNode)) {
    const trend = rawTrend as { asins?: unknown };
    assert.equal(Array.isArray(trend.asins) && trend.asins.every(asin => typeof asin === "string" && requestedSet.has(asin)), true);
  }
  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes("competitor-data.ts"), false);
  assert.equal(serialized.includes("formal-stack.env"), false);
  assert.equal(serialized.includes("AGENT_SERVICE_PROXY_TOKEN"), false);
});
