import assert from "node:assert/strict";

import {
  VocDataSnapshotRecordSchema,
  type VocDataSnapshotRecord,
} from "../../../server/data/voc-data-snapshot";
import { RepositoryVocSourceReader } from "../../../server/data/repository-voc-source";
import {
  preprocessVocSnapshot,
  type VocDeterministicPreprocessingResult,
} from "../../../server/domain/voc/preprocess-voc-snapshot";
import type { VocPositioningOutput } from "../../../server/domain/voc/voc-positioning-contracts";

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

export const SCOOTER_ASINS = [
  "B07VY9Q95Q",
  "B0BPXRVWYK",
  "B07DYG1C9B",
] as const;
export const LIGHTING_ASINS = [
  "B08Z36X6B4",
  "B0D77D5WKD",
  "B0BVFX154J",
] as const;

export function realVocSnapshot(
  asins: readonly string[],
  snapshotId: string,
  runId = "33333333-3333-4333-8333-333333333333",
): VocDataSnapshotRecord {
  const read = new RepositoryVocSourceReader().read({
    marketplace: "US",
    asins,
    dataCutoffAt: "2026-08-15T23:59:59.999Z",
  });
  assert.ok(read.candidate);
  return VocDataSnapshotRecordSchema.parse({
    ...read.candidate,
    id: snapshotId,
    runId,
    createdAt: "2026-08-15T23:59:59.999Z",
  });
}

export function realVocFacts(
  asins: readonly string[],
  snapshotId: string,
  runId?: string,
): VocDeterministicPreprocessingResult {
  return preprocessVocSnapshot(realVocSnapshot(asins, snapshotId, runId));
}

export function validVocPositioningOutput(
  facts: VocDeterministicPreprocessingResult,
): VocPositioningOutput {
  const requiredThemes = facts.dimensions.flatMap((dimension) =>
    dimension.themes
      .filter((theme) => theme.priority.level === "P0" || theme.priority.level === "P1")
      .map((theme) => ({ dimension: dimension.key, theme })),
  );
  const fallback = facts.dimensions
    .flatMap((dimension) =>
      dimension.themes.map((theme) => ({ dimension: dimension.key, theme })),
    )[0];
  assert.ok(fallback);
  const firstEvidence = fallback.theme.evidenceIds[0];
  assert.ok(firstEvidence);

  return {
    schemaVersion: "1.0.0",
    kind: "voc-positioning-analysis-result",
    status: facts.availability.every((source) => source.status === "available")
      ? "complete"
      : "partial",
    identity: {
      snapshotId: facts.snapshot.id,
      contentHash: facts.snapshot.contentHash,
      factsDigest: facts.factsDigest,
      dataCutoffAt: facts.snapshot.dataCutoffAt,
    },
    coverage: facts.availability.map((source) => ({
      sourceId: source.sourceId,
      status: source.status,
      missingAsins: [...source.missingAsins],
    })),
    coreConclusion: {
      statement: "Use verified customer needs and avoidance items for positioning.",
      evidenceIds: [firstEvidence],
    },
    positioning: POSITIONING_DIMENSIONS.map((dimension) => ({
      dimension,
      conclusion: `Positioning conclusion: ${dimension}`,
      priority: fallback.theme.priority.level,
      themeRefs: [
        { dimension: fallback.dimension, themeKey: fallback.theme.key },
      ],
      evidenceIds: [firstEvidence],
      limitation: dimension === "price-tier" ? "Exact price needs cost validation" : null,
    })),
    themeJudgments: requiredThemes.map(({ dimension, theme }) => ({
      themeKey: theme.key,
      label: theme.label,
      dimension,
      role: theme.priority.level === "P0" ? "new-product-avoidance" : "core-retention",
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
      direction: `Address ${theme.label}`,
      productAction: "Create a verifiable product action",
      acceptanceCriteria: "Establish an objective acceptance measure",
      risks: ["Cost and feasibility need validation"],
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
        question: "Validate action cost feasibility",
        evidenceIds: [firstEvidence],
      },
    ],
    limitations: [
      "voc-only",
      "no-market-size",
      "no-sales-forecast",
      "no-profitability",
      "no-project-approval",
      "requires-market-price-cost-compliance-patent-supply-chain-validation",
    ],
  };
}
