import {z} from 'zod';
import {MarketInputRecordSchema} from '../../shared/market-analysis-contracts';
import {PostgresQueryContext} from '../db/postgres/query-context';
import {PostgresMarketModuleExecutionStore} from '../db/postgres/market-module-execution-store';
import type {SkillRegistry} from '../skills/registry';
import type {ResolvedMarketSemanticConfiguration} from './market-semantic-execution-service';
import {readMarketOverviewCatalog} from './market-overview-catalog-step';
import {MARKET_OVERVIEW_EXPLAINED_FLOW_VERSION,MARKET_OVERVIEW_EXPANDED_FLOW_VERSION,MARKET_OVERVIEW_SYNTHESIS_FLOW_VERSION,MARKET_OVERVIEW_COMPLETE_FLOW_VERSION,inspectMarketOverviewContinuation} from '../domain/market-research/overview-flow';
import {MarketOverviewWindowsStepInputSchema,MarketOverviewWindowPlanSchema,marketOverviewWindowPreparations} from '../domain/market-research/overview-window-plan';
import {planMarketOverviewSemanticWindows} from '../domain/market-research/overview-semantic-windows';
import {planMarketSemanticBatches} from '../domain/market-research/semantic-batch-plan';
import {createMarketSemanticBatchMeter} from './market-semantic-batch-meter';
import {createMarketSemanticSkillRunner} from './market-semantic-runner';
import {canonicalJsonSha256 as digest} from './model-request-accounting';
import type {MarketStepHandler} from './market-module-step-worker';
function invalid():never{throw new z.ZodError([{code:'custom',path:[],message:'Overview window plan requires its current saved source catalog'}]);}
export function createMarketOverviewWindowsStep(context:PostgresQueryContext,model:{registry:SkillRegistry;configuration:ResolvedMarketSemanticConfiguration}|null):MarketStepHandler{
  const steps=new PostgresMarketModuleExecutionStore(context);
  return async({claim,signal})=>{
    signal.throwIfAborted();const input=MarketOverviewWindowsStepInputSchema.parse(claim.step.input),actor={organizationId:claim.organizationId,userId:claim.createdBy};
    const view=await steps.findModuleRun({actor,moduleRunId:claim.moduleRunId}),step=view?.steps.find(s=>s.id===claim.stepId);
    if(!view||!step||step.status!=='running'||step.latestAttemptId!==claim.attemptId||step.inputHash!==claim.inputHash||digest(claim.step)!==claim.inputHash||view.run.createdBy!==claim.createdBy||view.run.scope.researchId!==claim.studyId||view.run.moduleKind!=='overview'||view.run.status==='cancelled'||![MARKET_OVERVIEW_EXPLAINED_FLOW_VERSION,MARKET_OVERVIEW_EXPANDED_FLOW_VERSION,MARKET_OVERVIEW_SYNTHESIS_FLOW_VERSION,MARKET_OVERVIEW_COMPLETE_FLOW_VERSION].includes(String((view.run.params as {flow?:unknown}).flow))||claim.step.kind!=='prepare-members')invalid();
    if(!inspectMarketOverviewContinuation(view,new Date().toISOString()).currentStepKeys.includes(step.stepKey))invalid();
    const {catalog,sources}=await readMarketOverviewCatalog(context,view,input.catalogAttemptId,signal),full=catalog.semanticSnapshot;
    if(!full||digest(claim.step.inputRefs)!==digest([{kind:'step-output',id:input.catalogAttemptId},{kind:'input',id:full.snapshotId},{kind:'input',id:catalog.numericSnapshot.snapshotId}]))invalid();
    if(!model||model.configuration.task!=='market-overview-explanation'||view.run.versions.configuration!==model.configuration.configurationVersion||view.run.versions.model!=='market.semantic.text.v1')return {kind:'settlement',value:{outcome:{status:'failed',error:{code:'governance',retryable:false},diagnostic:{reason:'model-configuration-unavailable',numericInputSnapshotId:catalog.numericSnapshot.snapshotId}}}};
    const configuration=model.configuration,selectionRevision=`overview-selection:${digest({catalogAttemptId:input.catalogAttemptId,snapshotId:full.snapshotId})}`;
    const meter=createMarketSemanticBatchMeter(createMarketSemanticSkillRunner(context,model.registry,configuration),configuration,signal);
    const sourceMap=Object.fromEntries(sources.map(s=>[`market-source:${digest(s)}`,s]));
    const planned=await planMarketOverviewSemanticWindows(full,async snapshot=>{
      signal.throwIfAborted();const p=await planMarketSemanticBatches({task:'market-overview-explanation',moduleRunId:claim.moduleRunId,snapshot,sources:sourceMap,selectionRevision,configurationVersion:configuration.configurationVersion,dataCutoffAt:full.collectedAt},meter,signal);
      if(p.rejectedMembers.some(m=>m.reason!=='request-too-large')||p.missingMemberIds.length)invalid();return p.batches.length===1&&p.rejectedMembers.length===0;
    });signal.throwIfAborted();
    const output=MarketOverviewWindowPlanSchema.parse({schemaVersion:'overview-window-plan/v1',catalogAttemptId:input.catalogAttemptId,basisSnapshotId:full.snapshotId,numericInputSnapshotId:catalog.numericSnapshot.snapshotId,
      configurationVersion:configuration.configurationVersion,dataCutoffAt:full.collectedAt,selectionRevision,windows:planned.windows.map(w=>({inputSnapshotId:w.snapshot.snapshotId,primaryFactIds:w.primaryFactIds,gapIds:w.gapIds})),rejected:planned.rejected});
    return {kind:'settlement',value:{inputs:planned.windows.map(({snapshot:s})=>MarketInputRecordSchema.shape.data.parse({scope:s.scope,kind:s.kind,sourceVersion:s.sourceVersion,ruleVersion:s.ruleVersion,collectedAt:s.collectedAt,expectedRecordIds:s.expectedRecordIds,records:s.records})),
      children:marketOverviewWindowPreparations(output),outcome:{status:output.windows.length?'succeeded':'empty',output}}};
  };
}
