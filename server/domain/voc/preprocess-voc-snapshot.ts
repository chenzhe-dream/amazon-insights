import { z } from "zod";

import {
  AsinSchema,
  DateTimeSchema,
  EntityIdSchema,
  MarketplaceSchema,
  Sha256Schema,
} from "../../../shared/agent-contracts";
import {
  ReviewAnalysisSnapshotRecordSchema,
  VOC_SOURCE_REFERENCES,
  VocDataSnapshotRecordSchema,
  VocSnapshotSourceIdSchema,
  assertVocDataSnapshotRecordIntegrity,
  deepFreeze,
  normalizeRepositoryDateOnlyUtc,
  type VocDataSnapshotRecord,
  type VocSnapshotSourceId,
} from "../../data/voc-data-snapshot";
import { canonicalJsonSha256 } from "../../runtime/model-request-accounting";
import {
  classifyVocPriority,
  priorityRank,
} from "./priority-rules";
import {
  VOC_DIMENSIONS,
  canonicalTheme,
  compareCodePoints,
  isAlexaDimensionHeader,
  isSkippedAlexaLine,
  parseAlexaThemeObservation,
  type VocDimension,
  type VocProductFamily,
} from "./theme-normalization";

const PREPROCESSING_SCHEMA_VERSION = "1.0.0" as const;

const VocDimensionSchema = z.enum([
  "attention",
  "positives",
  "negatives",
  "unmet",
  "audiences",
  "scenarios",
  "motives",
]);
const VocProductFamilySchema = z.enum(["scooter", "lighting", "generic"]);
const MetricBasisSchema = z.enum([
  "explicit-percentage",
  "mention-count",
  "presence-only",
  "review-share-percentage",
]);
const PriorityLevelSchema = z.enum(["P0", "P1", "P2", "P3", "unknown"]);
const SafetyRuleSchema = z
  .enum([
    "safety",
    "compliance",
    "unusable",
    "structural-failure",
    "severe-damage",
    "concentrated-return",
  ])
  .nullable();
const NonEmptyLabelSchema = z.string().min(1).max(500);

const SourceDenominatorSchema = z.strictObject({
  asin: AsinSchema,
  kind: z.enum(["review-count", "sampled-reviews", "unknown"]),
  sampleCount: z.number().int().nonnegative().nullable(),
});

const SourceAvailabilitySchema = z.strictObject({
  sourceId: VocSnapshotSourceIdSchema,
  sourceType: z.enum(["manual-voc", "connector"]),
  status: z.enum(["available", "partial", "unavailable"]),
  reference: z.string().min(1).max(500).nullable(),
  marketplace: MarketplaceSchema,
  capturedAt: DateTimeSchema.nullable(),
  recordCount: z.number().int().nonnegative(),
  targetCount: z.number().int().positive(),
  missingAsins: z.array(AsinSchema),
  comparability: z.enum([
    "comparable",
    "not-comparable",
    "partial",
    "unknown",
  ]),
  denominators: z.array(SourceDenominatorSchema),
});

const ThemeMetricSchema = z.strictObject({
  evidenceId: Sha256Schema,
  recordKey: Sha256Schema,
  sourceId: VocSnapshotSourceIdSchema,
  sourceType: z.enum(["manual-voc", "connector"]),
  sourceReference: z.string().min(1).max(500),
  marketplace: MarketplaceSchema,
  capturedAt: DateTimeSchema,
  asin: AsinSchema,
  family: VocProductFamilySchema,
  rawLabel: NonEmptyLabelSchema,
  basis: MetricBasisSchema,
  mentionCount: z.number().int().nonnegative().nullable(),
  sampleCount: z.number().int().nonnegative().nullable(),
  mentionPct: z.number().min(0).max(100).nullable(),
  denominatorScope: z.literal("source-record"),
  comparability: z.literal("record-only"),
});

const PriorityDecisionSchema = z.strictObject({
  level: PriorityLevelSchema,
  reasons: z.array(z.string().min(1)),
  cannotDowngradeReason: z.string().min(1).nullable(),
  safetyRule: SafetyRuleSchema,
});

