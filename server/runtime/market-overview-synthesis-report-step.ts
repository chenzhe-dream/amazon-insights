import {MarketExecutionConflictError} from '../db/market-module-execution-repository';
import {PostgresQueryContext} from '../db/postgres/query-context';
import {PostgresMarketModuleExecutionStore} from '../db/postgres/market-module-execution-store';
import type {MarketStepHandler} from './market-module-step-worker';
import {canonicalJsonSha256 as digest} from './model-request-accounting';
import {readMarketOverviewSynthesisReport} from './market-overview-synthesis-report-reader';

export function createMarketOverviewSynthesisReportStep(context:PostgresQueryContext):MarketStepHandler{return async({claim,signal})=>{
 const actor={organizationId:claim.organizationId,userId:claim.createdBy},view=await new PostgresMarketModuleExecutionStore(context).findModuleRun({actor,moduleRunId:claim.moduleRunId}),step=view?.steps.find(value=>value.id===claim.stepId);
 if(!view||!step||step.kind!=='report'||step.status!=='running'||step.latestAttemptId!==claim.attemptId||step.inputHash!==claim.inputHash||digest(claim.step)!==claim.inputHash||view.run.status==='cancelled'||view.run.createdBy!==claim.createdBy||view.run.scope.researchId!==claim.studyId)throw new MarketExecutionConflictError();
 const {report}=await readMarketOverviewSynthesisReport(context,view,claim.step,signal);signal.throwIfAborted();return {kind:'settlement',value:{outcome:{status:'succeeded',output:report}}};
};}
