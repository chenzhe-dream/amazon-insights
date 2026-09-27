import {z} from 'zod';
import {MarketKeywordRevisionClassificationSchema} from './market-keyword-classification-contracts';
export const MarketKeywordOriginalClassificationSchema=z.object({
 version:z.literal('keyword-original-classification/v1'),
 identity:z.string().regex(/^keyword-original:[a-f0-9]{64}$/),
 factsId:z.string().regex(/^market-keyword-facts:[a-f0-9]{64}$/),
 productSeed:z.string().trim().min(1).max(500),
 classification:MarketKeywordRevisionClassificationSchema,
 meanings:z.array(z.object({keywordId:z.string(),category:z.enum(['core_product','category','function','benefit','pain_need','audience','age','scenario','attribute_spec','material_style','holiday_season','brand_competitor'])}).strict()).max(2000),
}).strict();
export type MarketKeywordOriginalClassification=z.infer<typeof MarketKeywordOriginalClassificationSchema>;
