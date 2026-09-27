import {z} from 'zod';

const asin=z.string().regex(/^[A-Z0-9]{10}$/);
export const MarketShapeDraftItemSchema=z.object({
  asin,
  included:z.boolean(),
  label:z.string().max(60).nullable(),
}).strict();
export const MarketShapeDraftContentSchema=z.object({
  items:z.array(MarketShapeDraftItemSchema).max(3000).superRefine((items,ctx)=>{
    if(new Set(items.map(item=>item.asin)).size!==items.length)ctx.addIssue({code:'custom',message:'Duplicate ASIN in draft'});
  }),
  catalogLabels:z.array(z.string().trim().min(1).max(60)).max(100).superRefine((labels,ctx)=>{
    if(new Set(labels).size!==labels.length)ctx.addIssue({code:'custom',message:'Duplicate shape label'});
  }),
}).strict();
export const MarketShapeDraftSchema=MarketShapeDraftContentSchema.extend({
  version:z.number().int().nonnegative(),
  updatedAt:z.string().datetime().nullable(),
}).strict();
export const MarketShapeDraftSaveRequestSchema=MarketShapeDraftContentSchema.extend({
  expectedVersion:z.number().int().nonnegative(),
}).strict();
export const MarketShapeDraftResponseSchema=z.object({draft:MarketShapeDraftSchema}).strict();
export type MarketShapeDraft=z.infer<typeof MarketShapeDraftSchema>;
export type MarketShapeDraftItem=z.infer<typeof MarketShapeDraftItemSchema>;
export type MarketShapeDraftSaveRequest=z.infer<typeof MarketShapeDraftSaveRequestSchema>;
