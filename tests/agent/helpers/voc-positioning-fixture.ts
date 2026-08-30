import assert from "node:assert/strict";

import { rufusVocData } from "../../../app/rufus-voc-data";
import {
  sellerSpriteMcpReviewAnalysisData,
  sellerSpriteMcpReviewAnalysisMeta,
} from "../../../app/seller-sprite-mcp-review-analysis-data";
import {
  sorftimeReviewAnalysisData,
  sorftimeReviewAnalysisMeta,
} from "../../../app/sorftime-review-analysis-data";
import { ManualAlexaVocNormalizedRecordSchema } from "../../../shared/agent-contracts";
import {
  AlexaVocSnapshotRecordSchema,
  ReviewAnalysisSnapshotRecordSchema,
  VOC_SOURCE_REFERENCES,
  VocDataSnapshotRecordSchema,
  buildVocSnapshotCandidate,
  normalizeRepositoryDateOnlyUtc,
  type VocDataSnapshotRecord,
  type VocSnapshotSourceBundle,
} from "../../../server/data/voc-data-snapshot";
import { RepositoryVocSourceReader } from "../../../server/data/repository-voc-source";
import {
  preprocessVocSnapshot,
  type VocDeterministicPreprocessingResult,
} from "../../../server/domain/voc/preprocess-voc-snapshot";
import type { VocPositioningOutput } from "../../../server/domain/voc/voc-positioning-contracts";
import { canonicalJsonSha256 } from "../../../server/runtime/model-request-accounting";

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

const ALEXA_FIXTURE_CAPTURED_AT = "2026-08-12T23:59:59.999Z";

export function createRepositoryVocSourceReaderFixture() {
  return new RepositoryVocSourceReader({
    manualVoc: {
      async listAtCutoff(input) {
        if (ALEXA_FIXTURE_CAPTURED_AT > input.dataCutoffAt) return [];
        return input.asins.flatMap(asin => {
          const normalizedRecord = ManualAlexaVocNormalizedRecordSchema.safeParse({
            ...rufusVocData[asin],
            asin,
          });
          if (!normalizedRecord.success) return [];
          return [{
            organizationId: input.organizationId,
            marketplace: "US" as const,
            asin,
            revision: "1",
            contentHash: canonicalJsonSha256(normalizedRecord.data),
            capturedAt: ALEXA_FIXTURE_CAPTURED_AT,
            normalizedRecord: normalizedRecord.data,
            normalizedSchemaVersion: "alexa-voc-record/v2" as const,
            parserVersion: "deterministic-alexa-parser/v3" as const,
          }];
        });
      },
    },
    legacySource: {
      async readIfEligible() {
        return { status: "missing" as const, reason: "not-found" as const };
      },
    },
  });
}

export function repositoryVocCandidateFixture(
  asins: readonly string[],
  dataCutoffAt = "2026-08-15T23:59:59.999Z",
) {
  const sourceBundles: VocSnapshotSourceBundle[] = [];
  const alexaRecords = asins.flatMap(asin => {
    const parsed = AlexaVocSnapshotRecordSchema.safeParse({
      ...rufusVocData[asin],
      asin,
    });
    return parsed.success ? [parsed.data] : [];
  });
  if (alexaRecords.length > 0 && ALEXA_FIXTURE_CAPTURED_AT <= dataCutoffAt) {
    sourceBundles.push({
      sourceId: "alexa-voc",
      type: "manual-voc",
      reference: VOC_SOURCE_REFERENCES.alexaVoc,
      marketplace: "US",
      capturedAt: ALEXA_FIXTURE_CAPTURED_AT,
      records: alexaRecords,
    });
  }
  addReviewFixtureBundle(
    sourceBundles,
    "sorftime-review-analysis",
    sorftimeReviewAnalysisMeta,
    sorftimeReviewAnalysisData,
    asins,
    dataCutoffAt,
  );
  addReviewFixtureBundle(
    sourceBundles,
    "seller-sprite-review-analysis",
    sellerSpriteMcpReviewAnalysisMeta,
    sellerSpriteMcpReviewAnalysisData,
    asins,
    dataCutoffAt,
  );
  return buildVocSnapshotCandidate({
    marketplace: "US",
    asins,
    dataCutoffAt,
    sourceBundles,
  });
}

export function realVocSnapshot(
  asins: readonly string[],
  snapshotId: string,
  runId = "33333333-3333-4333-8333-333333333333",
): VocDataSnapshotRecord {
  return VocDataSnapshotRecordSchema.parse({
    ...repositoryVocCandidateFixture(asins),
    id: snapshotId,
    runId,
    createdAt: "2026-08-15T23:59:59.999Z",
  });
}

function addReviewFixtureBundle(
  target: VocSnapshotSourceBundle[],
  sourceId: "sorftime-review-analysis" | "seller-sprite-review-analysis",
  meta: Readonly<{ marketplace: string }>,
  data: Readonly<Record<string, unknown>>,
  asins: readonly string[],
  dataCutoffAt: string,
) {
  if (meta.marketplace !== "US") return;
  const records = asins.flatMap(asin => {
    const parsed = ReviewAnalysisSnapshotRecordSchema.safeParse(data[asin]);
    if (!parsed.success || parsed.data.asin !== asin) return [];
    const capturedAt = normalizeRepositoryDateOnlyUtc(parsed.data.fetchedAt);
    return capturedAt <= dataCutoffAt ? [parsed.data] : [];
  });
  if (records.length === 0) return;
  const capturedAt = records.reduce(
    (latest, record) => {
      const candidate = normalizeRepositoryDateOnlyUtc(record.fetchedAt);
      return candidate > latest ? candidate : latest;
    },
    "0000-01-01T00:00:00.000Z",
  );
  target.push(sourceId === "sorftime-review-analysis"
    ? {
        sourceId,
        type: "connector",
        reference: VOC_SOURCE_REFERENCES.sorftimeReviewAnalysis,
        marketplace: "US",
        capturedAt,
        records,
      }
    : {
        sourceId,
        type: "connector",
        reference: VOC_SOURCE_REFERENCES.sellerSpriteReviewAnalysis,
        marketplace: "US",
        capturedAt,
        records,
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
      strategy: fallback.theme.priority.safetyRule || fallback.theme.priority.level === "P0"
        ? "avoid-protected-failure"
        : "retain-verified-value",
      themeRefs: [
        { dimension: fallback.dimension, themeKey: fallback.theme.key },
      ],
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
      themeRefs: [
        { dimension: fallback.dimension, themeKey: fallback.theme.key },
      ],
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
        themeRefs: [
          { dimension: fallback.dimension, themeKey: fallback.theme.key },
        ],
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
