import { MarketInputRecordSchema } from '../../shared/market-analysis-contracts';
import { createMarketThemeEvaluationArtifact, MarketThemeEvaluationInputSchema } from '../domain/market-research/customer-theme-reconciliation-artifact';
import { PostgresQueryContext } from '../db/postgres/query-context';
import { PostgresMarketModuleExecutionStore } from '../db/postgres/market-module-execution-store';
import { MarketExecutionConflictError } from '../db/market-module-execution-repository';
import { readMarketThemeReconciliationRound } from './market-theme-reconciliation-round';
import { canonicalJsonSha256 as digest } from './model-request-accounting';
import type { MarketStepHandler } from './market-module-step-worker';

/** Worker drains its heartbeat before this bounded atomic commit. All dependencies
 * are re-read under the run lock; a stale frontier cannot publish a new artifact. */
export function createMarketThemeReconciliationEvaluationStep(context:PostgresQueryContext):MarketStepHandler{
  const steps=new PostgresMarketModuleExecutionStore(context);
  return async({claim,signal})=>{
    const input=MarketThemeEvaluationInputSchema.parse(claim.step.input);
    const actor={organizationId:claim.organizationId,userId:claim.createdBy};
    for(const id of [input.initialRulesAttemptId,input.lastPageAttemptId,...(input.priorEvaluationAttemptIds??[])])
      if(!claim.step.inputRefs.some(r=>r.kind==='step-output'&&r.id===id))throw new MarketExecutionConflictError();
    return {kind:'atomic',commit:()=>context.transaction(async()=>{
      signal.throwIfAborted();await context.query('SELECT id FROM market_analysis_module_runs WHERE id=$1 AND organization_id=$2 FOR UPDATE',[claim.moduleRunId,claim.organizationId]);
      const view=await steps.findModuleRun({actor,moduleRunId:claim.moduleRunId}),step=view?.steps.find(s=>s.id===claim.stepId);
      if(!view||!step||claim.step.kind!=='reconcile'||!['running','succeeded'].includes(step.status)||step.latestAttemptId!==claim.attemptId||step.inputHash!==claim.inputHash||
        digest(claim.step)!==claim.inputHash||view.run.createdBy!==claim.createdBy||view.run.scope.researchId!==claim.studyId||view.run.status==='cancelled')throw new MarketExecutionConflictError();
      const round=await readMarketThemeReconciliationRound(context,{actor,moduleRunId:claim.moduleRunId,initialRulesAttemptId:input.initialRulesAttemptId,
        lastPageAttemptId:input.lastPageAttemptId,priorEvaluationAttemptIds:input.priorEvaluationAttemptIds},signal);
      const artifact=createMarketThemeEvaluationArtifact(view.run.scope,view.run.versions.source,round.plan.windows[0].snapshot.collectedAt,input,round);
      signal.throwIfAborted();const receipt=await steps.settleAndEnqueue({claim,inputs:[MarketInputRecordSchema.shape.data.parse(artifact.factory)],
        outcome:{status:'succeeded',output:MarketInputRecordSchema.shape.data.parse(artifact.output)}});
      if(receipt.status==='lease-lost')throw new MarketExecutionConflictError();return receipt;
    })};
  };
}
