import assert from "node:assert/strict";
import test from "node:test";

import {
  ANALYSIS_AGENT_EVAL_SET_VERSION,
  REQUIRED_ANALYSIS_AGENT_EVAL_CASE_IDS,
  buildAnalysisAgentEvaluationSet,
} from "../../server/evaluation/analysis-agent-eval-set";
import { VocPositioningInputSchema } from "../../server/domain/voc/voc-positioning-contracts";

const HUMAN_RATING_DIMENSIONS = [
  "accuracy",
  "explanation-quality",
  "actionability",
  "risk-completeness",
  "unsupported-inference-avoidance",
  "business-readability",
] as const;

const EXPECTED_INPUT_DIGESTS = {
  "scooter-complete": "13b0f157978e08bdc557bae7dbbe0c8ede362701a701df279f12ef65b0f4bde6",
  "lighting-complete": "ec833f02c0203790020d4daa02db7a7eafbb178afc32a7224ff6aa60487d2601",
  "missing-voc-keyword": "4d99b9a010ae2d111877e7f26c6158a5d46cf80b595e466d05eeb2639f2dd4d9",
  "third-party-metric-conflict": "c79170b6ddd1075758a79c511e9e694c18f9086fe53b257b8d12c39896bc2276",
  "safety-p0": "c7538ec00ba98436c2a3d33f760409229e67880a38cd141a5d68792fa80109ca",
} as const;

function isDeepFrozen(value: unknown): boolean {
  if (value === null || typeof value !== "object") {
    return true;
  }
  if (!Object.isFrozen(value)) {
    return false;
  }
  return Object.values(value).every(isDeepFrozen);
}

test("OpenSpec 9.1 evaluation set is versioned, complete, deterministic, and frozen", () => {
  const first = buildAnalysisAgentEvaluationSet();
  const second = buildAnalysisAgentEvaluationSet();

  assert.equal(ANALYSIS_AGENT_EVAL_SET_VERSION, "openspec-9.1.0");
  assert.equal(first.version, ANALYSIS_AGENT_EVAL_SET_VERSION);
  assert.deepEqual(first.caseIds, REQUIRED_ANALYSIS_AGENT_EVAL_CASE_IDS);
  assert.deepEqual(first.caseIds, [
    "scooter-complete",
    "lighting-complete",
    "missing-voc-keyword",
    "third-party-metric-conflict",
    "safety-p0",
  ]);
  assert.deepEqual(
    first.cases.map((entry) => entry.id),
    first.caseIds,
  );
  assert.equal(new Set(first.caseIds).size, 5);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(isDeepFrozen(first), true);
});

