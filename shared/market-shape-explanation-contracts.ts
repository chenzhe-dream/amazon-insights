import { z } from "zod";
import { MarketAnalysisScopeSchema } from "./market-analysis-contracts";

export const MARKET_SHAPE_EXPLANATION_DIMENSIONS = [
  "scope",
  "shape",
  "price",
  "brand",
  "age",
  "month",
] as const;
export const MarketShapeExplanationDimensionSchema = z.enum(
  MARKET_SHAPE_EXPLANATION_DIMENSIONS,
);
const id = z.string().trim().min(1).max(500),
  value = z.number().finite().nullable();
export const MarketShapeExplanationCellSchema = z
  .object({ id, path: id, value, unit: id })
  .strict();
export const MarketShapeExplanationRowSchema = z
  .object({
    id,
    dimension: MarketShapeExplanationDimensionSchema,
    path: id,
    context: z.record(z.string(), z.string().nullable()),
    cells: z.array(MarketShapeExplanationCellSchema).min(1),
  })
  .strict();
export const MarketShapeExplanationLimitationSchema = z
  .object({ code: id, detail: z.string().min(1) })
  .strict();
export const MarketShapeExplanationCatalogSchema = z
  .object({
    version: z.literal("market-shape-explanation-catalog/v1"),
    explanationCatalogId: z
      .string()
      .regex(/^market-shape-explanation:[a-f0-9]{64}$/),
    catalogId: z.string().regex(/^market-shape-price:[a-f0-9]{64}$/),
    revisionId: z.string().regex(/^market-shape-revision:[a-f0-9]{64}$/),
    scope: MarketAnalysisScopeSchema.safeExtend({
      requestedAsins: z.array(z.string()),
      eligibleAsins: z.array(z.string()),
    }),
    source: z
      .object({
        catalogVersion: id,
        dataCutoffAt: z.string().datetime(),
        referenceSnapshotId: id,
        inputSnapshotIds: z.array(id),
        sourceRefs: z.array(id),
        comparisonBasis: id,
        priceBasis: id,
        historicalPriceStatus: id,
        structureRuleVersion: id.nullable(),
        sourcePolicy: z.string().nullable(),
      })
      .strict(),
    limitations: z.array(MarketShapeExplanationLimitationSchema),
    rows: z.array(MarketShapeExplanationRowSchema),
  })
  .strict();
export type MarketShapeExplanationDimension = z.infer<
  typeof MarketShapeExplanationDimensionSchema
>;
export type MarketShapeExplanationCell = z.infer<
  typeof MarketShapeExplanationCellSchema
>;
export type MarketShapeExplanationRow = z.infer<
  typeof MarketShapeExplanationRowSchema
>;
export type MarketShapeExplanationLimitation = z.infer<
  typeof MarketShapeExplanationLimitationSchema
>;
export type MarketShapeExplanationCatalog = z.infer<
  typeof MarketShapeExplanationCatalogSchema
>;