const ThemeFactSchema = z.strictObject({
  key: NonEmptyLabelSchema,
  label: NonEmptyLabelSchema,
  family: VocProductFamilySchema,
  metrics: z.array(ThemeMetricSchema).min(1),
  priority: PriorityDecisionSchema,
  evidenceIds: z.array(Sha256Schema).min(1),
});

const DimensionFactSchema = z.strictObject({
  key: VocDimensionSchema,
  label: NonEmptyLabelSchema,
  themes: z.array(ThemeFactSchema),
});

const EvidenceFactSchema = z.strictObject({
  id: Sha256Schema,
  recordKey: Sha256Schema,
  snapshotId: EntityIdSchema,
  runId: EntityIdSchema,
  sourceId: VocSnapshotSourceIdSchema,
  sourceType: z.enum(["manual-voc", "connector"]),
  sourceReference: z.string().min(1).max(500),
  marketplace: MarketplaceSchema,
  capturedAt: DateTimeSchema,
  asin: AsinSchema,
  family: VocProductFamilySchema,
  dimension: VocDimensionSchema,
  themeKey: NonEmptyLabelSchema,
  rawLabel: NonEmptyLabelSchema,
  basis: MetricBasisSchema,
});

export const VocDeterministicPreprocessingResultSchema = z.strictObject({
  schemaVersion: z.literal(PREPROCESSING_SCHEMA_VERSION),
  kind: z.literal("voc-deterministic-preprocessing"),
  snapshot: z.strictObject({
    id: EntityIdSchema,
    runId: EntityIdSchema,
    contentHash: Sha256Schema,
    marketplace: MarketplaceSchema,
    asins: z.array(AsinSchema).min(1).max(10),
    dataCutoffAt: DateTimeSchema,
  }),
  availability: z.array(SourceAvailabilitySchema).length(3),
  dimensions: z.array(DimensionFactSchema).length(7),
  evidenceIndex: z.array(EvidenceFactSchema),
  canonicalDigest: Sha256Schema,
});

export type VocDeterministicPreprocessingResult = z.infer<
  typeof VocDeterministicPreprocessingResultSchema
>;

type ReviewRecord = z.infer<typeof ReviewAnalysisSnapshotRecordSchema>;
type MetricBasis = z.infer<typeof MetricBasisSchema>;
type ThemeMetric = z.infer<typeof ThemeMetricSchema>;
type EvidenceFact = z.infer<typeof EvidenceFactSchema>;

type MutableTheme = {
  key: string;
  label: string;
  families: Set<VocProductFamily>;
  metricsByEvidenceId: Map<string, ThemeMetric>;
};

type SourceConfig = Readonly<{
  sourceId: VocSnapshotSourceId;
  sourceType: "manual-voc" | "connector";
  reference: string;
}>;

const SOURCE_CONFIGS: readonly SourceConfig[] = Object.freeze([
  {
    sourceId: "alexa-voc",
    sourceType: "manual-voc",
    reference: VOC_SOURCE_REFERENCES.alexaVoc,
  },
  {
    sourceId: "sorftime-review-analysis",
    sourceType: "connector",
    reference: VOC_SOURCE_REFERENCES.sorftimeReviewAnalysis,
  },
  {
    sourceId: "seller-sprite-review-analysis",
    sourceType: "connector",
    reference: VOC_SOURCE_REFERENCES.sellerSpriteReviewAnalysis,
  },
]);

const REVIEW_BLOCK_TO_DIMENSION = Object.freeze({
  consumerProfile: "audiences",
  scenarios: "scenarios",
  unmet: "unmet",
  positives: "positives",
  negatives: "negatives",
  motives: "motives",
} satisfies Record<string, VocDimension>);

const DIMENSION_LABELS: Readonly<Record<VocDimension, string>> = Object.freeze({
  attention: "顾客关注点",
  positives: "买家喜爱",
  negatives: "差评问题",
  unmet: "未满足需求",
  audiences: "使用人群",
  scenarios: "使用场景",
  motives: "核心购买动机",
});

