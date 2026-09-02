import { z } from "zod";

import {
  AsinSchema,
  DateTimeSchema,
  MANUAL_ALEXA_VOC_SEVEN_QUESTION_PROMPT,
  ManualAlexaVocNormalizedRecordSchema,
  ManualAlexaVocReportHeaderSchema,
  MarketplaceSchema,
} from "../../../shared/agent-contracts";
import { canonicalJsonSha256 } from "../../runtime/model-request-accounting";
import type { ModelExecutionConfig } from "../../runtime/skill-runner";

export const ALEXA_VOC_NORMALIZATION_SKILL = Object.freeze({
  id: "alexa-for-shopping-voc",
  version: "1.1.1",
  contentHash: "24e52a9567a0d120311e3de0a538f517133749a733cc88ad384e2696650254fa",
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

export const AlexaVocNormalizationFactsSchemaDigest = canonicalJsonSha256({
  schema: "AlexaVocNormalizationFacts@1.1.0",
  dimensions: ["attention", "positives", "negatives", "unmet", "audiences", "scenarios", "motives"],
  statistics: "nullable-mention-counts-with-raw-evidence-rendered-with-trusted-review-count",
  headers: "renderer-owned",
});

const MatrixValueSchema = z.string().trim().min(1).max(1_200);
const AttentionRowSchema = MatrixValueSchema.refine(
  (row) => /^\d+\.\s+[^：]+：.+。$/.test(row),
  "Expected numbered attention row with a Chinese title separator",
);
const PositiveRowSchema = MatrixValueSchema.refine(
  (row) => /^(?:【[^】]+】约 \d+(?:\.\d+)?% 评论提及（(?:Mixed，)?[\d,]+ 条）|【[^】]+】暂无数据：.+)$/.test(row),
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
  marketplace: "US";
  asin: string;
  rawReportSha256: string;
  executionIdentity: AlexaVocNormalizationExecutionIdentity;
}>): string {
  return canonicalJsonSha256({
    marketplace: z.literal("US").parse(input.marketplace),
    asin: AsinSchema.parse(input.asin),
    rawReportSha256: z.string().regex(/^[a-f0-9]{64}$/).parse(input.rawReportSha256),
    parser: { id: "deterministic-alexa-parser", version: "deterministic-alexa-parser/v3" },
    skill: ALEXA_VOC_NORMALIZATION_SKILL,
    schemaDigest: AlexaVocNormalizationFactsSchemaDigest,
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

export const ALEXA_VOC_FACTS_ONLY_INSTRUCTION = "Normalization facts mode for AlexaVocNormalizationOutput@1.1.0: return all seven fact arrays and overallConclusion only; mentions and evidenceQuote are required nullable fields, and a non-null mention needs an exact raw-text quote containing that count; do not return page-header fields.";

export const AlexaVocNormalizationInputSchema = z.strictObject({
  schemaVersion: z.literal("1.0.0"),
  kind: z.literal("alexa-voc-normalization-input"),
  marketplace: MarketplaceSchema,
  asin: AsinSchema,
  rawText: z.string().min(1).max(135_168),
  normalizationInstructions: z.literal(ALEXA_VOC_FACTS_ONLY_INSTRUCTION),
  knownMeta: AlexaVocNormalizationKnownMetaSchema,
});

export type AlexaVocNormalizationInput = z.infer<
  typeof AlexaVocNormalizationInputSchema
>;

const FactTextSchema = z.string().trim().min(1).max(1_200);
const MentionCountSchema = z.number().int().nonnegative().nullable();
const EvidenceQuoteSchema = FactTextSchema.nullable();

const AttentionFactSchema = z.strictObject({
  title: FactTextSchema,
  detail: FactTextSchema,
  dimension: FactTextSchema,
  mentions: MentionCountSchema,
  evidenceQuote: EvidenceQuoteSchema,
});
const ThemeFactSchema = z.strictObject({
  label: FactTextSchema,
  detail: FactTextSchema,
  mentions: MentionCountSchema,
  evidenceQuote: EvidenceQuoteSchema,
});
const UnmetFactSchema = z.strictObject({ detail: FactTextSchema });
const AudienceFactSchema = z.strictObject({
  category: FactTextSchema,
  detail: FactTextSchema,
});
const ScenarioFactSchema = z.strictObject({
  name: FactTextSchema,
  detail: FactTextSchema,
});
const MotiveFactSchema = z.strictObject({
  label: FactTextSchema,
  importance: z.number().int().min(1).max(5),
  detail: FactTextSchema,
  mentions: MentionCountSchema,
  evidenceQuote: EvidenceQuoteSchema,
});

export const AlexaVocNormalizationFactsSchema = z.strictObject({
  attention: z.array(AttentionFactSchema).min(1).max(8),
  positives: z.array(ThemeFactSchema).min(1).max(10),
  negatives: z.array(ThemeFactSchema).min(1).max(8),
  unmet: z.array(UnmetFactSchema).min(1).max(8),
  audiences: z.array(AudienceFactSchema).min(1).max(256),
  scenarios: z.array(ScenarioFactSchema).min(1).max(256),
  motives: z.array(MotiveFactSchema).min(1).max(256),
  overallConclusion: FactTextSchema,
});
export type AlexaVocNormalizationFacts = z.infer<typeof AlexaVocNormalizationFactsSchema>;

export interface AlexaVocNormalizationRenderContext {
  readonly asin: string;
  readonly rawText: string;
  readonly knownMeta: Readonly<{
    rating: number | null;
    reviewCount: number | null;
    starBreakdown?: string;
    captureNote?: string;
  }>;
}

export function canonicalizeAlexaVocNormalizationOutputRecord(
  facts: AlexaVocNormalizationFacts,
  context: AlexaVocNormalizationRenderContext,
) {
  const asin = AsinSchema.parse(context.asin);
  assertAlexaVocRawReportMatchesAsin(context.rawText, asin);
  const reviewCount = trustedReviewCount(context.knownMeta.reviewCount);
  const rating = context.knownMeta.rating ?? 0;
  const rendered = {
    asin,
    attention: facts.attention.map((fact, index) => formatAttention(
      index + 1,
      fact,
      trustedMentions(fact, context.rawText),
      reviewCount,
    )),
    positives: facts.positives.map((fact) => formatTheme(
      fact,
      trustedMentions(fact, context.rawText),
      reviewCount,
    )),
    negatives: facts.negatives.map((fact) => formatTheme(
      fact,
      trustedMentions(fact, context.rawText),
      reviewCount,
    )),
    unmet: facts.unmet.map((fact, index) => `${index + 1}. ${sentence(factText(fact.detail))}`),
    audiences: ["人群分类｜特征", ...facts.audiences.map((fact) => matrixRow(factText(fact.category), factText(fact.detail)))],
    scenarios: ["场景｜说明与示例", ...facts.scenarios.map((fact) => matrixRow(factText(fact.name), factText(fact.detail)))],
    motives: [
      "动机｜重要性｜说明",
      ...facts.motives.map((fact) => matrixRow(factText(fact.label), "⭐".repeat(fact.importance), factText(fact.detail))),
    ],
    captureStatus: "dialog" as const,
    alexaReport: {
      title: "顾客评价深度分析" as const,
      asin,
      rating,
      reviewCount,
      ...(context.knownMeta.starBreakdown ? { starBreakdown: context.knownMeta.starBreakdown } : {}),
      prompt: MANUAL_ALEXA_VOC_SEVEN_QUESTION_PROMPT,
      overallConclusion: factText(facts.overallConclusion),
      ...(context.knownMeta.captureNote ? { captureNote: context.knownMeta.captureNote } : {}),
      captureStatus: "dialog" as const,
    },
  };
  const { asin: renderedAsin, ...matrix } = rendered;
  return ManualAlexaVocNormalizedRecordSchema.parse({
    asin: renderedAsin,
    ...AlexaVocMatrixRecordSchema.parse(matrix),
  });
}

function trustedReviewCount(value: number | null): number {
  return value !== null && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function formatAttention(
  index: number,
  fact: z.infer<typeof AttentionFactSchema>,
  mentions: number | null,
  reviewCount: number,
): string {
  const percentage = percentageFor(mentions, reviewCount);
  const prefix = `${index}. ${factText(fact.title)}：${stripTerminal(factText(fact.detail))}`;
  return percentage === null
    ? `${prefix}。`
    : `${prefix}（${factText(fact.dimension)} ${mentions!.toLocaleString("en-US")} 条提及，约 ${percentage}%）。`;
}

function formatTheme(
  fact: z.infer<typeof ThemeFactSchema>,
  mentions: number | null,
  reviewCount: number,
): string {
  const percentage = percentageFor(mentions, reviewCount);
  return percentage === null
    ? `【${factText(fact.label)}】暂无数据：${stripTerminal(factText(fact.detail))}`
    : `【${factText(fact.label)}】约 ${percentage}% 评论提及（${mentions!.toLocaleString("en-US")} 条）`;
}

function trustedMentions(
  fact: Readonly<{ mentions: number | null; evidenceQuote: string | null }>,
  rawText: string,
): number | null {
  if (fact.mentions === null || fact.evidenceQuote === null || !rawText.includes(fact.evidenceQuote)) {
    return null;
  }
  return evidenceQuoteBindsMentionCount(fact.evidenceQuote, fact.mentions)
    ? fact.mentions
    : null;
}

function evidenceQuoteBindsMentionCount(evidenceQuote: string, mentions: number): boolean {
  const compact = String(mentions);
  const grouped = mentions.toLocaleString("en-US");
  const count = `(?:${compact}|${grouped})`;
  const patterns = [
    new RegExp(`(?:提及次数|提及|提到)\\s*[:：]?\\s*${count}\\s*次?`),
    new RegExp(`出现\\s*${count}\\s*次`),
    new RegExp(`${count}\\s*(?:条\\s*)?(?:次\\s*)?提及`),
    new RegExp(`mentions?\\s*[:：]?\\s*${count}`, "i"),
    new RegExp(`${count}\\s+mentions?`, "i"),
    new RegExp(`mentioned\\s*${count}\\s*times`, "i"),
  ];
  return evidenceQuote
    .split(/[;；。.!！?\r\n]/u)
    .some((clause) => patterns.some((pattern) => pattern.test(clause)));
}

function percentageFor(mentions: number | null, reviewCount: number): string | null {
  if (
    mentions === null ||
    !Number.isSafeInteger(mentions) ||
    mentions < 0 ||
    reviewCount <= 0
  ) return null;
  const percentage = (mentions / reviewCount) * 100;
  return percentage >= 1 ? percentage.toFixed(1) : percentage.toFixed(2);
}

function sentence(value: string): string {
  return `${stripTerminal(value)}。`;
}

function stripTerminal(value: string): string {
  return value.trim().replace(/[。．.!！?？]+$/u, "");
}

function factText(value: string): string {
  const sanitized = value
    .replace(/[【】｜|]/g, " ")
    .replace(/：/g, "，")
    .replace(/\s+/g, " ")
    .trim();
  if (!sanitized) throw new Error("Alexa VOC fact is empty after structural character cleanup");
  return sanitized;
}

function matrixRow(...values: readonly string[]): string {
  const cells = values.map((value) => {
    if (value.includes("|") || value.includes("｜")) {
      throw new Error("Alexa VOC fact contains a matrix delimiter");
    }
    return value.trim();
  });
  return cells.join("｜");
}

export class AlexaVocAsinMismatchError extends Error {
  constructor() {
    super("Alexa report ASIN conflicts with trusted scope");
    this.name = "AlexaVocAsinMismatchError";
  }
}

function extractExplicitReportAsins(rawText: string): readonly string[] {
  return [
    ...(rawText.match(/(?<![A-Z0-9])B[A-Z0-9]{9}(?![A-Z0-9])/gi) ?? []),
    ...Array.from(rawText.matchAll(/\bASIN\s*[:：]?\s*([A-Z0-9]{10})\b/gi), (match) => match[1]!),
  ].map((candidate) => candidate.toUpperCase());
}

export function assertAlexaVocRawReportMatchesAsin(rawText: string, trustedAsin: string): void {
  const asin = AsinSchema.parse(trustedAsin);
  const reportAsins = extractExplicitReportAsins(rawText);
  if (reportAsins.some((candidate) => candidate !== asin)) throw new AlexaVocAsinMismatchError();
}

export function extractAlexaVocRawHeaderMeta(rawText: string): Readonly<{
  rating: number | null;
  reviewCount: number | null;
}> {
  const match = rawText.match(
    /([0-5](?:\.[0-9])?)\s*(?:星|stars?)\s*(?:·|\/|,|\||\s).*?(\d[\d,]*)\s*(?:条)?(?:评论|reviews?)/i,
  );
  if (!match) return { rating: null, reviewCount: null };
  const rating = Number(match[1]);
  const reviewCount = Number(match[2]!.replace(/,/g, ""));
  return {
    rating: Number.isFinite(rating) && rating >= 0 && rating <= 5 ? rating : null,
    reviewCount: Number.isSafeInteger(reviewCount) && reviewCount >= 0 ? reviewCount : null,
  };
}

export const AlexaVocNormalizationOutputSchema = z.strictObject({
  schemaVersion: z.literal("1.0.0"),
  kind: z.literal("alexa-voc-normalization-result"),
  record: AlexaVocNormalizationFactsSchema,
});

export type AlexaVocNormalizationOutput = z.infer<
  typeof AlexaVocNormalizationOutputSchema
>;
