import assert from "node:assert/strict";
import test from "node:test";

import { selectUkReviewFallbackAsins, selectReviewEvidence, sellerSpriteReviewMarkets } from "../../scripts/lib/uk-review-fallback.mjs";
import { projectStageOutput } from "../../scripts/lib/sync-stage-output.mjs";
import { deriveAsinModuleStatus } from "../../scripts/lib/asin-data-status.mjs";

const asin = "B0C6FP6LMY";
const empty = { asin, marketplace: "UK", status: "pending", terminalReason: "valid-empty", sampledReviews: 0, mentionTopics: 0, fetchedAt: "2026-10-21", blocks: [] };
const ready = { asin, marketplace: "UK", status: "ready", sampledReviews: 8, fetchedAt: "2026-10-21", blocks: [{ key: "positives", rows: [{ label: "fun", sharePct: 25, metricKind: "review_sample_incidence", numerator: 2, denominator: 8, reason: "fun" }] }] };

test("UK opt-in selects only exact ASINs with a valid Sorftime empty observation", () => {
  assert.deepEqual(selectUkReviewFallbackAsins([asin, "B0GHQW7GYY"], { [asin]: empty }, { marketplace: "UK", enabled: true }), [asin]);
  assert.deepEqual(selectUkReviewFallbackAsins([asin], { [asin]: empty }, { marketplace: "UK", enabled: false }), []);
  assert.deepEqual(selectUkReviewFallbackAsins([asin], { [asin]: empty }, { marketplace: "US", enabled: true }), []);
  assert.deepEqual(selectUkReviewFallbackAsins([asin], { [asin]: { ...empty, asin: "B000000001" } }, { marketplace: "UK", enabled: true }), []);
});

test("project UK evidence uses SellerSprite UK request identity", () => {
  assert.deepEqual(sellerSpriteReviewMarkets({ AGENT_SYNC_MARKETPLACE: "UK" }), { project: "UK", provider: "UK" });
  assert.deepEqual(sellerSpriteReviewMarkets({ SELLERSPRITE_MARKETPLACE: "US" }), { project: "US", provider: "US" });
});

test("usable Sorftime, errors, and unverified pending observations never trigger fallback", () => {
  for (const record of [ready, { ...empty, status: "error" }, { ...empty, terminalReason: undefined }, { ...empty, marketplace: "US" }, { ...empty, sampledReviews: 1 }]) {
    assert.deepEqual(selectUkReviewFallbackAsins([asin], { [asin]: record }, { marketplace: "UK", enabled: true }), []);
  }
});

test("review evidence keeps the provider and does not replace usable Sorftime or accept wrong identity", () => {
  assert.deepEqual(selectReviewEvidence(asin, "UK", ready, { ...ready, sourceProvider: "sellerSprite" }), { ...ready, sourceProvider: "sorftime" });
  assert.deepEqual(selectReviewEvidence(asin, "UK", empty, ready), { ...ready, sourceProvider: "sellerSprite" });
  assert.equal(selectReviewEvidence(asin, "UK", empty, { ...ready, marketplace: "US" }), null);
  assert.equal(selectReviewEvidence(asin, "UK", empty, { ...ready, asin: "B000000001" }), null);
});

test("partial seven-ASIN stage projects only real SellerSprite fallback with explicit provenance", () => {
  const asins = [asin, "B0GHQW7GYY", "B0TEST0001", "B0TEST0002", "B0TEST0003", "B0TEST0004", "B0TEST0005"];
  const readExport = (_file, name) => name === "sorftimeReviewAnalysisData" ? { [asin]: empty }
    : name === "sellerSpriteMcpReviewAnalysisData" ? { [asin]: ready }
    : name === "sorftimeRatingData" ? {} : {};
  const output = projectStageOutput("reviews", asins, { marketplace: "UK", ukSellerSpriteReviewFallback: true,
    stageStatus: "partial", dataAsins: [asin], readExport, updatedAt: "2026-10-21T08:00:00.000Z" });
  assert.deepEqual(Object.keys(output.data.analysisByAsin), [asin]);
  assert.equal(output.data.analysisByAsin[asin].sourceProvider, "sellerSprite");
  assert.equal(output.gap.items.length, 6);
  const disabled = projectStageOutput("reviews", asins, { marketplace: "UK", ukSellerSpriteReviewFallback: false,
    stageStatus: "partial", dataAsins: [asin], readExport, updatedAt: "2026-10-21T08:00:00.000Z" });
  assert.equal(disabled.data.analysisByAsin[asin]?.sourceProvider, undefined);
});

test("a real SellerSprite review record satisfies review readiness without fabricating zero-review VOC", () => {
  const sources = { catalogAsins: [], catalogProducts: [], keywords: {}, ratings: {}, reviews: { [asin]: { ...ready, sourceProvider: "sellerSprite" } },
    sales: {}, childSales: {}, priceStrategies: {}, fbaFees: {}, listing: {}, imageRemarks: {}, categoryTrends: {}, traffic: {}, vocSource: "" };
  assert.equal(deriveAsinModuleStatus(asin, sources).reviews, "ready");
  sources.reviews[asin] = { ...empty, status: "ready" };
  assert.equal(deriveAsinModuleStatus(asin, sources).reviews, "missing");
});
