import {z} from 'zod';
import {MarketInputRecordSchema} from '../../shared/market-analysis-contracts';
import {MarketSemanticRecordSchema} from '../../shared/market-semantic-contracts';
import {MarketOverviewSynthesisReportSchema} from '../../shared/market-overview-report-contracts';
import type {MarketModuleRunView,MarketStepDefinition} from '../db/market-module-execution-repository';
import {PostgresQueryContext} from '../db/postgres/query-context';
import {PostgresMarketAnalysisSnapshotStore} from '../db/postgres/market-analysis-snapshot-store';
import {PostgresMarketAgentRunStore} from '../db/postgres/market-agent-run-store';
import {marketOverviewSynthesisSourceRefs} from '../services/market-overview-synthesis-input-service';
import {validateMarketOverviewSynthesisOutput} from '../domain/market-research/semantic-validation';
import {buildMarketOverviewGapGroupRegistry,validateMarketOverviewFinalSynthesisOutput} from '../domain/market-research/overview-synthesis';
import {MarketOverviewSynthesisReportInputSchema,MarketOverviewSynthesisRoundInputSchema,MarketOverviewSynthesisRoundManifestSchema,marketOverviewSynthesisReportDefinition,marketOverviewSynthesisRoundDefinition} from '../domain/market-research/overview-synthesis-continuation';
import {canonicalJsonSha256 as digest} from './model-request-accounting';

