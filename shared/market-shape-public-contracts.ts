import {MarketProductSourcePolicySchema,MarketProductPriceProvenanceSchema,MarketProductMonthProvenanceSchema} from './market-product-source-policy';
import { z } from 'zod';
import { MarketAnalysisScopeSchema } from './market-analysis-contracts';
import { MarketModuleIdSchema, MarketModuleStepPublicSchema } from './market-module-contracts';
import { MarketSemanticLabelSchema, MarketShapeSuggestionOutputSchema } from './market-semantic-contracts';
import { MarketShapeStartRequestSchema, MarketShapePriceBandsSchema } from './market-shape-price-contracts';
import {MarketShapeStructureSchema} from './market-shape-structure-contracts';
const text = z.string().max(4000), asin = z.string().regex(/^[A-Z0-9]{10}$/), count = z.number().int().nonnegative().safe(), num = z.number().finite().nonnegative().nullable();
export const MarketShapeRevisionIdSchema = z.string().regex(/^market-shape-revision:[a-f0-9]{64}$/);
const month = z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/), issue = z.array(z.string().max(80)).max(10);
const group = z.object({ labelId: text.nullable(), units: num, links: count, monthlyUnitsPerLink: num, bands: z.array(z.object({ id: text, units: num, links: count, share: z.number().min(0).max(1).nullable(), denominatorUnits: num }).strict()).max(32) }).strict();
export const MarketShapeRevisionPublicSchema = z.object({ revisionId: MarketShapeRevisionIdSchema, parentRevisionId: MarketShapeRevisionIdSchema.nullable(), ordinal: count.min(1), createdAt: z.string().datetime(),
    catalogId: z.string().regex(/^market-shape-price:[a-f0-9]{64}$/), scope: MarketAnalysisScopeSchema, selectedAsins: z.array(asin).max(100), taxonomyVersion: text, labels: z.array(MarketSemanticLabelSchema).max(32), assignments: z.array(z.object({ asin, labelId: text.nullable() }).strict()).max(100), note: text, bands: MarketShapePriceBandsSchema,
    totalUnits: num, eligibleAsins: z.array(asin).max(100), coverage: z.enum(['complete', 'partial', 'none']), groups: z.array(group).max(33),
    comparisonBasis: z.literal('complete-common-members'), priceBasis: z.literal('reference-observation'), historicalPriceStatus: z.literal('not-collected'),
    products: z.array(z.object({ asin, shape: text.nullable(), price: num, rawPrice: num, priceIssues: issue, provenance:MarketProductPriceProvenanceSchema.optional(), observations: z.array(z.object({ month, units: num, rawUnits: num, issues: issue, provenance:MarketProductMonthProvenanceSchema.optional() }).strict()).max(120) }).strict()).max(100),
    monthly: z.array(z.object({ month, totalUnits: num, eligibleAsins: z.array(asin).max(100) }).strict()).max(120), semanticStatus: z.literal('not-integrated'), structure:MarketShapeStructureSchema.optional(), sourcePolicy:MarketProductSourcePolicySchema.optional(),
}).strict();
export const MarketShapeRunResponseSchema = z.object({ run: z.object({ id: MarketModuleIdSchema, scope: MarketAnalysisScopeSchema, status: z.enum(['queued', 'running', 'partial', 'succeeded', 'failed', 'cancelled']), params: MarketShapeStartRequestSchema, sourcePolicy:MarketProductSourcePolicySchema.optional(),
        steps: z.array(MarketModuleStepPublicSchema.extend({ month: month.nullable() })),
        source: z.object({ referenceAttemptId: MarketModuleIdSchema, historyAttemptIds: z.array(MarketModuleIdSchema).max(120), referenceSnapshotId: z.string(), fetchedAt: z.string().datetime(), selectionBasis: z.literal('provider-row-order'), bsrTopVerified: z.literal(false), products: z.array(z.object({ asin, title: text.nullable(), brand: text.nullable(), price: num, units: num }).strict()).max(100) }).strict().nullable(),
        suggestions: z.object({ status: z.enum(['not-ready', 'unavailable', 'running', 'partial', 'complete']), items: z.array(MarketShapeSuggestionOutputSchema.shape.products.element).max(100) }).strict(),
        latestRevision: MarketShapeRevisionPublicSchema.nullable(), history: z.array(z.object({ revisionId: MarketShapeRevisionIdSchema, ordinal: count.min(1), createdAt: z.string().datetime() }).strict()).max(100),
    }).strict() }).strict();
export const MarketShapeExplanationLinkSchema=z.object({moduleRunId:MarketModuleIdSchema,status:z.enum(['queued','running','partial','succeeded','failed','cancelled']),createdAt:z.string().datetime()}).strict();
export const MarketShapeRevisionResponseSchema = z.object({ revision: MarketShapeRevisionPublicSchema, explanation:z.object({moduleRunId:MarketModuleIdSchema,status:z.enum(['queued','running','partial','succeeded','failed','cancelled'])}).strict().nullable().optional(), explanationUnavailableReason:z.string().max(500).optional(),explanations:z.array(MarketShapeExplanationLinkSchema).optional() }).strict();
export type MarketShapeRun = z.infer<typeof MarketShapeRunResponseSchema>['run'];
export type MarketShapePublicRevision = z.infer<typeof MarketShapeRevisionPublicSchema>;
