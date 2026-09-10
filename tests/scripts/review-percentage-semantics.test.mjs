import assert from "node:assert/strict";
import test from "node:test";
import { buildReviewAnalysisFromRecords } from "../../scripts/lib/review-analysis-aggregate.mjs";
import { buildSorftimeReviewAnalysis } from "../../scripts/lib/sorftime-review-transform.mjs";

test("review sample incidence keeps its review count denominator when one review matches multiple topics", () => {
  const result = buildReviewAnalysisFromRecords("B000000001", "US", [
    { star: 5, content: "Easy assembly, sturdy and well built." },
    { star: 5, content: "Easy assembly." },
  ], "2026-09-10", { family: "generic" });
  const rows = result.blocks.flatMap(block => block.rows);
  const assembly = rows.find(row => row.label === "安装便捷");
  const sturdy = rows.find(row => row.label === "结构稳固");
  assert.deepEqual(
    { metricKind: assembly?.metricKind, numerator: assembly?.numerator, denominator: assembly?.denominator, sharePct: assembly?.sharePct },
    { metricKind: "review_sample_incidence", numerator: 2, denominator: 2, sharePct: 100 },
  );
  assert.deepEqual(
    { metricKind: sturdy?.metricKind, numerator: sturdy?.numerator, denominator: sturdy?.denominator, sharePct: sturdy?.sharePct },
    { metricKind: "review_sample_incidence", numerator: 1, denominator: 2, sharePct: 50 },
  );
});

test("Customers Say keeps topic mention share and mixed polarity out of sentiment blocks", () => {
  const result = buildSorftimeReviewAnalysis("B000000001", "US", { details: [
    { keyword: "quality", mention: 60, positive: 35, negative: 25, content: "Mixed quality feedback" },
    { keyword: "price", mention: 40, positive: 35, negative: 5, content: "Good value" },
  ] }, [], "2026-09-10", { family: "generic" });
  const positive = result.blocks.find(block => block.key === "positives").rows;
  const negative = result.blocks.find(block => block.key === "negatives").rows;
  const quality = positive.find(row => row.label.includes("质量"));
  assert.deepEqual(
    { metricKind: quality?.metricKind, numerator: quality?.numerator, denominator: quality?.denominator, sharePct: quality?.sharePct },
    { metricKind: "customers_say_topic_share", numerator: 60, denominator: 100, sharePct: 60 },
  );
  assert.equal(negative.some(row => row.label.includes("质量")), false);
});

test("broad report wording alone does not fabricate an unmet-needs candidate", () => {
  const result = buildSorftimeReviewAnalysis("B000000001", "US", { details: [
    { keyword: "quality", mention: 10, positive: 8, negative: 2, content: "Customers report good quality" },
  ] }, [], "2026-09-10", { family: "generic" });
  assert.deepEqual(result.blocks.find(block => block.key === "unmet").rows, []);
});

test("positive dimming text without negative evidence is not an unmet-needs candidate", () => {
  const result = buildSorftimeReviewAnalysis("B000000001", "US", { details: [
    { keyword: "dimmable", mention: 10, positive: 10, negative: 0, content: "Customers love brightness dimming" },
  ] }, [], "2026-09-10", { family: "generic" });
  assert.deepEqual(result.blocks.find(block => block.key === "unmet").rows, []);
});

test("missing or zero Customers Say mentions do not invent denominator one", () => {
  const result = buildSorftimeReviewAnalysis("B000000001", "US", { details: [
    { keyword: "quality", mention: 0, positive: 0, negative: 0, content: "quality" },
  ] }, [], "2026-09-10", { family: "generic" });
  assert.equal(result.blocks.flatMap(block => block.rows).some(row => row.metricKind === "customers_say_topic_share"), false);
});
