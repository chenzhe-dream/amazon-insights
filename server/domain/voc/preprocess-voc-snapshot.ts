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
  recordCapturedAt: DateTimeSchema,
  family: VocProductFamilySchema,
});

const SourceAvailabilitySchema = z.strictObject({
  sourceId: VocSnapshotSourceIdSchema,
  sourceType: z.enum(["manual-voc", "connector"]),
  status: z.enum(["available", "partial", "unavailable"]),
  reference: z.string().min(1).max(500).nullable(),
  marketplace: MarketplaceSchema,
  capturedAt: DateTimeSchema.nullable(),
  sourceChecksum: Sha256Schema.nullable(),
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

const VocDeterministicPreprocessingResultShapeSchema = z.strictObject({
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
  factsDigest: Sha256Schema,
});

export const VocDeterministicPreprocessingResultSchema =
  VocDeterministicPreprocessingResultShapeSchema
    .superRefine((value, context) => {
      try {
        assertVocDeterministicResultIntegrity(value);
      } catch (error) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            error instanceof Error
              ? error.message
              : "Invalid deterministic VOC result integrity",
        });
      }
    })
    .transform((value) => deepFreeze(value));

export type VocDeterministicPreprocessingResult = z.infer<
  typeof VocDeterministicPreprocessingResultSchema
>;

export function parseVocDeterministicPreprocessingResult(input: unknown) {
  return VocDeterministicPreprocessingResultSchema.parse(input);
}

type VocDeterministicPreprocessingResultShape = z.infer<
  typeof VocDeterministicPreprocessingResultShapeSchema
>;
type VocDeterministicFactsContainer = Omit<
  VocDeterministicPreprocessingResultShape,
  "factsDigest"
>;

type ReviewRecord = z.infer<typeof ReviewAnalysisSnapshotRecordSchema>;
type MetricBasis = z.infer<typeof MetricBasisSchema>;
type ThemeMetric = z.infer<typeof ThemeMetricSchema>;
type EvidenceFact = z.infer<typeof EvidenceFactSchema>;

