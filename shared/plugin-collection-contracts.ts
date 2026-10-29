import {z} from 'zod';

export const PluginSiteSchema=z.enum(['US','CA','UK','DE']);
export type PluginSite=z.infer<typeof PluginSiteSchema>;
export const pluginSiteDomains={US:'amazon.com',CA:'amazon.ca',UK:'amazon.co.uk',DE:'amazon.de'} as const;
export const PluginCollectionIdSchema=z.string().uuid();
const asin=z.string().regex(/^[A-Z0-9]{10}$/);
const timestamp=z.string().datetime({offset:true});
export const PluginFrozenCohortSchema=z.object({asins:z.array(asin).length(150),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict().refine(value=>new Set(value.asins).size===150,'Frozen cohort requires150 distinct ASINs');
export function parsePluginCategory(value:string,site:PluginSite='US'){
 PluginSiteSchema.parse(site);const domain=pluginSiteDomains[site];const text=value.trim();let node:string|null=null;
 if(/^\d+(?::\d+)*$/.test(text))node=text.split(':').at(-1)!;
 else {
  const url=new URL(text);
  if(url.protocol!=='https:'||![domain,`www.${domain}`].includes(url.hostname)||url.port||url.username||url.password)throw new TypeError('请输入对应站点的 Amazon 类目链接或数字节点');
  const nodes=url.searchParams.getAll('node'),rhs=url.searchParams.getAll('rh');
  if(nodes.length>1||rhs.length>1)throw new TypeError('类目链接包含重复节点');
  node=nodes[0]??null;
  const rhNodes=rhs[0]?[...rhs[0].matchAll(/(?:^|,)n:(\d+)(?=,|$)/g)].map(match=>match[1]):[];
  if(rhNodes.length>1||node&&rhNodes.length&&rhNodes[0]!==node)throw new TypeError('类目链接包含不一致的节点');
  if(!node)node=rhNodes[0]??null;
  if(!node)node=/\/(?:zgbs|bestsellers)\/[^?#]*\/(\d+)(?:\/|$)/.exec(url.pathname)?.[1]??null;
 }
 if(!node||!/^\d{1,20}$/.test(node))throw new TypeError('请输入包含类目节点的对应站点的 Amazon 链接');
 return {node,category:`https://www.${domain}/b?node=${node}`};
}
export const PluginCollectionCreateSchema=z.object({category:z.string().trim().min(1).max(2000),site:PluginSiteSchema.default('US'),target:z.literal(150).default(150)}).strict().superRefine((value,ctx)=>{try{parsePluginCategory(value.category,value.site);}catch{ctx.addIssue({code:'custom',path:['category'],message:'类目链接与所选站点不一致或节点无效'});}}).transform(value=>({...value,category:parsePluginCategory(value.category,value.site).category}));
export const PluginWorkerHealthSchema=z.object({protocol:z.literal(1),connected:z.boolean(),lastHeartbeatAt:timestamp.nullable(),workerVersion:z.string().max(100),capabilities:z.array(z.string()).optional()});
export const PluginSupplementLeaseSchema=z.object({acquired:z.boolean(),generation:z.number().int().positive(),expiresAt:timestamp});
export const PluginWorkerStatusSchema=z.object({installed:z.boolean(),connected:z.boolean(),lastHeartbeatAt:timestamp.nullable(),workerVersion:z.string().max(100).nullable(),message:z.string().max(300)}).strict();
export const PluginCollectionResultSchema=z.object({accepted:z.boolean(),products:z.number().int().min(0).max(150),images:z.number().int().min(0).max(150),status:z.string().max(80),filename:z.string().min(1).max(240).regex(/^[^\\/\x00-\x1f]+\.xlsx$/i),sha256:z.string().regex(/^[a-f0-9]{64}$/)});
export const PluginCategoryDiscoverySchema=z.object({provider:z.enum(['pending','amazon-page','sorftime']),nativeProducts:z.number().int().min(0).max(150),nativeFailure:z.enum(['AMAZON_EMPTY_PAGE','AMAZON_NO_GROWTH','AMAZON_SAMPLE_TOO_SMALL','AMAZON_TARGET_NOT_REACHED']).optional()}).strict();
export const PluginCollectionJobSchema=z.object({discovery:PluginCategoryDiscoverySchema.optional(),frozenCohort:PluginFrozenCohortSchema.optional(),id:PluginCollectionIdSchema,node:z.string().regex(/^\d+$/),target:z.literal(150),site:PluginSiteSchema.optional(),status:z.enum(['awaiting-sample','queued','running','awaiting-fallback','succeeded','failed','interrupted']),stage:z.string().max(100),products:z.number().int().min(0).max(150),page:z.number().int().min(0).max(100),batch:z.number().int().min(0).max(100),createdAt:timestamp,updatedAt:timestamp,heartbeatAt:timestamp.nullable(),error:z.object({code:z.string().max(100),message:z.string().max(300)}).nullable(),result:PluginCollectionResultSchema.nullable(),transport:z.literal('native-messaging'),pageRelayUsed:z.literal(false)});
export const PluginWorkerJobSchema=PluginCollectionJobSchema.extend({organizationId:z.string().min(1).max(200),userId:z.string().min(1).max(200)});
export const PluginCollectionResponseSchema=z.object({job:PluginCollectionJobSchema}).strict();
export const PluginCollectionListSchema=z.object({jobs:z.array(PluginCollectionJobSchema).max(200)}).strict();
export const PluginWorkerJobsSchema=z.object({jobs:z.array(PluginWorkerJobSchema).max(1000)});
export const PluginCollectionSourceSchema=z.object({frozenCohort:PluginFrozenCohortSchema.optional(),sourceSha256:z.string().regex(/^[a-f0-9]{64}$/).optional(),sourceManifest:z.object({version:z.literal(1),provider:z.literal('sellersprite-plugin'),site:PluginSiteSchema,node:z.string().regex(/^\d+$/),target:z.literal(150),cohortSha256:z.string().regex(/^[a-f0-9]{64}$/),files:z.array(z.object({path:z.string().regex(/^[a-z0-9-]+\.json$/),bytes:z.number().int().nonnegative(),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict()).max(100)}).strict().optional(),site:PluginSiteSchema,node:z.string().regex(/^\d+$/),target:z.literal(150),asins:z.array(asin).length(150),basic:z.record(asin,z.record(z.string(),z.unknown())),history:z.record(asin,z.record(z.string(),z.unknown())),summary:z.record(z.string(),z.unknown()),collectedAt:timestamp}).superRefine((value,ctx)=>{if(new Set(value.asins).size!==150)ctx.addIssue({code:'custom',message:'商品范围必须为150个去重ASIN'});for(const map of [value.basic,value.history])for(const [id,row] of Object.entries(map)){if(row.asin!==undefined&&row.asin!==id)ctx.addIssue({code:'custom',message:'ASIN身份不一致'});for(const key of ['site','marketplace','amz_site'])if(row[key]!==undefined&&row[key]!==value.site)ctx.addIssue({code:'custom',message:'来源站点不一致'});}if(value.sourceManifest&&value.sourceManifest.site!==value.site)ctx.addIssue({code:'custom',message:'来源清单站点不一致'});const allowed=new Set(value.asins);if([...Object.keys(value.basic),...Object.keys(value.history)].some(id=>!allowed.has(id)))ctx.addIssue({code:'custom',message:'来源包含冻结范围之外的商品'});});
/** Physical counts describe observed dispatches, never supplier billing units.
 * unknownCalls counts logical calls whose physical dispatch count remains unknown;
 * failedCalls includes rejected source validation, not just transport failures.
 * knownPhysicalAttempts is only a complete total when physicalCountComplete is true. */
export const PluginSupplementAccountingSchema=z.object({
 logicalAttempts:z.number().int().min(0).max(150),cacheHits:z.number().int().min(0).max(150),
 knownPhysicalAttempts:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
 unknownCalls:z.number().int().min(0).max(150),failedCalls:z.number().int().min(0).max(150),
 physicalCountComplete:z.boolean(),billingConfirmed:z.literal(false),
});
export type PluginSupplementAccounting=z.infer<typeof PluginSupplementAccountingSchema>;
export const PluginSupplementReceiptSchema=z.object({version:z.literal(1),rows:z.array(z.object({asin,fields:z.partialRecord(z.enum(['title','brand','image','rating','reviews','seller_name','parent','seller_type']),z.union([z.string().max(6000),z.number().finite()])),queriedAt:timestamp,evidence:z.record(z.string(),z.unknown())})).max(150),issues:z.array(z.record(z.string(),z.unknown())).max(5000),attemptedAsins:z.array(asin).max(150),requests:z.number().int().min(0).max(300),accounting:PluginSupplementAccountingSchema.optional()});
export const PluginCollectionFileSchema=z.instanceof(Uint8Array);
export type PluginCollectionJob=z.infer<typeof PluginCollectionJobSchema>;
export type PluginWorkerJob=z.infer<typeof PluginWorkerJobSchema>;
export type PluginCollectionSource=z.infer<typeof PluginCollectionSourceSchema>;
export type PluginSupplementReceipt=z.infer<typeof PluginSupplementReceiptSchema>;
