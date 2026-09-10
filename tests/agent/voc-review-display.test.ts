import assert from "node:assert/strict";
import test from "node:test";
import { reviewEmptyMessage, reviewEvidenceText, scopedReviewRecords, reviewMissingMessage } from "../../app/lib/voc-review-display";

const base = { asin: "B0F43M9KWW", marketplace: "US", sampledReviews: 33, fetchedAt: "2026-09-10", status: "ready" as const, blocks: [] };
test("distinguishes failed request, explicit no samples, unmatched dimension and pending read", () => {
  assert.match(reviewEmptyMessage({ ...base, status: "error", sampledReviews: 0, statusMessage: "Provider request failed" }), /请求失败/);
  assert.match(reviewEmptyMessage({ ...base, status: "pending", sampledReviews: 0, statusMessage: "No reviews found." }), /明确返回.*无评论样本/);
  assert.match(reviewEmptyMessage(base), /33.*本维度暂无匹配主题/);
  assert.match(reviewEmptyMessage(undefined), /读取/);
  assert.doesNotMatch(reviewEvidenceText({ ...base, status: "error", sampledReviews: 0 }), /样本：0/);
});
test("missing record uses the current gap, never historical diagnostics or fabricated zero samples", () => {
  assert.match(reviewMissingMessage({ stage: "reviews", stageStatus: "missing-output", reasonCode: "OUTPUT_UNAVAILABLE" }, base.asin), /读取失败/);
  assert.match(reviewMissingMessage(undefined, base.asin), /不会使用全局缓存/);
});
test("scoped records discard other ASIN and marketplace records", () => {
  const records = { [base.asin]: base, OTHER: { ...base, asin: "OTHER" } };
  assert.deepEqual(Object.keys(scopedReviewRecords(records, [base.asin], "US")), [base.asin]);
  assert.deepEqual(scopedReviewRecords(records, [base.asin], "UK"), {});
});
