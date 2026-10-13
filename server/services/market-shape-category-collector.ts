import {z} from 'zod';
import {MarketAnalysisScopeSchema,MarketInputRecordSchema,type MarketAnalysisScope} from '../../shared/market-analysis-contracts';
import {ShapeCategoryMetricSchema,ShapeCategoryStatsSchema,ShapeCategoryDashboardSchema,type ShapeCategorySource,type ShapeCategoryMetric} from '../../shared/market-shape-category-contracts';
import {sorftimeMarketSite} from '../../shared/market-sites';
import {ConnectorError,type RemoteMcpConnector} from '../connectors/connector-contract';
import {createMarketSourceEvidence} from '../domain/market-research/source-evidence';
import {DeadlineError,executeOnce} from './market-keyword-collector';
const obj=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
const numeric=(v:unknown,integer=false)=>{const n=typeof v==='number'?v:typeof v==='string'&&/^\d+(?:\.\d+)?$/.test(v.trim())?Number(v):NaN;return Number.isFinite(n)&&n>=0&&n<=Number.MAX_SAFE_INTEGER&&(!integer||Number.isSafeInteger(n))?n:null;};
function tail(v:unknown,pct=false){if(typeof v!=='string')return pct?null:numeric(v);const m=(pct?/:\s*(\d+(?:\.\d+)?)\s*%\s*$/:/:\s*(\d+(?:\.\d+)?)\s*$/).exec(v);const n=m?numeric(m[1]):pct&&/^\d+(?:\.\d+)?%$/.test(v.trim())?numeric(v.trim().slice(0,-1)):pct?null:numeric(v);return n!==null&&(!pct||n<=100)?n:null;}
export function normalizeShapeCategorySource(metricInput:string,raw:unknown,referenceMonth:string,currency='USD'):Pick<ShapeCategorySource,'points'|'stats'>{
 const metric=ShapeCategoryMetricSchema.parse(metricInput),envelope=obj(raw);MarketInputRecordSchema.shape.data.parse(raw);
 if(envelope.error||envelope.success===false||envelope.code!==undefined&&!['OK',200,'200',0,'0'].includes(envelope.code as string|number))throw Error('Invalid category envelope');
 if(metric==='report'){
  const data=obj(envelope.data??envelope);
  if(!Object.hasOwn(data,'category_stats_report')&&Object.hasOwn(data,'node_id')&&Object.hasOwn(data,'top100_monthly_sales_volume')){
   const pct=(v:unknown)=>{const n=numeric(v);return n!==null&&n<=100?n:null;};
   // Current contract declares USD and numeric percentage points. Its category average
   // price is not the original Top80% average or median, so those stay unknown.
   return {points:[],stats:ShapeCategoryStatsSchema.parse({top100Units:numeric(data.top100_monthly_sales_volume,true),top100Amount:currency==='USD'?numeric(data.top100_monthly_sales_amount):null,top3ProductPct:pct(data.top3_product_sales_volume_share),top3BrandPct:pct(data.top3_brand_sales_volume_share),top3SellerPct:pct(data.top3_seller_sales_volume_share),amazonOwnedPct:pct(data.amazon_owned_sales_volume_share),averagePrice:null,medianPrice:null,returnRatePct:pct(data.return_rate)})};
  }
  const s=obj(data.category_stats_report);
  if(!Object.hasOwn(data,'category_stats_report'))throw Error('Category stats absent');
  return {points:[],stats:ShapeCategoryStatsSchema.parse({top100Units:numeric(s.top100_monthly_sales_volume,true),top100Amount:numeric(s.top100_monthly_sales_amount),top3ProductPct:tail(s.top3_product_sales_volume_share,true),top3BrandPct:tail(s.top3_brands_sales_volume_share,true),top3SellerPct:tail(s.top3_seller_sales_volume_share,true),amazonOwnedPct:tail(s.amazon_owned_sales_volume_share,true),averagePrice:tail(s.average_price),medianPrice:tail(s.median_price),returnRatePct:tail(s.return_rate,true)})};
 }
 const value=typeof raw==='string'||Array.isArray(raw)?raw:envelope.data??envelope.content;
 if(typeof value!=='string'&&!Array.isArray(value))throw Error('Unsupported category trend');
 const rows=typeof value==='string'?(value.trim()?value.split(','):[]):value;
 if(rows.length>2000)throw Error('Category history too large');
 const points=new Map<string,number|null>(),end=Number(referenceMonth.slice(0,4))*12+Number(referenceMonth.slice(5));
 for(const row of rows){
  const m=typeof row==='string'?/^\s*(20\d{2})(?:年|-)(0[1-9]|1[0-2])月?\s*=\s*(.*?)\s*$/.exec(row):null;
  if(!m)throw Error('Invalid category month');
  const month=`${m[1]}-${m[2]}`;if(month>referenceMonth||Number(m[1])*12+Number(m[2])<end-119)continue;
  let n=numeric(m[3],metric==='SalesCount');if(metric.startsWith('Top3')&&n!==null&&n>100)n=null;
  if(points.has(month)&&points.get(month)!==n)n=null;
  points.set(month,n);
 }
 return {stats:null,points:[...points].sort(([a],[b])=>a.localeCompare(b)).map(([month,value])=>({month,value}))};
}
export function buildShapeCategoryDashboard(sources:ShapeCategorySource[],currency:string,referenceMonth:string){
 const units=sources.find(s=>s.metric==='SalesCount')?.points??[],prices=new Map((sources.find(s=>s.metric==='AvgPrice')?.points??[]).map(p=>[p.month,p.value]));
 return ShapeCategoryDashboardSchema.parse({provider:'sorftime',currency,referenceMonth,sources,estimatedAmount:units.map(p=>{const price=prices.get(p.month),n=p.value===null||price==null?null:p.value*price;return {month:p.month,value:n!==null&&Number.isFinite(n)&&n<=Number.MAX_SAFE_INTEGER?Math.round(n*100)/100:null};})});
}
export async function collectShapeCategory(input:{scope:MarketAnalysisScope;metric:ShapeCategoryMetric;connector:RemoteMcpConnector;jobId:string;signal?:AbortSignal;now?:()=>Date}){
 const scope=MarketAnalysisScopeSchema.parse(input.scope),metric=ShapeCategoryMetricSchema.parse(input.metric),now=input.now??(()=>new Date()),operation=metric==='report'?'category_report':'category_trend';
 if(input.connector.id!=='sorftime')return {status:'failed' as const,failure:{code:'configuration',retryable:false}};
 let response;try{response=await executeOnce(input.connector,{operation,input:{node_id:scope.nodeIdPath.split(':').at(-1)!,amz_site:sorftimeMarketSite(scope.marketplace),...(metric==='report'?{}:{trend_index:metric})},governorScope:{organizationId:scope.organizationId,jobId:input.jobId}},60000,input.signal);}
 catch(e){return {status:'failed' as const,failure:{code:e instanceof ConnectorError||e instanceof DeadlineError?e.code:'upstream-temporary',retryable:e instanceof ConnectorError?e.retryable:e instanceof DeadlineError?e.code==='timeout':true}};}
 try{
  const source=z.object({connectorId:z.literal('sorftime'),operation:z.literal(operation),fetchedAt:z.string().datetime()}).parse(response.source),payload=MarketInputRecordSchema.shape.data.parse(response.data),normalized=normalizeShapeCategorySource(metric,payload,scope.toMonth,scope.currency);
  const evidence=createMarketSourceEvidence({scope,provider:'sorftime',operation,requestIdentity:{marketplace:scope.marketplace,nodeId:scope.nodeIdPath.split(':').at(-1),currency:scope.currency},responseIdentityPaths:{currency:[['currency'],['data','currency']],marketplace:[['amz_site'],['marketplace'],['site'],['data','amz_site'],['data','marketplace'],['data','site']],nodeId:[['node_id'],['data','node_id'],['data','category_stats_report','node_id'],['category_stats_report','node_id']]},payload,fetchedAt:source.fetchedAt,
   observationPeriod:metric==='report'?{kind:'trailing-days',days:30,asOf:source.fetchedAt}:normalized.points.length?{kind:'calendar-months',fromMonth:normalized.points[0].month,toMonth:normalized.points.at(-1)!.month}:{kind:'unknown',reason:'No completed category months'},
   units:{value:metric==='SalesCount'?{status:'known',unit:'count',rawUnit:metric}:metric.startsWith('Top3')?{status:'known',unit:'percent',rawUnit:metric}:metric==='AvgPrice'?{status:'known',unit:'currency',currency:scope.currency,rawUnit:'AvgPrice in marketplace currency'}:{status:'unknown',rawUnit:null,reason:'Mixed count, marketplace currency and explicit percent fields'}},coverage:{receivedCount:normalized.points.length,expectedCount:null,truncation:{status:'unknown',reason:'Provider category coverage; not frozen product pool'}}},now());
  const values=normalized.stats?Object.values(normalized.stats):normalized.points.map(p=>p.value);
  return {status:values.every(v=>v===null)?'empty' as const:values.some(v=>v===null)?'partial' as const:'ready' as const,...normalized,evidence};
 }catch{return {status:'failed' as const,failure:{code:'invalid-data',retryable:false}};}
}
