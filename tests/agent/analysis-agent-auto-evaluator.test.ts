import assert from "node:assert/strict";
import test from "node:test";

import {
  type VocPositioningInput,
  type VocPositioningOutput,
} from "../../server/domain/voc/voc-positioning-contracts";
import { buildAnalysisAgentEvaluationSet } from "../../server/evaluation/analysis-agent-eval-set";
import {
  ANALYSIS_AGENT_AUTO_EVALUATOR_GATE_IDS,
  evaluateAnalysisAgentCandidate,
} from "../../server/evaluation/analysis-agent-auto-evaluator";

const POSITIONING_DIMENSIONS = [
  "target-audience",
  "core-scenario",
  "core-pain",
  "product-form",
  "base-function",
  "differentiator",
  "material-structure",
  "color-sku",
  "price-tier",
  "core-selling-point",
] as const;

type ReportSnapshot = Readonly<{
  id: string;
  version: number;
  contentDigest: string;
}>;

function completeInput(caseId = "scooter-complete"): VocPositioningInput {
  const input = buildAnalysisAgentEvaluationSet().casesById[caseId].snapshot.input;
  assert.equal(input.kind, "voc-positioning-input");
  return input;
}

function validOutput(input = completeInput()): VocPositioningOutput {
  const requiredThemes = input.dimensions.flatMap((dimension) =>
    dimension.themes
      .filter((theme) => theme.priority.level === "P0" || theme.priority.level === "P1")
      .map((theme) => ({ dimension: dimension.key, theme })),
  );
  const fallback = input.dimensions
    .flatMap((dimension) =>
      dimension.themes.map((theme) => ({ dimension: dimension.key, theme })),
    )[0];
  assert.ok(fallback);
  const firstEvidence = fallback.theme.evidenceIds[0];
  assert.ok(firstEvidence);

  return {
    schemaVersion: "1.0.0",
    kind: "voc-positioning-analysis-result",
    status: input.coverage.every((source) => source.status === "available")
      ? "complete"
      : "partial",
    identity: {
      snapshotId: input.snapshot.id,
      contentHash: input.snapshot.contentHash,
      factsDigest: input.factsDigest,
      dataCutoffAt: input.snapshot.dataCutoffAt,
    },
    coverage: input.coverage.map((source) => ({
      sourceId: source.sourceId,
      status: source.status,
      missingAsins: [...source.missingAsins],
    })),
    coreConclusion: {
      strategy: fallback.theme.priority.safetyRule || fallback.theme.priority.level === "P0"
        ? "avoid-protected-failure"
        : "retain-verified-value",
      themeRefs: [{ dimension: fallback.dimension, themeKey: fallback.theme.key }],
      evidenceIds: [firstEvidence],
    },
    positioning: POSITIONING_DIMENSIONS.map((dimension) => ({
      dimension,
      stance: dimension === "price-tier" ? "requires-validation" : "supported-by-voc",
      strategy:
        dimension === "price-tier"
          ? "validate"
          : fallback.theme.priority.safetyRule || fallback.theme.priority.level === "P0"
            ? "avoid"
            : "retain",
      priority: fallback.theme.priority.level,
      themeRefs: [{ dimension: fallback.dimension, themeKey: fallback.theme.key }],
      evidenceIds: [firstEvidence],
    })),
    themeJudgments: requiredThemes.map(({ dimension, theme }) => ({
      themeKey: theme.key,
      label: theme.label,
      dimension,
      role:
        theme.priority.safetyRule !== null || theme.priority.level === "P0"
          ? "new-product-avoidance"
          : dimension === "unmet"
            ? "differentiation-breakthrough"
            : dimension === "negatives" || dimension === "attention"
              ? "retain-and-redesign"
              : "core-retention",
      priority: theme.priority.level,
      metrics: theme.metrics.map((metric) => ({
        evidenceId: metric.evidenceId,
        sourceId: metric.sourceId,
        asin: metric.asin,
        capturedAt: metric.capturedAt,
        mentionCount: metric.mentionCount,
        sampleCount: metric.sampleCount,
        mentionPct: metric.mentionPct,
      })),
      evidenceIds: [...theme.evidenceIds],
    })),
    actions: requiredThemes.map(({ dimension, theme }, index) => ({
      id: `action-${index + 1}`,
      priority: theme.priority.level,
      actionType:
        theme.priority.safetyRule !== null || theme.priority.level === "P0"
          ? "avoid"
          : dimension === "unmet"
            ? "differentiate"
            : "retain",
      validationDomains: ["cost", "compliance"],
      themeRefs: [{ dimension, themeKey: theme.key }],
      evidenceIds: [...theme.evidenceIds],
    })),
    checklists: {
      mustKeep: [],
      mustAvoid: [],
      differentiationOpportunities: [],
    },
    nextValidations: [
      {
        domain: "cost",
        reason: "implementation-feasibility",
        themeRefs: [{ dimension: fallback.dimension, themeKey: fallback.theme.key }],
        evidenceIds: [firstEvidence],
      },
    ],
    decisionBoundaries: {
      marketSize: "not-assessed",
      salesForecast: "not-assessed",
      profitability: "not-assessed",
      projectApproval: "not-assessed",
      price: "requires-validation",
      cost: "requires-validation",
      compliance: "requires-validation",
      patent: "requires-validation",
      supplyChain: "requires-validation",
    },
  };
}

