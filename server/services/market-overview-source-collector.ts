import {z} from 'zod';
import {performance} from 'node:perf_hooks';
import {MarketAnalysisScopeSchema,MarketInputRecordSchema,type MarketAnalysisScope} from '../../shared/market-analysis-contracts';
import {MarketSourceIdentityValueSchemas,type MarketSourceEvidence,type MarketSourcePayloadPath,type MarketSourceUnit} from '../../shared/market-source-contracts';
import {ConnectorError,type RemoteMcpConnector} from '../connectors/connector-contract';
import {ResourceGovernorAdmissionError} from '../db/concurrency-control-repository';
import {createMarketSourceEvidence} from '../domain/market-research/source-evidence';
import {marketOverviewSourceFields} from '../domain/market-research/overview-source-catalog';

export const MarketOverviewSourceStepInputSchema=z.object({month:z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/),operation:z.enum(['market_research','market_research_statistics']),
  headTopN:z.union([z.literal(5),z.literal(10),z.literal(20)]),newProductMonths:z.union([z.literal(1),z.literal(3),z.literal(6),z.literal(12)])}).strict();
type Params=z.infer<typeof MarketOverviewSourceStepInputSchema>;
type Issue={code:string;retryable:boolean};
export type MarketOverviewSourceCollection={status:'ready'|'partial'|'empty'|'failed';month:string;operation:Params['operation'];parameters:{headTopN:Params['headTopN'];newProductMonths:Params['newProductMonths']};evidence:MarketSourceEvidence|null;issues:Issue[]};
const object=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
class SourceFailure extends Error{constructor(readonly code:string){super(code);}}
export async function collectMarketOverviewSource(input:Params&{scope:MarketAnalysisScope;jobId:string;connector:RemoteMcpConnector;signal?:AbortSignal;timeoutMs?:number;now?:()=>Date}):Promise<MarketOverviewSourceCollection>{
  const {month,operation,headTopN,newProductMonths}=MarketOverviewSourceStepInputSchema.parse({month:input.month,operation:input.operation,headTopN:input.headTopN,newProductMonths:input.newProductMonths}),scope=MarketAnalysisScopeSchema.parse(input.scope);
  const jobId=z.string().trim().min(1).max(160).parse(input.jobId),timeout=z.number().int().min(1).max(120000).parse(input.timeoutMs??60000),now=input.now??(()=>new Date());
  if(month<scope.fromMonth||month>scope.toMonth||month>=now().toISOString().slice(0,7))throw new TypeError('Overview source requires an in-scope complete month');
  const base:MarketOverviewSourceCollection={status:'failed',month,operation,parameters:{headTopN,newProductMonths},evidence:null,issues:[]};
  const controller=new AbortController(),signal=AbortSignal.any([controller.signal,...(input.signal?[input.signal]:[])]),deadline=performance.now()+timeout;
  const timer=setTimeout(()=>controller.abort(),timeout);timer.unref();
  const check=()=>{if(performance.now()>=deadline)controller.abort();signal.throwIfAborted();};
  try{
    check();if(input.connector.id!=='sellerSprite')throw new SourceFailure('source-mismatch');
    const request={marketplace:scope.marketplace,nodeIdPath:scope.nodeIdPath,month:month.replaceAll('-',''),newProduct:newProductMonths,
      ...(operation==='market_research'?{topNum:headTopN,page:1,size:10}:{topN:headTopN})};
    const response=await new Promise<Awaited<ReturnType<RemoteMcpConnector['execute']>>>((resolve,reject)=>{
      const abort=()=>reject(new SourceFailure(input.signal?.aborted?'interrupted':'timeout'));signal.addEventListener('abort',abort,{once:true});
      Promise.resolve().then(()=>{check();return input.connector.execute({operation,input:{request},governorScope:{organizationId:scope.organizationId,jobId},signal});})
        .then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
    });
    check();
    const payload=MarketInputRecordSchema.shape.data.parse(response.data),envelope=object(payload);
    const metadata=z.object({connectorId:z.literal('sellerSprite'),operation:z.literal(operation),fetchedAt:z.string().datetime(),attemptCount:z.number().int().positive()}).passthrough().safeParse(response.source);
    if(!metadata.success)throw new SourceFailure('source-mismatch');
    if(envelope.isError===true||(envelope.code!==undefined&&envelope.code!=='OK'))throw new SourceFailure('upstream-permanent');
    const data=object(envelope.data??envelope),dataPath:MarketSourcePayloadPath=Object.hasOwn(envelope,'data')?['data']:[];
    let row=data,rowPath=dataPath,empty=false;
    if(operation==='market_research'){
      if(!Array.isArray(data.items))throw new SourceFailure('malformed-response');
      const matches=data.items.map((v,index)=>({row:object(v),index})).filter(v=>v.row.nodeIdPath===scope.nodeIdPath||String(v.row.nodeId??'')===scope.nodeIdPath.split(':').at(-1));
      if(!data.items.length){row={};empty=true;}
      else{if(matches.length!==1)throw new SourceFailure('scope-mismatch');row=matches[0].row;rowPath=[...dataPath,'items',matches[0].index];}
    }else empty=Object.keys(data).length===0;
    const paths:Record<string,MarketSourcePayloadPath[]>={},expected={marketplace:scope.marketplace,nodeIdPath:scope.nodeIdPath,nodeId:scope.nodeIdPath.split(':').at(-1),month,currency:scope.currency};
    const visited=new Set<string>();
    for(const [record,path] of [[envelope,[]],[data,dataPath],[row,rowPath]] as Array<[Record<string,unknown>,MarketSourcePayloadPath]>){
      const location=JSON.stringify(path);if(visited.has(location))continue;visited.add(location);
      for(const field of ['marketplace','nodeIdPath','nodeId','month','currency'] as const){
        if(!Object.hasOwn(record,field))continue;const v=MarketSourceIdentityValueSchemas[field].safeParse(record[field]);
        if(!v.success||v.data!==expected[field])throw new SourceFailure('scope-mismatch');(paths[field]??=[]).push([...path,field]);
      }
    }
    const declaredFields=marketOverviewSourceFields({headTopN,newProductMonths},operation==='market_research_statistics');
    const available=declaredFields.filter(field=>row[field]!==undefined&&row[field]!==null);
    if(!empty&&!available.length)throw new SourceFailure('malformed-response');
    const units:Record<string,MarketSourceUnit>={};
    for(const field of available)units[field]=field.endsWith('Crn')?{status:'unknown',rawUnit:null,reason:'来源未说明ratio或percent口径'}:
      /Price|Revenue/.test(field)?paths.currency?.length?{status:'known',unit:'currency',rawUnit:'currency',currency:scope.currency}:{status:'unknown',rawUnit:null,reason:'来源未回显金额币种'}:
      {status:'known',unit:'count',rawUnit:field};
    const evidence=createMarketSourceEvidence({scope,provider:'sellerSprite',operation,requestIdentity:{marketplace:scope.marketplace,nodeIdPath:scope.nodeIdPath,month},responseIdentityPaths:paths,payload,
      fetchedAt:metadata.data.fetchedAt,observationPeriod:{kind:'calendar-months',fromMonth:month,toMonth:month},units,coverage:{receivedCount:empty?0:1,expectedCount:empty?0:1,truncation:{status:'unknown',reason:'来源聚合样本，未证明全类目覆盖'}}},now());
    const issues:Issue[]=[];
    if(evidence.responseIdentity.nodeIdPath.status!=='verified'||evidence.responseIdentity.month.status!=='verified')issues.push({code:'identity-unverified',retryable:false});
    if(Object.values(units).some(u=>u.status==='unknown'))issues.push({code:'unit-unknown',retryable:false});
    if(available.some(field=>!(typeof row[field]==='number'&&Number.isFinite(row[field])&&Number(row[field])>=0||typeof row[field]==='string'&&/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(String(row[field]).trim()))))issues.push({code:'invalid-metric',retryable:false});
    check();return {...base,status:empty?'empty':issues.length?'partial':'ready',evidence,issues};
  }catch(error){
    if(performance.now()>=deadline)controller.abort();
    const failure:Issue=input.signal?.aborted?{code:'interrupted',retryable:false}:controller.signal.aborted?{code:'timeout',retryable:true}:error instanceof ConnectorError?{code:error.code,retryable:error.retryable}:
      error instanceof ResourceGovernorAdmissionError?{code:'local-admission',retryable:true}:{code:error instanceof SourceFailure?error.code:'malformed-response',retryable:false};
    return {...base,issues:[failure]};
  }finally{clearTimeout(timer);}
}
