import { createHash } from "node:crypto";

import { z } from "zod";

import {
  AsinSchema,
  DateTimeSchema,
  EntityIdSchema,
  MarketplaceSchema,
  Sha256Schema,
} from "../../shared/agent-contracts";

export const KEYWORD_ANALYSIS_SNAPSHOT_SCHEMA_VERSION = "1.0.0" as const;

const KeywordQueryWindowSchema = z.strictObject({
  time_type: z.string().min(1), time_value: z.string().min(1), listingSearch: z.boolean(),
});
const CurrentEmptySchema = z.strictObject({
  queryWindow: KeywordQueryWindowSchema, observedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  terminalReason: z.literal("valid-empty"),
});
const KeywordCoverageSchema = z.strictObject({
  asin: AsinSchema, status: z.enum(["ready", "empty"]),
  queryWindow: KeywordQueryWindowSchema.nullable(),
  currentEmpty: CurrentEmptySchema.optional(),
});

const KeywordEvidenceSchema = z.strictObject({
  id: z.string().trim().min(1).max(200),
  sourceId: z.string().trim().min(1).max(500),
  capturedAt: DateTimeSchema,
  searchVolume: z.number().finite().nonnegative().nullable(),
  purchaseRate: z.number().finite().min(0).max(1).nullable(),
  queryWindow: KeywordQueryWindowSchema.optional(),
  currentEmpty: CurrentEmptySchema.optional(),
});

const KeywordGroupSchema = z.strictObject({
  id: z.string().trim().min(1).max(200),
  label: z.string().trim().min(1).max(200),
  keywords: z.array(z.string().trim().min(1).max(200)).min(1).max(50),
  demand: z.enum(["high", "medium", "low", "unknown"]),
  trend: z.enum(["growing", "stable", "declining", "unknown"]),
  seasonality: z.enum(["seasonal", "non-seasonal", "unknown"]),
  evidenceIds: z.array(z.string().trim().min(1).max(200)).min(1).max(50),
});

export const KeywordAnalysisSnapshotCandidateSchema = z
  .strictObject({
    kind: z.literal("keyword-analysis"),
    schemaVersion: z.literal(KEYWORD_ANALYSIS_SNAPSHOT_SCHEMA_VERSION),
    marketplace: MarketplaceSchema,
    asins: z.array(AsinSchema).min(1).max(10),
    dataCutoffAt: DateTimeSchema,
    sources: z.array(z.strictObject({
      id: z.string().trim().min(1).max(200),
      type: z.literal("deterministic-analysis"),
      capturedAt: DateTimeSchema,
      checksum: Sha256Schema,
    })).min(1).max(10),
    payload: z.strictObject({
      groups: z.array(KeywordGroupSchema).min(1).max(100),
      evidence: z.array(KeywordEvidenceSchema).min(1).max(500),
      coverage: z.array(KeywordCoverageSchema).min(1).max(10).optional(),
    }),
    contentHash: Sha256Schema,
  })
  .superRefine(validateSnapshot);

export type KeywordAnalysisSnapshotCandidate = z.infer<
  typeof KeywordAnalysisSnapshotCandidateSchema
>;

export const KeywordAnalysisSnapshotRecordSchema = z
  .strictObject({
    kind: z.literal("keyword-analysis"),
    schemaVersion: z.literal(KEYWORD_ANALYSIS_SNAPSHOT_SCHEMA_VERSION),
    marketplace: MarketplaceSchema,
    asins: z.array(AsinSchema).min(1).max(10),
    dataCutoffAt: DateTimeSchema,
    sources: KeywordAnalysisSnapshotCandidateSchema.shape.sources,
    payload: KeywordAnalysisSnapshotCandidateSchema.shape.payload,
    contentHash: Sha256Schema,
    id: EntityIdSchema,
    runId: EntityIdSchema,
    createdAt: DateTimeSchema,
  })
  .superRefine((snapshot, context) => validateSnapshot(snapshot, context));
export type KeywordAnalysisSnapshotRecord = z.infer<
  typeof KeywordAnalysisSnapshotRecordSchema
