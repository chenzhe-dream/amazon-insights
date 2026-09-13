import type {MarketShapeExplanationWindow} from '../../shared/market-shape-explanation-wire-contracts';
import {MarketInputRecordSchema,type MarketJsonValue} from '../../shared/market-analysis-contracts';
import type {MarketSourceEvidence} from '../../shared/market-source-contracts';
import {PostgresQueryContext} from '../db/postgres/query-context';
import {PostgresMarketModuleExecutionStore} from '../db/postgres/market-module-execution-store';
import {PostgresMarketAnalysisSnapshotStore} from '../db/postgres/market-analysis-snapshot-store';
import {loadMarketShapeExplanationCatalog} from '../services/market-shape-explanation-input-service';
import {marketShapeExplanationInitialSteps,isMarketShapeExplanationFlow} from '../domain/market-research/shape-explanation-flow';
import {buildMarketShapeExplanationWindows,decodeMarketShapeExplanationWindows} from '../domain/market-research/shape-explanation-wire';
import {createMarketInputSnapshot} from '../domain/market-research/snapshot';
import {planMarketSemanticBatches} from '../domain/market-research/semantic-batch-plan';
import type {SkillRegistry} from '../skills/registry';
import type {ResolvedMarketSemanticConfiguration} from './market-semantic-execution-service';
import {createMarketSemanticSkillRunner} from './market-semantic-runner';
import {createMarketSemanticBatchMeter} from './market-semantic-batch-meter';
import {canonicalJsonSha256 as digest} from './model-request-accounting';
import type {MarketStepHandler} from './market-module-step-worker';

const task='market-shape-structure-explanation' as const;
const json=(value:unknown):MarketJsonValue=>MarketInputRecordSchema.shape.data.parse(JSON.parse(JSON.stringify(value)));
function invalid():never{throw new TypeError('Shape explanation preparation differs from its saved revision or execution identity');}

/** Plans complete evidence outside transactions. The worker owns the heartbeat
 * and atomically commits the manifest, snapshots and preparation children. */
export function createMarketShapeExplanationWindowStep(context:PostgresQueryContext,options:{registry:SkillRegistry;configuration:ResolvedMarketSemanticConfiguration}):MarketStepHandler{
 return async({claim,signal})=>{
  signal.throwIfAborted();
  const actor={organizationId:claim.organizationId,userId:claim.createdBy};
  const steps=new PostgresMarketModuleExecutionStore(context),snapshots=new PostgresMarketAnalysisSnapshotStore(context);
  const view=await steps.findModuleRun({actor,moduleRunId:claim.moduleRunId}),step=view?.steps.find(s=>s.id===claim.stepId);
  if(!view||!step||!isMarketShapeExplanationFlow(view.run)||view.run.status==='cancelled'||view.run.createdBy!==claim.createdBy||view.run.scope.researchId!==claim.studyId||step.status!=='running'||step.latestAttemptId!==claim.attemptId||step.inputHash!==claim.inputHash||digest(claim.step)!==claim.inputHash)invalid();
  if(digest(claim.step)!==digest(marketShapeExplanationInitialSteps(view.run)[0])||options.configuration.task!==task||options.configuration.configurationVersion!==view.run.versions.configuration)invalid();
  const configurationVersion=view.run.versions.configuration;if(!configurationVersion)invalid();
  const catalog=await loadMarketShapeExplanationCatalog(context,actor,claim.moduleRunId);
  const sources:Record<string,MarketSourceEvidence>={};
  for(const id of catalog.source.sourceRefs){signal.throwIfAborted();const source=await snapshots.findSource({actor,studyId:claim.studyId,id});if(!source)invalid();sources[id]=source.evidence;}
  const snapshotFor=(window:MarketShapeExplanationWindow)=>{
   const input={scope:view.run.scope,kind:'overview' as const,sourceVersion:catalog.version,ruleVersion:'shape-explanation/v1',collectedAt:catalog.source.dataCutoffAt,
    expectedRecordIds:[window.windowId],records:[{id:window.windowId,scope:view.run.scope,data:json({semantic:{task,window,sourceRefs:catalog.source.sourceRefs}})}]};
   return {input,snapshot:createMarketInputSnapshot(input)};
  };
  const runner=createMarketSemanticSkillRunner(context,options.registry,options.configuration);
  const meter=createMarketSemanticBatchMeter(runner,options.configuration,signal);
  const windows=await buildMarketShapeExplanationWindows(catalog,async window=>{
   const plan=await planMarketSemanticBatches({task,moduleRunId:claim.moduleRunId,snapshot:snapshotFor(window).snapshot,sources,
    selectionRevision:catalog.revisionId,configurationVersion,dataCutoffAt:catalog.source.dataCutoffAt,shapeExplanationCatalog:catalog},meter,signal);
   return plan.batches.length===1&&plan.rejectedMembers.length===0&&plan.missingMemberIds.length===0;
  },signal);
  decodeMarketShapeExplanationWindows(catalog,windows);
  const prepared=windows.map(snapshotFor);
  signal.throwIfAborted();
  return {kind:'settlement',value:{outcome:{status:'succeeded',output:json({manifestVersion:'shape-explanation-windows/v2',sourceRefs:catalog.source.sourceRefs,explanationCatalogId:catalog.explanationCatalogId,revisionId:catalog.revisionId,windows})},
   inputs:prepared.map(p=>json(p.input)),children:prepared.map(p=>({stepKey:`shape-explanation/model-input/${p.snapshot.snapshotId}`,kind:'prepare-model-batches' as const,subject:{task},
    input:{task,inputSnapshotId:p.snapshot.snapshotId,selectionRevision:catalog.revisionId,dataCutoffAt:catalog.source.dataCutoffAt},inputRefs:[{kind:'input' as const,id:p.snapshot.snapshotId}]}))}};
 };
}
