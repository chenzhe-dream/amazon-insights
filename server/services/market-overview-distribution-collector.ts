import {z} from 'zod';
import {performance} from 'node:perf_hooks';
import {MarketAnalysisScopeSchema,MarketInputRecordSchema,type MarketAnalysisScope} from '../../shared/market-analysis-contracts';
import {MARKET_OVERVIEW_DISTRIBUTION_OPERATIONS,MARKET_OVERVIEW_PRODUCT_OPERATION,type MarketOverviewDistribution} from '../../shared/market-overview-distribution-contracts';
import {MarketSourceIdentityValueSchemas,type MarketSourceEvidence,type MarketSourcePayloadPath,type MarketSourceUnit} from '../../shared/market-source-contracts';
import {ConnectorError,type RemoteMcpConnector} from '../connectors/connector-contract';
import {ResourceGovernorAdmissionError} from '../db/concurrency-control-repository';
import {createMarketSourceEvidence} from '../domain/market-research/source-evidence';
import {normalizeMarketOverviewDistribution} from '../domain/market-research/overview-distributions';

export const MarketOverviewDistributionStepInputSchema=z.object({month:z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/),
  operation:z.enum([...MARKET_OVERVIEW_DISTRIBUTION_OPERATIONS,MARKET_OVERVIEW_PRODUCT_OPERATION,'market_product_demand_trend']),
  headTopN:z.union([z.literal(5),z.literal(10),z.literal(20)]),newProductMonths:z.union([z.literal(1),z.literal(3),z.literal(6),z.literal(12)]),
}).strict();
type Params=z.infer<typeof MarketOverviewDistributionStepInputSchema>;
type Issue={code:string;retryable:boolean};
export type MarketOverviewDistributionCollection={status:'ready'|'partial'|'empty'|'failed';month:string;operation:Params['operation'];parameters:{headTopN:Params['headTopN'];newProductMonths:Params['newProductMonths']};evidence:MarketSourceEvidence|null;distribution:MarketOverviewDistribution|null;issues:Issue[]};
const obj=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
class SourceFailure extends Error{constructor(readonly code:string){super(code);}}

export async function collectMarketOverviewDistribution(input:Params&{originalDemand?:boolean;scope:MarketAnalysisScope;jobId:string;connector:RemoteMcpConnector;signal?:AbortSignal;timeoutMs?:number;now?:()=>Date}):Promise<MarketOverviewDistributionCollection>{
  const scope=MarketAnalysisScopeSchema.parse(input.scope),{month,operation,headTopN,newProductMonths}=MarketOverviewDistributionStepInputSchema.parse({month:input.month,operation:input.operation,headTopN:input.headTopN,newProductMonths:input.newProductMonths});
  const now=input.now??(()=>new Date()),started=now(),deadline=performance.now()+(input.timeoutMs??45000);
  if(month<scope.fromMonth||month>scope.toMonth||month>=started.toISOString().slice(0,7))throw new TypeError('Distribution requires a complete month within study scope');
  const base:MarketOverviewDistributionCollection={status:'failed',month,operation,parameters:{headTopN,newProductMonths},evidence:null,distribution:null,issues:[]};
  const controller=new AbortController(),signal=AbortSignal.any([controller.signal,...(input.signal?[input.signal]:[])]),timer=setTimeout(()=>controller.abort(),Math.max(0,deadline-performance.now()));timer.unref();
  const check=()=>{if(performance.now()>=deadline)controller.abort();signal.throwIfAborted();};
  try{
    check();const request=input.connector.execute({operation,input:{request:{marketplace:scope.marketplace,nodeIdPath:scope.nodeIdPath,month:month.replaceAll('-',''),...(input.originalDemand&&operation==='market_product_demand_trend'?{topN:100}:{newProduct:newProductMonths,topN:headTopN})}},signal,governorScope:{organizationId:scope.organizationId,jobId:input.jobId}});
    let abortListener:()=>void=()=>{};
    const response=await Promise.race([request,new Promise<never>((_,reject)=>{abortListener=()=>reject(new SourceFailure(input.signal?.aborted?'interrupted':'timeout'));signal.addEventListener('abort',abortListener,{once:true});if(signal.aborted)abortListener();})]).finally(()=>signal.removeEventListener('abort',abortListener));check();
    const metadata=z.object({connectorId:z.literal('sellerSprite'),operation:z.literal(operation),fetchedAt:z.string().datetime(),attemptCount:z.number().int().positive()}).passthrough().safeParse(response.source);
    if(!metadata.success)throw new SourceFailure('source-mismatch');
    const projected=projectMarketOverviewDistribution({scope,month,operation,headTopN,newProductMonths,payload:response.data,fetchedAt:metadata.data.fetchedAt,now:now()});check();return projected;
  }catch(error){
    if(performance.now()>=deadline)controller.abort();const failure:Issue=input.signal?.aborted?{code:'interrupted',retryable:false}:controller.signal.aborted?{code:'timeout',retryable:true}:error instanceof ConnectorError?{code:error.code,retryable:error.retryable}:error instanceof ResourceGovernorAdmissionError?{code:'local-admission',retryable:true}:{code:error instanceof SourceFailure?error.code:'malformed-response',retryable:false};
    return {...base,issues:[failure]};
  }finally{clearTimeout(timer);}
}

