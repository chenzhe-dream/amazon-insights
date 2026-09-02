import { z } from "zod";

import {
  AsinSchema,
  DateTimeSchema,
  MANUAL_ALEXA_VOC_SEVEN_QUESTION_PROMPT,
  ManualAlexaVocReportHeaderSchema,
  MarketplaceSchema,
} from "../../../shared/agent-contracts";
import { canonicalJsonSha256 } from "../../runtime/model-request-accounting";
import type { ModelExecutionConfig } from "../../runtime/skill-runner";

export const ALEXA_VOC_NORMALIZATION_SKILL = Object.freeze({
  id: "alexa-for-shopping-voc",
  version: "1.0.0",
  contentHash: "dd97dda58ce916ed5c8cf5f39957e1a7b6e52af95be4bfed4a088caafd8dc3c3",
});

export const AlexaVocMatrixRecordSchemaDigest = canonicalJsonSha256({
  schema: "AlexaVocMatrixRecord@1.1.0",
  dimensions: [
    "attention",
    "positives",
    "negatives",
    "unmet",
    "audiences",
    "scenarios",
    "motives",
  ],
  matrixHeaders: [
    "人群分类｜特征",
    "场景｜说明与示例",
    "动机｜重要性｜说明",
  ],
  rowFormats: ["numbered-attention", "tagged-positive", "tagged-negative", "numbered-unmet", "star-motive"],
});

const MatrixValueSchema = z.string().trim().min(1).max(1_200);
const AttentionRowSchema = MatrixValueSchema.refine(
  (row) => /^\d+\.\s+[^：]+：.+。$/.test(row),
  "Expected numbered attention row with a Chinese title separator",
);
const PositiveRowSchema = MatrixValueSchema.refine(
  (row) => /^【[^】]+】约 \d+(?:\.\d+)?% 评论提及（(?:Mixed，)?[\d,]+ 条）$/.test(row),
  "Expected tagged positive row with percentage and mention count",
);
const NegativeRowSchema = MatrixValueSchema.refine(
  (row) => /^【[^】]+】(?:约 \d+(?:\.\d+)?% 评论提及（[\d,]+ 条）|.+)$/.test(row),
  "Expected tagged negative row",
);
const UnmetRowSchema = MatrixValueSchema.refine(
  (row) => /^\d+\.\s+.+。$/.test(row),
  "Expected numbered unmet-needs row",
);

function numberedRows(schema: typeof AttentionRowSchema | typeof UnmetRowSchema, maximum: number) {
  return z.array(schema).min(1).max(maximum).superRefine((rows, context) => {
    rows.forEach((row, index) => {
      if (!row.startsWith(`${index + 1}. `)) {
        context.addIssue({ code: "custom", path: [index], message: "Expected numbering to start at 1 and increase" });
      }
    });
  });
}

function matrixSchema(header: string, columns: number, validateParts?: (parts: readonly string[]) => boolean) {
  return z.array(MatrixValueSchema).min(2).max(256).superRefine((rows, context) => {
    if (rows[0] !== header) {
      context.addIssue({
        code: "custom",
        path: [0],
        message: `Expected matrix header ${header}`,
      });
    }
    rows.slice(1).forEach((row, index) => {
      const parts = row.split("｜");
      if (parts.length !== columns || parts.some((part) => part.trim().length === 0)) {
        context.addIssue({
          code: "custom",
          path: [index + 1],
          message: `Expected ${columns} non-empty full-width matrix columns`,
        });
      } else if (validateParts && !validateParts(parts)) {
        context.addIssue({
          code: "custom",
          path: [index + 1],
          message: "Matrix row does not match the latest Skill format",
        });
      }
    });
  });
}

export const AlexaVocMatrixRecordSchema = z.strictObject({
  attention: numberedRows(AttentionRowSchema, 8),
  positives: z.array(PositiveRowSchema).min(1).max(10),
  negatives: z.array(NegativeRowSchema).min(1).max(8),
  unmet: numberedRows(UnmetRowSchema, 8),
  audiences: matrixSchema("人群分类｜特征", 2),
  scenarios: matrixSchema("场景｜说明与示例", 2),
  motives: matrixSchema(
    "动机｜重要性｜说明",
    3,
    (parts) => /^(?=.{1,5}$)⭐+☆*$/.test(parts[1]!.trim()),
  ),
  captureStatus: z.literal("dialog"),
  alexaReport: ManualAlexaVocReportHeaderSchema.extend({
    title: z.literal("顾客评价深度分析"),
    prompt: z.literal(MANUAL_ALEXA_VOC_SEVEN_QUESTION_PROMPT),
    captureStatus: z.literal("dialog"),
  }),
});

