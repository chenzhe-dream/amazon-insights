import {z} from 'zod';
const count=z.number().int().nonnegative().safe();
const updateDate = z.string().regex(/^[0-9]{4}-(0[1-9]|1[0-2])-[0-9]{2}$/).refine((value) => {
  const time = new Date(`${value}T00:00:00.000Z`);
  return Number(value.slice(0, 4)) > 0 && Number.isFinite(time.getTime()) && time.toISOString().slice(0, 10) === value;
}, "update_time must be a real calendar date");
export const ThemeSourceRowSchema = z.object({
  keyword: z.string().refine((value) => value.trim().length > 0, "keyword must not be empty"),
  content: z.string(), mention: count, positive: count, negative: count, update_time: updateDate,
}).passthrough().superRefine((theme, context) => {
  for (const field of ["positive", "negative"] as const) {
    if (theme[field] > theme.mention) context.addIssue({ code: "custom", path: [field], message: `${field} cannot exceed mention`, params: { reason: 'count-exceeds-mention' } });
  }
});

export const ThemeQuarantineSchema=z.object({version:z.literal('theme-quarantine/v1'),receivedCount:count.min(1),rejected:z.array(z.object({index:count,fields:z.array(z.enum(['keyword','content','mention','positive','negative','update_time','row'])).min(1)}).strict()).min(1).max(2000)}).strict().superRefine((q,ctx)=>{if(q.rejected.some((r,i)=>r.index>=q.receivedCount||(i>0&&r.index<=q.rejected[i-1].index)))ctx.addIssue({code:'custom',message:'Invalid source row partition'});});
export type ThemeQuarantine=z.infer<typeof ThemeQuarantineSchema>;
export function partitionSourceThemes(rows:readonly unknown[]){
 const parsed=rows.map(row=>ThemeSourceRowSchema.safeParse(row));
 const rejected=parsed.flatMap((r,index)=>r.success?[]:[{index,fields:[...new Set(r.error.issues.map(e=>['keyword','content','mention','positive','negative','update_time'].includes(String(e.path[0]))?String(e.path[0]):'row'))]}]);
 const quarantine=rejected.length?ThemeQuarantineSchema.parse({version:'theme-quarantine/v1',receivedCount:rows.length,rejected}):undefined;
 return {parsed,quarantine,validIndices:parsed.flatMap((r,i)=>r.success?[i]:[])};
}
