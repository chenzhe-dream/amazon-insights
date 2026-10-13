import {MarketThemeSampleMetadataSchema} from '../../../shared/market-theme-selection-contracts';
import {normalizeSorftimeShapePool,sorftimeProductCategories} from '../../services/market-shape-sorftime-pool';
import {parseSorftimeProductMainImage} from '../../services/market-shape-product-image';
import {canonicalJsonSha256 as digest} from '../../runtime/model-request-accounting';
type Source={ref:string;snapshotId:string;payload:unknown;operation?:'category_report'|'category_products';nodeId?:string};
const obj=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
export function projectSorftimeThemeSample(input:{asin:string;sourceIndex:number;product:unknown;productSource:Source;summarySource?:Source;imageSource?:Source;imageMissingReason?:string}){
 const {asin,sourceIndex,productSource,summarySource,imageSource}=input;
 const parsed=normalizeSorftimeShapePool(productSource.payload,productSource.operation??'category_report',undefined,300,productSource.nodeId),p=parsed.products.find(p=>p.sourceIndex===sourceIndex);
 if(!p||p.asin!==asin||digest(p)!==digest(input.product))throw new TypeError('Theme sample differs from frozen Sorftime row');
 const current=productSource.operation==='category_products',envelope=obj(productSource.payload),prefix=envelope.data===undefined?[]:['data'],rows=current?envelope.data:obj(envelope.data??envelope).top100_products;
 const row=obj(Array.isArray(rows)?rows[sourceIndex]:null),base=current?[...prefix,sourceIndex]:[...prefix,'top100_products',sourceIndex];
 const rankEntries=current?sorftimeProductCategories(row.sub_category):[],rankEntry=productSource.nodeId?rankEntries.find(e=>e.nodeId===productSource.nodeId):rankEntries.length===1?rankEntries[0]:null;
 const missing=(reason:string)=>({value:null,evidence:null,missingReason:reason,truncated:false});
 const known=<T>(value:T,path:(string|number)[],source=productSource,truncated=false)=>({value,evidence:{sourceRef:source.ref,inputSnapshotId:source.snapshotId,path},missingReason:null,truncated});
 const summaryEnvelope=obj(summarySource?.payload),nested=obj(summaryEnvelope.data),summary=nested.customer_say??summaryEnvelope.customer_say;
 const image=p.imageUrl??(imageSource?parseSorftimeProductMainImage(imageSource.payload):null);
 const imageField=['main_image','image_url','imageUrl'].find(k=>row[k]!=null)??'main_image';
 const detailPath=obj(imageSource?.payload).data===undefined?['main_image']:['data','main_image'];
 return MarketThemeSampleMetadataSchema.parse({asin,sourceOrder:sourceIndex+1,
  title:p.title?known(p.title.slice(0,300),[...base,'title'],productSource,p.title.length>300):missing('来源未提供标题'),
  sourceRank:p.sourceRank&&p.sourceRank>0?known(p.sourceRank,current?[...base,'sub_category',rankEntry!.index,2]:[...base,'category_rank']):missing('来源未提供有效排名'),
  imageUrl:image?known(image,p.imageUrl?[...base,imageField,...(current&&Array.isArray(row[imageField])?[0]:[])]:detailPath,p.imageUrl?productSource:imageSource!):missing(input.imageMissingReason??'来源未提供可用商品图片'),
  customerSay:typeof summary==='string'&&summary.trim()?known(summary.slice(0,1000),nested.customer_say===undefined?['customer_say']:['data','customer_say'],summarySource!,summary.length>1000):missing('来源未提供总览摘要')});
}
