import { z } from 'zod';
import { MarketShapeExplanationOutputSchema } from './market-shape-explanation-output-contracts';
export const MarketShapeExplanationFragmentOutputSchema = z.object({
  version: z.literal('market-shape-explanation-fragment/v1'),
  explanationCatalogId: MarketShapeExplanationOutputSchema.shape.explanationCatalogId,
  revisionId: MarketShapeExplanationOutputSchema.shape.revisionId,
  windowId: z.string().min(1).max(240),
  section: MarketShapeExplanationOutputSchema.shape.dimensions.element,
}).strict();
export type MarketShapeExplanationFragmentOutput = z.infer<typeof MarketShapeExplanationFragmentOutputSchema>;
export const MarketShapeExplanationFragmentResultSchema = z.discriminatedUnion('status', [
  z.object({windowId:z.string().min(1).max(240),status:z.literal('succeeded'),output:MarketShapeExplanationFragmentOutputSchema}).strict(),
  z.object({windowId:z.string().min(1).max(240),status:z.literal('failed'),errorCode:z.enum(['timeout','invalid-output','budget','configuration','cancelled','internal'])}).strict(),
]);
export type MarketShapeExplanationFragmentResult = z.infer<typeof MarketShapeExplanationFragmentResultSchema>;
