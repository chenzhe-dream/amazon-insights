import type {MarketAnalysisScope} from '../../shared/market-analysis-contracts';
import type {MarketSourceEvidence} from '../../shared/market-source-contracts';
type Input={scope:MarketAnalysisScope;evidence:MarketSourceEvidence;sourceRef:string;inputSnapshotId:string;asin:string;product:unknown;summarySource?:{ref:string;snapshotId:string;payload:unknown};imageSource?:{ref:string;snapshotId:string;payload:unknown};imageMissingReason?:string};
import {replayPluginShapeCategoryPool} from './plugin-shape-category-pool';
import {MarketThemeSampleMetadataSchema} from '../../shared/market-theme-selection-contracts';
import {parseSorftimeProductMainImage} from './market-shape-product-image';
import {canonicalJsonSha256 as hash} from '../runtime/model-request-accounting';
const obj=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
/** Saved pool and saved Customers Say have separate evidence paths. No live lookup. */
export function projectPluginThemeSample(input:Input){
 const pool=replayPluginShapeCategoryPool(input.scope,input.evidence),p=pool.products.find(p=>p.asin===input.asin);
 if(!p||hash(p)!==hash(input.product)||input.sourceRef!=='market-source:'+hash(input.evidence))throw new TypeError('Plugin sample differs from saved pool');
 const source=obj(obj(input.evidence.payload).source),raw=obj(obj(source.basic)[input.asin]),base=['source','basic',input.asin];
 const known=(value:unknown,path:(string|number)[],evidence={ref:input.sourceRef,snapshotId:input.inputSnapshotId},truncated=false)=>({value,evidence:{sourceRef:evidence.ref,inputSnapshotId:evidence.snapshotId,path},missingReason:null,truncated});
 const missing=(reason:string)=>({value:null,evidence:null,missingReason:reason,truncated:false});
 const rankIndex=Array.isArray(raw.bsrList)?raw.bsrList.findIndex(r=>String(obj(r).id)===source.node&&obj(r).rank===p.sourceRank):-1;
 const summary=obj(obj(input.summarySource?.payload).data).customer_say??obj(input.summarySource?.payload).customer_say;
 let image=p.imageUrl,imagePath:(string|number)[]=[...base,raw.image===p.imageUrl?'image':'image_zoom'],imageSource={ref:input.sourceRef,snapshotId:input.inputSnapshotId};
 if(!image&&input.imageSource){
  const envelope=obj(input.imageSource.payload),nested=envelope.data!==undefined&&envelope.data!==null;
  const rawImage=obj(nested?envelope.data:envelope).main_image;
  // Keep paths in the original payload: a JSON string is not an array node.
  imagePath=nested?['data','main_image']:['main_image'];
  if(Array.isArray(rawImage))imagePath.push(0);
  image=parseSorftimeProductMainImage(input.imageSource.payload);imageSource=input.imageSource;
 }
 return MarketThemeSampleMetadataSchema.parse({asin:input.asin,sourceProvider:'sellerSprite',sourceOperation:'plugin_category_pool',sourceOrder:p.sourceIndex+1,
  title:p.title?known(p.title.slice(0,300),[...base,'title'],undefined,p.title.length>300):missing('来源未提供标题'),
  sourceRank:p.sourceRank!==null&&p.sourceRank>0&&rankIndex>=0?known(p.sourceRank,[...base,'bsrList',rankIndex,'rank']):missing('来源未提供当前类目的有效排名'),
  imageUrl:image?known(image,imagePath,imageSource):missing(input.imageMissingReason??'来源未提供可用商品图片'),
  customerSay:typeof summary==='string'&&summary.trim()?known(summary.slice(0,1000),obj(obj(input.summarySource?.payload).data).customer_say===undefined?['customer_say']:['data','customer_say'],input.summarySource,summary.length>1000):missing('来源未提供总览摘要')});
}
