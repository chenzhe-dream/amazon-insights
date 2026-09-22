import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildMarketOverviewCompleteCatalog } from "../../server/domain/market-research/overview-complete-catalog";
import { buildOverviewRuleBaseline } from "../../server/domain/market-research/overview-rule-baseline";
import { projectMarketOverviewDistribution } from "../../server/services/market-overview-distribution-collector";

const scope = {
  organizationId: "org-1",
  researchId: "11111111-1111-4111-8111-111111111111",
  marketplace: "US" as const,
  currency: "USD" as const,
  nodeIdPath: "1:2",
  fromMonth: "2026-08",
  toMonth: "2026-08",
};
const cutoff = "2026-09-12T00:00:00.000Z";
const parameters = { headTopN: 10 as const, newProductMonths: 6 as const };

function source(operation: "market_brand_concentration" | "market_price_distribution", data: unknown[]) {
  const projected = projectMarketOverviewDistribution({
    scope,
    month: "2026-08",
    operation,
    ...parameters,
    payload: { data } as never,
    fetchedAt: cutoff,
    now: new Date(cutoff),
  });
  assert.ok(projected.evidence);
  return projected.evidence;
}

test("complete overview catalog keeps a real zero and in-scope evidence", () => {
  const catalog = buildMarketOverviewCompleteCatalog({
    scope,
    parameters,
    dataCutoffAt: cutoff,
    sources: [source("market_price_distribution", [
      { label: "low", products: 1, asins: ["B000000001"], units: 0 },
      { label: "high", products: 1, asins: ["B000000002"], units: 4 },
    ])],
  });
  const first = buildOverviewRuleBaseline(catalog);
  const second = buildOverviewRuleBaseline(catalog);
  assert.deepEqual(second, first);
  assert.equal(first.module, "overview");
  assert.equal(first.ruleVersion, catalog.version);
  assert.equal(first.ruleVersion.includes("synthesis"), false);
  const zero = first.metrics.find(metric => metric.value === 0);
  assert.ok(zero);
  assert.equal(zero.missingReason, null);
  assert.ok(zero.evidenceRefs.length > 0);
  assert.equal(first.status, "partial");
});

test("empty demand trend and unconfirmed concentration stay missing", () => {
  const catalog = buildMarketOverviewCompleteCatalog({
    scope,
    parameters,
    dataCutoffAt: cutoff,
    sources: [source("market_brand_concentration", [
      { label: "bucket-0", brand: "brand-0", asins: ["B000000000"], products: 1, units: 2, totalUnits: 2, unitsRatio: 999 },
    ])],
  });
  const baseline = buildOverviewRuleBaseline(catalog);
  assert.equal(baseline.missing.some(item => item.reason === "unit-unknown" || item.reason === "not-collected"), true);
  assert.equal(baseline.metrics.some(metric => metric.value === null && metric.missingReason !== null), true);
  assert.equal(baseline.metrics.some(metric => metric.value === 0 && metric.missingReason !== null), false);
});

test("a catalog with no deterministic facts is unavailable and does not claim synthesis", () => {
  const catalog = buildMarketOverviewCompleteCatalog({ scope, parameters, dataCutoffAt: cutoff, sources: [] });
  const baseline = buildOverviewRuleBaseline(catalog);
  assert.equal(baseline.status, "unavailable");
  assert.equal(baseline.metrics.length, 0);
  assert.equal(baseline.missing[0]?.reason, "saved overview catalog has no deterministic facts");
  assert.equal(baseline.ruleVersion, catalog.version);
});

test("overview baseline builder does not import model runtime or source connectors", () => {
  const sourceText = readFileSync(new URL("../../server/domain/market-research/overview-rule-baseline.ts", import.meta.url), "utf8");
  assert.equal(/market-model-runtime|mcp-connectors|sellersprite|sorftime|sif-mcp|overview-synthesis/.test(sourceText), false);
});
