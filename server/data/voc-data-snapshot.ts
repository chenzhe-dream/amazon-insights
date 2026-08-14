import { z } from "zod";

import {
  AsinSchema,
  DataSnapshotSchema,
  DateTimeSchema,
  MarketplaceSchema,
  Sha256Schema,
} from "../../shared/agent-contracts";
import { canonicalJsonSha256 } from "../runtime/model-request-accounting";

export const VOC_SNAPSHOT_SCHEMA_VERSION = "1.0.0" as const;

const RepositoryDateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected repository date-only value")
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return (
      Number.isFinite(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === value
    );
  }, "Expected valid repository date-only value");

const NonEmptyTextSchema = z.string().min(1);

export const AlexaVocReportHeaderSnapshotSchema = z.strictObject({
  title: NonEmptyTextSchema,
  asin: AsinSchema,
  rating: z.number().min(0).max(5),
  reviewCount: z.number().int().nonnegative(),
  starBreakdown: NonEmptyTextSchema.optional(),
  prompt: NonEmptyTextSchema,
  overallConclusion: NonEmptyTextSchema,
  captureNote: NonEmptyTextSchema.optional(),
  captureStatus: z.literal("dialog").optional(),
});

export const AlexaVocSnapshotRecordSchema = z
  .strictObject({
    asin: AsinSchema,
    attention: z.array(NonEmptyTextSchema).min(1),
    positives: z.array(NonEmptyTextSchema).min(1),
    negatives: z.array(NonEmptyTextSchema).min(1),
    unmet: z.array(NonEmptyTextSchema).min(1),
    audiences: z.array(NonEmptyTextSchema).min(1),
    scenarios: z.array(NonEmptyTextSchema).min(1),
    motives: z.array(NonEmptyTextSchema).min(1),
    captureStatus: z.literal("dialog"),
    alexaReport: AlexaVocReportHeaderSnapshotSchema,
  })
  .refine((record) => record.alexaReport.asin === record.asin, {
    message: "Alexa report ASIN must match its record",
    path: ["alexaReport", "asin"],
  });

export const ReviewAnalysisBlockKeySchema = z.enum([
  "consumerProfile",
  "scenarios",
  "unmet",
  "positives",
  "negatives",
  "motives",
]);

export const ReviewAnalysisSnapshotRecordSchema = z.strictObject({
  asin: AsinSchema,
  marketplace: MarketplaceSchema,
  sampledReviews: z.number().int().positive(),
  mentionTopics: z.number().int().nonnegative().optional(),
  fetchedAt: RepositoryDateOnlySchema,
  status: z.literal("ready"),
  statusMessage: NonEmptyTextSchema.optional(),
  family: z.enum(["scooter", "lighting", "generic"]).optional(),
  blocks: z.array(
    z.strictObject({
      key: ReviewAnalysisBlockKeySchema,
      label: NonEmptyTextSchema,
      rows: z.array(
        z.strictObject({
          label: NonEmptyTextSchema,
          sharePct: z.number().min(0).max(100),
          reason: z.string(),
        }),
      ),
    }),
  ),
});

const PayloadAsinListSchema = z
  .array(AsinSchema)
  .min(1)
  .max(10)
  .refine((asins) => new Set(asins).size === asins.length, {
    message: "ASINs must be unique",
  });

export const VocSnapshotPayloadSchema = z
  .strictObject({
    schemaVersion: z.literal(VOC_SNAPSHOT_SCHEMA_VERSION),
    kind: z.literal("voc"),
    marketplace: MarketplaceSchema,
    asins: PayloadAsinListSchema,
    records: z.strictObject({
      alexaVoc: z.array(AlexaVocSnapshotRecordSchema),
      sorftimeReviewAnalysis: z.array(ReviewAnalysisSnapshotRecordSchema),
      sellerSpriteReviewAnalysis: z.array(ReviewAnalysisSnapshotRecordSchema),
    }),
  })
  .superRefine((payload, context) => {
    const targetOrdinals = new Map(
      payload.asins.map((asin, ordinal) => [asin, ordinal] as const),
    );
    const sourceRecords = Object.entries(payload.records) as Array<
      [string, Array<{ asin: string; marketplace?: string }>]
    >;

    if (sourceRecords.every(([, records]) => records.length === 0)) {
      context.addIssue({
        code: "custom",
        message: "VOC payload must contain at least one available record",
        path: ["records"],
      });
    }

    for (const [sourceId, records] of sourceRecords) {
      let previousOrdinal = -1;
      const seen = new Set<string>();
      records.forEach((record, recordIndex) => {
        const ordinal = targetOrdinals.get(record.asin);
        if (ordinal === undefined) {
          context.addIssue({
            code: "custom",
            message: "VOC record ASIN is outside the target whitelist",
            path: ["records", sourceId, recordIndex, "asin"],
          });
          return;
        }
        if (seen.has(record.asin) || ordinal <= previousOrdinal) {
          context.addIssue({
            code: "custom",
            message: "VOC records must be unique and follow target ASIN order",
            path: ["records", sourceId, recordIndex, "asin"],
          });
        }
        if (record.marketplace && record.marketplace !== payload.marketplace) {
          context.addIssue({
            code: "custom",
            message: "Review marketplace must match the snapshot target",
            path: ["records", sourceId, recordIndex, "marketplace"],
          });
        }
        seen.add(record.asin);
        previousOrdinal = ordinal;
      });
    }
  });

