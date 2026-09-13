import { z } from 'zod';
import type { MarketInputSnapshot } from '../../../shared/market-analysis-contracts';
import type { MarketExecutionActor, MarketModuleRunView } from '../market-module-execution-repository';
import { MarketExecutionConflictError } from '../market-module-execution-repository';
import { MarketThemeEvaluationInputSchema, MARKET_THEME_EVALUATION_VERSION } from '../../domain/market-research/customer-theme-reconciliation-artifact';
import { PostgresQueryContext } from './query-context';
import { PostgresMarketAnalysisSnapshotStore } from './market-analysis-snapshot-store';
import { canonicalJsonSha256 as digest } from '../../runtime/model-request-accounting';
const obj=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
const same=(a:unknown,b:unknown)=>{if(digest(a)!==digest(b))throw new MarketExecutionConflictError();};

/** Caller holds the run lock. These are fixed successful attempts, including old
 * report versions after retries; do not substitute their current model frontier. */
export async function loadMarketThemeEvaluationHistory(context:PostgresQueryContext,actor:MarketExecutionActor,view:MarketModuleRunView,evaluationAttemptId:string,finalSnapshot:MarketInputSnapshot){
  const locate=(id:string)=>{
    const attempt=view.attempts.find(a=>a.id===id),step=view.steps.find(s=>s.id===attempt?.stepId);
    if(!attempt||!step||step.kind!=='reconcile'||attempt.status!=='succeeded')throw new MarketExecutionConflictError();
    const input=MarketThemeEvaluationInputSchema.parse(step.input);
    for(const dependency of [input.initialRulesAttemptId,input.lastPageAttemptId,...(input.priorEvaluationAttemptIds??[])])
      if(!step.inputRefs.some(r=>r.kind==='step-output'&&r.id===dependency))throw new MarketExecutionConflictError();
    return {attempt,input};
  };
  const final=locate(evaluationAttemptId),ids=[...(final.input.priorEvaluationAttemptIds??[]),evaluationAttemptId];
  if(ids.length>8||new Set(ids).size!==ids.length)throw new MarketExecutionConflictError();
  const snapshots=new PostgresMarketAnalysisSnapshotStore(context),history:MarketInputSnapshot[]=[];
  for(const [index,id] of ids.entries()){
    const {attempt,input}=locate(id);same(input.initialRulesAttemptId,final.input.initialRulesAttemptId);same(input.priorEvaluationAttemptIds??[],ids.slice(0,index));
    const output=obj(attempt.output),snapshotId=z.string().regex(/^market-input:[a-f0-9]{64}$/).parse(output.inputSnapshotId);
    const snapshot=index===ids.length-1?finalSnapshot:(await snapshots.findInput({actor,studyId:view.run.scope.researchId,id:snapshotId}))?.snapshot;
    if(!snapshot)throw new MarketExecutionConflictError();same(snapshot.snapshotId,snapshotId);same(snapshot.scope,view.run.scope);
    const summary=obj(snapshot.records.find(r=>r.id==='summary')?.data);same(summary.input,input);
    same(output,{version:MARKET_THEME_EVALUATION_VERSION,inputSnapshotId:snapshot.snapshotId,evaluationHash:snapshot.contentHash,completedRound:index,
      initialRulesAttemptId:input.initialRulesAttemptId,frontierHash:input.frontierHash,status:summary.status,planHash:summary.afterPlanHash,
      resultHash:summary.result===null?null:obj(summary.result).resultHash});
    history.push(snapshot);
  }
  return history.slice(0,-1);
}
