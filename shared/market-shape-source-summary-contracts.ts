import {z} from 'zod';
import {MarketAnalysisScopeSchema} from './market-analysis-contracts';
const num=z.number().finite().nonnegative().nullable(),asin=z.string().regex(/^[A-Z0-9]{10}$/),month=z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/);
export const MarketShapeSourceSummarySchema=z.object({
 basis:z.literal('collected-source'),scope:MarketAnalysisScopeSchema,
 selectedAsins:z.array(asin).max(100),eligibleAsins:z.array(asin).max(100),totalUnits:num,referenceRevenue:num,
 monthly:z.array(z.object({month,totalUnits:num}).strict()).max(120),
 products:z.array(z.object({asin,observations:z.array(z.object({month,units:num,issues:z.array(z.string())}).strict()).max(120)}).strict()).max(100),
 periods:z.array(z.object({id:z.string(),issues:z.array(z.string()),products:z.array(z.object({asin,units:num}).strict()).max(100)}).strict()).max(4),
}).strict();
export type MarketShapeSourceSummary=z.infer<typeof MarketShapeSourceSummarySchema>;