export type VocSnapshotPayload = z.infer<typeof VocSnapshotPayloadSchema>;

export const VocSnapshotSourceIdSchema = z.enum([
  "alexa-voc",
  "sorftime-review-analysis",
  "seller-sprite-review-analysis",
]);
export type VocSnapshotSourceId = z.infer<typeof VocSnapshotSourceIdSchema>;

export const VOC_SOURCE_REFERENCES = Object.freeze({
  alexaVoc: "app/rufus-voc-data.ts#rufusVocData",
  sorftimeReviewAnalysis:
    "app/sorftime-review-analysis-data.ts#sorftimeReviewAnalysisData",
  sellerSpriteReviewAnalysis:
    "app/seller-sprite-mcp-review-analysis-data.ts#sellerSpriteMcpReviewAnalysisData",
});

export const MissingVocSourceReasonSchema = z.enum([
  "not-found",
  "pending",
  "source-error",
  "marketplace-mismatch",
  "after-cutoff",
]);

export const MissingVocSourceSchema = z.strictObject({
  sourceId: VocSnapshotSourceIdSchema,
  asin: AsinSchema,
  reason: MissingVocSourceReasonSchema,
});
export type MissingVocSource = z.infer<typeof MissingVocSourceSchema>;

export const VocSnapshotSourceSchema = z.strictObject({
  type: z.enum(["manual-voc", "connector"]),
  reference: z.string().min(1).max(500),
  marketplace: MarketplaceSchema,
  capturedAt: DateTimeSchema,
  checksum: Sha256Schema,
});
export type VocSnapshotSource = z.infer<typeof VocSnapshotSourceSchema>;

export type VocSnapshotSourceBundle =
  | Readonly<{
      sourceId: "alexa-voc";
      type: "manual-voc";
      reference: typeof VOC_SOURCE_REFERENCES.alexaVoc;
      marketplace: string;
      capturedAt: string;
      records: readonly z.infer<typeof AlexaVocSnapshotRecordSchema>[];
    }>
  | Readonly<{
      sourceId: "sorftime-review-analysis";
      type: "connector";
      reference: typeof VOC_SOURCE_REFERENCES.sorftimeReviewAnalysis;
      marketplace: string;
      capturedAt: string;
      records: readonly z.infer<typeof ReviewAnalysisSnapshotRecordSchema>[];
    }>
  | Readonly<{
      sourceId: "seller-sprite-review-analysis";
      type: "connector";
      reference: typeof VOC_SOURCE_REFERENCES.sellerSpriteReviewAnalysis;
      marketplace: string;
      capturedAt: string;
      records: readonly z.infer<typeof ReviewAnalysisSnapshotRecordSchema>[];
    }>;

export const VocSnapshotCandidateSchema = z
  .strictObject({
    schemaVersion: z.literal(VOC_SNAPSHOT_SCHEMA_VERSION),
    marketplace: MarketplaceSchema,
    asins: PayloadAsinListSchema,
    dataCutoffAt: DateTimeSchema,
    sources: z.array(VocSnapshotSourceSchema).min(1),
    payload: VocSnapshotPayloadSchema,
    contentHash: Sha256Schema,
  })
  .superRefine((candidate, context) => {
    if (
      candidate.payload.marketplace !== candidate.marketplace ||
      !sameTextList(candidate.payload.asins, candidate.asins)
    ) {
      context.addIssue({
        code: "custom",
        message: "VOC payload target must match snapshot metadata",
        path: ["payload"],
      });
    }
  });
