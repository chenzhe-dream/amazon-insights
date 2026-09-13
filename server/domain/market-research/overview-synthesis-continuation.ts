import {z} from 'zod';
import {MarketOverviewReportSchema} from '../../../shared/market-overview-report-contracts';
import {MarketOverviewWindowPlanSchema} from './overview-window-plan';
import type {MarketExecutionAttempt,MarketExecutionStep,MarketModuleRunView,MarketStepDefinition} from '../../db/market-module-execution-repository';
import {canonicalJsonSha256 as digest} from '../../runtime/model-request-accounting';
const uuid=z.string().uuid(),hash=z.string().regex(/^[a-f0-9]{64}$/),inputId=z.string().regex(/^market-input:[a-f0-9]{64}$/),id=z.string().min(1).max(240);
const terminal=new Set(['succeeded','empty','failed']);
const obj=(value:unknown):Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
export const MarketOverviewSynthesisRoundInputSchema=z.object({phase:z.literal('prepare-overview-synthesis'),sourceReportAttemptId:uuid,basisAttemptIds:z.array(uuid),childIds:z.array(id).min(1)}).strict();
export const MarketOverviewSynthesisRoundNodeSchema=z.object({nodeId:id,inputSnapshotId:inputId,leafSectionIds:z.array(id).min(1),dimensionId:z.union([id,z.literal('final')]),mode:z.enum(['dimension-reduce','final'])}).strict();
export const MarketOverviewSynthesisRoundManifestSchema=z.object({manifestVersion:z.literal('overview-synthesis-round/v1'),sourceReportAttemptId:uuid,basisAttemptIds:z.array(uuid),childIds:z.array(id).min(1),carriedChildIds:z.array(id),nodes:z.array(MarketOverviewSynthesisRoundNodeSchema).min(1)}).strict();
export const MarketOverviewSynthesisReportInputSchema=z.object({phase:z.literal('overview-synthesis-report'),sourceReportAttemptId:uuid,roundAttemptId:uuid,modelAttemptId:uuid,inputSnapshotId:inputId}).strict();

export type MarketOverviewSynthesisRoundInput=z.infer<typeof MarketOverviewSynthesisRoundInputSchema>;
export type MarketOverviewSynthesisRoundManifest=z.infer<typeof MarketOverviewSynthesisRoundManifestSchema>;
export type MarketOverviewSynthesisReportInput=z.infer<typeof MarketOverviewSynthesisReportInputSchema>;

export function marketOverviewSynthesisPreparation(snapshotId:string,revisionId:string,dataCutoffAt:string):MarketStepDefinition{
 inputId.parse(snapshotId);z.string().min(1).max(240).parse(revisionId);z.string().datetime().parse(dataCutoffAt);
 return {stepKey:`overview-synthesis/model-input/${snapshotId}`,kind:'prepare-model-batches',subject:{task:'market-overview-synthesis'},input:{task:'market-overview-synthesis',inputSnapshotId:snapshotId,selectionRevision:revisionId,dataCutoffAt},inputRefs:[{kind:'input',id:snapshotId}]};
}
export function marketOverviewSynthesisRoundDefinition(value:MarketOverviewSynthesisRoundInput):MarketStepDefinition{
 const input=MarketOverviewSynthesisRoundInputSchema.parse(value);unique([input.sourceReportAttemptId,...input.basisAttemptIds],'round basis');unique(input.childIds,'round children');
 return {stepKey:`overview-synthesis/synthesis-plan/${digest(input)}`,kind:'prepare-members',subject:{task:'market-overview-synthesis'},input,inputRefs:[{kind:'step-output',id:input.sourceReportAttemptId},...input.basisAttemptIds.map(value=>({kind:'step-output' as const,id:value}))]};
}
export function marketOverviewSynthesisReportDefinition(value:MarketOverviewSynthesisReportInput):MarketStepDefinition{
 const input=MarketOverviewSynthesisReportInputSchema.parse(value);unique([input.sourceReportAttemptId,input.roundAttemptId,input.modelAttemptId],'report basis');
 return {stepKey:`overview-synthesis/report/${digest(input)}`,kind:'report',subject:{task:'overview-synthesis-report'},input,inputRefs:[{kind:'step-output',id:input.sourceReportAttemptId},{kind:'step-output',id:input.roundAttemptId},{kind:'step-output',id:input.modelAttemptId},{kind:'input',id:input.inputSnapshotId}]};
}


