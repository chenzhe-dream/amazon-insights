import {PostgresQueryContext} from '../db/postgres/query-context';
import {PostgresMarketModuleExecutionStore} from '../db/postgres/market-module-execution-store';
import {MarketExecutionConflictError} from '../db/market-module-execution-repository';
import {readMarketOverviewReport} from './market-overview-report-reader';
import {canonicalJsonSha256 as digest} from './model-request-accounting';
import type {MarketStepHandler} from './market-module-step-worker';
export function createMarketOverviewReportStep(context:PostgresQueryContext):MarketStepHandler{
  return async({claim,signal})=>{
    const actor={organizationId:claim.organizationId,userId:claim.createdBy},view=await new PostgresMarketModuleExecutionStore(context).findModuleRun({actor,moduleRunId:claim.moduleRunId});
    const step=view?.steps.find(s=>s.id===claim.stepId);
    if(!view||!step||step.status!=='running'||step.latestAttemptId!==claim.attemptId||step.inputHash!==claim.inputHash||digest(claim.step)!==claim.inputHash||view.run.status==='cancelled'||view.run.createdBy!==claim.createdBy||view.run.scope.researchId!==claim.studyId)throw new MarketExecutionConflictError();
    const {report}=await readMarketOverviewReport(context,view,claim.step,signal);signal.throwIfAborted();
    return {kind:'settlement',value:{outcome:{status:report.dataReady?'succeeded':'empty',output:report}}};
  };
}