export type VocSnapshotCandidate = z.infer<typeof VocSnapshotCandidateSchema>;

export const VocDataSnapshotRecordSchema = DataSnapshotSchema.extend({
  schemaVersion: z.literal(VOC_SNAPSHOT_SCHEMA_VERSION),
  sources: z.array(VocSnapshotSourceSchema).min(1),
  payload: VocSnapshotPayloadSchema,
});
export type VocDataSnapshotRecord = z.infer<
  typeof VocDataSnapshotRecordSchema
>;

export function buildVocSnapshotCandidate(input: Readonly<{
  marketplace: string;
  asins: readonly string[];
  dataCutoffAt: string;
  sourceBundles: readonly VocSnapshotSourceBundle[];
}>): VocSnapshotCandidate {
  const marketplace = MarketplaceSchema.parse(input.marketplace);
  const asins = PayloadAsinListSchema.parse(input.asins);
  const dataCutoffAt = new Date(DateTimeSchema.parse(input.dataCutoffAt)).toISOString();
  const seenSources = new Set<VocSnapshotSourceId>();
  let previousSourceOrdinal = -1;
  const records: VocSnapshotPayload["records"] = {
    alexaVoc: [],
    sorftimeReviewAnalysis: [],
    sellerSpriteReviewAnalysis: [],
  };

  const sources = input.sourceBundles.map((bundle) => {
    const sourceId = VocSnapshotSourceIdSchema.parse(bundle.sourceId);
    const definition = sourceDefinition(sourceId);
    const ordinal = sourceOrdinal(sourceId);
    if (
      seenSources.has(sourceId) ||
      ordinal <= previousSourceOrdinal ||
      bundle.type !== definition.type ||
      bundle.reference !== definition.reference ||
      bundle.records.length === 0
    ) {
      throw new TypeError("Invalid VOC source bundle identity");
    }
    seenSources.add(sourceId);
    previousSourceOrdinal = ordinal;

    const capturedAt = new Date(DateTimeSchema.parse(bundle.capturedAt)).toISOString();
    const sourceMarketplace = MarketplaceSchema.parse(
      bundle.marketplace.trim().toUpperCase(),
    );
    if (sourceMarketplace !== marketplace) {
      throw new TypeError("VOC source marketplace does not match its target");
    }
    if (capturedAt > dataCutoffAt) {
      throw new TypeError("VOC source is after the snapshot cutoff");
    }

    if (sourceId === "alexa-voc") {
      records.alexaVoc = z.array(AlexaVocSnapshotRecordSchema).parse(bundle.records);
    } else if (sourceId === "sorftime-review-analysis") {
      records.sorftimeReviewAnalysis = z
        .array(ReviewAnalysisSnapshotRecordSchema)
        .parse(bundle.records);
    } else {
      records.sellerSpriteReviewAnalysis = z
        .array(ReviewAnalysisSnapshotRecordSchema)
        .parse(bundle.records);
    }

    return VocSnapshotSourceSchema.parse({
      type: bundle.type,
      reference: bundle.reference,
      marketplace: sourceMarketplace,
      capturedAt,
      checksum: canonicalJsonSha256({
        sourceId,
        marketplace: sourceMarketplace,
        records: bundle.records,
      }),
    });
  });

  const payload = VocSnapshotPayloadSchema.parse({
    schemaVersion: VOC_SNAPSHOT_SCHEMA_VERSION,
    kind: "voc",
    marketplace,
    asins,
    records,
  });
  const hashInput = {
    schemaVersion: VOC_SNAPSHOT_SCHEMA_VERSION,
    marketplace,
    asins,
    dataCutoffAt,
    sources,
    payload,
  };
  return deepFreeze(
    VocSnapshotCandidateSchema.parse({
      ...hashInput,
      contentHash: canonicalJsonSha256(hashInput),
    }),
  );
}