function reports(...versions: readonly number[]): ReportSnapshot[] {
  return versions.map((version) => ({
    id: `report-${version}`,
    version,
    contentDigest: `${version}`.repeat(64).slice(0, 64),
  }));
}

function observation(overrides = {}) {
  return {
    providerDispatched: true,
    terminalStatus: "succeeded" as const,
    selectedFallbackResult: false,
    reportsBefore: reports(1),
    reportsAfter: reports(1, 2),
    ...overrides,
  };
}

function evaluate(caseId: keyof ReturnType<typeof buildAnalysisAgentEvaluationSet>["casesById"], candidate: unknown, overrides = {}) {
  const evaluationSet = buildAnalysisAgentEvaluationSet();
  return evaluateAnalysisAgentCandidate({
    case: evaluationSet.casesById[caseId],
    candidate,
    observation: observation(overrides),
  });
}

function gate(result: ReturnType<typeof evaluate>, id: string) {
  const found = result.gates.find((entry) => entry.id === id);
  assert.ok(found, id);
  return found;
}

test("valid scooter result passes all OpenSpec 9.2 automatic gates", () => {
  const result = evaluate("scooter-complete", validOutput());

  assert.equal(result.evalSetVersion, "openspec-9.1.0");
  assert.equal(result.caseId, "scooter-complete");
  assert.equal(result.passed, true);
  assert.deepEqual(result.gates.map((item) => item.id), ANALYSIS_AGENT_AUTO_EVALUATOR_GATE_IDS);
  assert.equal(result.gates.every((item) => item.passed), true);
});

test("missing or extra output fields fail schema without throwing", () => {
  assert.equal(gate(evaluate("scooter-complete", { kind: "voc-positioning-analysis-result" }), "schema-valid").passed, false);
  assert.equal(gate(evaluate("scooter-complete", { ...validOutput(), hidden: "raw-provider-error" }), "schema-valid").passed, false);
});

test("deterministic metric mutation fails deterministic and fabrication gates", () => {
  const candidate = validOutput();
  candidate.themeJudgments[0]!.metrics[0]!.mentionPct = 99;
  const result = evaluate("scooter-complete", candidate);

  assert.equal(gate(result, "deterministic-values-match").passed, false);
  assert.equal(gate(result, "no-fabricated-data").passed, false);
});

test("dangling and cross-scoped evidence fails evidence and fabrication gates", () => {
  const candidate = validOutput();
  candidate.coreConclusion.evidenceIds = ["f".repeat(64)];
  const result = evaluate("scooter-complete", candidate);

  assert.equal(gate(result, "evidence-resolves").passed, false);
  assert.equal(gate(result, "no-fabricated-data").passed, false);
});

test("unknown theme references fail evidence and fabrication gates", () => {
  const candidate = validOutput();
  candidate.positioning[0]!.themeRefs = [
    { dimension: "negatives", themeKey: "unknown-theme" },
  ];
  const result = evaluate("scooter-complete", candidate);

  assert.equal(gate(result, "evidence-resolves").passed, false);
  assert.equal(gate(result, "no-fabricated-data").passed, false);
});

test("coverage and status mutations fail data boundary gate", () => {
  const coverageMutation = validOutput(completeInput("lighting-complete"));
  coverageMutation.coverage[0]!.missingAsins = ["B000000001"];
  assert.equal(gate(evaluate("lighting-complete", coverageMutation), "data-boundary-preserved").passed, false);

  const statusMutation = validOutput();
  statusMutation.status = "partial";
  assert.equal(gate(evaluate("scooter-complete", statusMutation), "data-boundary-preserved").passed, false);
});

test("P0 downgrade or protected action omission fails safety gate", () => {
  const downgrade = validOutput(completeInput("safety-p0"));
  const protectedJudgment = downgrade.themeJudgments.find((item) => item.priority === "P0");
  assert.ok(protectedJudgment);
  protectedJudgment.priority = "P1";
  assert.equal(gate(evaluate("safety-p0", downgrade), "safety-not-downgraded").passed, false);

  const omitted = validOutput(completeInput("safety-p0"));
  omitted.actions = [];
  assert.equal(gate(evaluate("safety-p0", omitted), "safety-not-downgraded").passed, false);
});

