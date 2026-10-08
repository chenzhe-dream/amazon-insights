import { z } from 'zod';
import { MarketModuleIdSchema, MarketThemeReportEntrySchema } from './market-module-contracts';

const itemId=z.string().min(1).max(512);
const hash=z.string().regex(/^[a-f0-9]{64}$/);
export const MarketThemeTranslationQuerySchema=z.object({reportHash:hash}).strict();
export const MarketThemeTranslationStartSchema=z.object({reportHash:hash,itemIds:z.array(itemId).max(5000).optional()}).strict();
export const MarketThemeTranslationItemSchema=z.object({
 itemId,field:z.enum(['group-label','group-definition','member-keyword','member-content','asin-summary']),language:z.literal('zh-CN'),translationVersion:z.literal('market-theme-translation/v1'),sourceHash:hash,original:z.string().max(20000),translated:z.string().max(20000).nullable(),state:z.enum(['missing','pending','ready','failed','unavailable']),message:z.string().max(240).nullable()
}).strict();
export const MarketThemeTranslationResponseSchema=z.object({report:MarketThemeReportEntrySchema,items:z.array(MarketThemeTranslationItemSchema).max(5000)}).strict();
export const MarketThemeTranslationRequestIdentitySchema=z.object({moduleRunId:MarketModuleIdSchema,attemptId:MarketModuleIdSchema,reportHash:hash}).strict();
export type MarketThemeTranslationItem=z.infer<typeof MarketThemeTranslationItemSchema>;
