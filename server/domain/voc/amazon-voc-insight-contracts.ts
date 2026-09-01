import { z } from "zod";

import {
  VocPositioningInputSchema,
  VocPositioningOutputShapeSchema,
  createVocPositioningOutputSchemaFromSkillInput,
  type VocPositioningInput,
} from "./voc-positioning-contracts";

const InsightTextSchema = z.string().trim().min(1).max(8_000);
const VocDimensionSchema = z.enum([
  "attention",
  "positives",
  "negatives",
  "unmet",
  "audiences",
  "scenarios",
  "motives",
]);
const EvidenceRowSchema = z.strictObject({
  label: z.string().trim().min(1).max(500),
  frequency: z.string().trim().min(1).max(500),
  feedback: InsightTextSchema,
  impact: z.enum(["low", "medium", "high", "critical"]),
  implication: InsightTextSchema,
});
const DevelopmentDifficultySchema = z.enum(["low", "medium", "high"]);
const RecommendationSchema = z.enum([
  "优先立项",
  "建议小批量测试",
  "继续观察",
  "暂不开发",
]);

export const AmazonVocInsightInputSchema = VocPositioningInputSchema;
export type AmazonVocInsightInput = z.infer<typeof AmazonVocInsightInputSchema>;

export const AmazonVocInsightShapeSchema = z.strictObject({
  summary: InsightTextSchema.max(1_200),
  sevenDimensions: z.array(z.strictObject({
    dimension: VocDimensionSchema,
    rows: z.array(EvidenceRowSchema).min(1).max(50),
  })).length(7).superRefine((dimensions, context) => {
    const expected = VocDimensionSchema.options;
    dimensions.forEach((dimension, index) => {
      if (dimension.dimension !== expected[index]) {
        context.addIssue({
          code: "custom",
          path: [index, "dimension"],
          message: "VOC dimensions must use the canonical seven-section order",
        });
      }
    });
  }),
  negativePriorities: z.array(z.strictObject({
    issue: InsightTextSchema,
    frequency: z.string().trim().min(1).max(500),
    severity: z.enum(["low", "medium", "high", "critical"]),
    industryCommon: z.boolean(),
    affectedStages: z.array(z.enum(["click", "conversion", "return", "review", "repurchase", "recommendation"])).min(1),
    shouldSolve: z.boolean(),
    direction: InsightTextSchema,
  })).min(1),
  unmetOpportunities: z.array(z.strictObject({
    need: InsightTextSchema,
    audience: InsightTextSchema,
    scenario: InsightTextSchema,
    competitorCoverage: InsightTextSchema,
    marketValue: z.enum(["low", "medium", "high"]),
    difficulty: DevelopmentDifficultySchema,
    proposal: InsightTextSchema,
  })).min(1),
  productDirections: z.array(z.strictObject({
    name: z.string().trim().min(1).max(500),
    positioning: InsightTextSchema,
    audience: InsightTextSchema,
    scenario: InsightTextSchema,
    painPoints: z.array(InsightTextSchema).min(1),
    baseFunctions: z.array(InsightTextSchema).min(1),
    differentiators: z.array(InsightTextSchema).min(1),
    avoid: z.array(InsightTextSchema),
    specification: InsightTextSchema,
    accessories: z.array(InsightTextSchema),
    priceBand: InsightTextSchema,
    sellingPoints: z.array(InsightTextSchema).min(1),
    competitorDifference: InsightTextSchema,
    qualityRisks: z.array(InsightTextSchema),
    compliancePatentRisks: z.array(InsightTextSchema),
    difficulty: DevelopmentDifficultySchema,
    priority: z.enum(["P0", "P1", "P2", "P3"]),
  })).min(3),
  scoredOpportunities: z.array(z.strictObject({
    rank: z.number().int().positive(),
    opportunity: InsightTextSchema,
    demandEvidence: z.array(InsightTextSchema).min(1),
    marketEvidence: z.array(InsightTextSchema).min(1),
    scores: z.strictObject({
      demandFrequency: z.number().int().min(1).max(5),
      painIntensity: z.number().int().min(1).max(5),
      marketSpace: z.number().int().min(1).max(5),
      competitorGap: z.number().int().min(1).max(5),
      differentiation: z.number().int().min(1).max(5),
      premiumPotential: z.number().int().min(1).max(5),
      feasibility: z.number().int().min(1).max(5),
      total: z.number().min(20).max(100),
    }),
    difficulty: DevelopmentDifficultySchema,
    conclusion: InsightTextSchema,
  })).min(1).superRefine((items, context) => {
    items.forEach((item, index) => {
      if (item.rank !== index + 1) {
        context.addIssue({ code: "custom", path: [index, "rank"], message: "Opportunity ranks must be contiguous and ordered" });
      }
    });
  }),
  finalDecision: z.strictObject({
    enterCategory: z.boolean(),
    recommendedDirection: InsightTextSchema,
    topPainPoints: z.array(InsightTextSchema).length(3),
    matureSellingPoints: z.array(InsightTextSchema).length(3),
    pseudoDemands: z.array(InsightTextSchema),
    priceBand: InsightTextSchema,
    targetAudience: InsightTextSchema,
    competitorDifference: InsightTextSchema,
    validationsNeeded: z.array(InsightTextSchema).min(1),
    recommendation: RecommendationSchema,
  }),
});

export const AmazonVocInsightOutputSchema = z.strictObject({
  schemaVersion: z.literal("1.0.0"),
  kind: z.literal("amazon-voc-insight-result"),
  insight: AmazonVocInsightShapeSchema,
  positioningProjection: VocPositioningOutputShapeSchema,
});

export type AmazonVocInsightOutput = z.infer<typeof AmazonVocInsightOutputSchema>;

export function createAmazonVocInsightOutputSchema(
  input: VocPositioningInput,
): z.ZodType<AmazonVocInsightOutput> {
  const facts = AmazonVocInsightInputSchema.parse(input);
  const positioningSchema = createVocPositioningOutputSchemaFromSkillInput(facts);
  return AmazonVocInsightOutputSchema.superRefine((value, context) => {
    const result = positioningSchema.safeParse(value.positioningProjection);
    if (!result.success) {
      for (const issue of result.error.issues) {
        context.addIssue({
          ...issue,
          path: ["positioningProjection", ...issue.path],
        });
      }
    }
  });
}
