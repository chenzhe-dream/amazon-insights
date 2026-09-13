import {MarketInputRecordSchema} from '../../shared/market-analysis-contracts';
import {PostgresQueryContext} from '../db/postgres/query-context';
import {PostgresMarketModuleExecutionStore} from '../db/postgres/market-module-execution-store';
import {MarketExecutionConflictError} from '../db/market-module-execution-repository';
import {MarketKeywordReconciliationPageInputSchema,MarketKeywordReconciliationEvaluationInputSchema,marketKeywordReconciliationPage,MARKET_KEYWORD_RECONCILIATION_PAGE_SIZE} from '../domain/market-research/keyword-reconciliation-pages';
import {inspectMarketKeywordContinuation} from '../domain/market-research/keyword-flow';
import {readMarketKeywordReconciliationPlan,readMarketKeywordReconciliationRound,validateMarketKeywordReconciliationPages,createMarketKeywordReconciliationArtifact} from './market-keyword-reconciliation-round';
import {canonicalJsonSha256 as digest} from './model-request-accounting';
import type {MarketStepHandler} from './market-module-step-worker';

/** No model calls in the commit transaction. Claim and current frontier are
 * rechecked under the run lock so retries cannot publish stale descendants. */
export function createMarketKeywordReconciliationStep(context:PostgresQueryContext):MarketStepHandler{
 const steps=new PostgresMarketModuleExecutionStore(context);
 return async({claim,signal})=>{
  const isPage=(claim.step.input as {task?:unknown}).task==='keyword-reconciliation-page';
  const input=isPage?MarketKeywordReconciliationPageInputSchema.parse(claim.step.input):MarketKeywordReconciliationEvaluationInputSchema.parse(claim.step.input);
  const actor={organizationId:claim.organizationId,userId:claim.createdBy};
  return {kind:'atomic',commit:()=>context.transaction(async()=>{
   signal.throwIfAborted();await context.query('SELECT id FROM market_analysis_module_runs WHERE id=$1 AND organization_id=$2 FOR UPDATE',[claim.moduleRunId,claim.organizationId]);
   const view=await steps.findModuleRun({actor,moduleRunId:claim.moduleRunId}),step=view?.steps.find(s=>s.id===claim.stepId);
   if(!view||!step||claim.step.kind!=='reconcile'||!['running','succeeded'].includes(step.status)||step.latestAttemptId!==claim.attemptId||step.inputHash!==claim.inputHash||digest(claim.step)!==claim.inputHash||view.run.createdBy!==claim.createdBy||view.run.scope.researchId!==claim.studyId||view.run.status==='cancelled'||
     !inspectMarketKeywordContinuation(view,new Date().toISOString()).currentStepKeys.includes(step.stepKey))throw new MarketExecutionConflictError();
   const request={actor,moduleRunId:claim.moduleRunId,anchor:input.anchor,priorEvaluationAttemptIds:input.priorEvaluationAttemptIds};
   if(input.task==='keyword-reconciliation-page'){
    const loaded=await readMarketKeywordReconciliationPlan(context,request,signal);
    if(input.previousPageAttemptId)validateMarketKeywordReconciliationPages(loaded,request,input.previousPageAttemptId,input.offset-MARKET_KEYWORD_RECONCILIATION_PAGE_SIZE);
    const page=marketKeywordReconciliationPage(loaded.plan,input.offset);signal.throwIfAborted();
    const receipt=await steps.settleAndEnqueue({claim,inputs:page.inputs,children:page.children,outcome:{status:'succeeded',output:MarketInputRecordSchema.shape.data.parse(page.output)}});
    if(receipt.status==='lease-lost')throw new MarketExecutionConflictError();return receipt;
   }
   const {loaded,round}=await readMarketKeywordReconciliationRound(context,{...request,lastPageAttemptId:input.lastPageAttemptId},signal);
   const artifact=createMarketKeywordReconciliationArtifact(loaded,input,round);signal.throwIfAborted();
   const receipt=await steps.settleAndEnqueue({claim,inputs:[MarketInputRecordSchema.shape.data.parse(artifact.factory)],outcome:{status:'succeeded',output:MarketInputRecordSchema.shape.data.parse(artifact.output)}});
   if(receipt.status==='lease-lost')throw new MarketExecutionConflictError();return receipt;
  })};
 };
}
