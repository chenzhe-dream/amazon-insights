import { z } from 'zod';
import { performance } from 'node:perf_hooks';
import { MarketAnalysisScopeSchema, MarketInputRecordSchema, type MarketAnalysisScope, type MarketJsonValue } from '../../shared/market-analysis-contracts';
import { MARKET_SOURCE_IDENTITY_FIELDS, MarketSourceIdentityValueSchemas, type MarketSourceEvidence, type MarketSourceIdentityField, type MarketSourcePayloadPath } from '../../shared/market-source-contracts';
import { ConnectorError, type ConnectorErrorCode, type ConnectorRequest, type ConnectorResult, type RemoteMcpConnector } from '../connectors/connector-contract';
import { createMarketSourceEvidence } from '../domain/market-research/source-evidence';

type IssueCode=ConnectorErrorCode|'scope-mismatch'|'empty'|'missing-member'|'missing-metric'|'invalid-metric'|'interrupted'|'local-admission';
export interface MarketProductPoolIssue { code:IssueCode; message:string; retryable:boolean; asin?:string; field?:string }
export interface MarketPoolProduct {
  asin:string; sourceIndex:number; title:string|null; brand:string|null; price:number|null;
  units:number|null; revenue:number|null; sourceRank:number|null; rating:number|null;
  ratingCount:number|null; sellerName:string|null; sellerType:string|null; listedAt:string|null;
}
export interface MarketProductPoolCollection {
  status:'ready'|'partial'|'empty'|'failed'; scope:MarketAnalysisScope; month:string;
  products:MarketPoolProduct[]; evidence:MarketSourceEvidence|null;
  /** Internal diagnostic input; publish only validated report fields through HTTP. */
  rawPayload:MarketJsonValue|null;
  issues:MarketProductPoolIssue[];
  sampling:{requestedSize:number;receivedSize:number;selectedSize:number;rankBasis:'provider-head-listings'|'fixed-selected-members';selectedAsins:string[]|null;missingAsins:string[];bsrTopVerified:false;exhaustive:false};
  boundaries:string[];
}
export interface CollectMarketProductPoolInput {
  scope:MarketAnalysisScope; month:string; poolSize:number; newProductMonths:number;
  selectedAsins?:string[];
  jobId:string; connector:RemoteMcpConnector; signal?:AbortSignal; now?:()=>Date; timeoutMs?:number;
}
const argumentsSchema=z.object({
  scope:MarketAnalysisScopeSchema,month:z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/),
  poolSize:z.number().int().min(1).max(100),
  selectedAsins:z.array(MarketSourceIdentityValueSchemas.asin).min(1).max(100).optional(),
  newProductMonths:z.union([z.literal(1),z.literal(3),z.literal(6),z.literal(12)]),
  jobId:z.string().trim().min(1).max(160),timeoutMs:z.number().int().min(1).max(120_000),
}).strict().superRefine((value,context)=>{
  if(value.selectedAsins&&(new Set(value.selectedAsins).size!==value.selectedAsins.length||value.selectedAsins.length!==value.poolSize)) {
    context.addIssue({code:'custom',path:['selectedAsins'],message:'Selected ASINs must be unique and match the requested pool size'});
  }
});
// Provider topN controls upstream analysis, not necessarily its response row count.
const MAX_PROVIDER_PRODUCT_ROWS=1000;
const messages:Record<IssueCode,string>={
  configuration:'商品池数据源未配置',authentication:'商品池数据源认证失败','rate-limit':'商品池数据源限流',
  timeout:'商品池采集超时','upstream-temporary':'商品池数据源暂时不可用','upstream-permanent':'商品池数据源拒绝请求',
  'malformed-response':'商品池返回格式或成员身份无效','scope-mismatch':'商品池返回的站点、类目或月份不匹配',
  empty:'所选范围没有返回商品','missing-metric':'来源缺少该商品字段','invalid-metric':'来源商品字段无效',
  'missing-member':'来源未返回该月份的固定商品，销量保持未知',
  interrupted:'商品池采集已中断','local-admission':'本地请求容量暂不可用',
};
function issue(code:IssueCode,retryable=false):MarketProductPoolIssue{return {code,message:messages[code],retryable};}
class CollectionFailure extends Error {constructor(readonly code:IssueCode){super(messages[code]);}}
function record(value:unknown):value is Record<string,unknown>{return value!==null&&typeof value==='object'&&!Array.isArray(value);}
function own(value:unknown,key:string):unknown {
  if(!record(value))return undefined;
  const descriptor=Object.getOwnPropertyDescriptor(value,key);
  return descriptor&&'value' in descriptor?descriptor.value:undefined;
}
function optionalText(value:unknown):string|null{return typeof value==='string'&&value.trim()?value.trim():null;}
function numeric(value:unknown,integer=false,max=Number.MAX_SAFE_INTEGER,min=0):number|null {
  if(typeof value!=='number'&&typeof value!=='string')return null;
  if(typeof value==='string') {
    const grammar=integer?/^(?:0|[1-9]\d*)(?:\.0+)?$/:/^(?:0|[1-9]\d*)(?:\.\d+)?$/;
    if(!grammar.test(value.trim()))return null;
    const [whole,fraction='']=value.trim().split('.');
    const ceiling=String(max);
    if(whole.length>ceiling.length||(whole.length===ceiling.length&&(whole>ceiling||(whole===ceiling&&/[1-9]/.test(fraction)))))return null;
  }
  const parsed=Number(value);
  if(typeof value==='string'&&parsed===0&&/[1-9]/.test(value))return null;
  return Number.isFinite(parsed)&&parsed>=min&&parsed<=max&&(!integer||Number.isSafeInteger(parsed))?parsed:null;
}
async function executeBeforeDeadline(connector:RemoteMcpConnector,request:ConnectorRequest,signal:AbortSignal):Promise<ConnectorResult> {
  signal.throwIfAborted();
  let abort:()=>void=()=>{};
  const stopped=new Promise<never>((_resolve,reject)=>{abort=()=>reject(signal.reason);});
  signal.addEventListener('abort',abort,{once:true});
  try { return await Promise.race([connector.execute({...request,signal}),stopped]); }
  finally { signal.removeEventListener('abort',abort); }
}
function classify(error:unknown,signal:AbortSignal,external?:AbortSignal):MarketProductPoolIssue {
  if(external?.aborted)return issue('interrupted',true);
  if(signal.aborted)return issue('timeout',true);
  if(error instanceof CollectionFailure)return issue(error.code);
  if(error instanceof ConnectorError)return issue(error.code,error.retryable);
  if(error instanceof Error&&error.name==='ResourceGovernorAdmissionError')return issue('local-admission',true);
  return issue('malformed-response');
}
const aliases:Partial<Record<MarketSourceIdentityField,readonly string[]>>={
  marketplace:['marketplace','site','amz_site'],nodeId:['nodeId','node_id'],nodeIdPath:['nodeIdPath','node_id_path'],month:['month'],currency:['currency'],
};

