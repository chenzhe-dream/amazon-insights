import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildCustomerThemeRuleBaseline } from "../../server/domain/market-research/customer-theme-rule-baseline";
import { buildKeywordRuleBaseline } from "../../server/domain/market-research/keyword-rule-baseline";
import { buildShapePriceRuleBaseline } from "../../server/domain/market-research/shape-price-rule-baseline";

const scope = {
  organizationId: "org-1",
  researchId: "11111111-1111-4111-8111-111111111111",
  marketplace: "US" as const,
  nodeIdPath: "1:2",
  fromMonth: "2026-08",
  toMonth: "2026-08",
  currency: "USD" as const,
};
const sourceSnapshot = {
  snapshotId: "market-input:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  sourceVersion: "frozen-source/v1",
  records: [{ id: "record-1", scope }],
};

test("shape baseline keeps a real zero and leaves image, margin, and returns missing", () => {
  const baseline = buildShapePriceRuleBaseline({
    scope,
    sourceSnapshot,
    revisionId: "revision-1",
    analysisInput: {
      months: ["2026-08"],
      bands: [{ id: "low", minInclusive: 0, maxExclusive: 20 }],
      products: [
        { asin: "B000000001", shape: "pen", price: 3, brand: "a", monthlySales: [{ month: "2026-08", units: 0 }] },
        { asin: "B000000002", shape: "pen", price: null, brand: "b", monthlySales: [{ month: "2026-08", units: 5 }] },
      ],
    },
  });
  assert.equal(baseline.metrics.find(metric => metric.key === "totalUnits")?.value, 0);
  assert.equal(baseline.metrics.find(metric => metric.key === "imageShape")?.value, null);
  assert.equal(baseline.metrics.find(metric => metric.key === "margin")?.missingReason, "cost inputs are not collected");
  assert.equal(baseline.metrics.find(metric => metric.key === "returnRate")?.value, null);
  assert.equal(baseline.facts[0]?.value, "revision-1");
  assert.equal(baseline.status, "partial");
});

test("keyword baseline keeps calendar three-month growth and does not rename recommended bid to CPC", () => {
  const baseline = buildKeywordRuleBaseline({
    scope,
    sourceSnapshot,
    revisionId: null,
    clusterCount: 2,
    coveredClusterCount: 1,
    keywords: [{
      keywordId: "gel-pen",
      searchVolume: 120,
      searchVolumeReason: null,
      threeMonthGrowth: null,
      threeMonthReason: "missing-baseline",
    }],
  });
  assert.equal(baseline.ruleVersion.startsWith("calendar-three-month-growth/v1"), true);
  assert.equal(baseline.metrics.find(metric => metric.key === "gel-pen:searchVolume")?.value, 120);
  assert.equal(baseline.metrics.find(metric => metric.key === "gel-pen:threeMonthGrowth")?.missingReason, "missing-baseline");
  assert.equal(baseline.metrics.find(metric => metric.key === "cpc")?.value, null);
  assert.equal(baseline.metrics.find(metric => metric.key === "cpc")?.missingReason, "source-provides-recommended-bid-only");
  assert.equal(baseline.facts[0]?.value, "1/2");
});

test("keyword pool baseline leaves cluster coverage missing until clustering runs", () => {
  const baseline = buildKeywordRuleBaseline({
    scope,
    sourceSnapshot,
    revisionId: null,
    clusterCount: 2,
    coveredClusterCount: null,
    keywords: [{
      keywordId: "gel-pen",
      searchVolume: 120,
      searchVolumeReason: null,
      threeMonthGrowth: null,
      threeMonthReason: "missing-baseline",
    }],
  });
  assert.equal(baseline.facts[0]?.value, null);
  assert.equal(baseline.facts[0]?.status, "unavailable");
  assert.equal(baseline.missing.some(item => item.key === "cluster-coverage"), true);
});

test("keyword pool baseline is unavailable when every rule metric is missing", () => {
  const baseline = buildKeywordRuleBaseline({
    scope,
    sourceSnapshot,
    revisionId: null,
    clusterCount: 0,
    coveredClusterCount: null,
    keywords: [{
      keywordId: "gel-pen",
      searchVolume: null,
      searchVolumeReason: "missing-completed-month-volume",
      threeMonthGrowth: null,
      threeMonthReason: "missing-baseline",
    }],
  });
  assert.equal(baseline.status, "unavailable");
});

test("theme baseline counts Customers Say observations and rebuilds after an exclusion", () => {
  const sourcePool = {
    selectedAsins: ["B000000001", "B000000002"],
    mappings: [],
    results: [
      {
        asin: "B000000001",
        status: "success" as const,
        source: { sourceRecordId: "record-1", fetchedAt: "2026-09-01T00:00:00.000Z", sourceUpdatedAt: null },
        themes: [{ sourceThemeId: "ink", keyword: "ink", content: "dries fast", mention: 4, positive: 3, negative: 2 }],
      },
      {
        asin: "B000000002",
        status: "success" as const,
        source: { sourceRecordId: "record-2", fetchedAt: "2026-09-01T00:00:00.000Z", sourceUpdatedAt: null },
        themes: [{ sourceThemeId: "grip", keyword: "grip", content: "slips", mention: 1, positive: 0, negative: 1 }],
      },
    ],
  };
  const full = buildCustomerThemeRuleBaseline({ scope, sourceSnapshot, sourcePool, excludedAsins: [] });
  const excluded = buildCustomerThemeRuleBaseline({ scope, sourceSnapshot, sourcePool, excludedAsins: ["B000000002"] });
  assert.equal(full.metrics.find(metric => metric.key === "mention")?.value, 5);
  assert.equal(excluded.metrics.find(metric => metric.key === "mention")?.value, 4);
  assert.equal(excluded.metrics.find(metric => metric.key === "positive")?.value, 3);
  assert.equal(excluded.metrics.find(metric => metric.key === "negative")?.value, 2);
  assert.equal(excluded.facts[0]?.value, "not_assumed_disjoint");
  assert.equal(excluded.metrics.find(metric => metric.key === "uniqueReviews")?.missingReason, "Customers Say observations are not deduplicated reviews");
});

test("module baseline adapters do not import model runtime or source connectors", () => {
  for (const file of ["shape-price-rule-baseline.ts", "keyword-rule-baseline.ts", "customer-theme-rule-baseline.ts"]) {
    const sourceText = readFileSync(new URL(`../../server/domain/market-research/${file}`, import.meta.url), "utf8");
    assert.equal(/market-model-runtime|mcp-connectors|sellersprite|sorftime|sif-mcp/.test(sourceText), false);
  }
});
