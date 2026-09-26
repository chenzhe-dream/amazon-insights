import {z} from 'zod';

/** Safe location metadata only. Supplier text, credentials and raw diagnostics stay private. */
export const MarketThemeSourceIssueSchema=z.object({
 code:z.enum(['invalid-theme','count-exceeds-mention']),
 themeIndex:z.number().int().nonnegative().max(1999),
 field:z.enum(['keyword','content','mention','positive','negative','update_time']),
}).strict().refine(v=>v.code!=='count-exceeds-mention'||v.field==='positive'||v.field==='negative');
export type MarketThemeSourceIssue=z.infer<typeof MarketThemeSourceIssueSchema>;
const fields={keyword:'主题名称',content:'主题说明',mention:'总提及数',positive:'正面提及数',negative:'负面提及数',update_time:'更新时间'};
export function marketThemeSourceIssueText(issue:MarketThemeSourceIssue):string{
 return `来源第 ${issue.themeIndex+1} 条主题的${fields[issue.field]}${issue.code==='count-exceeds-mention'?'超过总提及数':'无效'}，该商品未纳入本次统计。`;
}
