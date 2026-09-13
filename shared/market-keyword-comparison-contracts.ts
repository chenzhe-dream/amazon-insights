import {z} from 'zod';

/** Explicit comparison months survive projection of the displayed research window. */
export function keywordComparisonMonthKeys(referenceMonth:string):string[]{
 const [year,month]=referenceMonth.split('-').map(Number),reference=year*12+month-1;
 return [12,3,1,0].map(offset=>{const n=reference-offset;return `${Math.floor(n/12)}-${String(n%12+1).padStart(2,'0')}`;});
}
const month=z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const measurement=z.object({value:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),reason:z.enum(['missing','incomplete-month']).nullable()}).strict()
 .refine(v=>(v.value===null)===(v.reason!==null),'A comparison volume is known or has a missing reason');
export const MarketKeywordComparisonMonthsSchema=z.object({version:z.literal('keyword-comparison-months/v1'),referenceMonth:month,
 months:z.array(z.object({month,searchVolume:measurement}).strict()).length(4),
}).strict().refine(v=>JSON.stringify(v.months.map(m=>m.month))===JSON.stringify(keywordComparisonMonthKeys(v.referenceMonth)),'Comparison months must be the exact ordered reference baselines');
export type MarketKeywordComparisonMonths=z.infer<typeof MarketKeywordComparisonMonthsSchema>;
