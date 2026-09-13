import {z} from 'zod';
import {MarketInputRecordSchema} from '../../shared/market-analysis-contracts';
import {MarketSemanticRecordSchema} from '../../shared/market-semantic-contracts';
import type {MarketModuleRunView,MarketStepDefinition} from '../db/market-module-execution-repository';
import {PostgresQueryContext} from '../db/postgres/query-context';
import {PostgresMarketAnalysisSnapshotStore} from '../db/postgres/market-analysis-snapshot-store';
import {PostgresMarketAgentRunStore} from '../db/postgres/market-agent-run-store';
import {loadMarketShapeExplanationCatalog} from '../services/market-shape-explanation-input-service';
import {loadMarketShapeSynthesisEvidence} from '../services/market-shape-synthesis-input-service';
import {validateMarketShapeSynthesisOutput} from '../domain/market-research/semantic-validation';
import {validateMarketShapeFinalSynthesisOutput} from '../domain/market-research/shape-explanation-synthesis';
import {MarketShapeExplanationReportInputSchema,MarketShapeSynthesisRoundManifestSchema,inspectMarketShapeExplanationContinuation,marketShapeExplanationReportDefinition} from '../domain/market-research/shape-explanation-continuation';
import {canonicalJsonSha256 as digest} from './model-request-accounting';