export function preprocessVocSnapshot(
  input: unknown,
): VocDeterministicPreprocessingResult {
  const snapshot = VocDataSnapshotRecordSchema.parse(input);
  assertVocDataSnapshotRecordIntegrity(snapshot);

  const themesByDimension = new Map<
    VocDimension,
    Map<string, MutableTheme>
  >(VOC_DIMENSIONS.map((dimension) => [dimension, new Map()]));
  const evidenceById = new Map<string, EvidenceFact>();
  for (const config of SOURCE_CONFIGS) {
    const source = sourceFor(snapshot, config);
    if (!source) continue;
    if (config.sourceId === "alexa-voc") {
      for (const record of snapshot.payload.records.alexaVoc) {
        collectAlexaRecord(
          snapshot,
          config,
          source.capturedAt,
          record,
          "generic",
          themesByDimension,
          evidenceById,
        );
      }
    } else {
      const records =
        config.sourceId === "sorftime-review-analysis"
          ? snapshot.payload.records.sorftimeReviewAnalysis
          : snapshot.payload.records.sellerSpriteReviewAnalysis;
      for (const record of records) {
        collectReviewRecord(
          snapshot,
          config,
          source.capturedAt,
          record,
          record.family ?? "generic",
          themesByDimension,
          evidenceById,
        );
      }
    }
  }

  const priorityFacts = buildPriorityFacts(themesByDimension);
  const dimensions = VOC_DIMENSIONS.map((dimension) => ({
    key: dimension,
    label: DIMENSION_LABELS[dimension],
    themes: [...(themesByDimension.get(dimension)?.values() ?? [])]
      .map((theme) => finalizeTheme(theme, priorityFacts.get(theme.key) ?? [], snapshot))
      .sort(compareThemes),
  }));
  const evidenceIndex = [...evidenceById.values()].sort((left, right) =>
    compareEvidence(left, right, snapshot),
  );
  assertEvidenceClosure(dimensions, evidenceIndex, snapshot);

  const withoutDigest = {
    schemaVersion: PREPROCESSING_SCHEMA_VERSION,
    kind: "voc-deterministic-preprocessing" as const,
    snapshot: {
      id: snapshot.id,
      runId: snapshot.runId,
      contentHash: snapshot.contentHash,
      marketplace: snapshot.marketplace,
      asins: [...snapshot.asins],
      dataCutoffAt: snapshot.dataCutoffAt,
    },
    availability: buildAvailability(snapshot),
    dimensions,
    evidenceIndex,
  };
  const result = VocDeterministicPreprocessingResultSchema.parse({
    ...withoutDigest,
    canonicalDigest: canonicalJsonSha256({
      ...withoutDigest,
      snapshot: {
        id: withoutDigest.snapshot.id,
        runId: withoutDigest.snapshot.runId,
        marketplace: withoutDigest.snapshot.marketplace,
        asins: withoutDigest.snapshot.asins,
        dataCutoffAt: withoutDigest.snapshot.dataCutoffAt,
      },
    }),
  });
  return deepFreeze(result);
}

function collectAlexaRecord(
  snapshot: VocDataSnapshotRecord,
  config: SourceConfig,
  capturedAt: string,
  record: VocDataSnapshotRecord["payload"]["records"]["alexaVoc"][number],
  family: VocProductFamily,
  themesByDimension: Map<VocDimension, Map<string, MutableTheme>>,
  evidenceById: Map<string, EvidenceFact>,
) {
  for (const dimension of VOC_DIMENSIONS) {
    const lines = record[dimension];
    lines.forEach((line) => {
      if (isSkippedAlexaLine(line)) return;
      if (isAlexaDimensionHeader(line, dimension)) return;
      const observation = parseAlexaThemeObservation(
        line,
        dimension,
        record.alexaReport.reviewCount,
      );
      addMetric({
        snapshot,
        config,
        capturedAt,
        asin: record.asin,
        dimension,
        family,
        rawLabel: observation.rawLabel,
        basis: observation.basis,
        mentionCount: observation.mentionCount,
        sampleCount: observation.sampleCount,
        mentionPct: observation.mentionPct,
        themesByDimension,
        evidenceById,
      });
    });
  }
}