export function reviewRowMetricInputs(
  row: Readonly<{ metricKind?: string; numerator?: number; denominator?: number; sharePct: number }>,
  sampledReviews: number,
): Readonly<{ basis: MetricBasis; mentionCount: number | null; sampleCount: number | null; mentionPct: number | null }> {
  if (
    row.metricKind === "review_sample_incidence"
    && Number.isInteger(row.numerator)
    && Number.isInteger(row.denominator)
    && row.denominator === sampledReviews
  ) {
    return {
      basis: "review-share-percentage",
      mentionCount: row.numerator!,
      sampleCount: row.denominator!,
      mentionPct: row.sharePct,
    };
  }
  if (
    row.metricKind === "customers_say_topic_share"
    && Number.isInteger(row.numerator)
    && Number.isInteger(row.denominator)
  ) {
    return {
      basis: "presence-only",
      mentionCount: null,
      sampleCount: sampledReviews,
      mentionPct: null,
    };
  }
  return { basis: "presence-only", mentionCount: null, sampleCount: sampledReviews, mentionPct: null };
}

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
    const activeConfig = source.reference === config.reference
      ? config
      : { ...config, reference: source.reference };
    if (config.sourceId === "alexa-voc") {
      for (const [recordIndex, record] of
        snapshot.payload.records.alexaVoc.entries()) {
        collectAlexaRecord(
          snapshot,
          activeConfig,
          alexaRecordCapturedAt(source, record, recordIndex),
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
          activeConfig,
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
  const result = parseVocDeterministicPreprocessingResult({
    ...withoutDigest,
    factsDigest: calculateFactsDigest(withoutDigest),
  });
  return result;
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
      const metric = reviewRowMetricInputs(row, record.sampledReviews);
      addMetric({
        snapshot,
        config,
        capturedAt: recordCapturedAt,
        asin: record.asin,
        dimension,
        family,
        rawLabel: row.label,
        ...metric,
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
    if (records.length > 0 && !source) {
      throw new TypeError("VOC records are missing source provenance");
    }
    const status =
      records.length === 0
        ? "unavailable"
        : missingAsins.length > 0
          ? "partial"
          : "available";
    const denominators = records.map((record, recordIndex) => {
      if (config.sourceId === "alexa-voc") {
        const alexa = record as VocDataSnapshotRecord["payload"]["records"]["alexaVoc"][number];
        return {
          asin: record.asin,
          kind: "review-count" as const,
          sampleCount: alexa.alexaReport.reviewCount,
          recordCapturedAt: alexaRecordCapturedAt(
            source!,
            alexa,
            recordIndex,
          ),
          family: "generic" as const,
        };
      }
      const review = record as ReviewRecord;
      return {
        asin: record.asin,
        kind: "sampled-reviews" as const,
        sampleCount: review.sampledReviews,
        recordCapturedAt: normalizeRepositoryDateOnlyUtc(review.fetchedAt),
        family: review.family ?? ("generic" as const),
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
      sourceChecksum: source?.checksum ?? null,
      recordCount: records.length,
      targetCount: snapshot.asins.length,
      missingAsins,
      comparability,
      denominators,
    });
  });
}

function sourceFor(snapshot: VocDataSnapshotRecord, config: SourceConfig) {
  return snapshot.sources.find((source) =>
    sourceReferenceMatches(config, source.reference),
  );
}

function sourceReferenceMatches(config: SourceConfig, reference: string) {
  return reference === config.reference || (
    config.sourceId === "alexa-voc" &&
    reference === VOC_SOURCE_REFERENCES.manualAlexaVocRepository
  );
}

function alexaRecordCapturedAt(
  source: VocDataSnapshotRecord["sources"][number],
  record: VocDataSnapshotRecord["payload"]["records"]["alexaVoc"][number],
  recordIndex: number,
) {
  const provenance = source.recordProvenance?.[recordIndex];
  return provenance?.asin === record.asin
    ? provenance.capturedAt
    : source.capturedAt;
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
  snapshot: Readonly<{ asins: readonly string[] }>,
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
  snapshot: Readonly<{ asins: readonly string[] }>,
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

/**
 * Hashes only facts eligible for the future 8.3 whitelist. This is not a
 * complete source hash; persisted identity must also bind snapshot.id and
 * snapshot.contentHash.
 */
function calculateFactsDigest(value: VocDeterministicFactsContainer) {
  return canonicalJsonSha256({
    schemaVersion: value.schemaVersion,
    kind: value.kind,
    snapshot: {
      id: value.snapshot.id,
      runId: value.snapshot.runId,
      marketplace: value.snapshot.marketplace,
      asins: value.snapshot.asins,
      dataCutoffAt: value.snapshot.dataCutoffAt,
    },
    availability: value.availability.map((source) => ({
      sourceId: source.sourceId,
      sourceType: source.sourceType,
      status: source.status,
      reference: source.reference,
      marketplace: source.marketplace,
      capturedAt: source.capturedAt,
      recordCount: source.recordCount,
      targetCount: source.targetCount,
      missingAsins: source.missingAsins,
      comparability: source.comparability,
      denominators: source.denominators,
    })),
    dimensions: value.dimensions,
    evidenceIndex: value.evidenceIndex,
  });
}

function assertVocDeterministicResultIntegrity(
  value: VocDeterministicPreprocessingResultShape,
) {
  requireIntegrity(
    new Set(value.snapshot.asins).size === value.snapshot.asins.length,
    "VOC result target ASINs must be unique",
  );
  requireIntegrity(
    value.snapshot.dataCutoffAt ===
      new Date(value.snapshot.dataCutoffAt).toISOString(),
    "VOC result cutoff must use canonical UTC milliseconds",
  );
  requireIntegrity(
    calculateFactsDigest(value) === value.factsDigest,
    "VOC result facts digest mismatch",
  );

  const availabilityBySource = new Map<
    VocSnapshotSourceId,
    z.infer<typeof SourceAvailabilitySchema>
  >();
  const sourceChecksums = new Set<string>();
  for (const [index, config] of SOURCE_CONFIGS.entries()) {
    const availability = value.availability[index];
    requireIntegrity(
      availability !== undefined &&
        availability.sourceId === config.sourceId &&
        availability.sourceType === config.sourceType &&
        availability.marketplace === value.snapshot.marketplace &&
        availability.targetCount === value.snapshot.asins.length,
      "VOC source availability identity mismatch",
    );
    requireIntegrity(
      !availabilityBySource.has(availability.sourceId),
      "Duplicate VOC source availability",
    );
    availabilityBySource.set(availability.sourceId, availability);

    const denominatorAsins = availability.denominators.map(
      (denominator) => denominator.asin,
    );
    requireIntegrity(
      new Set(denominatorAsins).size === denominatorAsins.length &&
        denominatorAsins.every((asin) => value.snapshot.asins.includes(asin)) &&
        availability.recordCount === availability.denominators.length,
      "VOC source denominator coverage mismatch",
    );
    const sortedDenominatorAsins = [...denominatorAsins].sort(
      (left, right) =>
        value.snapshot.asins.indexOf(left) - value.snapshot.asins.indexOf(right),
    );
    requireIntegrity(
      sameJson(denominatorAsins, sortedDenominatorAsins),
      "VOC source denominators are not in target order",
    );
    const missingAsins = value.snapshot.asins.filter(
      (asin) => !denominatorAsins.includes(asin),
    );
    requireIntegrity(
      sameJson(availability.missingAsins, missingAsins),
      "VOC source missing ASIN coverage mismatch",
    );
    const expectedDenominatorKind =
      config.sourceId === "alexa-voc" ? "review-count" : "sampled-reviews";
    requireIntegrity(
      availability.denominators.every(
        (denominator) => denominator.kind === expectedDenominatorKind,
      ),
      "VOC source denominator kind mismatch",
    );

    if (availability.recordCount === 0) {
      requireIntegrity(
        availability.status === "unavailable" &&
          availability.reference === null &&
          availability.capturedAt === null &&
          availability.sourceChecksum === null &&
          availability.comparability === "unknown",
        "Unavailable VOC source contains fabricated provenance",
      );
      continue;
    }

    requireIntegrity(
      availability.reference !== null &&
        sourceReferenceMatches(config, availability.reference) &&
        availability.capturedAt !== null &&
        availability.sourceChecksum !== null,
      "Available VOC source provenance mismatch",
    );
    requireIntegrity(
      availability.capturedAt ===
        new Date(availability.capturedAt).toISOString() &&
        availability.capturedAt <= value.snapshot.dataCutoffAt,
      "VOC source capture time is non-canonical or after cutoff",
    );
    requireIntegrity(
      availability.denominators.every(
        (denominator) =>
          denominator.recordCapturedAt ===
            new Date(denominator.recordCapturedAt).toISOString() &&
          denominator.recordCapturedAt <= availability.capturedAt! &&
          denominator.recordCapturedAt <= value.snapshot.dataCutoffAt &&
          (config.sourceId === "alexa-voc"
            ? denominator.family === "generic"
            : denominator.recordCapturedAt.endsWith("T23:59:59.999Z")),
      ),
      "VOC record scope time or family is invalid",
    );
    requireIntegrity(
      !sourceChecksums.has(availability.sourceChecksum),
      "Duplicate VOC source checksum",
    );
    sourceChecksums.add(availability.sourceChecksum);
    const expectedStatus =
      missingAsins.length === 0 ? "available" : "partial";
    const usableDenominators = availability.denominators.every(
      (denominator) =>
        denominator.sampleCount !== null && denominator.sampleCount > 0,
    );
    const expectedComparability =
      expectedStatus === "partial"
        ? "partial"
        : !usableDenominators
          ? "unknown"
          : availability.recordCount === 1
            ? "comparable"
            : "not-comparable";
    requireIntegrity(
      availability.status === expectedStatus &&
        availability.comparability === expectedComparability,
      "VOC source status or comparability mismatch",
    );
  }

  const evidenceById = new Map<string, EvidenceFact>();
  for (const evidence of value.evidenceIndex) {
    requireIntegrity(
      !evidenceById.has(evidence.id),
      "Duplicate VOC evidence ID",
    );
    evidenceById.set(evidence.id, evidence);
    assertEvidenceSourceBoundary(evidence, value, availabilityBySource);
  }
  requireIntegrity(
    sameJson(
      value.evidenceIndex,
      [...value.evidenceIndex].sort((left, right) =>
        compareEvidence(left, right, value.snapshot),
      ),
    ),
    "VOC evidence index is not canonically ordered",
  );

  const evidenceReferenceCounts = new Map(
    value.evidenceIndex.map((evidence) => [evidence.id, 0]),
  );
  const priorityFactsByKey = new Map<
    string,
    Array<{ dimension: VocDimension; mentionPct: number | null; label: string }>
  >();
  const themesByKey = new Map<
    string,
    Array<z.infer<typeof ThemeFactSchema>>
  >();

  for (const [dimensionIndex, expectedDimension] of VOC_DIMENSIONS.entries()) {
    const dimension = value.dimensions[dimensionIndex];
    requireIntegrity(
      dimension !== undefined &&
        dimension.key === expectedDimension &&
        dimension.label === DIMENSION_LABELS[expectedDimension],
      "VOC dimension identity or order mismatch",
    );
    const themeKeys = new Set<string>();
    requireIntegrity(
      sameJson(
        dimension.themes,
        [...dimension.themes].sort(compareThemes),
      ),
      "VOC themes are not canonically ordered",
    );
    for (const theme of dimension.themes) {
      requireIntegrity(!themeKeys.has(theme.key), "Duplicate VOC theme key");
      themeKeys.add(theme.key);
      requireIntegrity(
        sameJson(
          theme.metrics,
          [...theme.metrics].sort((left, right) =>
            compareMetrics(left, right, value.snapshot),
          ),
        ),
        "VOC theme metrics are not canonically ordered",
      );
      requireIntegrity(
        new Set(theme.metrics.map((metric) => metric.evidenceId)).size ===
          theme.metrics.length &&
          sameJson(
            theme.evidenceIds,
            theme.metrics.map((metric) => metric.evidenceId),
          ),
        "VOC theme evidence list does not exactly match its metrics",
      );

      const candidateLabels: string[] = [];
      const families = new Set<VocProductFamily>();
      for (const metric of theme.metrics) {
        const evidence = evidenceById.get(metric.evidenceId);
        requireIntegrity(evidence !== undefined, "Dangling VOC evidence ID");
        assertMetricEvidencePair(
          metric,
          evidence,
          dimension.key,
          theme.key,
          value,
          availabilityBySource,
        );
        evidenceReferenceCounts.set(
          evidence.id,
          (evidenceReferenceCounts.get(evidence.id) ?? 0) + 1,
        );
        const normalized = canonicalTheme(
          metric.rawLabel,
          dimension.key,
          metric.family,
        );
        requireIntegrity(
          normalized.key === theme.key,
          "VOC metric canonical key mismatch",
        );
        candidateLabels.push(normalized.label);
        families.add(metric.family);
        const priorityFacts = priorityFactsByKey.get(theme.key) ?? [];
        priorityFacts.push({
          dimension: dimension.key,
          mentionPct: metric.mentionPct,
          label: metric.rawLabel,
        });
        priorityFactsByKey.set(theme.key, priorityFacts);
      }
      candidateLabels.sort(compareCodePoints);
      requireIntegrity(
        theme.label === candidateLabels[0],
        "VOC theme display label is not the canonical representative",
      );
      const expectedFamily =
        families.size === 1 ? [...families][0] : "generic";
      requireIntegrity(
        theme.family === expectedFamily,
        "VOC theme aggregate family mismatch",
      );
      const matchingThemes = themesByKey.get(theme.key) ?? [];
      matchingThemes.push(theme);
      themesByKey.set(theme.key, matchingThemes);
    }
  }

  for (const [evidenceId, count] of evidenceReferenceCounts) {
    requireIntegrity(
      count === 1,
      `VOC evidence ${evidenceId} must be referenced exactly once`,
    );
  }
  for (const [themeKey, themes] of themesByKey) {
    const expectedPriority = classifyVocPriority(
      priorityFactsByKey.get(themeKey) ?? [],
    );
    requireIntegrity(
      themes.every((theme) => sameJson(theme.priority, expectedPriority)),
      "VOC theme priority decision mismatch",
    );
  }
}

function assertEvidenceSourceBoundary(
  evidence: EvidenceFact,
  value: VocDeterministicPreprocessingResultShape,
  availabilityBySource: ReadonlyMap<
    VocSnapshotSourceId,
    z.infer<typeof SourceAvailabilitySchema>
  >,
) {
  const availability = availabilityBySource.get(evidence.sourceId);
  requireIntegrity(
    availability !== undefined &&
      availability.status !== "unavailable" &&
      availability.reference !== null &&
      availability.capturedAt !== null &&
      evidence.snapshotId === value.snapshot.id &&
      evidence.runId === value.snapshot.runId &&
      evidence.sourceType === availability.sourceType &&
      evidence.sourceReference === availability.reference &&
      evidence.marketplace === value.snapshot.marketplace &&
      value.snapshot.asins.includes(evidence.asin) &&
      availability.denominators.some(
        (denominator) =>
          denominator.asin === evidence.asin &&
          denominator.recordCapturedAt === evidence.capturedAt &&
          denominator.family === evidence.family,
      ),
    "VOC evidence source or snapshot binding mismatch",
  );
  requireIntegrity(
    evidence.capturedAt === new Date(evidence.capturedAt).toISOString() &&
      evidence.capturedAt <= availability.capturedAt &&
      evidence.capturedAt <= value.snapshot.dataCutoffAt,
    "VOC evidence capture time is non-canonical or out of bounds",
  );
  requireIntegrity(
    evidence.sourceId !== "alexa-voc" ||
      evidence.family === "generic",
    "Alexa VOC evidence has invented family or record time",
  );
  const recordKey = canonicalJsonSha256({
    snapshotId: value.snapshot.id,
    sourceId: evidence.sourceId,
    sourceType: evidence.sourceType,
    sourceReference: evidence.sourceReference,
    marketplace: evidence.marketplace,
    asin: evidence.asin,
    family: evidence.family,
    capturedAt: evidence.capturedAt,
  });
  requireIntegrity(
    recordKey === evidence.recordKey,
    "VOC evidence record key mismatch",
  );
  const normalized = canonicalTheme(
    evidence.rawLabel,
    evidence.dimension,
    evidence.family,
  );
  requireIntegrity(
    normalized.key === evidence.themeKey,
    "VOC evidence canonical key mismatch",
  );
}

function assertMetricEvidencePair(
  metric: ThemeMetric,
  evidence: EvidenceFact,
  dimension: VocDimension,
  themeKey: string,
  value: VocDeterministicPreprocessingResultShape,
  availabilityBySource: ReadonlyMap<
    VocSnapshotSourceId,
    z.infer<typeof SourceAvailabilitySchema>
  >,
) {
  requireIntegrity(
    metric.recordKey === evidence.recordKey &&
      metric.sourceId === evidence.sourceId &&
      metric.sourceType === evidence.sourceType &&
      metric.sourceReference === evidence.sourceReference &&
      metric.marketplace === evidence.marketplace &&
      metric.capturedAt === evidence.capturedAt &&
      metric.asin === evidence.asin &&
      metric.family === evidence.family &&
      metric.rawLabel === evidence.rawLabel &&
      metric.basis === evidence.basis &&
      evidence.dimension === dimension &&
      evidence.themeKey === themeKey,
    "VOC metric and evidence fields diverge",
  );
  const availability = availabilityBySource.get(metric.sourceId);
  requireIntegrity(
    availability !== undefined &&
      availability.denominators.some(
        (denominator) =>
          denominator.asin === metric.asin &&
          denominator.sampleCount === metric.sampleCount &&
          denominator.recordCapturedAt === metric.capturedAt &&
          denominator.family === metric.family,
      ),
    "VOC metric denominator is not bound to source availability",
  );
  if (metric.sourceId === "alexa-voc") {
    requireIntegrity(
      metric.basis !== "review-share-percentage",
      "Alexa VOC metric uses review-share basis",
    );
  } else {
    requireIntegrity(
      (metric.basis === "presence-only" &&
        metric.mentionCount === null &&
        metric.mentionPct === null) ||
      (metric.basis === "review-share-percentage" &&
        metric.mentionPct !== null &&
        (metric.mentionCount === null || (
          metric.sampleCount !== null &&
          metric.mentionCount <= metric.sampleCount &&
          metric.mentionPct === Number(((metric.mentionCount / metric.sampleCount) * 100).toFixed(2))
        ))),
      "Review VOC metric basis or numerator is invalid",
    );
  }
  if (metric.basis === "presence-only") {
    requireIntegrity(
      metric.mentionCount === null && metric.mentionPct === null,
      "Presence-only VOC metric contains invented statistics",
    );
  }
  if (metric.basis === "mention-count") {
    const expectedPct =
      metric.mentionCount !== null &&
      metric.sampleCount !== null &&
      metric.sampleCount > 0
        ? (metric.mentionCount / metric.sampleCount) * 100
        : null;
    requireIntegrity(
      metric.mentionCount !== null && metric.mentionPct === expectedPct,
      "Mention-count VOC metric percentage mismatch",
    );
  }
  if (metric.basis === "explicit-percentage") {
    requireIntegrity(
      metric.mentionPct !== null,
      "Explicit-percentage VOC metric is missing its percentage",
    );
  }
  const evidenceId = canonicalJsonSha256({
    recordKey: metric.recordKey,
    dimension,
    themeKey,
    rawLabel: metric.rawLabel,
    basis: metric.basis,
    mentionCount: metric.mentionCount,
    sampleCount: metric.sampleCount,
    mentionPct: metric.mentionPct,
  });
  requireIntegrity(
    evidenceId === metric.evidenceId && evidenceId === evidence.id,
    "VOC metric evidence ID mismatch",
  );
}

function sameJson(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function requireIntegrity(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) throw new TypeError(message);
}

function sourceOrdinal(sourceId: VocSnapshotSourceId) {
  return SOURCE_CONFIGS.findIndex((source) => source.sourceId === sourceId);
}