const task='market-overview-synthesis' as const;
const receipt=z.object({agentRunId:z.string().uuid(),bindingId:z.string().uuid(),task:z.literal(task),executionFingerprint:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const obj=(value:unknown):Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
function fail():never{throw new TypeError('Overview synthesis report frozen evidence is unavailable');}
const same=(left:unknown,right:unknown)=>{if(digest(left)!==digest(right))fail();};
const sameSet=(left:readonly string[],right:readonly string[])=>{if(new Set(left).size!==left.length||new Set(right).size!==right.length)fail();same([...left].sort(),[...right].sort());};

/** Named successful attempts are immutable history. Current-attempt fencing is
 * enforced by settlement, while historical reads remain valid after retries. */
export async function readMarketOverviewSynthesisReport(context:PostgresQueryContext,view:MarketModuleRunView,definition:MarketStepDefinition,signal:AbortSignal){
 signal.throwIfAborted();const input=MarketOverviewSynthesisReportInputSchema.parse(definition.input);
 same({stepKey:definition.stepKey,kind:definition.kind,subject:definition.subject,input:definition.input,inputRefs:definition.inputRefs},marketOverviewSynthesisReportDefinition(input));
 if(view.run.moduleKind!=='overview')fail();
 const attempt=(id:string)=>{const value=view.attempts.find(a=>a.id===id),step=view.steps.find(s=>s.id===value?.stepId);if(!value||!step||value.status!=='succeeded')fail();return {value,step};};
 const source=attempt(input.sourceReportAttemptId),round=attempt(input.roundAttemptId),model=attempt(input.modelAttemptId);
 if(source.step.kind!=='report'||obj(source.step.input).task!=='overview-report'||obj(source.step.input).phase!=='window-results'
  ||round.step.kind!=='prepare-members'||obj(round.step.input).phase!=='prepare-overview-synthesis'
  ||model.step.kind!=='model-batch'||obj(model.step.input).task!==task)fail();
 const manifest=MarketOverviewSynthesisRoundManifestSchema.parse(round.value.output),node=manifest.nodes.length===1?manifest.nodes[0]:null;
 if(!node||node.mode!=='final'||node.dimensionId!=='final'||node.inputSnapshotId!==input.inputSnapshotId||manifest.sourceReportAttemptId!==input.sourceReportAttemptId||manifest.carriedChildIds.length)fail();
 const roundInput=MarketOverviewSynthesisRoundInputSchema.parse(round.step.input);
 same(round.step.inputHash,digest(marketOverviewSynthesisRoundDefinition(roundInput)));
 same({sourceReportAttemptId:manifest.sourceReportAttemptId,basisAttemptIds:manifest.basisAttemptIds,childIds:manifest.childIds},
  {sourceReportAttemptId:roundInput.sourceReportAttemptId,basisAttemptIds:roundInput.basisAttemptIds,childIds:roundInput.childIds});
 const actor={organizationId:view.run.scope.organizationId,userId:view.run.createdBy},studyId=view.run.scope.researchId,moduleRunId=view.run.id;
 const snapshots=new PostgresMarketAnalysisSnapshotStore(context),saved=await snapshots.findInput({actor,studyId,id:input.inputSnapshotId});if(!saved)fail();
 if(saved.snapshot.kind!=='overview'||saved.snapshot.records.length!==1||saved.snapshot.expectedRecordIds.length!==1||saved.snapshot.expectedRecordIds[0]!==node.nodeId)fail();same(saved.snapshot.scope,view.run.scope);
 const semantic=MarketSemanticRecordSchema.parse(obj(saved.snapshot.records[0].data).semantic);
 if(semantic.task!==task||semantic.synthesis.mode!=='final'||semantic.synthesis.nodeId!==node.nodeId||saved.snapshot.records[0].id!==node.nodeId||semantic.sourceReportAttemptId!==input.sourceReportAttemptId)fail();
 sameSet(manifest.childIds,semantic.synthesis.directChildIds);
 const audits=new PostgresMarketAgentRunStore(context),bindingId=z.string().uuid().parse(obj(model.step.input).bindingId);
 const validated=await audits.findOverviewSynthesisBinding({actor,studyId,moduleRunId,bindingId},signal);if(!validated)fail();
 const {binding,evidence}=validated,basis=evidence.overviewSynthesisBasis,base=validated.sourceReport;
 same(base.report,source.value.output);if(base.report.windowStatus!=='complete')fail();
 if(!basis||!evidence.overviewSynthesisChildren||!evidence.overviewSynthesisExpectedLeaves)fail();
 same(basis.scope,view.run.scope);same(basis.numericInputSnapshotId,base.report.numericInputSnapshotId);
 if(base.semantic?.task!=='market-overview-explanation')fail();same(basis.facts,base.semantic.facts);same(basis.metrics,base.semantic.metrics);same(basis.gaps,base.semantic.gaps);
 same(evidence.overviewSynthesisChildren,semantic.synthesis.children);sameSet(evidence.overviewSynthesisExpectedLeaves,semantic.synthesis.leafSectionIds);sameSet(node.leafSectionIds,semantic.synthesis.leafSectionIds);
 if(basis.basisId!==semantic.synthesis.basisId||basis.dataCutoffAt!==base.report.dataCutoffAt||basis.configurationVersion!==view.run.versions.configuration)fail();
 if(binding.task!==task||binding.inputSnapshotId!==input.inputSnapshotId||binding.inputDigest!==obj(model.step.input).inputDigest||binding.selectionRevision!==basis.selectionRevision||binding.dataCutoffAt!==basis.dataCutoffAt||!model.step.inputRefs.some(ref=>ref.kind==='input'&&ref.id===input.inputSnapshotId))fail();
 same(binding.memberRefs,[node.nodeId]);sameSet(binding.sourceRefs,marketOverviewSynthesisSourceRefs(basis));
 const reference=receipt.parse(model.value.output),audit=await audits.findAgentRun({actor,studyId,moduleRunId,agentRunId:reference.agentRunId});
 if(!audit||audit.bindingId!==binding.id||audit.attemptId!==model.value.id||audit.stepId!==model.step.id||audit.task!==task||audit.executionFingerprint!==reference.executionFingerprint||audit.validationStatus!=='passed'||audit.terminalStatus!=='succeeded'||!audit.outcome?.output)fail();
 same(reference,{agentRunId:audit.id,bindingId:audit.bindingId,task:audit.task,executionFingerprint:audit.executionFingerprint});
 const sources:Record<string,NonNullable<Awaited<ReturnType<typeof snapshots.findSource>>>['evidence']>={};
 for(const ref of binding.sourceRefs){signal.throwIfAborted();const source=await snapshots.findSource({actor,studyId,id:ref});if(!source)fail();sources[ref]=source.evidence;}
 const checked=validateMarketOverviewSynthesisOutput(binding.inputProjection,audit.outcome.output,{scope:view.run.scope,inputSnapshot:saved.snapshot,sourceEvidenceByRef:sources,
  selectionRevision:binding.selectionRevision,batchKey:binding.batchKey,inputDigest:binding.inputDigest,expectedIds:binding.memberRefs,
  sourceCatalog:Object.fromEntries(saved.snapshot.records.map(record=>[record.id,MarketSemanticRecordSchema.parse(obj(MarketInputRecordSchema.shape.data.parse(record.data)).semantic)])),...evidence});
 const result=validateMarketOverviewFinalSynthesisOutput(semantic.synthesis,checked.result);
 const {reportHash:_oldHash,...original}=base.report;
 const report={...original,reportVersion:'market-overview-report/v2' as const,
  reasons:original.reasons.filter(reason=>!['cross-window-synthesis-not-integrated','distribution-synthesis-not-integrated'].includes(reason)),
  synthesis:{status:'complete' as const,result,dimensionChildren:semantic.synthesis.children,gapGroups:buildMarketOverviewGapGroupRegistry(basis),
   provenance:{sourceReportAttemptId:input.sourceReportAttemptId,sourceReportHash:base.report.reportHash,roundAttemptId:input.roundAttemptId,modelAttemptId:input.modelAttemptId,inputSnapshotId:input.inputSnapshotId,agentRunId:audit.id,basisId:basis.basisId}}};
 signal.throwIfAborted();return {report:MarketOverviewSynthesisReportSchema.parse({...report,reportHash:digest(report)}),numbers:base.numbers,semantic:base.semantic};
}
