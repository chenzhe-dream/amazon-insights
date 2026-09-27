import {MarketShapeProductImagesPublicSchema} from './market-shape-product-image-contracts';
import {z} from 'zod';
import {MarketAnalysisScopeSchema} from './market-analysis-contracts';
import {SorftimeShapePoolPublicSchema} from './market-shape-sorftime-contracts';
import {ProductHistoryPublicSchema,ProductAmountHistoryPublicSchema} from './market-product-history-contracts';
import {ShapeCategoryDashboardSchema} from './market-shape-category-contracts';

const asin=z.string().regex(/^[A-Z0-9]{10}$/);
export const MarketShapeReferenceRevisionIdSchema=z.string().regex(/^market-shape-revision:[a-f0-9]{64}$/);
export const MarketShapeReferenceRevisionRequestSchema=z.object({
 expectedParentRevisionId:MarketShapeReferenceRevisionIdSchema.nullable(),
 selectedAsins:z.array(asin).min(1).max(300),
 assignments:z.array(z.object({asin,label:z.string().trim().min(1).max(60).nullable()}).strict()).max(300),
 note:z.string().max(500).default(''),
}).strict().superRefine((v,ctx)=>{
 const selected=new Set(v.selectedAsins);
 if(selected.size!==v.selectedAsins.length||new Set(v.assignments.map(a=>a.asin)).size!==v.assignments.length||v.assignments.some(a=>!selected.has(a.asin)))ctx.addIssue({code:'custom',message:'Manual assignments differ from selected products'});
});
export const MarketShapeReferenceRevisionDataSchema=z.object({
 calculationVersion:z.literal('shape-known-coverage/2').optional(),
 scope:MarketAnalysisScopeSchema,
 pool:SorftimeShapePoolPublicSchema,
 productImages:MarketShapeProductImagesPublicSchema.optional(),
 productHistory:ProductHistoryPublicSchema,
 productAmountHistory:ProductAmountHistoryPublicSchema,
 categoryDashboard:ShapeCategoryDashboardSchema,
}).strict();
export const MarketShapeReferenceRevisionSchema=z.object({
 revisionId:MarketShapeReferenceRevisionIdSchema,parentRevisionId:MarketShapeReferenceRevisionIdSchema.nullable(),ordinal:z.number().int().positive(),
 createdAt:z.string().datetime(),authorId:z.string().uuid(),selectedAsins:z.array(asin).min(1).max(300),
 assignments:z.array(z.object({asin,label:z.string().trim().min(1).max(60).nullable()}).strict()).max(300),note:z.string().max(500),
 data:MarketShapeReferenceRevisionDataSchema,
}).strict();
export const MarketShapeReferenceRevisionSummarySchema=MarketShapeReferenceRevisionSchema.omit({data:true});
export const MarketShapeReferenceRevisionResponseSchema=z.object({revision:MarketShapeReferenceRevisionSchema}).strict();
export const MarketShapeReferenceRevisionHistorySchema=z.array(z.object({revisionId:MarketShapeReferenceRevisionIdSchema,ordinal:z.number().int().positive(),createdAt:z.string().datetime()}).strict()).max(100);
export type MarketShapeReferenceRevisionRequest=z.infer<typeof MarketShapeReferenceRevisionRequestSchema>;
export type MarketShapeReferenceRevisionData=z.infer<typeof MarketShapeReferenceRevisionDataSchema>;
export type MarketShapeReferenceRevision=z.infer<typeof MarketShapeReferenceRevisionSchema>;
