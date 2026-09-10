import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { formatReviewAnalysisItem, reviewMetricExplanation } from "../../app/seller-sprite-review-analysis";
import { ReviewAnalysisSnapshotRecordSchema } from "../../server/data/voc-data-snapshot";
import { reviewRowMetricInputs } from "../../server/domain/voc/preprocess-voc-snapshot";

test("formatter distinguishes review incidence, Customers Say mention share, and unknown legacy rows", () => {
  assert.equal(formatReviewAnalysisItem({ label: "稳固", sharePct: 25, metricKind: "review_sample_incidence", numerator: 1, denominator: 4, reason: "" }), "【稳固】约 25.0% 评论样本提及（1/4 条）");
  assert.equal(formatReviewAnalysisItem({ label: "质量", sharePct: 60, metricKind: "customers_say_topic_share", numerator: 60, denominator: 100, reason: "" }), "【质量】占 Customers Say 主题提及约 60.0%（60/100 次）");
  assert.equal(formatReviewAnalysisItem({ label: "旧缓存", sharePct: 80, reason: "" }), "【旧缓存】80.0%（旧缓存未记录指标口径）");
  assert.match(reviewMetricExplanation({ label: "质量", sharePct: 60, metricKind: "customers_say_topic_share", numerator: 60, denominator: 100, reason: "" }), /同一条评论可提及多个主题.*不能解读为评论占比/);
  assert.match(reviewMetricExplanation({ label: "未知", sharePct: 12, metricKind: "review_sample_incidence", numerator: 3, reason: "" }), /分母不可用.*不推算/);
  assert.match(formatReviewAnalysisItem({ label: "错配", sharePct: 20, metricKind: "review_sample_incidence", numerator: 1, denominator: 5, reason: "" }, 4), /未记录指标口径/);
});

test("snapshot schema accepts new provenance and old rows, while preprocessing only treats review incidence as a review rate", () => {
  const base = { asin: "B000000001", marketplace: "US", sampledReviews: 4, fetchedAt: "2026-09-10", status: "ready", blocks: [{ key: "positives", label: "好评", rows: [] }] };
  const measured = { label: "稳固", sharePct: 25, reason: "evidence", metricKind: "review_sample_incidence", numerator: 1, denominator: 4 };
  const topicShare = { label: "质量", sharePct: 60, reason: "evidence", metricKind: "customers_say_topic_share", numerator: 60, denominator: 100 };
  assert.equal(ReviewAnalysisSnapshotRecordSchema.safeParse({ ...base, blocks: [{ ...base.blocks[0], rows: [measured] }] }).success, true);
  assert.equal(ReviewAnalysisSnapshotRecordSchema.safeParse({ ...base, blocks: [{ ...base.blocks[0], rows: [{ label: "旧", sharePct: 80, reason: "" }] }] }).success, true);
  assert.equal(ReviewAnalysisSnapshotRecordSchema.safeParse({ ...base, blocks: [{ ...base.blocks[0], rows: [{ ...measured, sharePct: 90 }] }] }).success, false);
  assert.equal(ReviewAnalysisSnapshotRecordSchema.safeParse({ ...base, sampledReviews: 0, blocks: [{ ...base.blocks[0], rows: [topicShare] }] }).success, true);
  assert.equal(ReviewAnalysisSnapshotRecordSchema.safeParse({ ...base, blocks: [{ ...base.blocks[0], rows: [{ ...measured, denominator: 5, sharePct: 20 }] }] }).success, false);
  assert.deepEqual(reviewRowMetricInputs(measured, 4), { basis: "review-share-percentage", mentionCount: 1, sampleCount: 4, mentionPct: 25 });
  assert.deepEqual(reviewRowMetricInputs(topicShare, 4), { basis: "presence-only", mentionCount: null, sampleCount: 4, mentionPct: null });
  assert.deepEqual(reviewRowMetricInputs({ sharePct: 80 }, 4), { basis: "presence-only", mentionCount: null, sampleCount: 4, mentionPct: null });
});

test("review bars use the fixed 0 to 100 percent scale and expose a Chinese explanation", () => {
  const source = readFileSync("app/features/voc/review-analysis-matrix.tsx", "utf8");
  assert.doesNotMatch(source, /row\.sharePct\s*\/\s*maxPct/);
  assert.match(source, /width:\s*`\$\{Math\.min\(100,\s*Math\.max\(0,\s*row\.sharePct\)\)\}%`/);
  assert.match(source, /title=\{reviewMetricExplanation\(row, analysis\.sampledReviews\)\}/);
  assert.match(source, /同一条评论可命中多个主题.*合计不要求等于 100%/);
});

test("database validator tolerates the JavaScript half-cent rounding boundary without accepting material drift", () => {
  const row = { label: "边界", sharePct: 0.01, reason: "evidence", metricKind: "customers_say_topic_share", numerator: 3, denominator: 20_000 };
  const base = { asin: "B000000001", marketplace: "US", sampledReviews: 4, fetchedAt: "2026-09-10", status: "ready", blocks: [{ key: "positives", label: "好评", rows: [row] }] };
  assert.equal(ReviewAnalysisSnapshotRecordSchema.safeParse(base).success, true);
  const migration = readFileSync("server/db/migrations/postgres/0029_review_metric_provenance.sql", "utf8");
  assert.match(migration, /abs\([\s\S]*?sharePct[\s\S]*?\)\s*>\s*0\.0050001/);
});
