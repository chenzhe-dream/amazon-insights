import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";

import { buildMarketRuleBaseline } from "../../server/domain/market-research/market-rule-baseline";

const scope = {
  organizationId: "org-1",
  researchId: "11111111-1111-4111-8111-111111111111",
  marketplace: "US" as const,
  nodeIdPath: "1064954:1069242",
  fromMonth: "2026-08",
  toMonth: "2026-08",
  currency: "USD" as const,
};

const input = {
  module: "overview" as const,
  scope,
  sourceSnapshot: {
    snapshotId: "market-input:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    sourceVersion: "sellersprite-overview/v1",
    records: [{ id: "sales-record", scope }, { id: "empty-demand", scope }],
  },
  projection: {
    ruleVersion: "overview-catalog/v1",
    status: "partial" as const,
    metrics: [
      {
        key: "sampleMonthlySales",
        value: 1_422_413,
        unit: "count",
        denominator: 100,
        status: "complete" as const,
        missingReason: null,
        evidenceRecordIds: ["sales-record"],
      },
      {
        key: "searchDemand",
        value: null,
        unit: "count",
        denominator: null,
        status: "unavailable" as const,
        missingReason: "market_product_demand_trend empty",
        evidenceRecordIds: [],
      },
    ],
    facts: [],
    missing: [{ key: "searchDemand", reason: "market_product_demand_trend empty" }],
  },
};

test("assembly is deterministic and keeps missing reasons on replay", () => {
  const first = buildMarketRuleBaseline(input);
  const second = buildMarketRuleBaseline(structuredClone(input));
  assert.deepEqual(second, first);
  assert.equal(first.ruleVersion, "overview-catalog/v1");
  assert.equal(first.metrics[0]?.value, 1_422_413);
  assert.equal(first.metrics[0]?.evidenceRefs[0]?.id, "market-input:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:sales-record");
  assert.equal(first.metrics[1]?.value, null);
  assert.equal(first.metrics[1]?.missingReason, "market_product_demand_trend empty");
  assert.equal(first.status, "partial");
});

test("assembly rejects evidence that is not in the frozen snapshot", () => {
  assert.throws(() => buildMarketRuleBaseline({
    ...input,
    projection: {
      ...input.projection,
      metrics: [{ ...input.projection.metrics[0]!, evidenceRecordIds: ["not-in-snapshot"] }, input.projection.metrics[1]!],
    },
  }));
});

test("assembly does not import model runtime or source connectors", () => {
  const source = readFileSync(new URL("../../server/domain/market-research/market-rule-baseline.ts", import.meta.url), "utf8");
  assert.equal(/market-model-runtime|mcp-connectors|sellersprite|sorftime|sif-mcp/.test(source), false);
});
