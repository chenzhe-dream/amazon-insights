import {z} from 'zod';
import {MarketModuleIdSchema,MarketStudyRequestSchema} from '../../shared/market-module-contracts';
import {MarketOverviewStartRequestSchema,MarketOverviewRunResponseSchema,MarketOverviewDetailsResponseSchema,MarketOverviewSavedRunQuerySchema,MarketOverviewSavedRunResponseSchema} from '../../shared/market-overview-report-contracts';
import {localAgentFetch,localAgentErrorMessage} from './local-agent-browser';
import {createThemeStudy} from './market-theme-browser';
export {retryThemeSteps as retryOverviewSteps,cancelThemeRun as cancelOverviewRun} from './market-theme-browser';
export async function createOverviewStudy(scope:z.input<typeof MarketStudyRequestSchema>,key:string,signal?:AbortSignal){
  const input=MarketStudyRequestSchema.parse(scope),study=await createThemeStudy(input,key,signal);
  if(Object.entries(input).some(([name,value])=>name==='nodeIdPath'&&!String(value).includes(':')?study.scope.nodeIdPath.split(':').at(-1)!==value:study.scope[name as keyof typeof input]!==value))throw new Error('研究范围不一致，未加载该结果。');return study;
}
export async function findSavedOverviewRun(input:z.input<typeof MarketOverviewSavedRunQuerySchema>,signal?:AbortSignal){
  const query=MarketOverviewSavedRunQuerySchema.parse(input),search=new URLSearchParams(Object.entries(query).filter(([,value])=>value!==undefined).map(([key,value])=>[key,String(value)]));
  return request(`overview/saved?${search}`,MarketOverviewSavedRunResponseSchema,{signal});
}
function validateRun(run:z.infer<typeof MarketOverviewRunResponseSchema>['run']){
  for(const entry of [...run.history,...(run.currentReport?[run.currentReport]:[]),...(run.latestSavedReport?[run.latestSavedReport]:[])]){
    if(entry.report.moduleRunId!==run.id||Object.entries(run.scope).some(([key,value])=>entry.report.scope[key as keyof typeof run.scope]!==value))throw new Error('报告研究范围不一致，未加载该结果。');
  }return run;
}
async function request<T>(path:string,schema:z.ZodType<T>,init:RequestInit={}){
  init.signal?.throwIfAborted();const response=await localAgentFetch(`/v1/market-analysis/${path}`,{...init,cache:'no-store'}),value:unknown=await response.json().catch(()=>null);init.signal?.throwIfAborted();
  if(!response.ok)throw new Error(localAgentErrorMessage(value,'总览分析请求失败，请刷新后重试。'));
  const parsed=schema.safeParse(value);if(!parsed.success)throw new Error('总览响应格式不正确，未加载该结果。');return parsed.data;
}
export async function startOverviewRun(studyId:string,params:z.input<typeof MarketOverviewStartRequestSchema>,key:string,signal?:AbortSignal){
  const study=MarketModuleIdSchema.parse(studyId),result=await request(`studies/${study}/overview`,MarketOverviewRunResponseSchema,{method:'POST',signal,headers:{'idempotency-key':MarketModuleIdSchema.parse(key)},body:JSON.stringify(MarketOverviewStartRequestSchema.parse(params))});
  const expected=MarketOverviewStartRequestSchema.parse(params);if(result.run.scope.researchId!==study||result.run.params.headTopN!==expected.headTopN||result.run.params.newProductMonths!==expected.newProductMonths)throw new Error('研究身份或参数不一致，未加载该结果。');return validateRun(result.run);
}
export async function readOverviewRun(id:string,signal?:AbortSignal){
  const runId=MarketModuleIdSchema.parse(id),result=await request(`runs/${runId}/overview`,MarketOverviewRunResponseSchema,{signal});
  if(result.run.id!==runId)throw new Error('任务身份不一致，未加载该结果。');return validateRun(result.run);
}
export async function readOverviewDetails(id:string,attemptId:string,hash:string,signal?:AbortSignal){
  const runId=MarketModuleIdSchema.parse(id),attempt=MarketModuleIdSchema.parse(attemptId),result=await request(`runs/${runId}/reports/${attempt}/overview`,MarketOverviewDetailsResponseSchema,{signal});
  if(result.entry.report.moduleRunId!==runId||result.entry.attemptId!==attempt||result.entry.report.reportHash!==hash)throw new Error('报告版本不一致，未加载该明细。');return result;
}