test("blocked missing-input case fails closed on output, dispatch, wrong terminal, or missing fallback", () => {
  assert.equal(gate(evaluate("missing-voc-keyword", validOutput(), {
    providerDispatched: false,
    terminalStatus: "waiting-input",
    selectedFallbackResult: true,
  }), "missing-input-marked").passed, false);
  assert.equal(gate(evaluate("missing-voc-keyword", undefined, {
    providerDispatched: true,
    terminalStatus: "waiting-input",
    selectedFallbackResult: true,
  }), "missing-input-marked").passed, false);
  assert.equal(gate(evaluate("missing-voc-keyword", undefined, {
    providerDispatched: false,
    terminalStatus: "succeeded",
    selectedFallbackResult: true,
  }), "missing-input-marked").passed, false);
  assert.equal(gate(evaluate("missing-voc-keyword", undefined, {
    providerDispatched: false,
    terminalStatus: "waiting-input",
    selectedFallbackResult: false,
  }), "failure-fallback-effective").passed, false);
});

test("valid waiting-input blocked observation passes missing-input and fallback gates", () => {
  const result = evaluate("missing-voc-keyword", undefined, {
    providerDispatched: false,
    terminalStatus: "waiting-input",
    selectedFallbackResult: true,
  });

  assert.equal(gate(result, "missing-input-marked").passed, true);
  assert.equal(gate(result, "failure-fallback-effective").passed, true);
});

test("executable failed or waiting-input observations require an effective fallback", () => {
  for (const terminalStatus of ["failed", "waiting-input"] as const) {
    const missingFallback = evaluate("scooter-complete", validOutput(), {
      terminalStatus,
      selectedFallbackResult: false,
    });
    assert.equal(gate(missingFallback, "failure-fallback-effective").passed, false);

    const selectedFallback = evaluate("scooter-complete", validOutput(), {
      terminalStatus,
      selectedFallbackResult: true,
    });
    assert.equal(gate(selectedFallback, "failure-fallback-effective").passed, true);
  }

  const succeeded = evaluate("scooter-complete", validOutput(), {
    terminalStatus: "succeeded",
    selectedFallbackResult: false,
  });
  assert.equal(gate(succeeded, "failure-fallback-effective").passed, true);
});

test("report history rejects deletion, mutation, replacement, duplicate, reorder, and non-increasing append", () => {
  const before = reports(1, 2);

  for (const reportsAfter of [
    reports(1),
    [{ ...before[0]!, contentDigest: "f".repeat(64) }, before[1]!],
    [{ ...before[0]!, id: "replaced-report" }, before[1]!],
    [before[1]!, before[0]!],
    [...before, { id: "report-duplicate", version: 2, contentDigest: "3".repeat(64) }],
    [...before, { id: "report-zero", version: 0, contentDigest: "3".repeat(64) }],
    [...before, { id: "report-4", version: 4, contentDigest: "4".repeat(64) }, { id: "report-3", version: 3, contentDigest: "3".repeat(64) }],
  ]) {
    const result = evaluate("scooter-complete", validOutput(), {
      reportsBefore: before,
      reportsAfter,
    });
    assert.equal(gate(result, "history-version-immutable").passed, false);
  }

  const unsortedBefore = evaluate("scooter-complete", validOutput(), {
    reportsBefore: reports(2, 1),
    reportsAfter: reports(2, 1, 3),
  });
  assert.equal(gate(unsortedBefore, "history-version-immutable").passed, false);
});

test("unchanged version 1 plus appended version 2 passes history gate", () => {
  const result = evaluate("scooter-complete", validOutput(), {
    reportsBefore: reports(1),
    reportsAfter: reports(1, 2),
  });

  assert.equal(gate(result, "history-version-immutable").passed, true);
});

test("closed observation schema rejects unknown fields and invalid status, version, or digest without leaking raw text", () => {
  for (const invalidObservation of [
    { ...observation(), rawProviderError: "secret-stack-trace" },
    { ...observation(), terminalStatus: "crashed: secret-stack-trace" },
    { ...observation(), reportsAfter: [{ id: "report-1", version: 0, contentDigest: "1".repeat(64) }] },
    { ...observation(), reportsAfter: [{ id: "report-1", version: 1, contentDigest: "secret-stack-trace" }] },
  ]) {
    const result = evaluateAnalysisAgentCandidate({
      case: buildAnalysisAgentEvaluationSet().casesById["scooter-complete"],
      candidate: validOutput(),
      observation: invalidObservation as never,
    });
    const serialized = JSON.stringify(result);

    assert.equal(gate(result, "failure-fallback-effective").ruleIds.includes("observation-invalid"), true);
    assert.equal(gate(result, "history-version-immutable").ruleIds.includes("observation-invalid"), true);
    assert.equal(serialized.includes("secret-stack-trace"), false);
  }
});

test("result exposes only stable gate and rule identifiers, never raw error text", () => {
  const result = evaluate("scooter-complete", {
    kind: "voc-positioning-analysis-result",
    raw: "provider stack trace raw-provider-error",
  });
  const serialized = JSON.stringify(result);

  assert.equal(serialized.includes("raw-provider-error"), false);
  assert.equal(serialized.includes("stack trace"), false);
  assert.equal(result.gates.every((item) => typeof item.id === "string"), true);
  assert.equal(
    result.gates.flatMap((item) => item.ruleIds).every((ruleId) => /^[a-z0-9-]+$/.test(ruleId)),
    true,
  );
});
