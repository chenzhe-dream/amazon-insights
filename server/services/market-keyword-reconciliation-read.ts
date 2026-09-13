import {MarketKeywordReconciliationReportSchema} from '../../shared/market-keyword-reconciliation-contracts';
import {isMarketKeywordGlobalMode} from '../../shared/market-keyword-flow-contracts';
import type {MarketKeywordRunResponse} from '../../shared/market-keyword-public-contracts';
import type {MarketExecutionActor} from '../db/market-module-execution-repository';
import {MarketExecutionConflictError} from '../db/market-module-execution-repository';
import {PostgresQueryContext} from '../db/postgres/query-context';
import {PostgresMarketModuleExecutionStore} from '../db/postgres/market-module-execution-store';
import {MarketKeywordReconciliationPageInputSchema,MarketKeywordReconciliationEvaluationInputSchema,marketKeywordReconciliationPage} from '../domain/market-research/keyword-reconciliation-pages';
import {readMarketKeywordReconciliationPlan} from '../runtime/market-keyword-reconciliation-round';
import {canonicalJsonSha256 as digest} from '../runtime/model-request-accounting';

const obj=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
/** Invoked by the public service under the same read lock as its facts. This is
 * deliberately outside the initial facts reader, which also supplies runtime
 * reconciliation inputs and must never recursively request its own result. */
export async function readMarketKeywordReconciliationReport(context:PostgresQueryContext,actor:MarketExecutionActor,run:MarketKeywordRunResponse['run']){
 if(!isMarketKeywordGlobalMode(run.params.analysisMode))return undefined;
 const view=await new PostgresMarketModuleExecutionStore(context).findModuleRun({actor,moduleRunId:run.id});if(!view)throw new MarketExecutionConflictError();
 const current=new Set(run.steps.filter(s=>s.current).map(s=>s.id));
 const steps=view.steps.filter(s=>current.has(s.id)&&s.kind==='reconcile'),successful=steps.filter(s=>s.status==='succeeded');
 const attempt=(s:typeof steps[number])=>view.attempts.find(a=>a.id===s.latestAttemptId&&a.stepId===s.id)!;
 const evaluation=successful.filter(s=>obj(s.input).task==='keyword-reconciliation-evaluate').sort((a,b)=>Number(obj(attempt(b)?.output).completedRound)-Number(obj(attempt(a)?.output).completedRound)).find(s=>['ready','partial'].includes(String(obj(attempt(s)?.output).status)));
 const terminalPage=successful.find(s=>obj(s.input).task==='keyword-reconciliation-page'&&obj(attempt(s)?.output).status!=='needs-model');
 const base={version:'keyword-reconciliation-report/v1' as const,moduleRunId:run.id,inputSnapshotId:run.facts?.pool.semanticInputSnapshotId??null,completedRounds:0,resultHash:null,catalog:[],decisions:[]};
 if(!evaluation&&!terminalPage){
  const active=view.steps.filter(s=>current.has(s.id));
  const failedPreparation=active.some(s=>s.kind==='prepare-model-batches'&&s.status==='failed'&&s.inputRefs.some(r=>r.kind==='input'&&r.id===base.inputSnapshotId));
  const failedBeforePool=!run.facts&&active.some(s=>s.status==='failed')&&!active.some(s=>s.status==='queued'||s.status==='running');
  const status=run.status==='cancelled'?'cancelled':run.facts?.members.length===0?'empty':!view.run.versions.model?'unavailable':failedPreparation?'waiting-initial-models':failedBeforePool||steps.some(s=>s.status==='failed')?'failed':'pending';
  return MarketKeywordReconciliationReportSchema.parse({...base,status});
 }
 const step=evaluation??terminalPage!,input=evaluation?MarketKeywordReconciliationEvaluationInputSchema.parse(step.input):MarketKeywordReconciliationPageInputSchema.parse(step.input);
 const loaded=await readMarketKeywordReconciliationPlan(context,{actor,moduleRunId:run.id,anchor:input.anchor,priorEvaluationAttemptIds:[...input.priorEvaluationAttemptIds,...(evaluation?[attempt(step).id]:[])]},new AbortController().signal);
 if(!evaluation&&digest(attempt(step).output)!==digest(marketKeywordReconciliationPage(loaded.plan,0).output))throw new MarketExecutionConflictError();
 const plan=loaded.plan,result=plan.result;
 if(!result)return MarketKeywordReconciliationReportSchema.parse({...base,status:plan.status,completedRounds:plan.round});
 const dimensions=['W1','W2','W3','W4','cluster'] as const;
 return MarketKeywordReconciliationReportSchema.parse({...base,status:plan.status,completedRounds:plan.round,resultHash:result.resultHash,
  catalog:result.usedCatalog.map(({candidateId,dimension,label,definition,evidence})=>({candidateId,dimension,label,definition,evidence})),
  decisions:result.decisions.map(row=>({keywordId:row.keywordId,...Object.fromEntries(dimensions.map(d=>{
   const cell=row[d];const last=cell.observations.at(-1);
   return [d,{status:cell.status,candidateIds:cell.candidateIds,reason:cell.reason,evidence:last?.decision.evidence??[]}];
  }))})),
 });
}
