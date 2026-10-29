import {z} from 'zod';
import {PluginSiteSchema} from './plugin-collection-contracts';

export const PluginSavedSourceScopeSchema=z.object({site:PluginSiteSchema,node:z.string().regex(/^\d{1,20}$/)}).strict();
export const PluginSavedSourceSchema=z.object({
 snapshotId:z.string().regex(/^plugin-source:[a-f0-9]{64}$/),jobId:z.string().uuid(),
 site:PluginSiteSchema,node:z.string().regex(/^\d{1,20}$/),collectedAt:z.string().datetime({offset:true}),
 products:z.number().int().nonnegative(),basicRecords:z.number().int().nonnegative(),historyRecords:z.number().int().nonnegative(),
}).strict();
export const PluginSavedSourcesSchema=z.object({sources:z.array(PluginSavedSourceSchema)}).strict();
export type PluginSavedSource=z.infer<typeof PluginSavedSourceSchema>;