>;

export function buildKeywordAnalysisSnapshotCandidate(input: {
  marketplace: string;
  asins: readonly string[];
  dataCutoffAt: string;
  groups: readonly z.input<typeof KeywordGroupSchema>[];
  evidence: readonly z.input<typeof KeywordEvidenceSchema>[];
  coverage?: readonly z.input<typeof KeywordCoverageSchema>[];
}): KeywordAnalysisSnapshotCandidate {
  const evidence = z.array(KeywordEvidenceSchema).parse(input.evidence);
  const unsigned = {
    kind: "keyword-analysis" as const,
    schemaVersion: KEYWORD_ANALYSIS_SNAPSHOT_SCHEMA_VERSION,
    marketplace: MarketplaceSchema.parse(input.marketplace),
    asins: z.array(AsinSchema).min(1).max(10).parse(input.asins),
    dataCutoffAt: DateTimeSchema.parse(input.dataCutoffAt),
    sources: [{
      id: "keyword-analysis",
      type: "deterministic-analysis" as const,
      capturedAt: DateTimeSchema.parse(input.dataCutoffAt),
      checksum: keywordSnapshotContentHash({ groups: input.groups, evidence, ...(input.coverage ? { coverage: input.coverage } : {}) }),
    }],
    payload: {
      groups: z.array(KeywordGroupSchema).min(1).max(100).parse(input.groups),
      evidence,
      ...(input.coverage ? { coverage: z.array(KeywordCoverageSchema).min(1).max(10).parse(input.coverage) } : {}),
    },
  };
  return KeywordAnalysisSnapshotCandidateSchema.parse({
    ...unsigned,
    contentHash: keywordSnapshotContentHash(unsigned),
  });
}

export function keywordSnapshotContentHash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function validateSnapshot(
  snapshot: {
    kind: "keyword-analysis";
    schemaVersion: "1.0.0";
    marketplace: string;
    asins: string[];
    dataCutoffAt: string;
    sources: z.infer<typeof KeywordAnalysisSnapshotCandidateSchema.shape.sources>;
    payload: z.infer<typeof KeywordAnalysisSnapshotCandidateSchema.shape.payload>;
    contentHash: string;
  },
  context: z.RefinementCtx,
) {
  const evidenceIds = new Set(snapshot.payload.evidence.map(({ id }) => id));
  if (evidenceIds.size !== snapshot.payload.evidence.length) {
    context.addIssue({ code: "custom", path: ["payload", "evidence"], message: "Keyword evidence IDs must be unique" });
  }
  for (const [index, group] of snapshot.payload.groups.entries()) {
    if (group.evidenceIds.some((id) => !evidenceIds.has(id))) {
      context.addIssue({ code: "custom", path: ["payload", "groups", index, "evidenceIds"], message: "Keyword group evidence must exist" });
    }
  }
  if (snapshot.payload.coverage && (snapshot.payload.coverage.length !== snapshot.asins.length ||
    snapshot.payload.coverage.some((row, index) => row.asin !== snapshot.asins[index]))) {
    context.addIssue({ code: "custom", path: ["payload", "coverage"], message: "Keyword coverage must match the fixed target" });
  }
  for (const [index, row] of snapshot.payload.evidence.entries()) {
    if (row.queryWindow?.time_type === "month" && !row.currentEmpty) {
      context.addIssue({ code: "custom", path: ["payload", "evidence", index], message: "Historical keyword evidence needs a verified current empty observation" });
    }
  }
  const unsigned = {
    kind: snapshot.kind,
    schemaVersion: snapshot.schemaVersion,
    marketplace: snapshot.marketplace,
    asins: snapshot.asins,
    dataCutoffAt: snapshot.dataCutoffAt,
    sources: snapshot.sources,
    payload: snapshot.payload,
  };
  if (snapshot.contentHash !== keywordSnapshotContentHash(unsigned)) {
    context.addIssue({ code: "custom", path: ["contentHash"], message: "Keyword snapshot content hash mismatch" });
  }
}
