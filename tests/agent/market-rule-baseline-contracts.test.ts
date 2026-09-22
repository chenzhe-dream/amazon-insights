import assert from "node:assert/strict";
import test from "node:test";

import { normalizeMarketRuleBaseline } from "../../shared/market-rule-baseline-contracts";

const scope = {
  organizationId: "org-1",
  researchId: "11111111-1111-4111-8111-111111111111",
  marketplace: "US" as const,
  nodeIdPath: "1064954:1069242",
  fromMonth: "2026-08",
  toMonth: "2026-08",
  currency: "USD" as const,
};

const outsideScope = { ...scope, researchId: "22222222-2222-4222-8222-222222222222" };

const evidence = { id: "source-record-1", scope };

function baseline(overrides: Record<string, unknown> = {}) {
  return {
    module: "overview",
    ruleVersion: "market-rule-baseline/v1",
    scope,
    status: "complete",
    metrics: [],
    facts: [],
    missing: [],
    evidenceRefs: [evidence],
    ...overrides,
  };
}

function metric(overrides: Record<string, unknown> = {}) {
  return {
    key: "sampleMonthlySales",
    value: 1_422_413,
    unit: "count",
    denominator: 100,
    status: "complete",
    missingReason: null,
    evidenceRefs: [evidence],
    ...overrides,
  };
}

test("known values keep their number and in-scope evidence", () => {
  const parsed = normalizeMarketRuleBaseline(baseline({
    metrics: [metric()],
    facts: [{ id: "fact-sales", label: "样本月销量", value: 1_422_413, status: "complete", sourceRefs: [evidence] }],
  }));
  assert.equal(parsed.metrics[0]?.value, 1_422_413);
  assert.equal(parsed.metrics[0]?.missingReason, null);
  assert.equal(parsed.metrics[0]?.evidenceRefs[0]?.id, "source-record-1");
  assert.equal(parsed.facts[0]?.value, 1_422_413);
  assert.throws(() => normalizeMarketRuleBaseline(baseline({
    metrics: [metric({ evidenceRefs: [] })],
    evidenceRefs: [],
  })));
});

test("missing values stay null with a reason and cannot be stored as zero", () => {
  const parsed = normalizeMarketRuleBaseline(baseline({
    status: "partial",
    metrics: [
      metric(),
      metric({
        key: "searchDemand",
        value: null,
        denominator: null,
        status: "unavailable",
        missingReason: "market_product_demand_trend empty",
        evidenceRefs: [],
      }),
    ],
    missing: [{ key: "searchDemand", reason: "market_product_demand_trend empty" }],
  }));
  assert.equal(parsed.metrics[1]?.value, null);
  assert.equal(parsed.metrics[1]?.missingReason, "market_product_demand_trend empty");
  assert.equal(parsed.status, "partial");
  assert.throws(() => normalizeMarketRuleBaseline(baseline({
    status: "partial",
    metrics: [metric({
      key: "searchDemand",
      value: 0,
      denominator: null,
      status: "unavailable",
      missingReason: "market_product_demand_trend empty",
      evidenceRefs: [],
    })],
    missing: [{ key: "searchDemand", reason: "market_product_demand_trend empty" }],
    evidenceRefs: [],
  })));
});

test("a real zero stays zero when evidence is in scope", () => {
  const parsed = normalizeMarketRuleBaseline(baseline({
    metrics: [metric({ key: "abaClicks", value: 0, denominator: 12, unit: "count" })],
  }));
  assert.equal(parsed.metrics[0]?.value, 0);
  assert.equal(parsed.metrics[0]?.status, "complete");
  assert.equal(parsed.metrics[0]?.missingReason, null);
  assert.equal(parsed.missing.length, 0);
});

test("out-of-scope evidence is rejected", () => {
  const outside = { id: "source-record-outside", scope: outsideScope };
  assert.throws(() => normalizeMarketRuleBaseline(baseline({
    metrics: [metric({ evidenceRefs: [outside] })],
    evidenceRefs: [outside],
  })));
  assert.throws(() => normalizeMarketRuleBaseline(baseline({
    facts: [{ id: "fact-outside", label: "范围外", value: 1, status: "complete", sourceRefs: [outside] }],
  })));
});
