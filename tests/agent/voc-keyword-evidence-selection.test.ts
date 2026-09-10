import assert from "node:assert/strict";
import { test } from "node:test";
import { RepositoryVocSourceReader } from "../../server/data/repository-voc-source";
const asin = "B08L7DD8L9";
const review = { asin, marketplace: "US", sampledReviews: 2, fetchedAt: "2026-09-09", status: "ready", blocks: [{ key: "positives", label: "喜爱", rows: [{ label: "亮度充足", reason: "阅读时光线充足", sharePct: 50 }] }] };
const input = { organizationId: "22222222-2222-4222-8222-222222222222", marketplace: "US", asins: [asin], dataCutoffAt: "2026-09-10T00:00:00.000Z" };
function reader(value: unknown = review) { return new RepositoryVocSourceReader({ manualVoc: { listAtCutoff: async () => [] }, legacyFallbackEnabled: false, reviewSources: { sorftime: { meta: { marketplace: "US" }, data: { [asin]: value } }, sellerSprite: { meta: { marketplace: "US" }, data: {} } } }); }
test("default selection does not implicitly enable reviews", async () => {
  assert.equal((await reader().read(input)).candidate, null);
});
test("explicit review fallback can select substantive comments", async () => {
  const result = await reader().read({ ...input, sourcePolicy: "manual-with-review-fallback" } as typeof input);
  assert.equal(result.candidate?.payload.records.sorftimeReviewAnalysis.length, 1);
});
for (const blocks of [[], [{ key: "positives", label: "喜爱", rows: [] }], [{ key: "positives", label: "喜爱", rows: [{ label: "  ", reason: "", sharePct: 100 }] }]]) {
  test(`explicit fallback rejects empty themes ${JSON.stringify(blocks)}`, async () => {
    assert.equal((await reader({ ...review, blocks }).read({ ...input, sourcePolicy: "manual-with-review-fallback" } as typeof input)).candidate, null);
  });
}

test("manual dimensions stay primary, reviews only supplement missing dimensions with conflicts separate", async () => {
 const { selectEvidenceDimensions } = await import("../../server/data/voc-evidence-selection");
 assert.deepEqual(selectEvidenceDimensions(["positives"], ["positives", "negatives"], true), { reviewDimensions: ["positives", "negatives"], reviewSupplementDimensions: ["negatives"], conflictDimensions: ["positives"], missingDimensions: ["attention", "unmet", "audiences", "scenarios", "motives"] });
 assert.deepEqual(selectEvidenceDimensions([], ["positives"], false).reviewDimensions, []);
});