/** Extends only v5 after the saved, fully audited window report. All identities
 * are rebuilt from the immutable report's own preparation/attempt lineage. */
export function inspectMarketOverviewSynthesisContinuation(view:MarketModuleRunView,sourceReport:MarketExecutionAttempt):{children:MarketStepDefinition[];currentStepKeys:string[]}{
 const children:MarketStepDefinition[]=[],currentStepKeys:string[]=[];const done=()=>({children,currentStepKeys});
 const report=MarketOverviewReportSchema.parse(sourceReport.output);
 if(report.reportVersion!=='market-overview-report/v1'||report.phase!=='window-results'||report.windowStatus!=='complete'||!report.windowAttemptId)return done();
 const windowAttempt=view.attempts.find(a=>a.id===report.windowAttemptId);if(!windowAttempt||windowAttempt.status!=='succeeded')return done();
 const plan=MarketOverviewWindowPlanSchema.parse(windowAttempt.output);
 const find=(definition:MarketStepDefinition)=>{currentStepKeys.push(definition.stepKey);const matches=view.steps.filter(step=>step.stepKey===definition.stepKey);if(matches.length>1||matches[0]&&matches[0].inputHash!==digest(definition))throw new TypeError('Overview synthesis definition differs');return matches[0]};
 const latest=(step:MarketExecutionStep)=>{const attempt=view.attempts.find(value=>value.id===step.latestAttemptId&&value.stepId===step.id);if(!attempt||attempt.status!==step.status&&!(step.status==='failed'&&attempt.status==='interrupted'))throw new TypeError('Overview synthesis latest attempt differs');return attempt};
 let childLeaves=new Map<string,string[]>();
 for(const window of plan.windows){
  const preparations=view.attempts.filter(a=>report.preparationAttemptIds.includes(a.id)&&obj(view.steps.find(s=>s.id===a.stepId)?.input).inputSnapshotId===window.inputSnapshotId);
  if(preparations.length!==1)throw new TypeError('Overview synthesis leaf preparation differs');
  const batches=z.array(z.object({bindingId:uuid})).parse(obj(preparations[0].output).batches);
  if(batches.length!==1)throw new TypeError('Overview synthesis leaf binding differs');
  const results=report.modelResults.filter(r=>r.bindingId===batches[0].bindingId);
  if(results.length!==1||results[0].status!=='succeeded'||!results[0].output?.analysis)return done();
  for(const section of results[0].output.analysis.dimensions){const leafId=`market-overview-synthesis-leaf:${digest({inputSnapshotId:window.inputSnapshotId,dimensionId:section.dimensionId})}`;if(childLeaves.has(leafId))throw new TypeError('Duplicate overview leaf');childLeaves.set(leafId,[leafId]);}
 }
 if(!childLeaves.size)return done();
 const initialCount=childLeaves.size;let basis:string[]=[];
 for(let ordinal=0;ordinal<=initialCount*2+6;ordinal++){
  const roundInput={phase:'prepare-overview-synthesis' as const,sourceReportAttemptId:sourceReport.id,basisAttemptIds:basis,childIds:[...childLeaves.keys()]},definition=marketOverviewSynthesisRoundDefinition(roundInput),round=find(definition);
  if(!round){children.push(definition);return done()}if(!terminal.has(round.status))return done();const roundAttempt=latest(round);if(round.status!=='succeeded')return done();const manifest=validateRound(roundAttempt.output,roundInput,childLeaves);
  const models:MarketExecutionAttempt[]=[];let ready=true;
  for(const node of manifest.nodes){const prep=find(marketOverviewSynthesisPreparation(node.inputSnapshotId,plan.selectionRevision,plan.dataCutoffAt));if(!prep)throw new TypeError('Overview synthesis preparation is missing');if(!terminal.has(prep.status)){ready=false;continue}const prepared=latest(prep);if(prep.status!=='succeeded'){ready=false;continue}const steps=modelSteps(view,prepared,currentStepKeys,'market-overview-synthesis',node.inputSnapshotId,node.nodeId);if(steps.length!==1)throw new TypeError('Overview synthesis needs one batch');if(!terminal.has(steps[0].status)){ready=false;continue}const model=latest(steps[0]);if(steps[0].status!=='succeeded'){ready=false;continue}models.push(model)}
  if(!ready)return done();
  if(manifest.nodes.length===1&&manifest.nodes[0].mode==='final'){const node=manifest.nodes[0],definition=marketOverviewSynthesisReportDefinition({phase:'overview-synthesis-report',sourceReportAttemptId:sourceReport.id,roundAttemptId:roundAttempt.id,modelAttemptId:models[0].id,inputSnapshotId:node.inputSnapshotId});if(!find(definition))children.push(definition);return done()}
  const next=new Map<string,string[]>();for(const carried of manifest.carriedChildIds)next.set(carried,childLeaves.get(carried)!);for(const node of manifest.nodes)next.set(node.nodeId,node.leafSectionIds);childLeaves=next;basis=[roundAttempt.id,...models.map(a=>a.id)];
 }
 throw new TypeError('Overview synthesis continuation exceeds reduction bound');
}
function modelSteps(view:MarketModuleRunView,attempt:MarketExecutionAttempt,current:string[],task:'market-overview-synthesis',snapshotId:string,memberId:string){const manifest=z.object({plannerVersion:z.string(),basisHash:z.string(),task:z.literal(task),inputSnapshotId:inputId,expectedMemberIds:z.array(id),missingMemberIds:z.array(id),rejectedMembers:z.array(z.unknown()),batches:z.array(z.object({bindingId:uuid,batchKey:z.string(),inputDigest:hash,memberRefs:z.array(id)}).strict())}).strict().parse(attempt.output);if(manifest.inputSnapshotId!==snapshotId||digest(manifest.expectedMemberIds)!==digest([memberId])||manifest.missingMemberIds.length||manifest.rejectedMembers.length||manifest.batches.length!==1)throw new TypeError('Overview model preparation manifest differs');unique(manifest.batches.map(value=>value.bindingId),'model bindings');return manifest.batches.map(binding=>{if(digest(binding.memberRefs)!==digest([memberId]))throw new TypeError('Overview model batch members differ');const definition:MarketStepDefinition={stepKey:`model/${binding.batchKey}`,kind:'model-batch',subject:{task},input:{task,bindingId:binding.bindingId,inputDigest:binding.inputDigest},inputRefs:[{kind:'input',id:snapshotId}]},matches=view.steps.filter(step=>step.stepKey===definition.stepKey);if(matches.length!==1||matches[0].inputHash!==digest(definition))throw new TypeError('Overview explanation model step is missing or conflicting');current.push(matches[0].stepKey);return matches[0]})}
function validateRound(value:unknown,input:MarketOverviewSynthesisRoundInput,current:Map<string,string[]>){
 const manifest=MarketOverviewSynthesisRoundManifestSchema.parse(value);
 const lineage=(source:{sourceReportAttemptId:string;basisAttemptIds:string[];childIds:string[]})=>({sourceReportAttemptId:source.sourceReportAttemptId,basisAttemptIds:source.basisAttemptIds,childIds:source.childIds});
 if(digest(lineage(manifest))!==digest(lineage(input)))throw new TypeError('Overview synthesis round basis differs');
 unique(manifest.childIds,'round children');if(digest(manifest.childIds)!==digest([...current.keys()]))throw new TypeError('Overview synthesis round children differ');
 unique(manifest.carriedChildIds,'carried children');unique(manifest.nodes.map(node=>node.nodeId),'round nodes');unique(manifest.nodes.map(node=>node.inputSnapshotId),'round snapshots');
 if(manifest.carriedChildIds.some(child=>!current.has(child))||manifest.nodes.some(node=>current.has(node.nodeId)||manifest.carriedChildIds.includes(node.nodeId)))throw new TypeError('Unknown or reused synthesis child');
 const expected=[...current.values()].flat(),actual=[...manifest.carriedChildIds.flatMap(child=>current.get(child)!),...manifest.nodes.flatMap(node=>node.leafSectionIds)];
 unique(actual,'round leaves');if(actual.length!==expected.length||actual.some(leaf=>!expected.includes(leaf)))throw new TypeError('Overview synthesis round leaf coverage differs');
 if(!manifest.nodes.some(node=>node.mode==='final')&&manifest.carriedChildIds.length+manifest.nodes.length>=current.size)throw new TypeError('Overview synthesis round does not reduce');
 for(const node of manifest.nodes)if((node.mode==='final')!==(node.dimensionId==='final'))throw new TypeError('Overview synthesis node mode differs');
 if(manifest.nodes.some(node=>node.mode==='final')&&(manifest.nodes.length!==1||manifest.carriedChildIds.length))throw new TypeError('Final synthesis round must have one node');
 return manifest;
}
function unique(values:readonly string[],label:string){if(new Set(values).size!==values.length)throw new TypeError(`Duplicate ${label}`)}