function collectReviewRecord(
  snapshot: VocDataSnapshotRecord,
  config: SourceConfig,
  capturedAt: string,
  record: ReviewRecord,
  family: VocProductFamily,
  themesByDimension: Map<VocDimension, Map<string, MutableTheme>>,
  evidenceById: Map<string, EvidenceFact>,
) {
  const recordCapturedAt = normalizeRepositoryDateOnlyUtc(record.fetchedAt);
  if (
    recordCapturedAt > capturedAt ||
    recordCapturedAt > snapshot.dataCutoffAt
  ) {
    throw new TypeError("VOC review record is after its source or snapshot cutoff");
  }
  for (const block of record.blocks) {
    const dimension = REVIEW_BLOCK_TO_DIMENSION[block.key];
    for (const row of block.rows) {
      addMetric({
        snapshot,
        config,
        capturedAt: recordCapturedAt,
        asin: record.asin,
        dimension,
        family,
        rawLabel: row.label,
        basis: "review-share-percentage",
        mentionCount: null,
        sampleCount: record.sampledReviews,
        mentionPct: row.sharePct,
        themesByDimension,
        evidenceById,
      });
    }
  }
}

function addMetric(input: Readonly<{
  snapshot: VocDataSnapshotRecord;
  config: SourceConfig;
  capturedAt: string;
  asin: string;
  dimension: VocDimension;
  family: VocProductFamily;
  rawLabel: string;
  basis: MetricBasis;
  mentionCount: number | null;
  sampleCount: number | null;
  mentionPct: number | null;
  themesByDimension: Map<VocDimension, Map<string, MutableTheme>>;
  evidenceById: Map<string, EvidenceFact>;
}>) {
  const normalized = canonicalTheme(input.rawLabel, input.dimension, input.family);
  if (!normalized.key || !normalized.label) return;
  const recordKey = canonicalJsonSha256({
    snapshotId: input.snapshot.id,
    sourceId: input.config.sourceId,
    sourceType: input.config.sourceType,
    sourceReference: input.config.reference,
    marketplace: input.snapshot.marketplace,
    asin: input.asin,
    family: input.family,
    capturedAt: input.capturedAt,
  });
  const evidenceId = canonicalJsonSha256({
    recordKey,
    dimension: input.dimension,
    themeKey: normalized.key,
    rawLabel: input.rawLabel,
    basis: input.basis,
    mentionCount: input.mentionCount,
    sampleCount: input.sampleCount,
    mentionPct: input.mentionPct,
  });
  const metric = ThemeMetricSchema.parse({
    evidenceId,
    recordKey,
    sourceId: input.config.sourceId,
    sourceType: input.config.sourceType,
    sourceReference: input.config.reference,
    marketplace: input.snapshot.marketplace,
    capturedAt: input.capturedAt,
    asin: input.asin,
    family: input.family,
    rawLabel: input.rawLabel,
    basis: input.basis,
    mentionCount: input.mentionCount,
    sampleCount: input.sampleCount,
    mentionPct: input.mentionPct,
    denominatorScope: "source-record",
    comparability: "record-only",
  });
  const dimensionThemes = input.themesByDimension.get(input.dimension);
  if (!dimensionThemes) throw new TypeError("Unknown VOC dimension");
  const theme = dimensionThemes.get(normalized.key) ?? {
    key: normalized.key,
    label: normalized.label,
    families: new Set<VocProductFamily>(),
    metricsByEvidenceId: new Map<string, ThemeMetric>(),
  };
  if (compareCodePoints(normalized.label, theme.label) < 0) {
    theme.label = normalized.label;
  }
  theme.families.add(input.family);
  theme.metricsByEvidenceId.set(evidenceId, metric);
  dimensionThemes.set(normalized.key, theme);
  input.evidenceById.set(
    evidenceId,
    EvidenceFactSchema.parse({
      id: evidenceId,
      recordKey,
      snapshotId: input.snapshot.id,
      runId: input.snapshot.runId,
      sourceId: input.config.sourceId,
      sourceType: input.config.sourceType,
      sourceReference: input.config.reference,
      marketplace: input.snapshot.marketplace,
      capturedAt: input.capturedAt,
      asin: input.asin,
      family: input.family,
      dimension: input.dimension,
      themeKey: normalized.key,
      rawLabel: input.rawLabel,
      basis: input.basis,
    }),
  );
}

