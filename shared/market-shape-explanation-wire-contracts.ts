import { z } from 'zod';
import { MarketShapeExplanationDimensionSchema, MarketShapeExplanationLimitationSchema, MarketShapeExplanationRowSchema } from './market-shape-explanation-contracts';

const index=z.number().int().nonnegative();
export const MarketShapeExplanationWireRowSchema=z.tuple([
  index,z.array(z.tuple([index,index.nullable()])),
  z.array(z.tuple([index,z.number().finite().nullable(),index])).min(1),
]);
export const MarketShapeExplanationWireLimitationSchema=z.tuple([
  index,z.number().int().positive(),z.number().int().positive(),z.enum(['text','json-array']),z.string(),
]);
export const MarketShapeExplanationWindowSchema=z.object({
  version:z.literal('market-shape-explanation-window/v1'),
  windowId:z.string().min(1).max(240),
  explanationCatalogId:z.string().regex(/^market-shape-explanation:[a-f0-9]{64}$/),
  revisionId:z.string().regex(/^market-shape-revision:[a-f0-9]{64}$/),
  mode:z.literal('dimension'),
  dimension:MarketShapeExplanationDimensionSchema,
  scope:z.object({marketplace:z.string(),nodeIdPath:z.string(),fromMonth:z.string(),toMonth:z.string(),currency:z.string()}).strict(),
  source:z.object({catalogVersion:z.string(),dataCutoffAt:z.string(),comparisonBasis:z.string(),priceBasis:z.string(),historicalPriceStatus:z.string(),structureRuleVersion:z.string().nullable()}).strict(),
  rules:z.object({version:z.literal('market-shape-explanation-model-rules/v1'),limitations:z.array(MarketShapeExplanationLimitationSchema)}).strict(),
  fragment:z.object({ordinal:z.number().int().positive(),count:z.number().int().positive()}).strict(),
  coverage:z.object({dimensionRowCount:z.number().int().nonnegative(),dimensionCellCount:z.number().int().nonnegative(),rowIds:z.array(z.string())}).strict(),
  dictionary:z.object({strings:z.array(z.string())}).strict(),
  rows:z.array(MarketShapeExplanationWireRowSchema),
  limitations:z.array(MarketShapeExplanationWireLimitationSchema),
}).strict();
export type MarketShapeExplanationWindow=z.infer<typeof MarketShapeExplanationWindowSchema>;
export type MarketShapeExplanationWireRow=z.infer<typeof MarketShapeExplanationWireRowSchema>;
export type MarketShapeExplanationWireLimitation=z.infer<typeof MarketShapeExplanationWireLimitationSchema>;

export const DecodedMarketShapeExplanationWindowSchema=z.object({
  rows:z.array(MarketShapeExplanationRowSchema),limitations:z.array(MarketShapeExplanationLimitationSchema),
}).strict();
