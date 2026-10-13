import {MarketLinkedRequestSchema,MarketLinkedResponseSchema,MarketLinkedRetrySchema,type MarketLinkedRequest} from '../../shared/market-linked-contracts';
import {MarketModuleIdSchema} from '../../shared/market-module-contracts';
import {localAgentFetch,localAgentErrorMessage} from './local-agent-browser';
async function request(path:string,init:RequestInit){
 const response=await localAgentFetch(`/v1/market-analysis/linked${path}`,{...init,cache:'no-store'}),value:unknown=await response.json().catch(()=>null);
 if(!response.ok)throw Object.assign(new Error(localAgentErrorMessage(value,'联动分析状态暂时无法读取，已接受的后台任务继续执行。')),{status:response.status});
 init.signal?.throwIfAborted();
 return MarketLinkedResponseSchema.parse(value).batch;
}
export const readLinkedBatch=(id:string,signal?:AbortSignal)=>request(`/${MarketModuleIdSchema.parse(id)}`,{signal});
export const startLinkedBatch=(input:MarketLinkedRequest,key:string,signal?:AbortSignal)=>request('',{method:'POST',signal,headers:{'idempotency-key':MarketModuleIdSchema.parse(key)},body:JSON.stringify(MarketLinkedRequestSchema.parse(input))});
export const retryLinkedBatch=(id:string,input:unknown,signal?:AbortSignal)=>request(`/${MarketModuleIdSchema.parse(id)}/retry`,{method:'POST',signal,body:JSON.stringify(MarketLinkedRetrySchema.parse(input))});
