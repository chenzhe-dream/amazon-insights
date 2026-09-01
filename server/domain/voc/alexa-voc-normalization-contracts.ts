import { z } from "zod";

import {
  AsinSchema,
  DateTimeSchema,
  MANUAL_ALEXA_VOC_SEVEN_QUESTION_PROMPT,
  ManualAlexaVocReportHeaderSchema,
  MarketplaceSchema,
} from "../../../shared/agent-contracts";

export const ALEXA_VOC_NORMALIZATION_SKILL = Object.freeze({
  id: "alexa-for-shopping-voc",
  version: "1.0.0",
  contentHash: "dd97dda58ce916ed5c8cf5f39957e1a7b6e52af95be4bfed4a088caafd8dc3c3",
});

const MatrixValueSchema = z.string().trim().min(1).max(1_200);

function matrixSchema(header: string, columns: number) {
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
      }
    });
  });
}

export const AlexaVocMatrixRecordSchema = z.strictObject({
  attention: z.array(MatrixValueSchema).min(1).max(8),
  positives: z.array(MatrixValueSchema).min(1).max(10),
  negatives: z.array(MatrixValueSchema).min(1).max(8),
  unmet: z.array(MatrixValueSchema).min(1).max(8),
  audiences: matrixSchema("人群分类｜特征", 2),
  scenarios: matrixSchema("场景｜说明与示例", 2),
  motives: matrixSchema("动机｜重要性｜说明", 3),
  captureStatus: z.literal("dialog"),
  alexaReport: ManualAlexaVocReportHeaderSchema.extend({
    title: z.literal("顾客评价深度分析"),
    prompt: z.literal(MANUAL_ALEXA_VOC_SEVEN_QUESTION_PROMPT),
    captureStatus: z.literal("dialog"),
  }),
});

export type AlexaVocMatrixRecord = z.infer<typeof AlexaVocMatrixRecordSchema>;

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
  record: AlexaVocMatrixRecordSchema,
});

export type AlexaVocNormalizationOutput = z.infer<
  typeof AlexaVocNormalizationOutputSchema
>;