export type AlexaVocMatrixRecord = z.infer<typeof AlexaVocMatrixRecordSchema>;

const StrictAlexaVocNormalizationReportHeaderSchema = ManualAlexaVocReportHeaderSchema.extend({
  title: z.literal("顾客评价深度分析"),
  prompt: z.literal(MANUAL_ALEXA_VOC_SEVEN_QUESTION_PROMPT),
  starBreakdown: z.string().trim().min(1).max(16_384).nullable(),
  captureNote: z.string().trim().min(1).max(16_384).nullable(),
  captureStatus: z.literal("dialog"),
});

const StrictAlexaVocNormalizationRecordSchema = AlexaVocMatrixRecordSchema.extend({
  alexaReport: StrictAlexaVocNormalizationReportHeaderSchema,
});

export function canonicalizeAlexaVocNormalizationOutputRecord(
  record: z.infer<typeof StrictAlexaVocNormalizationRecordSchema>,
): AlexaVocMatrixRecord {
  const { starBreakdown, captureNote, ...header } = record.alexaReport;
  return AlexaVocMatrixRecordSchema.parse({
    ...record,
    alexaReport: {
      ...header,
      ...(starBreakdown === null ? {} : { starBreakdown }),
      ...(captureNote === null ? {} : { captureNote }),
    },
  });
}

export const AlexaVocNormalizationExecutionIdentitySchema = z.strictObject({
  providerName: z.string().trim().min(1).max(500),
  model: z.strictObject({
    name: z.string().trim().min(1).max(500),
    estimatedInputTokens: z.number().int().positive(),
    maxOutputTokens: z.number().int().positive(),
    timeoutMs: z.number().int().positive(),
    pricing: z.strictObject({
      inputUsdPerMillionTokens: z.number().nonnegative(),
      outputUsdPerMillionTokens: z.number().nonnegative(),
    }),
  }),
});
export type AlexaVocNormalizationExecutionIdentity = Readonly<{
  providerName: string;
  model: ModelExecutionConfig;
}>;

export function createAlexaVocNormalizationFingerprint(input: Readonly<{
  rawReportSha256: string;
  executionIdentity: AlexaVocNormalizationExecutionIdentity;
}>): string {
  return canonicalJsonSha256({
    rawReportSha256: z.string().regex(/^[a-f0-9]{64}$/).parse(input.rawReportSha256),
    parser: { id: "deterministic-alexa-parser", version: "deterministic-alexa-parser/v3" },
    skill: ALEXA_VOC_NORMALIZATION_SKILL,
    schemaDigest: AlexaVocMatrixRecordSchemaDigest,
    executionIdentity: AlexaVocNormalizationExecutionIdentitySchema.parse(input.executionIdentity),
  });
}

export const AlexaVocNormalizationKnownMetaSchema = z.strictObject({
  rating: z.number().min(0).max(5).nullable(),
  reviewCount: z.number().int().nonnegative().nullable(),
  starBreakdown: z.string().trim().min(1).max(16_384).optional(),
  capturedAt: DateTimeSchema,
  captureMode: z.enum(["paste", "file-import", "automatic"]),
});

export const AlexaVocNormalizationInputSchema = z.strictObject({
  schemaVersion: z.literal("1.0.0"),
  kind: z.literal("alexa-voc-normalization-input"),
  marketplace: MarketplaceSchema,
  asin: AsinSchema,
  rawText: z.string().min(1).max(135_168),
  knownMeta: AlexaVocNormalizationKnownMetaSchema,
});

export type AlexaVocNormalizationInput = z.infer<
  typeof AlexaVocNormalizationInputSchema
>;

export const AlexaVocNormalizationOutputSchema = z.strictObject({
  schemaVersion: z.literal("1.0.0"),
  kind: z.literal("alexa-voc-normalization-result"),
  record: StrictAlexaVocNormalizationRecordSchema,
});

export type AlexaVocNormalizationOutput = z.infer<
  typeof AlexaVocNormalizationOutputSchema
>;