function buildPriorityFacts(
  themesByDimension: Map<VocDimension, Map<string, MutableTheme>>,
) {
  const facts = new Map<
    string,
    Array<{ dimension: VocDimension; mentionPct: number | null; label: string }>
  >();
  for (const [dimension, themes] of themesByDimension) {
    for (const theme of themes.values()) {
      const themeFacts = facts.get(theme.key) ?? [];
      for (const metric of theme.metricsByEvidenceId.values()) {
        themeFacts.push({
          dimension,
          mentionPct: metric.mentionPct,
          label: metric.rawLabel,
        });
      }
      facts.set(theme.key, themeFacts);
    }
  }
  return facts;
}

function finalizeTheme(
  theme: MutableTheme,
  priorityFacts: readonly Readonly<{
    dimension: VocDimension;
    mentionPct: number | null;
    label: string;
  }>[],
  snapshot: VocDataSnapshotRecord,
) {
  const metrics = [...theme.metricsByEvidenceId.values()].sort((left, right) =>
    compareMetrics(left, right, snapshot),
  );
  const family =
    theme.families.size === 1 ? [...theme.families][0] : "generic";
  const priority = classifyVocPriority(priorityFacts);
  return ThemeFactSchema.parse({
    key: theme.key,
    label: theme.label,
    family,
    metrics,
    priority,
    evidenceIds: metrics.map((metric) => metric.evidenceId),
  });
}

function buildAvailability(snapshot: VocDataSnapshotRecord) {
  return SOURCE_CONFIGS.map((config) => {
    const records = recordsFor(snapshot, config.sourceId);
    const recordAsins = new Set(records.map((record) => record.asin));
    const missingAsins = snapshot.asins.filter((asin) => !recordAsins.has(asin));
    const source = sourceFor(snapshot, config);
    const status =
      records.length === 0
        ? "unavailable"
        : missingAsins.length > 0
          ? "partial"
          : "available";
    const denominators = records.map((record) => {
      if (config.sourceId === "alexa-voc") {
        const alexa = record as VocDataSnapshotRecord["payload"]["records"]["alexaVoc"][number];
        return {
          asin: record.asin,
          kind: "review-count" as const,
          sampleCount: alexa.alexaReport.reviewCount,
        };
      }
      const review = record as ReviewRecord;
      return {
        asin: record.asin,
        kind: "sampled-reviews" as const,
        sampleCount: review.sampledReviews,
      };
    });
    const usableDenominators = denominators.every(
      (denominator) =>
        denominator.sampleCount !== null && denominator.sampleCount > 0,
    );
    const comparability =
      status === "unavailable"
        ? "unknown"
        : status === "partial"
          ? "partial"
          : !usableDenominators
            ? "unknown"
            : records.length === 1
              ? "comparable"
              : "not-comparable";
    return SourceAvailabilitySchema.parse({
      sourceId: config.sourceId,
      sourceType: config.sourceType,
      status,
      reference: source?.reference ?? null,
      marketplace: snapshot.marketplace,
      capturedAt: source?.capturedAt ?? null,
      recordCount: records.length,
      targetCount: snapshot.asins.length,
      missingAsins,
      comparability,
      denominators,
    });
  });
}

function sourceFor(snapshot: VocDataSnapshotRecord, config: SourceConfig) {
  return snapshot.sources.find((source) => source.reference === config.reference);
}

