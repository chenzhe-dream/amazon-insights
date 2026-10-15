import {MarketKeywordQueryRequestSchema,assertStandaloneQueryBinding} from '../../shared/market-standalone-query-contracts';
import {z} from 'zod';
import {MarketModuleIdSchema, MarketStudyRequestSchema, MarketStudyResponseSchema} from '../../shared/market-module-contracts';
import {MarketKeywordStartRequestSchema} from '../../shared/market-keyword-flow-contracts';
import {MarketKeywordRunResponseSchema, type MarketKeywordFacts, type MarketKeywordRunResponse} from '../../shared/market-keyword-public-contracts';
import {MarketKeywordRevisionEntrySchema, MarketKeywordRevisionIdSchema, MarketKeywordRevisionRequestSchema} from '../../shared/market-keyword-revision-contracts';
import {type MarketKeywordRuleReport} from '../../shared/market-keyword-rule-report-contracts';
import {assertKeywordScoreInputAuditBinding} from '../../shared/market-keyword-score-input-audit-contracts';
import {localAgentFetch, localAgentErrorMessage} from './local-agent-browser';
export {retryThemeSteps as retryKeywordSteps, cancelThemeRun as cancelKeywordRun} from './market-theme-browser';

const revisionEntry = MarketKeywordRevisionEntrySchema;
const readRevision = z.object({revision:revisionEntry}).strict();
class KeywordHttpError extends Error {
 constructor(message:string,readonly status:number){super(message);}
}
/** Read-only recovery: never resubmit a collection or retry an invalid/authenticated response. */
export function keywordReadRetryDelay(error:unknown,consecutiveFailures:number):number|null {
 const temporary=error instanceof TypeError||(error instanceof KeywordHttpError&&(error.status===408||error.status===429||error.status>=500));
 return temporary&&consecutiveFailures>=1&&consecutiveFailures<=5?Math.min(2000*2**(consecutiveFailures-1),30000):null;
}
async function request<T>(path:string,schema:z.ZodType<T>,init:RequestInit={}){
 init.signal?.throwIfAborted();
 const response=await localAgentFetch(`/v1/market-analysis/${path}`,{...init,cache:'no-store'});
 const body:unknown=await response.json().catch(error=>{if(error instanceof SyntaxError)return null;throw error;});init.signal?.throwIfAborted();
 if(!response.ok)throw new KeywordHttpError(localAgentErrorMessage(body,'关键词分析请求失败，请保留输入并重试。'),response.status);
 const parsed=schema.safeParse(body);if(!parsed.success)throw new Error('关键词分析响应格式不正确，未加载该结果。');return parsed.data;
}
const post=(body:unknown,key:string,signal?:AbortSignal):RequestInit=>({method:'POST',signal,headers:{'idempotency-key':MarketModuleIdSchema.parse(key)},body:JSON.stringify(body)});
function same(a:unknown,b:unknown):boolean{
 if(a===b)return true;
 if(a===null||b===null||typeof a!=='object'||typeof b!=='object')return false;
 if(Array.isArray(a)||Array.isArray(b))return Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((v,i)=>same(v,b[i]));
 const left=a as Record<string,unknown>,right=b as Record<string,unknown>,keys=Object.keys(left);
 return keys.length===Object.keys(right).length&&keys.every(k=>Object.hasOwn(right,k)&&same(left[k],right[k]));
}
function checkFacts(facts:MarketKeywordFacts,runId:string){
 if(facts.moduleRunId!==runId)throw new Error('事实与任务身份不一致，未加载该结果。');
 if(facts.referenceMonth!==facts.scope.toMonth)throw new Error('事实参考月份与研究范围不一致，未加载该结果。');
}
function checkRun(run:MarketKeywordRunResponse['run']){
 if(run.automaticClassification&&(run.semanticStatus!=='skipped'||run.automaticClassification.factsId!==run.facts?.factsId))throw new Error('自动分类与事实版本不一致，未加载该结果。');
 if(run.reconciliation&&(run.reconciliation.moduleRunId!==run.id||run.reconciliation.inputSnapshotId!==(run.facts?.pool.semanticInputSnapshotId??null)))throw new Error('归并结果与当前词池不一致，未加载该结果。');
 if(run.facts){checkFacts(run.facts,run.id);if(!same(run.scope,run.facts.scope))throw new Error('事实与任务研究范围不一致，未加载该结果。');}
 if(run.ruleReport){if(!run.facts)throw new Error('规则报告缺少事实基线，未加载该结果。');checkRules(run.ruleReport,run.facts,run.automaticClassification?'local':run.reconciliation?'global':'none',run.automaticClassification?.identity??run.reconciliation?.resultHash??null);}
 if(run.scoreInputAudit){if(!run.facts||!run.ruleReport)throw new Error('输入核对缺少事实或规则报告，未加载该结果。');assertKeywordScoreInputAuditBinding(run.scoreInputAudit,run.facts,run.ruleReport);}
 return run;
}
function checkRules(report:MarketKeywordRuleReport,facts:MarketKeywordFacts,kind:'none'|'manual'|'global'|'local',identity:string|null){
 if(report.factsId!==facts.factsId||report.moduleRunId!==facts.moduleRunId||report.referenceMonth!==facts.referenceMonth||!same(report.scope,facts.scope)||report.classification.kind!==kind||report.classification.identity!==identity)
  throw new Error('规则报告与事实或分类版本不一致，未加载该结果。');
}
export async function createKeywordStudy(scope:z.input<typeof MarketStudyRequestSchema>,key:string,signal?:AbortSignal){
 const expected=MarketStudyRequestSchema.parse(scope),id=MarketModuleIdSchema.parse(key);
 const {study}=await request('studies',MarketStudyResponseSchema,post(expected,id,signal));
 if(study.id!==id||study.scope.researchId!==id)throw new Error('研究身份不一致，未加载该结果。');
 const {organizationId,researchId,...actual}=study.scope;void organizationId;void researchId;
 // A bare node is expanded by the server; only the same leaf may gain ancestors.
 const resolvedNodeMatches=!expected.nodeIdPath.includes(':')&&actual.nodeIdPath.split(':').at(-1)===expected.nodeIdPath;
 const comparable=resolvedNodeMatches?{...actual,nodeIdPath:expected.nodeIdPath}:actual;
 if(!same(expected,comparable))throw new Error('研究范围不一致，未加载该结果。');return study;
}
export async function startKeywordRun(studyId:string,body:unknown,key:string,signal?:AbortSignal){
 const study=MarketModuleIdSchema.parse(studyId),params=MarketKeywordStartRequestSchema.parse(body);
 const {run}=await request(`studies/${study}/keywords`,MarketKeywordRunResponseSchema,post(params,key,signal));
 if(run.scope.researchId!==study)throw new Error('研究身份不一致，未加载该结果。');
 if(!same(run.params,params))throw new Error('关键词任务参数不一致，未加载该结果。');return checkRun(run);
}
export async function readKeywordRun(id:string,signal?:AbortSignal){
 const runId=MarketModuleIdSchema.parse(id),{run}=await request(`runs/${runId}/keywords`,MarketKeywordRunResponseSchema,{signal});
 if(run.id!==runId)throw new Error('任务身份不一致，未加载该结果。');return checkRun(run);
}
export async function saveKeywordRevision(id:string,body:unknown,key:string,signal?:AbortSignal){
 const runId=MarketModuleIdSchema.parse(id),params=MarketKeywordRevisionRequestSchema.parse(body);
 const {revision}=await request(`runs/${runId}/keywords/revisions`,readRevision,post(params,key,signal));
 const {catalog}=revision;checkFacts(catalog.facts,runId);
 if(revision.ruleReport)checkRules(revision.ruleReport,catalog.facts,'manual',catalog.revision.revisionId);
 if(revision.scoreInputAudit){if(!revision.ruleReport)throw new Error('输入核对缺少规则报告，未加载该结果。');assertKeywordScoreInputAuditBinding(revision.scoreInputAudit,catalog.facts,revision.ruleReport);}
 if(catalog.facts.factsId!==params.factsId||catalog.revision.parentRevisionId!==params.expectedParentRevisionId||catalog.revision.note!==params.note||!same(catalog.classification,{labels:params.labels,clusters:params.clusters,assignments:params.assignments}))throw new Error('保存版本与事实基线或人工选择不一致，未加载该结果。');
 return revision;
}
export async function readKeywordRevision(id:string,revisionId:string,signal?:AbortSignal){
 const runId=MarketModuleIdSchema.parse(id),selected=MarketKeywordRevisionIdSchema.parse(revisionId);
 const {revision}=await request(`runs/${runId}/keywords/revisions/${encodeURIComponent(selected)}`,readRevision,{signal});
 checkFacts(revision.catalog.facts,runId);if(revision.catalog.revision.revisionId!==selected)throw new Error('报告版本不一致，未加载该结果。');
 if(revision.ruleReport)checkRules(revision.ruleReport,revision.catalog.facts,'manual',selected);
 if(revision.scoreInputAudit){if(!revision.ruleReport)throw new Error('输入核对缺少规则报告，未加载该结果。');assertKeywordScoreInputAuditBinding(revision.scoreInputAudit,revision.catalog.facts,revision.ruleReport);}
 return revision;
}

export async function queryKeywordRun(body:unknown,key:string,signal?:AbortSignal){
 const input=MarketKeywordQueryRequestSchema.parse(body),{run}=await request('keywords/query',MarketKeywordRunResponseSchema,post(input,key,signal));
 assertStandaloneQueryBinding(input,run);return checkRun(run);
}
