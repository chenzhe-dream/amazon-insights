import { z } from 'zod';
import { MarketModuleIdSchema, MarketStudyRequestSchema, MarketStudyResponseSchema, MarketThemeStartRequestSchema, MarketThemeRunResponseSchema, MarketModuleRetryRequestSchema, MarketModuleRetryResponseSchema, MarketModuleCancelResponseSchema } from '../../shared/market-module-contracts';
import { MarketThemeDetailQuerySchema, MarketThemeDetailResponseSchema } from '../../shared/market-theme-detail-contracts';
import { MarketThemeEvidenceQuerySchema, MarketThemeEvidenceResponseSchema } from '../../shared/market-theme-evidence-contracts';
import { localAgentFetch, localAgentErrorMessage } from './local-agent-browser';

async function request<T>(path:string,schema:z.ZodType<T>,init:RequestInit={}) {
  init.signal?.throwIfAborted();
  const response=await localAgentFetch(`/v1/market-analysis/${path}`,{...init,cache:'no-store'});
  const value:unknown=await response.json().catch(()=>null);init.signal?.throwIfAborted();
  if(!response.ok)throw new Error(localAgentErrorMessage(value,'主题分析请求失败，请刷新状态后重试。'));
  const parsed=schema.safeParse(value);if(!parsed.success)throw new Error('主题分析响应格式不正确，未加载该结果。');return parsed.data;
}
const post=(body:unknown,key:string,signal?:AbortSignal):RequestInit=>({method:'POST',signal,headers:{'idempotency-key':MarketModuleIdSchema.parse(key)},body:JSON.stringify(body)});
export async function createThemeStudy(scope:z.input<typeof MarketStudyRequestSchema>,key:string,signal?:AbortSignal) {
  const result=await request('studies',MarketStudyResponseSchema,post(MarketStudyRequestSchema.parse(scope),key,signal));
  if(result.study.id!==MarketModuleIdSchema.parse(key))throw new Error('研究身份不一致，未加载该结果。');return result.study;
}
export async function startThemeRun(studyId:string,params:z.input<typeof MarketThemeStartRequestSchema>,key:string,signal?:AbortSignal) {
  const result=await request(`studies/${MarketModuleIdSchema.parse(studyId)}/customer-themes`,MarketThemeRunResponseSchema,post(MarketThemeStartRequestSchema.parse(params),key,signal));
  if(result.run.scope.researchId!==MarketModuleIdSchema.parse(studyId))throw new Error('研究身份不一致，未加载该结果。');return result.run;
}
export async function readThemeRun(id:string,signal?:AbortSignal) {
  const parsed=MarketModuleIdSchema.parse(id),result=await request(`runs/${parsed}`,MarketThemeRunResponseSchema,{signal});
  if(result.run.id!==parsed)throw new Error('任务身份不一致，未加载该结果。');return result.run;
}
export async function retryThemeSteps(id:string,steps:z.input<typeof MarketModuleRetryRequestSchema>['steps'],key:string,signal?:AbortSignal) {
  const parsed=MarketModuleIdSchema.parse(id),result=await request(`runs/${parsed}/retry`,MarketModuleRetryResponseSchema,post(MarketModuleRetryRequestSchema.parse({steps}),key,signal));
  if(result.moduleRunId!==parsed)throw new Error('任务身份不一致，请刷新状态。');return result;
}
export async function cancelThemeRun(id:string,key:string,signal?:AbortSignal) {
  const parsed=MarketModuleIdSchema.parse(id),result=await request(`runs/${parsed}/cancel`,MarketModuleCancelResponseSchema,post({},key,signal));
  if(result.moduleRunId!==parsed)throw new Error('任务身份不一致，请刷新状态。');return result;
}
export async function readThemeDetails(id:string,attemptId:string,reportHash:string,query:z.input<typeof MarketThemeDetailQuerySchema>,signal?:AbortSignal) {
  const runId=MarketModuleIdSchema.parse(id),attempt=MarketModuleIdSchema.parse(attemptId),q=MarketThemeDetailQuerySchema.parse(query);
  const search=new URLSearchParams(Object.entries(q).filter(([,value])=>value!==undefined).map(([key,value])=>[key,String(value)]));
  const result=await request(`runs/${runId}/reports/${attempt}/details?${search}`,MarketThemeDetailResponseSchema,{signal});
  if(result.report.attemptId!==attempt||result.report.report.moduleRunId!==runId||result.report.report.reportHash!==reportHash||
    result.page.section!==q.section||result.page.offset!==q.offset||result.page.limit!==q.limit||result.page.groupIndex!==(q.groupIndex??null))throw new Error('报告版本或分页身份不一致，未加载该明细。');
  return result;
}
export async function readThemeEvidence(id:string,attemptId:string,reportHash:string,sourceThemeId:string,signal?:AbortSignal) {
  const runId=MarketModuleIdSchema.parse(id),attempt=MarketModuleIdSchema.parse(attemptId),query=MarketThemeEvidenceQuerySchema.parse({sourceThemeId});
  const result=await request(`runs/${runId}/reports/${attempt}/evidence?${new URLSearchParams(query)}`,MarketThemeEvidenceResponseSchema,{signal});
  if(result.report.attemptId!==attempt||result.report.report.moduleRunId!==runId||result.report.report.reportHash!==reportHash||result.evidence.sourceThemeId!==sourceThemeId)throw new Error('报告版本或主题身份不一致，未加载该证据。');return result.evidence;
}
