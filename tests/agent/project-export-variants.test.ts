import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

import { RuntimeAnalysisDataSnapshotSchema } from "../../app/lib/runtime-analysis-data";
import { readGeneratedRuntimeAnalysisData } from "../../app/lib/runtime-analysis-data-server";
import { readVariantsSnapshot } from "../../app/project-export/read-variants-export";
import { getXydcOrderWindow } from "../../shared/xydc-order-summary";
import { xydcVariantCachePath } from "../../scripts/lib/xydc-variant-cache";
import { xydcOrderCachePath } from "../../scripts/lib/xydc-order-cache";

const asins = ["B000000001", "B000000002", "B000000003"];
const children = ["B000000011", "B000000012", "B000000013", "B000000014"];
const capturedAt = "2026-09-24T10:00:00.000Z";
const window = getXydcOrderWindow(new Date(capturedAt));
const family = (inputAsin: string) => ({
  inputAsin, country: "US", parentAsin: "B000000010", dimensions: ["Color"],
  children: children.map((asin, index) => ({ asin, attributes: [{ dimension: "Color", value: index === 0 ? "Red" : "Blue", labelZh: index === 0 ? "红色" : "蓝色" }],
    title: `Child ${index}`, imageUrl: `https://example.com/${asin}.jpg`, price: 10 + index, currency: "USD",
    stars: 4, productPageRatings: 5, listingDate: null, infoStatus: "ready" as const })),
  sourceUpdatedAt: capturedAt, fetchedAt: capturedAt, status: "ready" as const, reasonCode: null, cacheState: "fresh" as const,
});
function snapshot() {
  return RuntimeAnalysisDataSnapshotSchema.parse({
    catalog: [], keywords: { analysisByAsin: {}, enrichmentByKeyword: {} }, reviews: { analysisByAsin: {}, ratingByAsin: {} },
    salesTrend: { trendByAsin: {} }, fba: { feeByAsin: {} }, listing: { contentByAsin: {} }, category: { trendByNode: {} },
    childSales: { rowsByAsin: {} }, priceStrategy: { strategyByAsin: {} }, imageRemarks: { remarksByAsin: {}, outcomesByAsin: {} },
    variants: { families: [family(asins[0]!), family(asins[1]!)] },
    variantOrders: { families: [{ version: 1, source: "xydc", aggregation: "children", country: "US", parentAsin: "B000000010", childAsins: children,
      window, children: children.map((asin, index) => ({ asin, fetchedAt: capturedAt, reasonCode: index === 3 ? "PARTIAL_DATA" : null,
        trends: window.months.filter((_, monthIndex) => index !== 3 || monthIndex !== 0).map((date, monthIndex) => ({ date, orders: index === 0 && monthIndex === 0 ? 0 : index + 1 })) })),
      sourceUpdatedAt: capturedAt, fetchedAt: capturedAt, cacheState: "fresh", reasonCode: "PARTIAL_DATA" }] },
    exportScope: { projectId: "project", organizationId: "org", marketplace: "US", asins, readAt: capturedAt, contentHash: "a".repeat(64) },
  });
}
const context = { projectId: "project", organizationId: "org", marketplace: "US", asins: [asins[0]!], sourceAsins: asins,
  currentRunId: null, version: null, capturedAt };

test("reader checks authorization scope and rejects cache changes between strict reads", async () => {
  const first = snapshot();
  let calls = 0;
  const read = async (url: string, init?: RequestInit) => {
    assert.match(url, /exportStrict=1/);
    assert.match(url, /B000000003/);
    assert.equal(init?.method, "GET");
    calls += 1;
    const value = structuredClone(first);
    if (calls === 2) value.variants.families[0]!.children[0]!.attributes[0]!.labelZh = "深红色";
    return Response.json(value);
  };
  await assert.rejects(readVariantsSnapshot(context, read), /缓存正在变化/);
  assert.equal(calls, 2);
  await assert.rejects(readVariantsSnapshot({ ...context, organizationId: "other" }, async () => Response.json(first)), /来源范围/);
});

test("strict cache reads distinguish absent files from malformed variant and order caches", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "xydc-export-strict-"));
  const oldRoot = process.env.AGENT_DATA_ROOT;
  process.env.AGENT_DATA_ROOT = dataRoot;
  try {
    const missing = readGeneratedRuntimeAnalysisData(asins, "US", { strictCacheRead: true });
    assert.deepEqual(missing.variants.families, []);
    const variantPath = xydcVariantCachePath(dataRoot, "US", asins[0]!);
    await mkdir(path.dirname(variantPath), { recursive: true });
    await writeFile(variantPath, "{");
    assert.throws(() => readGeneratedRuntimeAnalysisData(asins, "US", { strictCacheRead: true }));
    await writeFile(variantPath, JSON.stringify(family(asins[0]!)));
    const labelId = createHash("sha256").update(JSON.stringify(["color", "red"])).digest("hex");
    const labelPath = path.join(dataRoot, "xydc-labels", "v1", `${labelId}.json`);
    await mkdir(path.dirname(labelPath), { recursive: true });
    await writeFile(labelPath, "{");
    assert.throws(() => readGeneratedRuntimeAnalysisData(asins, "US", { strictCacheRead: true }));
    await rm(labelPath);
    const orderPath = xydcOrderCachePath(dataRoot, family(asins[0]!), window);
    await mkdir(path.dirname(orderPath), { recursive: true });
    await writeFile(orderPath, "{");
    assert.throws(() => readGeneratedRuntimeAnalysisData(asins, "US", { strictCacheRead: true }));
    const ordinary = readGeneratedRuntimeAnalysisData(asins, "US");
    assert.equal(ordinary.variants.families.length, 1);
    assert.deepEqual(ordinary.variantOrders.families, []);
  } finally {
    if (oldRoot === undefined) delete process.env.AGENT_DATA_ROOT;
    else process.env.AGENT_DATA_ROOT = oldRoot;
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("strict export rejects an unconfigured cache directory without calling collectors", () => {
  const oldRoot = process.env.AGENT_DATA_ROOT;
  try {
    delete process.env.AGENT_DATA_ROOT;
    assert.throws(() => readGeneratedRuntimeAnalysisData(asins, "US", { strictCacheRead: true }), /缓存目录/);
    process.env.AGENT_DATA_ROOT = "relative-cache";
    assert.throws(() => readGeneratedRuntimeAnalysisData(asins, "US", { strictCacheRead: true }), /缓存目录/);
  } finally {
    if (oldRoot === undefined) delete process.env.AGENT_DATA_ROOT;
    else process.env.AGENT_DATA_ROOT = oldRoot;
  }
});
