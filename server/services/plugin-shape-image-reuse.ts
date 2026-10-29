import {z} from 'zod';
import type {PluginCategoryPoolSource} from '../../shared/plugin-category-pool-contracts';
import {PluginSiteSchema,type PluginSite,type PluginCollectionSource} from '../../shared/plugin-collection-contracts';
import {MarketAnalysisScopeSchema,type MarketAnalysisScope} from '../../shared/market-analysis-contracts';
import {MarketShapeProductImageUrlSchema} from '../../shared/market-shape-product-image-contracts';
import {createMarketSourceEvidence} from '../domain/market-research/source-evidence';

export interface PluginProductSource {
 snapshotId:string;jobId:string;node:string;marketplace:PluginSite;asin:string;collectedAt:string;
 basic:Record<string,unknown>;history:Record<string,unknown>;
}
export interface PluginProductSources {
 findSnapshot?(input:{organizationId:string;userId:string;snapshotId:string}):Promise<Readonly<{snapshotId:string;jobId:string;source:PluginCollectionSource}>|null>;
 findCategoryPool?(input:{organizationId:string;userId:string;marketplace:string;node:string;poolSize:number;savedOnly?:boolean;now?:Date;notBefore?:string}):Promise<PluginCategoryPoolSource|null>;
 findProduct(input:{organizationId:string;userId:string;marketplace:string;asin:string;now?:Date;notBefore?:string}):Promise<PluginProductSource|null>;
}
const asinSchema=z.string().regex(/^[A-Z0-9]{10}$/);
const payloadSchema=z.object({allowMissingDetail:z.literal(true).optional(),version:z.literal(1),asin:asinSchema,marketplace:PluginSiteSchema,
 sourceSnapshotId:z.string().regex(/^plugin-source:[a-f0-9]{64}$/),pluginJobId:z.string().uuid(),sourceNode:z.string().regex(/^\d+$/),
 collectedAt:z.string().datetime({offset:true}),basic:z.record(z.string(),z.unknown()),
 requiredPool:z.object({asin:asinSchema,price:z.number().finite().positive().max(Number.MAX_SAFE_INTEGER).nullable(),grossProfitMargin:z.number().finite().min(-1000).max(100).nullable()}).strict(),
}).strict();
type Input={scope:MarketAnalysisScope;asin:string;userId:string;product:unknown;source:PluginProductSource;reuseSaved?:boolean;allowMissingDetail?:boolean;now?:Date;notBefore?:string};

/** A missing price or margin already requires MCP detail; avoid loading large unused plugin snapshots. */
export function canReusePluginShapeImage(value:unknown,asin:string){
 const product=value as Record<string,unknown>|null;
 const required=payloadSchema.shape.requiredPool.safeParse({asin:product?.asin,price:product?.price,grossProfitMargin:product?.grossProfitMargin});
 return required.success&&required.data.asin===asin&&required.data.price!==null&&required.data.grossProfitMargin!==null;
}

/** Only skips detail when its non-image requirement (pool margin) is already known. */
export function collectPluginShapeImage(input:Input){
 const scope=MarketAnalysisScopeSchema.parse(input.scope),now=input.now??new Date(),stamp=Date.parse(input.source.collectedAt);
 if(!PluginSiteSchema.safeParse(scope.marketplace).success||input.source.marketplace!==scope.marketplace||input.source.asin!==input.asin||
  !Number.isFinite(stamp)||stamp>now.getTime()||(!input.reuseSaved&&now.getTime()-stamp>6*3600_000)||
  input.notBefore!==undefined&&(!Number.isFinite(Date.parse(input.notBefore))||stamp<Date.parse(input.notBefore)))return null;
 const product=input.product as Record<string,unknown>;
 const parsed=payloadSchema.safeParse({...(input.allowMissingDetail?{allowMissingDetail:true}:{}),version:1,asin:input.asin,marketplace:input.source.marketplace,
  sourceSnapshotId:input.source.snapshotId,pluginJobId:input.source.jobId,sourceNode:input.source.node,collectedAt:input.source.collectedAt,
  basic:input.source.basic,requiredPool:{asin:product?.asin,price:product?.price,grossProfitMargin:product?.grossProfitMargin}});
 if(!parsed.success||!input.allowMissingDetail&&!canReusePluginShapeImage(input.product,input.asin))return null;
 const payload=parsed.data;
 if(payload.basic.asin!==input.asin||payload.requiredPool.asin!==input.asin)return null;
 for(const field of ['marketplace','site','amz_site'])if(payload.basic[field]!==undefined&&payload.basic[field]!==scope.marketplace)return null;
 const image=[payload.basic.image,payload.basic.image_zoom].map(v=>MarketShapeProductImageUrlSchema.safeParse(v)).find(v=>v.success&&v.data);
 if(!image?.success||!image.data)return null;
 const imageUrl=image.data,fetchedAt=new Date(payload.collectedAt).toISOString();
 const evidence=createMarketSourceEvidence({scope,provider:'sellerSprite',operation:'plugin_product_basic',
  requestIdentity:{asin:input.asin,marketplace:scope.marketplace},responseIdentityPaths:{asin:[['asin'],['basic','asin']],marketplace:[['marketplace']]},
  payload:JSON.parse(JSON.stringify(payload)),fetchedAt,observationPeriod:{kind:'current',asOf:fetchedAt},
  units:{image:{status:'unknown',rawUnit:null,reason:'Plugin main image URL; not a numeric metric'}},
  coverage:{receivedCount:1,expectedCount:1,truncation:{status:'not-truncated'}}},now);
 return {status:'ready' as const,asin:input.asin,imageUrl,evidence};
}

/** Frozen report replay must not read today's cache or depend on a running Chrome worker. */
export function replayPluginShapeImage(scope:MarketAnalysisScope,value:unknown,fetchedAt:string){
 const payload=payloadSchema.parse(value);
 if(Date.parse(payload.collectedAt)!==Date.parse(fetchedAt))throw new TypeError('Plugin image timestamp differs');
 // Replay at the earliest valid analysis instant; fetchedAt can precede the month boundary.
 const [year,month]=scope.toMonth.split('-').map(Number);
 const replayAt=new Date(Math.max(Date.parse(fetchedAt),Date.UTC(year,month,1)));
 const result=collectPluginShapeImage({scope,asin:payload.asin,userId:'frozen-replay',product:payload.requiredPool,now:replayAt,reuseSaved:true,allowMissingDetail:payload.allowMissingDetail,
  source:{snapshotId:payload.sourceSnapshotId,jobId:payload.pluginJobId,node:payload.sourceNode,marketplace:payload.marketplace,asin:payload.asin,collectedAt:payload.collectedAt,basic:payload.basic,history:{}}});
 if(!result)throw new TypeError('Plugin image identity or compatible pool differs');
 return result;
}