export function assertVocSnapshotCandidateIntegrity(
  value: VocSnapshotCandidate,
): void {
  const candidate = VocSnapshotCandidateSchema.parse(value);
  if (
    candidate.dataCutoffAt !== new Date(candidate.dataCutoffAt).toISOString() ||
    candidate.sources.some(
      (source) => source.capturedAt !== new Date(source.capturedAt).toISOString(),
    )
  ) {
    throw new TypeError("VOC snapshot DateTimes must use canonical UTC milliseconds");
  }
  if (
    candidate.sources.some(
      (source) =>
        new Date(source.capturedAt).getTime() >
        new Date(candidate.dataCutoffAt).getTime(),
    )
  ) {
    throw new TypeError("VOC snapshot source is after its cutoff");
  }
  const expectedSources = sourceRecords(candidate.payload).map(
    ({ sourceId, records }, index) => {
      const source = candidate.sources[index];
      const definition = sourceDefinition(sourceId);
      if (
        !source ||
        source.type !== definition.type ||
        source.reference !== definition.reference ||
        source.marketplace !== candidate.marketplace
      ) {
        throw new TypeError("VOC snapshot provenance does not match its payload");
      }
      return {
        ...source,
        checksum: canonicalJsonSha256({
          sourceId,
          marketplace: source.marketplace,
          records,
        }),
      };
    },
  );
  if (
    expectedSources.length !== candidate.sources.length ||
    expectedSources.some(
      (source, index) => source.checksum !== candidate.sources[index]?.checksum,
    )
  ) {
    throw new TypeError("VOC snapshot source checksum mismatch");
  }
  const expectedHash = canonicalJsonSha256({
    schemaVersion: candidate.schemaVersion,
    marketplace: candidate.marketplace,
    asins: candidate.asins,
    dataCutoffAt: candidate.dataCutoffAt,
    sources: candidate.sources,
    payload: candidate.payload,
  });
  if (expectedHash !== candidate.contentHash) {
    throw new TypeError("VOC snapshot content hash mismatch");
  }
}

export function canonicalizeVocSnapshotCandidate(
  value: unknown,
): VocSnapshotCandidate {
  const parsed = VocSnapshotCandidateSchema.parse(value);
  const canonical = VocSnapshotCandidateSchema.parse({
    ...parsed,
    dataCutoffAt: new Date(parsed.dataCutoffAt).toISOString(),
    sources: parsed.sources.map((source) => ({
      ...source,
      capturedAt: new Date(source.capturedAt).toISOString(),
    })),
  });
  return deepFreeze(canonical);
}

export function assertVocDataSnapshotRecordIntegrity(
  value: VocDataSnapshotRecord,
): void {
  const record = VocDataSnapshotRecordSchema.parse(value);
  assertVocSnapshotCandidateIntegrity({
    schemaVersion: record.schemaVersion,
    marketplace: record.marketplace,
    asins: record.asins,
    dataCutoffAt: record.dataCutoffAt,
    sources: record.sources,
    payload: record.payload,
    contentHash: record.contentHash,
  });
}

/**
 * Repository modules only expose calendar dates. Treating them as the final
 * instant of that UTC day prevents a same-day run cutoff from claiming data
 * whose capture time is unknown.
 */
export function normalizeRepositoryDateOnlyUtc(value: string): string {
  const dateOnly = RepositoryDateOnlySchema.safeParse(value);
  if (!dateOnly.success) {
    throw new TypeError("Invalid repository date-only value");
  }
  return `${dateOnly.data}T23:59:59.999Z`;
}

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

function sourceRecords(payload: VocSnapshotPayload) {
  const available: Array<{
    sourceId: VocSnapshotSourceId;
    records: readonly unknown[];
  }> = [];
  if (payload.records.alexaVoc.length > 0) {
    available.push({ sourceId: "alexa-voc", records: payload.records.alexaVoc });
  }
  if (payload.records.sorftimeReviewAnalysis.length > 0) {
    available.push({
      sourceId: "sorftime-review-analysis",
      records: payload.records.sorftimeReviewAnalysis,
    });
  }
  if (payload.records.sellerSpriteReviewAnalysis.length > 0) {
    available.push({
      sourceId: "seller-sprite-review-analysis",
      records: payload.records.sellerSpriteReviewAnalysis,
    });
  }
  return available;
}

function sourceDefinition(sourceId: VocSnapshotSourceId) {
  switch (sourceId) {
    case "alexa-voc":
      return {
        type: "manual-voc" as const,
        reference: VOC_SOURCE_REFERENCES.alexaVoc,
      };
    case "sorftime-review-analysis":
      return {
        type: "connector" as const,
        reference: VOC_SOURCE_REFERENCES.sorftimeReviewAnalysis,
      };
    case "seller-sprite-review-analysis":
      return {
        type: "connector" as const,
        reference: VOC_SOURCE_REFERENCES.sellerSpriteReviewAnalysis,
      };
  }
}

function sourceOrdinal(sourceId: VocSnapshotSourceId) {
  return [
    "alexa-voc",
    "sorftime-review-analysis",
    "seller-sprite-review-analysis",
  ].indexOf(sourceId);
}

function sameTextList(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
