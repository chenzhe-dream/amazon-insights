import {z} from 'zod';
import {MarketAnalysisScopeSchema,MarketInputRecordSchema,type MarketAnalysisScope} from '../../shared/market-analysis-contracts';
import {MarketSourceIdentityValueSchemas,type MarketSourceEvidence,type MarketSourcePayloadPath} from '../../shared/market-source-contracts';
import {ProductHistoryPointSchema,ProductAmountHistoryPointSchema,type ProductHistoryPoint,type ProductAmountHistoryPoint} from '../../shared/market-product-history-contracts';
import {sorftimeMarketSite} from '../../shared/market-sites';
import {ConnectorError,type RemoteMcpConnector} from '../connectors/connector-contract';
import {createMarketSourceEvidence} from '../domain/market-research/source-evidence';
import {DeadlineError,executeOnce} from './market-keyword-collector';

const obj=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
const index=(s:string)=>Number(s.slice(0,4))*12+Number(s.slice(5))-1;
const format=(n:number)=>`${Math.floor(n/12)}-${String(n%12+1).padStart(2,'0')}`;
function historyValue(payload:unknown,metric:'SalesVolume'|'SalesAmount'){
 const envelope=obj(payload),data=obj(envelope.data);
 if(Object.hasOwn(data,'type')){
  if(data.type!==metric||!Array.isArray(data.data)||data.data.length%2||data.data.length>4000)throw new TypeError('Invalid monthly product trend');
  const rows:string[]=[];
  for(let i=0;i<data.data.length;i+=2){
   const month=String(data.data[i]),value=data.data[i+1];
   if(!/^20\d{2}(0[1-9]|1[0-2])$/.test(month)||value!==null&&typeof value!=='number'&&typeof value!=='string')throw new TypeError('Invalid monthly product trend row');
   rows.push(`${month.slice(0,4)}-${month.slice(4)}=${value??''}`);
  }
  return rows;
 }
 return typeof payload==='string'||Array.isArray(payload)?payload:envelope.data??envelope.content;
}

