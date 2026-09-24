import {z} from 'zod';
import {MarketAnalysisScopeSchema,MarketInputRecordSchema,type MarketAnalysisScope} from '../../shared/market-analysis-contracts';
import {MarketSourceIdentityValueSchemas,type MarketSourceEvidence,type MarketSourcePayloadPath} from '../../shared/market-source-contracts';
import {ProductHistoryPointSchema,type ProductHistoryPoint} from '../../shared/market-product-history-contracts';
import {sorftimeMarketSite} from '../../shared/market-sites';
import {ConnectorError,type RemoteMcpConnector} from '../connectors/connector-contract';
import {createMarketSourceEvidence} from '../domain/market-research/source-evidence';
import {DeadlineError,executeOnce} from './market-keyword-collector';

const obj=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
const index=(s:string)=>Number(s.slice(0,4))*12+Number(s.slice(5))-1;
const format=(n:number)=>`${Math.floor(n/12)}-${String(n%12+1).padStart(2,'0')}`;

/** Original provider format, with strict months/values instead of Number('')=0 or silent duplicate summation. */
export function normalizeProductHistory(raw:unknown,referenceMonth:string):ProductHistoryPoint[]{
 const payload=MarketInputRecordSchema.shape.data.parse(raw),envelope=obj(payload);
 const value=typeof payload==='string'||Array.isArray(payload)?payload:envelope.data??envelope.content;
 if(typeof value!=='string'&&!Array.isArray(value))throw new TypeError('Unsupported product history payload');
 const parts=typeof value==='string'?(value.trim()?value.split(','):[]):value;
 if(parts.length>2000)throw new TypeError('History point limit exceeded');
 const points=new Map<string,ProductHistoryPoint>();
 for(const part of parts){
  if(typeof part!=='string')throw new TypeError('Unsupported history row');
  const match=/^\s*(20\d{2})(?:年|-)(0[1-9]|1[0-2])月?\s*=\s*(.*?)\s*$/.exec(part);
  if(!match)throw new TypeError('Invalid history month');
  const month=`${match[1]}-${match[2]}`,v=match[3];
  if(month>referenceMonth||index(month)<index(referenceMonth)-119)continue;
  const n=/^\d+(?:\.0+)?$/.test(v)?Number(v):NaN;
  const point:ProductHistoryPoint={month,units:Number.isSafeInteger(n)?n:null,issues:Number.isSafeInteger(n)?[]:['invalid-value']};
  const prior=points.get(month);
  if(prior&&(prior.units!==point.units||prior.issues.length||point.issues.length))points.set(month,{month,units:null,issues:['conflicting-month']});
  else points.set(month,point);
 }
 return z.array(ProductHistoryPointSchema).max(120).parse([...points.values()].sort((a,b)=>a.month.localeCompare(b.month)));
}

export function productHistoryPeriods(points:ProductHistoryPoint[],referenceMonth:string){
 const end=index(referenceMonth),year=Number(referenceMonth.slice(0,4)),map=new Map(points.map(p=>[p.month,p.units]));
 return [{id:'last-3',start:end-2,end},{id:'last-6',start:end-5,end},...[year-1,year-2].map(y=>({id:`year-${y}`,start:y*12,end:y*12+11}))].map(p=>{
  const months=Array.from({length:p.end-p.start+1},(_,i)=>format(p.start+i));
  const missingMonths=months.filter(m=>map.get(m)==null);
  const total=missingMonths.length?null:months.reduce((n,m)=>n+map.get(m)!,0);
  return {id:p.id,fromMonth:format(p.start),toMonth:format(p.end),units:total!==null&&Number.isSafeInteger(total)?total:null,missingMonths};
 });
}

type Input={scope:MarketAnalysisScope;asin:string;jobId:string;connector:RemoteMcpConnector;signal?:AbortSignal;now?:()=>Date;timeoutMs?:number};
type Result={status:'ready'|'partial'|'empty';asin:string;points:ProductHistoryPoint[];evidence:MarketSourceEvidence}|{status:'failed';failure:{code:string;retryable:boolean}};
export async function collectMarketProductHistory(input:Input):Promise<Result>{
 const scope=MarketAnalysisScopeSchema.parse(input.scope),asin=MarketSourceIdentityValueSchemas.asin.parse(input.asin),now=input.now??(()=>new Date());
 if(input.connector.id!=='sorftime'||scope.toMonth>=now().toISOString().slice(0,7))return {status:'failed',failure:{code:'configuration',retryable:false}};
 let response;
 try{
  response=await executeOnce(input.connector,{operation:'product_trend',input:{asin,amz_site:sorftimeMarketSite(scope.marketplace),product_trend_type:'SalesVolume'},governorScope:{organizationId:scope.organizationId,jobId:input.jobId}},input.timeoutMs??60000,input.signal);
 }catch(error){return {status:'failed',failure:{code:error instanceof ConnectorError||error instanceof DeadlineError?error.code:'upstream-temporary',retryable:error instanceof ConnectorError?error.retryable:error instanceof DeadlineError?error.code==='timeout':true}}}
 try{
  const timestamp=z.object({connectorId:z.literal('sorftime'),operation:z.literal('product_trend'),fetchedAt:z.string().datetime(),attemptCount:z.number().int().positive()}).parse(response.source).fetchedAt;
  const payload=MarketInputRecordSchema.shape.data.parse(response.data),envelope=obj(payload);
  // Error envelopes cannot masquerade as an empty history.
  if(envelope.error||envelope.success===false||envelope.code!==undefined&&!['OK',200,'200',0,'0'].includes(envelope.code as string|number))throw new TypeError('Upstream error envelope');
  const points=normalizeProductHistory(payload,scope.toMonth);
  const paths:Record<string,MarketSourcePayloadPath[]>={asin:[['asin']],marketplace:[['amz_site']]};
  for(const [field,aliases] of Object.entries({asin:['asin','ASIN'],marketplace:['amz_site','site','marketplace']})){
   const found=aliases.filter(key=>Object.hasOwn(envelope,key)).map(key=>[key]);if(found.length)paths[field]=found;
  }
  const evidence=createMarketSourceEvidence({scope,provider:'sorftime',operation:'product_trend',requestIdentity:{asin,marketplace:scope.marketplace},responseIdentityPaths:paths,payload,fetchedAt:timestamp,
   observationPeriod:points.length?{kind:'calendar-months',fromMonth:points[0].month,toMonth:points.at(-1)!.month}:{kind:'unknown',reason:'No completed historical months returned'},
   units:{units:{status:'known',unit:'count',rawUnit:'product_trend SalesVolume'}},coverage:{receivedCount:points.length,expectedCount:null,truncation:{status:'unknown',reason:'Supplier historical coverage varies by ASIN; missing calendar months remain unknown'}}},now());
  return {status:points.length?points.some(p=>p.units===null)?'partial':'ready':'empty',asin,points,evidence};
 }catch{return {status:'failed',failure:{code:'invalid-data',retryable:false}}}
}
