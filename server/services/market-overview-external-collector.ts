import {overviewSourceMonth} from '../../shared/market-overview-period';
import {z} from 'zod';
import type {MarketAnalysisScope} from '../../shared/market-analysis-contracts';
import {MarketInputRecordSchema} from '../../shared/market-analysis-contracts';
import {OverviewExternalInputSchema,OverviewAsinProfitSchema,type OverviewExternalInput} from '../../shared/market-overview-external';
import type {MarketSourceEvidence} from '../../shared/market-source-contracts';
import {createMarketSourceEvidence} from '../domain/market-research/source-evidence';
import {distRows} from '../domain/market-research/original-overview/original-mappers';
import {sorftimeMarketSite} from '../../shared/market-sites';
import type {ConnectorMap} from '../connectors/connector-contract';
import {ConnectorError} from '../connectors/connector-contract';
import {DeadlineError,executeOnce} from './market-keyword-collector';
const obj=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
const num=(v:unknown)=>{if(v===null||v===undefined||typeof v==='string'&&v.trim()==='')return null;const n=Number(v);return Number.isFinite(n)?n:null;};
export function overviewExternalAsins(sources:readonly MarketSourceEvidence[],scope:MarketAnalysisScope){
 const source=sources.find(s=>s.provider==='sellerSprite'&&s.operation==='market_price_distribution'&&overviewSourceMonth(s)===scope.toMonth);
 if(!source)return [];
 const asins=[...new Set(distRows(obj(source.payload).data??source.payload,r=>String(r.label??'')).flatMap(r=>r.asins??[]).map(a=>a.trim()).filter(a=>/^[A-Z0-9]{10}$/.test(a)))];
 if(asins.length>2000)throw new TypeError('Price distribution exceeds external ASIN budget');return asins;
}
export function parseOverviewCategoryTrend(payload:unknown,referenceMonth:string){
 const envelope=obj(payload);if(envelope.error||envelope.success===false||envelope.code!==undefined&&!['OK',200,'200',0,'0'].includes(envelope.code as string|number))throw new TypeError('Invalid category envelope');
 const data=typeof payload==='string'||Array.isArray(payload)?payload:envelope.data??envelope.content;
 if(!Array.isArray(data)&&typeof data!=='string')throw new TypeError('Missing category series');
 const rows=Array.isArray(data)?data:data.trim()?data.split(','):[];
 if(rows.length>2000)throw new TypeError('Category series too large');
 const points=new Map<string,number>();
 for(const row of rows){const match=typeof row==='string'?/^\s*(20\d{2}(?:年|-)(?:0[1-9]|1[0-2])月?)\s*=\s*(.*?)\s*$/.exec(row):null;if(!match)throw new TypeError('Invalid category point');match[1]=match[1].replace('年','-').replace('月','');const value=num(match[2]);if(value===null||value<0||match[2].trim()==='')throw new TypeError('Invalid category value');if(match[1]>referenceMonth)continue;if(points.has(match[1])&&points.get(match[1])!==value)throw new TypeError('Conflicting category month');points.set(match[1],value);}
 return [...points].sort(([a],[b])=>a.localeCompare(b)).map(([month,value])=>({month,value}));
}
export function projectOverviewExternal(input:OverviewExternalInput,payload:unknown,referenceMonth:string){
 if(input.kind!=='profits')return {points:parseOverviewCategoryTrend(payload,referenceMonth),items:{},pages:1,receivedCount:parseOverviewCategoryTrend(payload,referenceMonth).length};
 const envelope=obj(payload);if(envelope.code!==undefined&&envelope.code!=='OK'||envelope.isError===true)throw new TypeError('Invalid profit envelope');
 const data=obj(envelope.data??payload);if(!Array.isArray(data.items)||data.items.length>1000)throw new TypeError('Missing competitor rows');
 if(data.page!==undefined&&Number(data.page)!==input.page)throw new TypeError('Competitor page differs');
 const pages=data.pages===undefined?data.items.length===(input.asins?.length??40)?input.page!+1:input.page!:Number(data.pages);
 if(!Number.isSafeInteger(pages)||pages<0)throw new TypeError('Invalid competitor page count');
 const items:Record<string,z.infer<typeof OverviewAsinProfitSchema>>={};
 for(const value of data.items){const row=obj(value),asin=String(row.asin??'').trim();if(!input.asins!.includes(asin)||Object.hasOwn(items,asin))continue;items[asin]=OverviewAsinProfitSchema.parse({profit:num(row.profit),price:num(row.price),fba:num(row.fba)});}
 return {points:[],items,pages:Math.max(input.page!,pages),receivedCount:data.items.length};
}
export async function collectOverviewExternal(input:{scope:MarketAnalysisScope;stage:OverviewExternalInput;connectors:Pick<ConnectorMap,'sellerSprite'|'sorftime'>;jobId:string;signal:AbortSignal}){
 const {scope,signal}=input,stage=OverviewExternalInputSchema.parse(input.stage),profits=stage.kind==='profits',connector=profits?input.connectors.sellerSprite:input.connectors.sorftime,operation=profits?'competitor_lookup':'category_trend';
 signal.throwIfAborted();if(connector.id!==(profits?'sellerSprite':'sorftime'))return {status:'failed' as const,code:'configuration',retryable:false};
 const request=profits?{request:{marketplace:scope.marketplace,asins:stage.asins,returnFields:'asin,price,profit,fba',size:stage.asins!.length,page:stage.page,...(scope.overviewPeriod?{}:{month:scope.toMonth.replaceAll('-','')})}}:{node_id:scope.nodeIdPath.split(':').at(-1)!,amz_site:sorftimeMarketSite(scope.marketplace),trend_index:stage.kind==='sales'?'SalesCount':'AvgPrice'};
 try{
  const response=await executeOnce(connector,{operation,input:request,governorScope:{organizationId:scope.organizationId,jobId:input.jobId}},60000,signal);signal.throwIfAborted();
  if(response.source.connectorId!==connector.id||response.source.operation!==operation)throw new TypeError('Source differs');
  const payload=MarketInputRecordSchema.shape.data.parse(response.data),result=projectOverviewExternal(stage,payload,scope.toMonth);
  const proposal={scope,provider:profits?'sellerSprite' as const:'sorftime' as const,operation,requestIdentity:{marketplace:scope.marketplace,nodeIdPath:scope.nodeIdPath,nodeId:scope.nodeIdPath.split(':').at(-1),...(profits&&scope.overviewPeriod?{}:{month:scope.toMonth}),currency:scope.currency,...(profits?{page:stage.page}:{})},responseIdentityPaths:{marketplace:[['marketplace'],['amz_site'],['site'],['data','marketplace'],['data','amz_site'],['data','site']],nodeId:[['node_id'],['nodeId'],['data','node_id'],['data','nodeId']],nodeIdPath:[['nodeIdPath'],['data','nodeIdPath']],currency:[['currency'],['data','currency']],...(profits&&!scope.overviewPeriod?{month:[['month'],['data','month']]}:{})},payload,fetchedAt:response.source.fetchedAt,observationPeriod:profits&&scope.overviewPeriod?{kind:'trailing-days' as const,days:30,asOf:response.source.fetchedAt}:profits?{kind:'calendar-months' as const,fromMonth:scope.toMonth,toMonth:scope.toMonth}:result.points.length?{kind:'calendar-months' as const,fromMonth:result.points[0].month,toMonth:result.points.at(-1)!.month}:{kind:'unknown' as const,reason:'No completed category months'},units:profits?{profit:{status:'unknown' as const,rawUnit:'profit',reason:'Original provider profit value retained without conversion'},price:{status:'known' as const,unit:'currency' as const,rawUnit:'price',currency:scope.currency},fba:{status:'known' as const,unit:'currency' as const,rawUnit:'fba',currency:scope.currency}}:{value:stage.kind==='sales'?{status:'known' as const,unit:'count' as const,rawUnit:'SalesCount'}:{status:'known' as const,unit:'currency' as const,rawUnit:'AvgPrice',currency:scope.currency}},coverage:{receivedCount:result.receivedCount,expectedCount:null,truncation:{status:'unknown' as const,reason:profits?'Provider variant expansion; exact requested ASIN matches only':'Category history returned by provider'}}};
  const evidence=createMarketSourceEvidence(proposal);return {status:'ready' as const,result,evidence,proposal};
 }catch(error){signal.throwIfAborted();return {status:'failed' as const,code:error instanceof ConnectorError||error instanceof DeadlineError?error.code:'invalid-data',retryable:error instanceof ConnectorError?error.retryable:error instanceof DeadlineError&&error.code==='timeout'};}
}