const receipt=z.object({agentRunId:z.string().uuid(),bindingId:z.string().uuid(),task:z.literal('market-shape-synthesis'),executionFingerprint:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const obj=(value:unknown):Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
function fail():never{throw new TypeError('Shape explanation report frozen evidence is unavailable')}
const same=(a:unknown,b:unknown)=>{if(digest(a)!==digest(b))fail()};
const sameSet=(left:readonly string[],right:readonly string[])=>same([...new Set(left)].sort(),[...new Set(right)].sort());

/** Restores a final report from named immutable attempts. It never invokes a
 * provider and never selects a newer result than the report definition names. */
export async function readMarketShapeExplanationReport(context:PostgresQueryContext,view:MarketModuleRunView,definition:MarketStepDefinition,signal:AbortSignal){
 signal.throwIfAborted();const input=MarketShapeExplanationReportInputSchema.parse(definition.input);
 same(definition,marketShapeExplanationReportDefinition(input));
 const replayView=view.run.status==='cancelled'?{...view,run:{...view.run,status:'running' as const}}:view;
 const continuation=inspectMarketShapeExplanationContinuation(replayView,new Date().toISOString());
 if(!continuation.currentStepKeys.includes(definition.stepKey))fail();
 const attempt=(id:string)=>{const value=view.attempts.find(a=>a.id===id),step=view.steps.find(s=>s.id===value?.stepId);if(!value||!step||step.latestAttemptId!==value.id||step.status!=='succeeded'||value.status!=='succeeded')fail();return {value,step}};
 const window=attempt(input.windowAttemptId),round=attempt(input.roundAttemptId),model=attempt(input.modelAttemptId);
 if(window.step.kind!=='prepare-members'||obj(window.step.input).phase!=='prepare-shape-explanation'||round.step.kind!=='prepare-members'||obj(round.step.input).phase!=='prepare-shape-synthesis'||model.step.kind!=='model-batch'||obj(model.step.input).task!=='market-shape-synthesis')fail();
 const roundManifest=MarketShapeSynthesisRoundManifestSchema.parse(round.value.output),node=roundManifest.nodes.length===1?roundManifest.nodes[0]:null;
 if(!node||node.mode!=='final'||node.dimension!=='final'||node.inputSnapshotId!==input.inputSnapshotId||roundManifest.windowAttemptId!==input.windowAttemptId)fail();
 const actor={organizationId:view.run.scope.organizationId,userId:view.run.createdBy},studyId=view.run.scope.researchId,moduleRunId=view.run.id;
 const snapshots=new PostgresMarketAnalysisSnapshotStore(context),saved=await snapshots.findInput({actor,studyId,id:input.inputSnapshotId});if(!saved)fail();
 if(saved.snapshot.kind!=='overview'||saved.snapshot.records.length!==1||saved.snapshot.expectedRecordIds.length!==1||saved.snapshot.expectedRecordIds[0]!==node.nodeId)fail();same(saved.snapshot.scope,view.run.scope);
 const record=saved.snapshot.records[0],semantic=MarketSemanticRecordSchema.parse((MarketInputRecordSchema.shape.data.parse(record.data) as any).semantic);if(semantic.task!=='market-shape-synthesis'||semantic.synthesis.mode!=='final'||semantic.synthesis.nodeId!==node.nodeId)fail();
 const evidence=await loadMarketShapeSynthesisEvidence(context,actor,moduleRunId,input.inputSnapshotId),catalog=await loadMarketShapeExplanationCatalog(context,actor,moduleRunId);
 same(evidence.shapeExplanationCatalog,catalog);same(evidence.shapeSynthesisChildren,semantic.synthesis.children);sameSet(evidence.shapeSynthesisExpectedLeaves,semantic.synthesis.leafWindowIds);sameSet(node.leafWindowIds,semantic.synthesis.leafWindowIds);
 const audits=new PostgresMarketAgentRunStore(context),bindingId=z.string().uuid().parse(obj(model.step.input).bindingId),binding=await audits.findSnapshotBinding({actor,studyId,moduleRunId,bindingId});if(!binding)fail();
 if(binding.inputSnapshotId!==input.inputSnapshotId||binding.task!=='market-shape-synthesis'||binding.selectionRevision!==catalog.revisionId||binding.inputDigest!==obj(model.step.input).inputDigest||!model.step.inputRefs.some(ref=>ref.kind==='input'&&ref.id===input.inputSnapshotId))fail();
 same(binding.memberRefs,[node.nodeId]);sameSet(binding.sourceRefs,catalog.source.sourceRefs);
 const reference=receipt.parse(model.value.output),audit=await audits.findAgentRun({actor,studyId,moduleRunId,agentRunId:reference.agentRunId});
 if(!audit||audit.id!==reference.agentRunId||audit.bindingId!==binding.id||audit.attemptId!==model.value.id||audit.stepId!==model.step.id||audit.task!=='market-shape-synthesis'||audit.executionFingerprint!==reference.executionFingerprint||audit.validationStatus!=='passed'||audit.terminalStatus!=='succeeded'||!audit.outcome?.output)fail();same(reference,{agentRunId:audit.id,bindingId:audit.bindingId,task:audit.task,executionFingerprint:audit.executionFingerprint});
 const sources:Record<string,any>={};for(const sourceRef of binding.sourceRefs){signal.throwIfAborted();const source=await snapshots.findSource({actor,studyId,id:sourceRef});if(!source)fail();sources[sourceRef]=source.evidence;}
 const validationBinding={scope:view.run.scope,inputSnapshot:saved.snapshot,sourceEvidenceByRef:sources,selectionRevision:binding.selectionRevision,batchKey:binding.batchKey,inputDigest:binding.inputDigest,expectedIds:binding.memberRefs,sourceCatalog:Object.fromEntries(saved.snapshot.records.map(item=>[item.id,MarketSemanticRecordSchema.parse((MarketInputRecordSchema.shape.data.parse(item.data) as any).semantic)])),shapeExplanationCatalog:catalog,shapeSynthesisChildren:evidence.shapeSynthesisChildren,shapeSynthesisExpectedLeaves:evidence.shapeSynthesisExpectedLeaves};
 const checked=validateMarketShapeSynthesisOutput(binding.inputProjection,audit.outcome.output,validationBinding),explanation=validateMarketShapeFinalSynthesisOutput(catalog,semantic.synthesis,checked.result);
 signal.throwIfAborted();return {catalog,report:Object.freeze({reportVersion:'market-shape-explanation-report/v1' as const,moduleRunId,revisionId:catalog.revisionId,explanationCatalogId:catalog.explanationCatalogId,dataReady:true as const,explanation,provenance:Object.freeze({inputSnapshotId:input.inputSnapshotId,modelAttemptId:input.modelAttemptId,roundAttemptId:input.roundAttemptId,windowAttemptId:input.windowAttemptId,agentRunId:audit.id})})};
}
