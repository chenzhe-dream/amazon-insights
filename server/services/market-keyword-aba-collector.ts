import {z} from 'zod';
import {MarketAnalysisScopeSchema,type MarketAnalysisScope} from '../../shared/market-analysis-contracts';
import {MarketSourceIdentityValueSchemas} from '../../shared/market-source-contracts';
import type {MarketKeywordAbaFailureDiagnostic} from '../../shared/market-keyword-aba-source-contracts';
import {normalizeMarketKeywordAbaSource} from '../domain/market-research/keyword-aba-source';
import {ConnectorError,type RemoteMcpConnector} from '../connectors/connector-contract';
import {DeadlineError,executeOnce} from './market-keyword-collector';

const requestSchema=z.object({scope:MarketAnalysisScopeSchema,keywords:z.array(MarketSourceIdentityValueSchemas.keyword).min(1).max(10),
 referenceMonth:z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/),jobId:z.string().min(1).max(160),timeoutMs:z.number().int().min(1).max(60000).default(15000)}).strict()
 .refine(v=>new Set(v.keywords).size===v.keywords.length&&v.referenceMonth===v.scope.toMonth,'Exact unique pool keywords and reference month are required');
type Input={scope:MarketAnalysisScope;keywords:string[];referenceMonth:string;jobId:string;timeoutMs?:number;connector:RemoteMcpConnector;signal?:AbortSignal};
const failed=(code:string,retryable=false,stage:MarketKeywordAbaFailureDiagnostic['stage']='request-validation')=>({status:'failed' as const,failure:{code,retryable},rawPayload:null,
 diagnostic:{stage,issues:[],truncated:false} satisfies MarketKeywordAbaFailureDiagnostic});

/** Transport only. Source admission and source replay use the same pure normalizer. */
export async function collectMarketKeywordAba(input:Input,now?:Date){
 const request=requestSchema.safeParse({scope:input.scope,keywords:input.keywords,referenceMonth:input.referenceMonth,jobId:input.jobId,timeoutMs:input.timeoutMs});
 if(!request.success||input.connector.id!=='sif')return failed('invalid-request');
 // Other sites have not yet been verified for this supplementary operation.
 if(request.data.scope.marketplace!=='US')return failed('unsupported-marketplace');
 const observedNow=now??new Date();if(request.data.referenceMonth>=observedNow.toISOString().slice(0,7))return failed('invalid-request');
 try{
  const response=await executeOnce(input.connector,{operation:'market_get_keyword_history',input:{country:'US',granularity:'month',keywords:request.data.keywords},
   governorScope:{organizationId:request.data.scope.organizationId,jobId:request.data.jobId}},request.data.timeoutMs,input.signal);
  if(response.source.connectorId!=='sif'||response.source.operation!=='market_get_keyword_history')return failed('identity-conflict',false,'response-identity');
  return normalizeMarketKeywordAbaSource({scope:request.data.scope,keywords:request.data.keywords,referenceMonth:request.data.referenceMonth,fetchedAt:response.source.fetchedAt,rawPayload:response.data},now??new Date());
 }catch(error){
  if(error instanceof DeadlineError)return failed(error.code,error.code==='timeout','transport');
  if(error instanceof ConnectorError)return failed(error.code,error.retryable,'transport');
  return failed('malformed-response',false,'transport');
 }
}