/** One durable-step-sized request. The caller persists each month before requesting another. */
export async function collectMarketProductPool(input:CollectMarketProductPoolInput):Promise<MarketProductPoolCollection>{
  const options=argumentsSchema.parse({scope:input.scope,month:input.month,poolSize:input.poolSize,selectedAsins:input.selectedAsins,newProductMonths:input.newProductMonths,jobId:input.jobId,timeoutMs:input.timeoutMs??60_000});
  const selectedAsins=options.selectedAsins?[...options.selectedAsins].sort():null;
  const selectedSet=selectedAsins?new Set(selectedAsins):null;
  const startedAt=input.now?.()??new Date();
  if(!Number.isFinite(startedAt.getTime())||options.scope.toMonth>=startedAt.toISOString().slice(0,7)||options.month<options.scope.fromMonth||options.month>options.scope.toMonth)throw new TypeError('Choose a completed month within the research range');
  if(input.connector.id!=='sellerSprite')throw new TypeError('Monthly product pools require the configured SellerSprite connector');
  const deadline=new AbortController();
  const deadlineAt=performance.now()+options.timeoutMs;
  const timer=setTimeout(()=>deadline.abort(new Error('deadline')),options.timeoutMs);
  const signal=AbortSignal.any([...(input.signal?[input.signal]:[]),deadline.signal]);
  const base:MarketProductPoolCollection={status:'failed',scope:options.scope,month:options.month,products:[],evidence:null,rawPayload:null,issues:[],
    sampling:{requestedSize:options.poolSize,receivedSize:0,selectedSize:0,rankBasis:selectedAsins?'fixed-selected-members':'provider-head-listings',selectedAsins,missingAsins:selectedAsins?[...selectedAsins]:[],bsrTopVerified:false,exhaustive:false},
    boundaries:[
      selectedAsins?'商品池固定为所选 ASIN；当月未返回的成员保留缺口，不以其他商品替代或补零。':'商品池为来源接口返回的头部Listing样本，不代表全市场，也未验证为BSR前N。',
      '月销量按接口月份参数取得；返回缺少月份回显时保留未核验状态。',
      'price为来源行单价，尚未独立确认其历史时点或是否为当月平均成交价。',
      '金额和单价的币种回显缺失时保留单位待核验；不能据字段名直接换算。',
    ]};
  try {
    signal.throwIfAborted();
    const response=await executeBeforeDeadline(input.connector,{operation:'market_product_concentration',
      input:{request:{marketplace:options.scope.marketplace,nodeIdPath:options.scope.nodeIdPath,month:options.month.replace('-',''),topN:options.poolSize,newProduct:options.newProductMonths,...(selectedAsins?{asins:[...selectedAsins]}:{})}},
      governorScope:{organizationId:options.scope.organizationId,jobId:options.jobId}},signal);
    // Timers cannot interrupt synchronous connector work. Reject a late return
    // even if that work prevented the timer callback from running on time.
    if(performance.now()>=deadlineAt)deadline.abort(new Error('deadline'));
    signal.throwIfAborted();
    const guarded=MarketInputRecordSchema.shape.data.safeParse(own(response,'data'));
    if(!guarded.success)throw new CollectionFailure('malformed-response');
    const serialized=JSON.stringify(guarded.data);
    if(Buffer.byteLength(serialized,'utf8')>8_000_000)throw new CollectionFailure('malformed-response');
    base.rawPayload=JSON.parse(serialized) as MarketJsonValue;
    signal.throwIfAborted();
    const guardedSource=MarketInputRecordSchema.shape.data.safeParse(own(response,'source'));
    if(!guardedSource.success)throw new CollectionFailure('malformed-response');
    const source=z.object({connectorId:z.literal('sellerSprite'),operation:z.literal('market_product_concentration'),fetchedAt:z.string().datetime(),attemptCount:z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)}).parse(guardedSource.data);
    const envelope=base.rawPayload;
    if(!record(envelope)||typeof envelope.code!=='string')throw new CollectionFailure('malformed-response');
    if(envelope.code!=='OK')throw new CollectionFailure('upstream-permanent');
    const rows=envelope.data;
    if(!Array.isArray(rows)||rows.length>MAX_PROVIDER_PRODUCT_ROWS||rows.some(row=>!record(row)))throw new CollectionFailure('malformed-response');
    base.sampling.receivedSize=rows.length;
    const paths:Partial<Record<MarketSourceIdentityField,MarketSourcePayloadPath[]>>={};
    const expected={marketplace:options.scope.marketplace,nodeIdPath:options.scope.nodeIdPath,nodeId:options.scope.nodeIdPath.split(':').at(-1)!,month:options.month,currency:options.scope.currency};
    for(const [object,path] of [[envelope,[]],...rows.map((row,index)=>[row,['data',index]])] as Array<[Record<string,unknown>,MarketSourcePayloadPath]>) {
      for(const field of MARKET_SOURCE_IDENTITY_FIELDS) {
        for(const alias of aliases[field]??[]) {
          if(!Object.hasOwn(object,alias))continue;
          const checked=MarketSourceIdentityValueSchemas[field].safeParse(object[alias]);
          if(!checked.success||checked.data!==expected[field as keyof typeof expected])throw new CollectionFailure('scope-mismatch');
          (paths[field]??=[]).push([...path,alias]);
        }
      }
    }
    // A member-level echo establishes that member's unit only. A pool-wide unit
    // requires an envelope declaration or a declaration on every returned row.
    const sourceCurrency=Object.hasOwn(envelope,'currency')||(rows.length>0&&rows.every(row=>Object.hasOwn(row as object,'currency')))?options.scope.currency:null;
    const currencyUnit=sourceCurrency?{status:'known',unit:'currency',rawUnit:'currency',currency:sourceCurrency}
      :{status:'unknown',rawUnit:null,reason:'接口未回显金额币种；价格和金额原值保留，待单位核验'};
    const buildEvidence=()=>createMarketSourceEvidence({scope:options.scope,provider:'sellerSprite',operation:'market_product_concentration',
      requestIdentity:{marketplace:options.scope.marketplace,nodeIdPath:options.scope.nodeIdPath,month:options.month},responseIdentityPaths:paths,
      payload:base.rawPayload,fetchedAt:source.fetchedAt,observationPeriod:{kind:'calendar-months',fromMonth:options.month,toMonth:options.month},
      units:{units:{status:'known',unit:'count',rawUnit:'totalUnits'},price:currencyUnit,revenue:currencyUnit},
      coverage:{receivedCount:rows.length,expectedCount:selectedAsins&&[...identities].every(asin=>selectedSet!.has(asin))?selectedAsins.length:null,truncation:{status:'unknown',reason:selectedAsins?'来源返回量与固定成员命中数分别记录；额外商品不纳入样本，缺失成员的当月数据未知':'接口返回样本按来源顺序截取到请求数量，未证明全类目覆盖'}}},input.now?.()??new Date());
    const identities=new Set<string>();
    const products:MarketPoolProduct[]=[];
    const issues:MarketProductPoolIssue[]=[];
    for(const [sourceIndex,value] of rows.entries()) {
      const row=value as Record<string,unknown>;
      const asin=MarketSourceIdentityValueSchemas.asin.safeParse(row.asin);
      if(!asin.success||identities.has(asin.data))throw new CollectionFailure('malformed-response');
      identities.add(asin.data);
      // Validate every identity above, even for rows excluded from local selection.
      if(selectedSet?!selectedSet.has(asin.data):products.length>=options.poolSize)continue;
      const metric=(field:string,integer=false,max?:number,min=0):number|null=>{
        const result=numeric(row[field],integer,max,min);
        if(result===null)issues.push({...issue(row[field]===null||row[field]===undefined?'missing-metric':'invalid-metric'),asin:asin.data,field});
        return result;
      };
      const title=optionalText(row.title);
      if(!title)issues.push({...issue('missing-metric'),asin:asin.data,field:'title'});
      const listedAt=typeof row.shelfDate==='string'&&z.string().date().safeParse(row.shelfDate).success?row.shelfDate:null;
      products.push({asin:asin.data,sourceIndex,title,brand:optionalText(row.brand),price:metric('price'),units:metric('totalUnits',true),revenue:metric('totalRevenue'),sourceRank:metric('ranking',true,undefined,1),rating:metric('rating',false,5),ratingCount:metric('ratings',true),sellerName:optionalText(row.sellerName),sellerType:optionalText(row.sellerType),listedAt});
    }
    const missingAsins=selectedAsins?.filter(asin=>!identities.has(asin))??[];
    for(const asin of missingAsins)issues.push({...issue('missing-member'),asin});
    if(!products.length)issues.unshift(issue('empty'));
    return {...base,sampling:{...base.sampling,selectedSize:products.length,missingAsins},products,evidence:buildEvidence(),issues,status:!products.length?'empty':issues.length?'partial':'ready'};
  } catch(error){
    if(performance.now()>=deadlineAt)deadline.abort(new Error('deadline'));
    return {...base,issues:[classify(error,signal,input.signal)]};
  }
  finally { clearTimeout(timer); }
}
