import {z} from 'zod';
import {MarketStudyRequestSchema,MarketThemeStartRequestSchema} from './market-module-contracts';
import {MarketKeywordStartRequestSchema} from './market-keyword-flow-contracts';

const scope=MarketStudyRequestSchema.refine(v=>!v.overviewPeriod,'Keyword and theme queries require closed-month scope');
export const MarketKeywordQueryRequestSchema=z.object({scope,params:MarketKeywordStartRequestSchema,forceRefresh:z.boolean().default(false)}).strict();
export const MarketThemeQueryRequestSchema=z.object({scope,params:MarketThemeStartRequestSchema,forceRefresh:z.boolean().default(false)}).strict();

/** Preserve report identity when a bare leaf and its resolved path denote the same category. */
export function assertStandaloneQueryBinding(input:{scope:z.infer<typeof MarketStudyRequestSchema>;params:unknown},run:{scope:z.infer<typeof MarketStudyRequestSchema>;params:unknown}){
 const expected=input.scope,actual=run.scope;
 const a=expected.nodeIdPath,b=actual.nodeIdPath;
 const sameNode=a===b||(!a.includes(':')&&a===b.split(':').at(-1))||(!b.includes(':')&&b===a.split(':').at(-1));
 const stable=(v:unknown):string=>JSON.stringify(v,(_key,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))):value);
 if(!sameNode||expected.marketplace!==actual.marketplace||expected.currency!==actual.currency||expected.fromMonth!==actual.fromMonth||expected.toMonth!==actual.toMonth||actual.overviewPeriod||stable(input.params)!==stable(run.params))throw new Error('研究范围或参数不一致，未加载该结果。');
}
