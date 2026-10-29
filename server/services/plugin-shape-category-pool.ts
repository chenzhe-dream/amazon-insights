import {z} from 'zod';
import {PluginCategoryPoolSourceSchema,type PluginCategoryPoolSource} from '../../shared/plugin-category-pool-contracts';
import {MarketAnalysisScopeSchema,type MarketAnalysisScope} from '../../shared/market-analysis-contracts';
import {SorftimeShapeProductSchema} from '../../shared/market-shape-sorftime-contracts';
import type {MarketSourceEvidence} from '../../shared/market-source-contracts';
import {createMarketSourceEvidence} from '../domain/market-research/source-evidence';
import {canonicalJsonSha256 as digest} from '../runtime/model-request-accounting';
import {pluginProduct} from './plugin-product-projection';

const currencies={US:['USD','$'],CA:['CAD','$','CA$','C$','CDN$'],UK:['GBP','£'],DE:['EUR','€']} as const;
const rawFields=['asin','site','marketplace','amz_site','currency','title','brand','price','units','amount','rating','reviews','seller_name','seller_type','image','image_zoom','available','node_id_path','node_label_path','profit'];
function compactBasic(raw:Record<string,unknown>){
 const value={...Object.fromEntries(rawFields.filter(key=>Object.hasOwn(raw,key)).map(key=>[key,raw[key]]))};
 if(raw.seller_dto&&typeof raw.seller_dto==='object')value.seller_dto={nation_code:(raw.seller_dto as Record<string,unknown>).nation_code??null};
 if(Array.isArray(raw.bsrList))value.bsrList=raw.bsrList.map(item=>item&&typeof item==='object'?Object.fromEntries(['id','rank','label','text'].filter(key=>Object.hasOwn(item,key)).map(key=>[key,item[key]])):{});
 return value;
}
const payloadSchema=z.object({version:z.literal(1),poolSize:z.number().int().min(1).max(150),source:PluginCategoryPoolSourceSchema}).strict();
function project(scope:MarketAnalysisScope,value:unknown){
 MarketAnalysisScopeSchema.parse(scope);const payload=payloadSchema.parse(value),source=payload.source;
 if(scope.marketplace!==source.marketplace||scope.currency!==currencies[source.marketplace][0]||scope.nodeIdPath.split(':').at(-1)!==source.node)throw new TypeError('Plugin category scope differs');
 const products=source.asins.slice(0,payload.poolSize).map((asin,sourceIndex)=>{
  const raw=source.basic[asin]??{};
  if(raw.asin!==undefined&&raw.asin!==asin)throw new TypeError('Plugin category ASIN differs');
  for(const key of ['site','marketplace','amz_site'])if(raw[key]!==undefined&&raw[key]!==scope.marketplace)throw new TypeError('Plugin category site differs');
  if(raw.currency!==undefined&&!(currencies[source.marketplace] as readonly unknown[]).includes(raw.currency))throw new TypeError('Plugin category currency differs');
  const blank=SorftimeShapeProductSchema.parse({...Object.fromEntries(Object.keys(SorftimeShapeProductSchema.shape).map(key=>[key,null])),asin,sourceIndex});
  // prepare_workbook.py emits this two-field sentinel when SellerSprite returns no basic row.
  // Keep it in raw evidence, but never count the UI placeholder as an observed title.
  const missingBasic=raw.title==='基础信息缺失'&&Object.keys(raw).every(key=>key==='asin'||key==='title');
  return pluginProduct(blank,missingBasic?{asin}:raw,source.node,source.collectedAt);
 });
 const labels=[...new Set(products.map(p=>p.productCategory).filter((v):v is string=>!!v))],categoryName=labels.length===1?labels[0]:null;
 const fetchedAt=new Date(source.collectedAt).toISOString();
 const evidence=createMarketSourceEvidence({scope,provider:'sellerSprite',operation:'plugin_category_pool',requestIdentity:{marketplace:scope.marketplace,nodeId:source.node},responseIdentityPaths:{marketplace:[['source','marketplace']],nodeId:[['source','node']]},payload:JSON.parse(JSON.stringify(payload)),fetchedAt,
  observationPeriod:{kind:'trailing-days',days:30,asOf:fetchedAt},units:{products:{status:'known',unit:'count',rawUnit:'Ordered plugin collector membership; field provider SellerSprite; discovery source saved separately'}},coverage:{receivedCount:products.length,expectedCount:payload.poolSize,truncation:{status:'not-truncated'}}},new Date(fetchedAt));
 return {status:'ready' as const,products,categoryName,receivedCount:products.length,evidence};
}
export function collectPluginShapeCategoryPool(input:{scope:MarketAnalysisScope;poolSize:number;source:PluginCategoryPoolSource;reuseSaved?:boolean;now?:Date;notBefore?:string}){
 const source=PluginCategoryPoolSourceSchema.parse(input.source),stamp=Date.parse(source.collectedAt),now=input.now??new Date();
 if(stamp>now.getTime()||(!input.reuseSaved&&now.getTime()-stamp>6*3600000)||input.notBefore!==undefined&&(!Number.isFinite(Date.parse(input.notBefore))||stamp<Date.parse(input.notBefore)))throw new TypeError('Plugin category snapshot is stale');
 return project(input.scope,{version:1,poolSize:input.poolSize,source:{...source,basic:Object.fromEntries(source.asins.slice(0,input.poolSize).filter(asin=>source.basic[asin]).map(asin=>[asin,compactBasic(source.basic[asin])]))}});
}
export function replayPluginShapeCategoryPool(scope:MarketAnalysisScope,evidence:MarketSourceEvidence){
 if(evidence.operation!=='plugin_category_pool'||evidence.provider!=='sellerSprite')throw new TypeError('Plugin category source differs');
 const result=project(scope,evidence.payload);
 if(digest(result.evidence)!==digest(evidence))throw new TypeError('Plugin category replay differs');
 return result;
}
