import { z } from 'zod';
import { MarketModuleIdSchema, MarketThemeReportEntrySchema } from './market-module-contracts';

const itemId=z.string().min(1).max(512);
const hash=z.string().regex(/^[a-f0-9]{64}$/);
const siteLanguages={US:{code:'en-US',name:'英语'},UK:{code:'en-GB',name:'英语'},CA:{code:'en-CA',name:'英语'},DE:{code:'de-DE',name:'德语'},FR:{code:'fr-FR',name:'法语'},IT:{code:'it-IT',name:'意大利语'},ES:{code:'es-ES',name:'西班牙语'},JP:{code:'ja-JP',name:'日语'}} as const;
export function marketThemeLanguage(site:string){
 const language=Object.hasOwn(siteLanguages,site)?siteLanguages[site as keyof typeof siteLanguages]:undefined;
 if(!language)throw new Error('该站点尚未配置评论展示语言');
 return language;
}
export const MarketThemeLanguageSchema=z.enum(['zh-CN','en-US','en-GB','en-CA','de-DE','fr-FR','it-IT','es-ES','ja-JP']);
export const MarketThemeTranslationQuerySchema=z.object({reportHash:hash}).strict();
export const MarketThemeTranslationStartSchema=z.object({reportHash:hash,itemIds:z.array(itemId).max(5000).optional()}).strict();
export const MarketThemeTranslationItemSchema=z.object({
 itemId,field:z.enum(['group-label','group-definition','member-keyword','member-content','asin-summary']),language:MarketThemeLanguageSchema,translationVersion:z.enum(['market-theme-translation/v1','market-theme-translation/v2','market-theme-translation/v3']),sourceHash:hash,original:z.string().max(20000),translated:z.string().max(20000).nullable(),state:z.enum(['missing','pending','ready','failed','unavailable']),message:z.string().max(240).nullable()
}).strict();
export const MarketThemeTranslationResponseSchema=z.object({report:MarketThemeReportEntrySchema,items:z.array(MarketThemeTranslationItemSchema).max(5000)}).strict();
export const MarketThemeTranslationRequestIdentitySchema=z.object({moduleRunId:MarketModuleIdSchema,attemptId:MarketModuleIdSchema,reportHash:hash}).strict();
export type MarketThemeTranslationItem=z.infer<typeof MarketThemeTranslationItemSchema>;
