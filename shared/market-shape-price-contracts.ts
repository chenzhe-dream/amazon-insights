import {MarketAcquisitionPolicyFields} from './market-acquisition-policy';
import {ShapeHistoryPolicySchema} from './shape-history-selection';
import { z } from 'zod';
import { MarketAnalysisScopeSchema } from './market-analysis-contracts';
import { MarketSemanticLabelSchema,MarketShapeSuggestionInputSchema } from './market-semantic-contracts';
export const MarketShapeStartRequestSchema=z.object({...MarketAcquisitionPolicyFields,historySourcePolicy:ShapeHistoryPolicySchema.optional(),poolSize:z.number().int().min(1).max(300).default(100),newProductMonths:z.union([z.literal(1),z.literal(3),z.literal(6),z.literal(12)]).default(6),catalog:MarketShapeSuggestionInputSchema.pick({task:true,taxonomyVersion:true,allowedLabels:true})}).strict();
const asin = z.string().regex(/^[A-Z0-9]{10}$/), id = z.string().trim().min(1).max(160);
export const MarketShapeRevisionBodySchema = z.object({ schemaVersion: z.literal('market-shape-revision/v1').default('market-shape-revision/v1'), scope: MarketAnalysisScopeSchema,
    basisSnapshotId: z.string().regex(/^market-input:[a-f0-9]{64}$/), parentRevisionId: z.string().regex(/^market-shape-revision:[a-f0-9]{64}$/).nullable(),
    selectedAsins: z.array(asin).min(1).max(100), taxonomyVersion: id, labels: z.array(MarketSemanticLabelSchema).max(32),
    assignments: z.array(z.object({ asin, labelId: id.nullable() }).strict()).max(100), authorId: id, createdAt: z.string().datetime(), note: z.string().max(500).default(''),
}).strict().superRefine((v, ctx) => {
    const selected = new Set(v.selectedAsins), labels = new Set(v.labels.map(l => l.labelId));
    if (selected.size !== v.selectedAsins.length || labels.size !== v.labels.length || new Set(v.assignments.map(a => a.asin)).size !== v.assignments.length || v.assignments.some(a => !selected.has(a.asin) || a.labelId !== null && !labels.has(a.labelId)))
        ctx.addIssue({ code: 'custom', message: 'Shape selection or manual labels differ from the declared catalog' });
});
export type MarketShapeRevision = z.infer<typeof MarketShapeRevisionBodySchema> & {
    revisionId: string;
};
export const MarketShapePriceBandsSchema = z.array(z.object({ id, minInclusive: z.number().finite().nonnegative(), maxExclusive: z.number().finite().nonnegative().nullable() }).strict()).min(1).max(32);
/** Browser commands contain manual choices only. Scope, author and time come
 * from the authenticated server, and all prices/sales come from saved sources. */
export const MarketShapeRevisionRequestSchema = z.object({
    referenceAttemptId: z.string().uuid(), historyAttemptIds: z.array(z.string().uuid()).max(120),
    expectedParentRevisionId: z.string().regex(/^market-shape-revision:[a-f0-9]{64}$/).nullable(),
    selectedAsins: z.array(asin).min(1).max(100), taxonomyVersion: id,
    labels: z.array(MarketSemanticLabelSchema).max(32),
    assignments: z.array(z.object({ asin, labelId: id.nullable() }).strict()).max(100),
    bands: MarketShapePriceBandsSchema, note: z.string().max(500).default(''),
}).strict();