/** Replays the same source normalization without a connector or a network call. */
export function projectMarketOverviewDistribution(input:Params&{scope:MarketAnalysisScope;payload:unknown;fetchedAt:string;now?:Date}):MarketOverviewDistributionCollection{
  const scope=MarketAnalysisScopeSchema.parse(input.scope),{month,operation,headTopN,newProductMonths}=MarketOverviewDistributionStepInputSchema.parse({month:input.month,operation:input.operation,headTopN:input.headTopN,newProductMonths:input.newProductMonths});
  if(month<scope.fromMonth||month>scope.toMonth||month>=(input.now??new Date()).toISOString().slice(0,7))throw new TypeError("Distribution requires a complete study month");
  const base:MarketOverviewDistributionCollection={status:"failed",month,operation,parameters:{headTopN,newProductMonths},evidence:null,distribution:null,issues:[]};
    const payload=MarketInputRecordSchema.shape.data.parse(input.payload),envelope=obj(payload);
    if(envelope.isError===true||envelope.code!==undefined&&envelope.code!=='OK')throw new SourceFailure('upstream-permanent');
    const data=envelope.data,rows=Array.isArray(data)?data:[],demand=operation==='market_product_demand_trend';
    if(demand?Array.isArray(data)||!Array.isArray(obj(data).items):!Array.isArray(data))throw new SourceFailure('malformed-response');
    const paths:Record<string,MarketSourcePayloadPath[]>={},expected={marketplace:scope.marketplace,nodeIdPath:scope.nodeIdPath,nodeId:scope.nodeIdPath.split(':').at(-1),month,currency:scope.currency};
    const locations:Array<[Record<string,unknown>,MarketSourcePayloadPath]>=[[envelope,[]],...(demand?[[obj(data),['data']] as [Record<string,unknown>,MarketSourcePayloadPath]]:rows.map((row,i)=>[obj(row),['data',i]] as [Record<string,unknown>,MarketSourcePayloadPath]))];
    for(const [record,path] of locations)for(const field of ['marketplace','nodeIdPath','nodeId','month','currency'] as const){
      if(!Object.hasOwn(record,field))continue;const echoed=MarketSourceIdentityValueSchemas[field].safeParse(record[field]);
      if(!echoed.success||echoed.data!==expected[field])throw new SourceFailure('scope-mismatch');(paths[field]??=[]).push([...path,field]);
    }
    // No response echoes are synthesized from the request. Currency must be
    // declared for the whole response or every row that reports money.
    const moneyRows=rows.map(obj).filter(r=>r.revenue!==undefined||r.totalRevenue!==undefined);
    const currencyKnown=envelope.currency===scope.currency||demand&&obj(data).currency===scope.currency||moneyRows.length>0&&moneyRows.every(r=>r.currency===scope.currency);
    const fields=[...new Set((demand?[obj(data),...(obj(data).items as unknown[]).map(obj)]:rows.map(obj)).flatMap(r=>Object.keys(r)))];
    const units:Record<string,MarketSourceUnit>={};
    for(const field of fields){
      if(field.endsWith('Ratio'))units[field]={status:'unknown',rawUnit:field,reason:'供应商未声明此字段使用比例原值或百分数'};
      else if(['revenue','totalRevenue','newRevenue','avgPrice'].includes(field))units[field]=currencyKnown?{status:'known',unit:'currency',rawUnit:field,currency:scope.currency}:{status:'unknown',rawUnit:field,reason:'响应未确认金额币种'};
      else if(['products','asinNum','productNum','units','totalUnits','newProducts','newUnits','ratings','reviews','asinCount'].includes(field))units[field]={status:'known',unit:'count',rawUnit:field};
    }
    let distribution:MarketOverviewDistribution|null=null,empty=false;const issues:Issue[]=[];
    if(demand){const d=obj(data);empty=(d.items as unknown[]).length===0&&Object.entries(d).filter(([key])=>!['items','marketplace','nodeIdPath','nodeId','month','currency'].includes(key)).every(([,v])=>v===null||v===undefined);
      if(!empty)issues.push({code:'demand-series-not-normalized',retryable:false});
    }else{distribution=normalizeMarketOverviewDistribution(operation,payload,currencyKnown?{currency:scope.currency}:{});empty=distribution.status==='empty';issues.push(...distribution.issues.map(code=>({code,retryable:false})));}
    const evidence=createMarketSourceEvidence({scope,provider:'sellerSprite',operation,requestIdentity:{marketplace:scope.marketplace,nodeIdPath:scope.nodeIdPath,month},responseIdentityPaths:paths,payload,
      fetchedAt:input.fetchedAt,observationPeriod:{kind:'calendar-months',fromMonth:month,toMonth:month},units,
      coverage:{receivedCount:demand?(obj(data).items as unknown[]).length:rows.length,expectedCount:null,truncation:{status:'unknown',reason:'来源返回分组，未证明覆盖整个类目'}}},input.now??new Date());
    if(evidence.responseIdentity.nodeIdPath.status!=='verified'||evidence.responseIdentity.month.status!=='verified')issues.push({code:'identity-request-bound',retryable:false});
    return {...base,status:empty?'empty':issues.length?'partial':'ready',evidence,distribution,issues};
}