/** Original provider format, with strict months/values instead of Number('')=0 or silent duplicate summation. */
export function normalizeProductHistory(raw:unknown,referenceMonth:string):ProductHistoryPoint[]{
 const payload=MarketInputRecordSchema.shape.data.parse(raw),envelope=obj(payload);
 const value=historyValue(payload,'SalesVolume');
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

/** Monetary history accepts finite decimal values but never invents values for malformed rows. */
export function normalizeProductAmountHistory(raw:unknown,referenceMonth:string):ProductAmountHistoryPoint[]{
 const payload=MarketInputRecordSchema.shape.data.parse(raw),envelope=obj(payload);
 const value=historyValue(payload,'SalesAmount');
 if(typeof value!=='string'&&!Array.isArray(value))throw new TypeError('Unsupported product amount history payload');
 const parts=typeof value==='string'?(value.trim()?value.split(','):[]):value;
 if(parts.length>2000)throw new TypeError('History point limit exceeded');
 const points=new Map<string,ProductAmountHistoryPoint>();
 for(const part of parts){
  if(typeof part!=='string')throw new TypeError('Unsupported history row');
  const match=/^\s*(20\d{2})(?:年|-)(0[1-9]|1[0-2])月?\s*=\s*(.*?)\s*$/.exec(part);
  if(!match)throw new TypeError('Invalid history month');
  const month=`${match[1]}-${match[2]}`,v=match[3];
  if(month>referenceMonth||index(month)<index(referenceMonth)-119)continue;
  const n=/^\d+(?:\.\d+)?$/.test(v)?Number(v):NaN;
  const valid=Number.isFinite(n)&&n>=0&&n<=Number.MAX_SAFE_INTEGER;
  const point:ProductAmountHistoryPoint={month,amount:valid?n:null,issues:valid?[]:['invalid-value']};
  const prior=points.get(month);
  if(prior&&(prior.amount!==point.amount||prior.issues.length||point.issues.length))points.set(month,{month,amount:null,issues:['conflicting-month']});
  else points.set(month,point);
 }
 return z.array(ProductAmountHistoryPointSchema).max(120).parse([...points.values()].sort((a,b)=>a.month.localeCompare(b.month)));
}

/** Reference dashboard periods select actual returned months, including unavailable values. */
export function referenceProductHistoryPeriods(points:readonly (ProductHistoryPoint|ProductAmountHistoryPoint)[],referenceMonth:string){
 const year=Number(referenceMonth.slice(0,4));
 const sorted=[...points].filter(p=>p.month<=referenceMonth).sort((a,b)=>a.month.localeCompare(b.month));
 const groups=[{id:'last-3',items:sorted.slice(-3)},{id:'last-6',items:sorted.slice(-6)},
  ...[year-1,year-2].map(y=>({id:`year-${y}`,items:sorted.filter(p=>p.month.startsWith(`${y}-`))}))];
 return groups.map(({id,items})=>{
  const months=items.map(p=>p.month),missingMonths=items.filter(p=>('amount'in p?p.amount:p.units)===null).map(p=>p.month);
  const values=items.map(p=>'amount'in p?p.amount:p.units);
  const sum=values.reduce<number>((total,value)=>total+(value??0),0);
  const fallback=id.startsWith('year-')?`${id.slice(5)}-01`:referenceMonth;
  return {id,fromMonth:months[0]??fallback,toMonth:months.at(-1)??(id.startsWith('year-')?`${id.slice(5)}-12`:referenceMonth),months,
   value:items.length&&missingMonths.length===0&&Number.isFinite(sum)&&sum<=Number.MAX_SAFE_INTEGER?sum:null,missingMonths};
 });
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

type Input={scope:MarketAnalysisScope;asin:string;jobId:string;connector:RemoteMcpConnector;signal?:AbortSignal;now?:()=>Date;timeoutMs?:number;metric?:'SalesVolume'|'SalesAmount'};
type Failure={status:'failed';failure:{code:string;retryable:boolean}};
type VolumeResult={status:'ready'|'partial'|'empty';asin:string;points:ProductHistoryPoint[];evidence:MarketSourceEvidence}|Failure;
type AmountResult={status:'ready'|'partial'|'empty';asin:string;points:ProductAmountHistoryPoint[];evidence:MarketSourceEvidence}|Failure;
export function collectMarketProductHistory(input:Input&{metric:'SalesAmount'}):Promise<AmountResult>;
export function collectMarketProductHistory(input:Input&{metric?:'SalesVolume'}):Promise<VolumeResult>;
export function collectMarketProductHistory(input:Input):Promise<VolumeResult|AmountResult>;
export async function collectMarketProductHistory(input:Input):Promise<VolumeResult|AmountResult>{
 const scope=MarketAnalysisScopeSchema.parse(input.scope),asin=MarketSourceIdentityValueSchemas.asin.parse(input.asin),now=input.now??(()=>new Date());
 const metric=input.metric??'SalesVolume';
 if(input.connector.id!=='sorftime'||scope.toMonth>=now().toISOString().slice(0,7))return {status:'failed',failure:{code:'configuration',retryable:false}};
 let response;
 try{
  response=await executeOnce(input.connector,{operation:'product_trend',input:{asin,amz_site:sorftimeMarketSite(scope.marketplace),type:metric},governorScope:{organizationId:scope.organizationId,jobId:input.jobId}},input.timeoutMs??60000,input.signal);
 }catch(error){return {status:'failed',failure:{code:error instanceof ConnectorError||error instanceof DeadlineError?error.code:'upstream-temporary',retryable:error instanceof ConnectorError?error.retryable:error instanceof DeadlineError?error.code==='timeout':true}}}
 try{
  const timestamp=z.object({connectorId:z.literal('sorftime'),operation:z.literal('product_trend'),fetchedAt:z.string().datetime(),attemptCount:z.number().int().positive()}).parse(response.source).fetchedAt;
  const payload=MarketInputRecordSchema.shape.data.parse(response.data),envelope=obj(payload);
  // Error envelopes cannot masquerade as an empty history.
  if(envelope.error||envelope.success===false||envelope.code!==undefined&&!['OK',200,'200',0,'0'].includes(envelope.code as string|number))throw new TypeError('Upstream error envelope');
  const modern=obj(envelope.data);
  if(Object.hasOwn(modern,'type')&&(modern.asin!==asin||modern.type!==metric||metric==='SalesAmount'&&scope.currency!=='USD'))throw new TypeError('Product trend identity, dimension or currency differs');
  const points=metric==='SalesAmount'?normalizeProductAmountHistory(payload,scope.toMonth):normalizeProductHistory(payload,scope.toMonth);
  const paths:Record<string,MarketSourcePayloadPath[]>={asin:[['asin']],marketplace:[['amz_site']]};
  for(const [field,aliases] of Object.entries(metric==='SalesAmount'?{asin:['asin','ASIN'],marketplace:['amz_site','site','marketplace'],currency:['currency','currency_code','currencyCode']}:{asin:['asin','ASIN'],marketplace:['amz_site','site','marketplace']})){
   const found=aliases.filter(key=>Object.hasOwn(envelope,key)).map(key=>[key]);if(found.length)paths[field]=found;
  }
  if(Object.hasOwn(modern,'type')){
   paths.asin=[...(paths.asin??[]),['data','asin']];
   for(const [field,aliases] of Object.entries({marketplace:['amz_site','site','marketplace'],currency:['currency','currency_code','currencyCode']})){
    const nested=aliases.filter(key=>Object.hasOwn(modern,key)).map(key=>['data',key]);
    if(nested.length)paths[field]=[...(paths[field]??[]),...nested];
   }
  }
  const evidence=createMarketSourceEvidence({scope,provider:'sorftime',operation:'product_trend',requestIdentity:{asin,marketplace:scope.marketplace},responseIdentityPaths:paths,payload,fetchedAt:timestamp,
   observationPeriod:points.length?{kind:'calendar-months',fromMonth:points[0].month,toMonth:points.at(-1)!.month}:{kind:'unknown',reason:'No completed historical months returned'},
   units:metric==='SalesAmount'?{amount:{status:'known',unit:'currency',currency:scope.currency,rawUnit:'product_trend SalesAmount'}}:{units:{status:'known',unit:'count',rawUnit:'product_trend SalesVolume'}},coverage:{receivedCount:points.length,expectedCount:null,truncation:{status:'unknown',reason:'Supplier historical coverage varies by ASIN; missing calendar months remain unknown'}}},now());
  if(metric==='SalesAmount')return {status:points.length?points.some(p=>('amount'in p)&&p.amount===null)?'partial':'ready':'empty',asin,points:points as ProductAmountHistoryPoint[],evidence};
  return {status:points.length?points.some(p=>('units'in p)&&p.units===null)?'partial':'ready':'empty',asin,points:points as ProductHistoryPoint[],evidence};
 }catch{return {status:'failed',failure:{code:'invalid-data',retryable:false}}}
}
