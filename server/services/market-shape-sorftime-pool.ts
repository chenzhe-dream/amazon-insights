import {z} from 'zod';
import {MarketAnalysisScopeSchema,MarketInputRecordSchema,type MarketAnalysisScope} from '../../shared/market-analysis-contracts';
import {type MarketSourceEvidence,type MarketSourcePayloadPath} from '../../shared/market-source-contracts';
import {SorftimeShapeProductSchema,type SorftimeShapeProduct} from '../../shared/market-shape-sorftime-contracts';
import {sorftimeMarketSite} from '../../shared/market-sites';
import {ConnectorError,type RemoteMcpConnector} from '../connectors/connector-contract';
import {createMarketSourceEvidence} from '../domain/market-research/source-evidence';
import {DeadlineError,executeOnce} from './market-keyword-collector';
import {canonicalJsonSha256 as digest} from '../runtime/model-request-accounting';

const obj=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
const text=(v:unknown)=>typeof v==='string'&&v.trim()&&v.length<=4000?v.trim():null;
function numeric(v:unknown,integer=false,min=0,max=Number.MAX_SAFE_INTEGER){
 if(typeof v!=='number'&&(typeof v!=='string'||! /^-?\d+(?:\.\d+)?$/.test(v.trim())))return null;
 const n=Number(v);return Number.isFinite(n)&&n>=min&&n<=max&&(!integer||Number.isSafeInteger(n))?n:null;
}
function image(v:unknown){try{const u=new URL(String(v));return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&['m.media-amazon.com','images-na.ssl-images-amazon.com','images-eu.ssl-images-amazon.com','images-fe.ssl-images-amazon.com'].includes(u.hostname)?u.href:null;}catch{return null;}}
const rank=(v:unknown)=>{const m=typeof v==='string'?/Rank:\s*(\d+)/i.exec(v):null;return m?numeric(m[1],true):null;};
function categoryEntries(v:unknown){
 if(typeof v!=='string')return [];
 return v.split(/\r?\n/).flatMap(line=>{const match=/^\s*(?:Category:\s*)?(.+?)(?:,\s*|\s*\()Rank:\s*(\d+)\)?\s*$/i.exec(line);return match?[{name:match[1].trim(),rank:numeric(match[2],true)}]:[]});
}
const category=(v:unknown)=>categoryEntries(v)[0]?.name??text(typeof v==='string'?v.split('(')[0].trim():null);
function commonCategory(rows:unknown[]){
 let shared:Set<string>|null=null;const names=new Map<string,string>();
 for(const row of rows){const entries=categoryEntries(obj(row).category_rank);if(!entries.length)return null;const keys=new Set(entries.map(e=>{names.set(e.name.toLowerCase(),e.name);return e.name.toLowerCase()}));shared=shared===null?keys:new Set([...shared].filter((k:string)=>keys.has(k)));}
 return shared?.size===1?names.get([...shared][0])??null:null;
}
export function resolveReferenceMarginEntry(value:number|null){return value===null||!Number.isFinite(value)?'未知':value>=70?'优先进入':value>=60?'建议进入':value>=50?'谨慎进入':'不建议进入';}
export function normalizeSorftimeShapePool(raw:unknown,operation:'category_report'|'product_search',categoryName?:string,poolSize=300){
 MarketInputRecordSchema.shape.data.parse(raw);const e=obj(raw),data=e.data??e;
 if(e.error||e.success===false||e.code!==undefined&&!['OK',200,'200',0,'0'].includes(e.code as string|number))throw Error('Source error envelope');
 const container=obj(data),rows=operation==='category_report'?container.top100_products:data;
 if(!Array.isArray(rows)||rows.length>1000)throw Error('Unsupported Sorftime pool payload');
 const targetCategory=categoryName??text(obj(container.category_stats_report).category_name)??(operation==='category_report'?commonCategory(rows):null);
 const seen=new Map<string,SorftimeShapeProduct>(),normalized: SorftimeShapeProduct[]=[];
 rows.forEach((v,sourceIndex)=>{const r=obj(v),asin=String(r.asin??'').trim().toUpperCase();
  if(!/^[A-Z0-9]{10}$/.test(asin))throw Error('Invalid product identity');
  const categoryText=operation==='product_search'?r.subcategory:r.category_rank,targetRank=targetCategory?categoryEntries(categoryText).find(e=>e.name.toLowerCase()===targetCategory.toLowerCase())?.rank??null:rank(categoryText);
  if(operation==='product_search'&&(categoryName&&category(r.subcategory)?.toLowerCase()!==categoryName.trim().toLowerCase()||targetRank===null||targetRank<101||targetRank>poolSize))return;
  const p=SorftimeShapeProductSchema.parse({asin,sourceIndex,title:text(r.title),brand:text(r.brand),price:numeric(r.price),units:numeric(r.monthly_sales_volume,true),revenue:numeric(r.monthly_sales_amount),sourceRank:targetRank,rating:numeric(r.star_rating,false,0,5),ratingCount:numeric(r.review_count,true),sellerName:text(r.seller??r.seller_country),sellerType:text(r.delivery_type),listedAt:text(r.online_date)==='null'?null:text(r.online_date),imageUrl:image(r.main_image??r.image_url??r.imageUrl),grossProfitMargin:numeric(r.gross_profit_margin,false,-1000,100),categoryRank:text(operation==='product_search'?r.subcategory:r.category_rank),productCategory:category(r.product_category??r.subcategory??r.category_rank),sellerOrigin:text(r.seller_origin??r.seller_country)});
  const previous=seen.get(asin);if(previous){if(digest({...previous,sourceIndex:0})!==digest({...p,sourceIndex:0}))throw Error('Conflicting duplicate product');return;}
  seen.set(asin,p);normalized.push(p);
 });
 normalized.sort((a,b)=>(a.sourceRank??a.sourceIndex+1)-(b.sourceRank??b.sourceIndex+1)||(b.units??-1)-(a.units??-1));
 return {products:normalized,categoryName:targetCategory,receivedCount:rows.length};
}
type Input={scope:MarketAnalysisScope;jobId:string;connector:RemoteMcpConnector;page?:number;poolSize?:number;categoryName?:string;signal?:AbortSignal;timeoutMs?:number;now?:()=>Date};
type Result={status:'ready'|'empty';products:SorftimeShapeProduct[];categoryName:string|null;receivedCount:number;evidence:MarketSourceEvidence}|{status:'failed';failure:{code:string;retryable:boolean}};
export async function collectSorftimeShapePoolPage(input:Input):Promise<Result>{
 const scope=MarketAnalysisScopeSchema.parse(input.scope),operation=input.page===undefined?'category_report':'product_search',poolSize=z.number().int().min(1).max(300).parse(input.poolSize??100);
 if(input.connector.id!=='sorftime')return {status:'failed',failure:{code:'configuration',retryable:false}};
 if(input.page!==undefined){z.number().int().min(1).max(20).parse(input.page);z.string().trim().min(1).max(500).parse(input.categoryName);if(poolSize<=100)return {status:'failed',failure:{code:'configuration',retryable:false}};}
 let response;
 try{response=await executeOnce(input.connector,{operation,input:operation==='category_report'?{node_id:scope.nodeIdPath.split(':').at(-1)!,amz_site:sorftimeMarketSite(scope.marketplace)}:{amz_site:sorftimeMarketSite(scope.marketplace),search_name:input.categoryName!,subcategory_sales_volume_rank_min:101,subcategory_sales_volume_rank_max:poolSize,page:input.page!},governorScope:{organizationId:scope.organizationId,jobId:input.jobId}},input.timeoutMs??60000,input.signal);}
 catch(e){return {status:'failed',failure:{code:e instanceof ConnectorError||e instanceof DeadlineError?e.code:'upstream-temporary',retryable:e instanceof ConnectorError?e.retryable:true}};}
 try{
  const fetchedAt=z.object({connectorId:z.literal('sorftime'),operation:z.literal(operation),fetchedAt:z.string().datetime(),attemptCount:z.number().int().positive()}).parse(response.source).fetchedAt;
  const parsed=normalizeSorftimeShapePool(response.data,operation,input.categoryName,poolSize),payload=MarketInputRecordSchema.shape.data.parse(response.data),e=obj(payload),d=obj(e.data),stats=obj(d.category_stats_report);
  const responseIdentityPaths:Record<string,MarketSourcePayloadPath[]>={};
  for(const [field,aliases] of Object.entries({marketplace:['amz_site','marketplace','site'],currency:['currency'],...(operation==='category_report'?{nodeId:['node_id','nodeId']}: {})})){
   const paths:MarketSourcePayloadPath[]=[];for(const [record,prefix] of [[e,[]],[d,['data']],[stats,['data','category_stats_report']]] as [Record<string,unknown>,string[]][]){for(const alias of aliases)if(Object.hasOwn(record,alias))paths.push([...prefix,alias]);}if(paths.length)responseIdentityPaths[field]=paths;
  }
  const evidence=createMarketSourceEvidence({scope,provider:'sorftime',operation,requestIdentity:{marketplace:scope.marketplace,currency:scope.currency,...(operation==='category_report'?{nodeId:scope.nodeIdPath.split(':').at(-1)!}:{keyword:input.categoryName!,page:input.page!})},responseIdentityPaths,payload,fetchedAt,observationPeriod:{kind:'trailing-days',days:30,asOf:fetchedAt},units:{units:{status:'known',unit:'count',rawUnit:'monthly_sales_volume (recent30days)'},revenue:{status:'known',unit:'currency',currency:scope.currency,rawUnit:'monthly_sales_amount'},grossProfitMargin:{status:'known',unit:'percent',rawUnit:'gross_profit_margin'}},coverage:{receivedCount:parsed.receivedCount,expectedCount:null,truncation:{status:'unknown',reason:'Provider category head products or matching expansion results; not whole-market coverage'}}},input.now?.()??new Date());
  return {status:parsed.products.length?'ready':'empty',...parsed,evidence};
 }catch{return {status:'failed',failure:{code:'invalid-data',retryable:false}};}
}