function recordsFor(
  snapshot: VocDataSnapshotRecord,
  sourceId: VocSnapshotSourceId,
): ReadonlyArray<{ asin: string }> {
  if (sourceId === "alexa-voc") return snapshot.payload.records.alexaVoc;
  if (sourceId === "sorftime-review-analysis") {
    return snapshot.payload.records.sorftimeReviewAnalysis;
  }
  return snapshot.payload.records.sellerSpriteReviewAnalysis;
}

function compareMetrics(
  left: ThemeMetric,
  right: ThemeMetric,
  snapshot: VocDataSnapshotRecord,
) {
  return (
    sourceOrdinal(left.sourceId) - sourceOrdinal(right.sourceId) ||
    snapshot.asins.indexOf(left.asin) - snapshot.asins.indexOf(right.asin) ||
    compareCodePoints(left.capturedAt, right.capturedAt) ||
    compareCodePoints(left.family, right.family) ||
    compareCodePoints(left.rawLabel, right.rawLabel) ||
    compareCodePoints(left.evidenceId, right.evidenceId)
  );
}

function compareEvidence(
  left: EvidenceFact,
  right: EvidenceFact,
  snapshot: VocDataSnapshotRecord,
) {
  return (
    sourceOrdinal(left.sourceId) - sourceOrdinal(right.sourceId) ||
    snapshot.asins.indexOf(left.asin) - snapshot.asins.indexOf(right.asin) ||
    compareCodePoints(left.capturedAt, right.capturedAt) ||
    compareCodePoints(left.family, right.family) ||
    VOC_DIMENSIONS.indexOf(left.dimension) - VOC_DIMENSIONS.indexOf(right.dimension) ||
    compareCodePoints(left.themeKey, right.themeKey) ||
    compareCodePoints(left.rawLabel, right.rawLabel) ||
    compareCodePoints(left.id, right.id)
  );
}

function compareThemes(
  left: z.infer<typeof ThemeFactSchema>,
  right: z.infer<typeof ThemeFactSchema>,
) {
  const maxPct = (theme: z.infer<typeof ThemeFactSchema>) =>
    theme.metrics.reduce(
      (maximum, metric) => Math.max(maximum, metric.mentionPct ?? -1),
      -1,
    );
  const asinCount = (theme: z.infer<typeof ThemeFactSchema>) =>
    new Set(theme.metrics.map((metric) => metric.asin)).size;
  return (
    priorityRank(left.priority.level) - priorityRank(right.priority.level) ||
    Number(left.priority.safetyRule === null) -
      Number(right.priority.safetyRule === null) ||
    maxPct(right) - maxPct(left) ||
    asinCount(right) - asinCount(left) ||
    compareCodePoints(left.key, right.key) ||
    compareCodePoints(left.evidenceIds[0], right.evidenceIds[0])
  );
}

function assertEvidenceClosure(
  dimensions: readonly z.infer<typeof DimensionFactSchema>[],
  evidenceIndex: readonly EvidenceFact[],
  snapshot: VocDataSnapshotRecord,
) {
  const byId = new Map(evidenceIndex.map((evidence) => [evidence.id, evidence]));
  if (byId.size !== evidenceIndex.length) {
    throw new TypeError("Duplicate VOC evidence ID");
  }
  for (const dimension of dimensions) {
    for (const theme of dimension.themes) {
      for (const evidenceId of theme.evidenceIds) {
        const evidence = byId.get(evidenceId);
        if (
          !evidence ||
          evidence.snapshotId !== snapshot.id ||
          evidence.runId !== snapshot.runId ||
          evidence.marketplace !== snapshot.marketplace ||
          evidence.dimension !== dimension.key ||
          evidence.themeKey !== theme.key ||
          !snapshot.asins.includes(evidence.asin)
        ) {
          throw new TypeError("Dangling or cross-snapshot VOC evidence");
        }
      }
    }
  }
}

function sourceOrdinal(sourceId: VocSnapshotSourceId) {
  return SOURCE_CONFIGS.findIndex((source) => source.sourceId === sourceId);
}
