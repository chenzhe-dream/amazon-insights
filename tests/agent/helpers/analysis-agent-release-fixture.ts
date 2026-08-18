import assert from "node:assert/strict";

import type {
  VocPositioningInput,
  VocPositioningOutput,
} from "../../../server/domain/voc/voc-positioning-contracts";
import { buildAnalysisAgentEvaluationSet } from "../../../server/evaluation/analysis-agent-eval-set";
import type { AnalysisAgentReleaseCaseEvidence } from "../../../server/evaluation/analysis-agent-release-gate";

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

function validOutput(input: VocPositioningInput): VocPositioningOutput {
  const requiredThemes = input.dimensions.flatMap((dimension) =>
    dimension.themes
      .filter((theme) => theme.priority.level === "P0" || theme.priority.level === "P1")
      .map((theme) => ({ dimension: dimension.key, theme })),
  );
  const fallback = input.dimensions.flatMap((dimension) =>
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
      strategy: dimension === "price-tier"
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
      role: theme.priority.safetyRule !== null || theme.priority.level === "P0"
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
      actionType: theme.priority.safetyRule !== null || theme.priority.level === "P0"
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
    nextValidations: [{
      domain: "cost",
      reason: "implementation-feasibility",
      themeRefs: [{ dimension: fallback.dimension, themeKey: fallback.theme.key }],
      evidenceIds: [firstEvidence],
    }],
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

function observation(blocked: boolean) {
  return {
    providerDispatched: !blocked,
    terminalStatus: blocked ? "waiting-input" as const : "succeeded" as const,
    selectedFallbackResult: blocked,
    reportsBefore: [{ id: "report-1", version: 1, contentDigest: "1".repeat(64) }],
    reportsAfter: [
      { id: "report-1", version: 1, contentDigest: "1".repeat(64) },
      { id: "report-2", version: 2, contentDigest: "2".repeat(64) },
    ],
  };
}

export function validAnalysisAgentReleaseCaseEvidence(): readonly AnalysisAgentReleaseCaseEvidence[] {
  return buildAnalysisAgentEvaluationSet().cases.map((evalCase) => {
    if (evalCase.snapshot.input.kind === "dependency-blocked-input") {
      return {
        caseId: evalCase.id,
        observation: observation(true),
      };
    }
    return {
      caseId: evalCase.id,
      candidate: validOutput(evalCase.snapshot.input),
      observation: observation(false),
    };
  });
}

export function validAnalysisAgentVocResult(): VocPositioningOutput {
  const input = buildAnalysisAgentEvaluationSet().casesById["scooter-complete"].snapshot.input;
  assert.equal(input.kind, "voc-positioning-input");
  return validOutput(input);
}
