import assert from "node:assert/strict";
import test from "node:test";
import { projectMarketOverviewOriginalSynthesis } from "../../server/domain/market-research/overview-original-synthesis";
import { createMarketSourceEvidence } from "../../server/domain/market-research/source-evidence";
import { MARKET_SYNTHESIS_DIMENSIONS } from "../../server/domain/market-research/original-overview/sellersprite-market-overview-synthesis";
import { MARKET_OVERVIEW_ZIP_DIMENSIONS, MARKET_OVERVIEW_ZIP_GRADE_THRESHOLDS, MARKET_OVERVIEW_ZIP_SCORE_MAX } from "../../shared/market-overview-zip-baseline";
import { randomUUID } from "node:crypto";

test("ZIP score report declares the frozen zip-code-v1 rule baseline", () => {
  const scope = {
    organizationId: randomUUID(),
    researchId: randomUUID(),
    marketplace: "US" as const,
    nodeIdPath: "123:456",
    fromMonth: "2026-07",
    toMonth: "2026-08",
    currency: "USD" as const,
  };
  const evidence = createMarketSourceEvidence({
    scope,
    provider: "sellerSprite",
    operation: "market_research",
    requestIdentity: { nodeIdPath: scope.nodeIdPath, marketplace: scope.marketplace, month: scope.toMonth },
    responseIdentityPaths: { nodeIdPath: [["data", "items", 0, "nodeIdPath"]], month: [["data", "items", 0, "month"]] },
    payload: { code: "OK", data: { items: [{ nodeIdPath: scope.nodeIdPath, month: scope.toMonth, totalUnits: 50_000, avgPrice: 50, top10ProductCrn: 0.3, top10BrandCrn: 0.35, top10SellerCrn: 0.25, l6NewRatio: 0.2, l6NewAvgSales: 100 }] } },
    fetchedAt: "2026-10-07T00:00:00.000Z",
    observationPeriod: { kind: "calendar-months", fromMonth: scope.toMonth, toMonth: scope.toMonth },
    units: {},
    coverage: { receivedCount: 1, expectedCount: 1, truncation: { status: "not-truncated" } },
  });
  const result = projectMarketOverviewOriginalSynthesis({
    scope,
    parameters: { headTopN: 10, newProductMonths: 6 },
    sources: [evidence],
  });

  assert.equal(result.summary.ruleVersion, "zip-code-v1");
});

test("ZIP score contract preserves dimension caps, grade thresholds, and reachable total", () => {
  assert.deepEqual(MARKET_OVERVIEW_ZIP_DIMENSIONS, MARKET_SYNTHESIS_DIMENSIONS.map(({ key, max }) => ({ key, max })));
  assert.deepEqual(MARKET_OVERVIEW_ZIP_GRADE_THRESHOLDS, [80, 70, 60, 50, 40]);
  assert.equal(MARKET_OVERVIEW_ZIP_SCORE_MAX, 97);
});