test("every OpenSpec 9.1 case has fixed inputs, deterministic expectations, forbidden conclusions, and human baselines", () => {
  const evaluationSet = buildAnalysisAgentEvaluationSet();

  for (const entry of evaluationSet.cases) {
    assert.match(entry.snapshot.frozenAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(entry.snapshot.sanitized, true);
    assert.equal(
      entry.snapshot.inputDigest,
      EXPECTED_INPUT_DIGESTS[entry.id],
      entry.id,
    );
    assert.ok(entry.expectations.requiredAssertions.length > 0, entry.id);
    assert.ok(entry.expectations.forbiddenConclusions.length > 0, entry.id);
    assert.deepEqual(
      entry.humanBaseline.dimensions.map((dimension) => dimension.id),
      HUMAN_RATING_DIMENSIONS,
      entry.id,
    );
    assert.ok(
      entry.humanBaseline.dimensions.every((dimension) => dimension.minimumScore >= 3),
      entry.id,
    );
  }
});

test("complete scooter and lighting cases provide three-source VOC coverage and closed Skill inputs", () => {
  const cases = buildAnalysisAgentEvaluationSet().casesById;

  for (const id of ["scooter-complete", "lighting-complete"] as const) {
    const entry = cases[id];
    const input = VocPositioningInputSchema.parse(entry.snapshot.input);
    assert.equal(
      input.coverage.every((source) => source.status === "available"),
      true,
      id,
    );
    assert.equal(input.coverage.length, 3);
    assert.equal(input.dimensions.length, 7);
    assert.equal(entry.expectations.dataCoverage, "three-source-complete");
    assert.equal(entry.expectations.requiredAssertions.includes("closed-voc-skill-input"), true);
    assert.equal(JSON.stringify(entry.snapshot.input).includes("organizationId"), false);
    assert.equal(JSON.stringify(entry.snapshot.input).includes("cookie"), false);
  }
});

test("missing VOC or keyword case records a dependency boundary without fabricating executable Skill input", () => {
  const entry = buildAnalysisAgentEvaluationSet().casesById["missing-voc-keyword"];

  assert.equal(entry.snapshot.input.kind, "dependency-blocked-input");
  assert.equal(entry.snapshot.input.status, "waiting-input");
  assert.equal(entry.snapshot.input.executable, false);
  assert.deepEqual(entry.snapshot.input.missingDependencies, ["voc", "keywords"]);
  assert.equal(entry.expectations.dataCoverage, "blocked-missing-input");
  assert.equal(
    entry.expectations.forbiddenConclusions.includes("invent-voc-positioning-from-empty-input"),
    true,
  );
});

test("third-party metric conflict case preserves source-scoped percentages without an aggregate percentage", () => {
  const entry = buildAnalysisAgentEvaluationSet().casesById["third-party-metric-conflict"];
  const input = VocPositioningInputSchema.parse(entry.snapshot.input);
  const expected = entry.expectations.sourceScopedMetricConflict;
  assert.ok(expected);
  const dimension = input.dimensions.find((item) => item.key === expected.dimension);
  assert.ok(dimension);
  const theme = dimension.themes.find((item) => item.key === expected.themeKey);
  assert.ok(theme);

  assert.deepEqual(
    theme.metrics.map((metric) => ({
      sourceId: metric.sourceId,
      mentionPct: metric.mentionPct,
    })),
    [
      { sourceId: "alexa-voc", mentionPct: 2 },
      { sourceId: "sorftime-review-analysis", mentionPct: 6 },
      { sourceId: "seller-sprite-review-analysis", mentionPct: 11 },
    ],
  );
  assert.equal(expected.aggregateMentionPct, null);
  assert.equal("mentionPct" in theme, false);
  assert.equal(entry.expectations.requiredAssertions.includes("no-cross-source-average"), true);
  assert.equal(entry.expectations.forbiddenConclusions.includes("average-2-6-11-into-6.33"), true);
});

test("safety P0 case protects non-downgradable safety themes", () => {
  const entry = buildAnalysisAgentEvaluationSet().casesById["safety-p0"];
  const input = VocPositioningInputSchema.parse(entry.snapshot.input);
  const expected = entry.expectations.protectedTheme;
  assert.ok(expected);
  const dimension = input.dimensions.find((item) => item.key === expected.dimension);
  assert.ok(dimension);
  const theme = dimension.themes.find((item) => item.key === expected.themeKey);
  assert.ok(theme);

  assert.equal(theme.priority.level, "P0");
  assert.notEqual(theme.priority.safetyRule, null);
  assert.equal(theme.priority.cannotDowngradeReason?.length > 0, true);
  assert.deepEqual(expected, {
    dimension: dimension.key,
    themeKey: theme.key,
    priority: theme.priority.level,
    safetyRule: theme.priority.safetyRule,
    cannotDowngradeReason: theme.priority.cannotDowngradeReason,
  });
  assert.equal(entry.expectations.safetyDowngradeForbidden, true);
  assert.equal(entry.expectations.requiredAssertions.includes("safety-remains-p0"), true);
  assert.equal(entry.expectations.forbiddenConclusions.includes("downgrade-safety-p0-to-p1"), true);
});
