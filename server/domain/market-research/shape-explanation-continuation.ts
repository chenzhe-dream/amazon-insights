import {z} from 'zod';
import {MarketShapeExplanationWindowSchema} from '../../../shared/market-shape-explanation-wire-contracts';
import {MARKET_SHAPE_EXPLANATION_DIMENSIONS, MarketShapeExplanationDimensionSchema} from '../../../shared/market-shape-explanation-contracts';
import type {MarketJsonValue} from '../../../shared/market-analysis-contracts';
import type {MarketExecutionAttempt, MarketExecutionStep, MarketModuleRunView, MarketStepDefinition} from '../../db/market-module-execution-repository';
import {canonicalJsonSha256 as digest} from '../../runtime/model-request-accounting';
import {createMarketInputSnapshot} from './snapshot';
import {isMarketShapeExplanationFlow, marketShapeExplanationInitialSteps} from './shape-explanation-flow';

const uuid=z.string().uuid(), hash=z.string().regex(/^[a-f0-9]{64}$/), inputId=z.string().regex(/^market-input:[a-f0-9]{64}$/), id=z.string().min(1).max(240);
const terminal=new Set(['succeeded','empty','failed']);
const obj=(value:unknown):Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};

export const MarketShapeExplanationWindowManifestSchema=z.object({
 manifestVersion:z.literal('shape-explanation-windows/v2'), explanationCatalogId:z.string().regex(/^market-shape-explanation:[a-f0-9]{64}$/), revisionId:z.string().regex(/^market-shape-revision:[a-f0-9]{64}$/), sourceRefs:z.array(z.string().regex(/^market-source:[a-f0-9]{64}$/)).min(1), windows:z.array(MarketShapeExplanationWindowSchema).min(1),
}).strict();
export const MarketShapeSynthesisRoundInputSchema=z.object({phase:z.literal('prepare-shape-synthesis'),windowAttemptId:uuid,basisAttemptIds:z.array(uuid).min(1),childIds:z.array(id).min(1)}).strict();
export const MarketShapeSynthesisRoundNodeSchema=z.object({nodeId:id,inputSnapshotId:inputId,leafWindowIds:z.array(id).min(1),dimension:z.union([MarketShapeExplanationDimensionSchema,z.literal('final')]),mode:z.enum(['dimension-reduce','final'])}).strict();
export const MarketShapeSynthesisRoundManifestSchema=z.object({manifestVersion:z.literal('shape-synthesis-round/v1'),windowAttemptId:uuid,basisAttemptIds:z.array(uuid).min(1),childIds:z.array(id).min(1),carriedChildIds:z.array(id),nodes:z.array(MarketShapeSynthesisRoundNodeSchema).min(1)}).strict();
export const MarketShapeExplanationReportInputSchema=z.object({phase:z.literal('shape-explanation-report'),windowAttemptId:uuid,roundAttemptId:uuid,modelAttemptId:uuid,inputSnapshotId:inputId}).strict();

export type MarketShapeSynthesisRoundInput=z.infer<typeof MarketShapeSynthesisRoundInputSchema>;
export type MarketShapeSynthesisRoundManifest=z.infer<typeof MarketShapeSynthesisRoundManifestSchema>;
export type MarketShapeExplanationReportInput=z.infer<typeof MarketShapeExplanationReportInputSchema>;

export function marketShapeSynthesisPreparation(snapshotId:string,revisionId:string,dataCutoffAt:string):MarketStepDefinition{
 inputId.parse(snapshotId);z.string().regex(/^market-shape-revision:[a-f0-9]{64}$/).parse(revisionId);z.string().datetime().parse(dataCutoffAt);
 return {stepKey:`shape-explanation/model-input/${snapshotId}`,kind:'prepare-model-batches',subject:{task:'market-shape-synthesis'},input:{task:'market-shape-synthesis',inputSnapshotId:snapshotId,selectionRevision:revisionId,dataCutoffAt},inputRefs:[{kind:'input',id:snapshotId}]};
}
export function marketShapeSynthesisRoundDefinition(value:MarketShapeSynthesisRoundInput):MarketStepDefinition{
 const input=MarketShapeSynthesisRoundInputSchema.parse(value);unique([input.windowAttemptId,...input.basisAttemptIds],'round basis');unique(input.childIds,'round children');
 return {stepKey:`shape-explanation/synthesis-plan/${digest(input)}`,kind:'prepare-members',subject:{task:'market-shape-synthesis'},input,inputRefs:[{kind:'step-output',id:input.windowAttemptId},...input.basisAttemptIds.map(value=>({kind:'step-output' as const,id:value}))]};
}
export function marketShapeExplanationReportDefinition(value:MarketShapeExplanationReportInput):MarketStepDefinition{
 const input=MarketShapeExplanationReportInputSchema.parse(value);unique([input.windowAttemptId,input.roundAttemptId,input.modelAttemptId],'report basis');
 return {stepKey:`shape-explanation/report/${digest(input)}`,kind:'report',subject:{task:'shape-explanation-report'},input,inputRefs:[{kind:'step-output',id:input.windowAttemptId},{kind:'step-output',id:input.roundAttemptId},{kind:'step-output',id:input.modelAttemptId},{kind:'input',id:input.inputSnapshotId}]};
}

export function inspectMarketShapeExplanationContinuation(view:MarketModuleRunView,now:string):{children:MarketStepDefinition[];currentStepKeys:string[]}{
 const children:MarketStepDefinition[]=[],currentStepKeys:string[]=[];const done=()=>({children,currentStepKeys});
 if(!isMarketShapeExplanationFlow(view.run)||view.run.status==='cancelled')return done();z.string().datetime().parse(now);
 const find=(definition:MarketStepDefinition,missing='missing')=>{currentStepKeys.push(definition.stepKey);const matches=view.steps.filter(step=>step.stepKey===definition.stepKey);if(matches.length>1||matches[0]&&matches[0].inputHash!==digest(definition))throw new TypeError(`Shape explanation ${missing} definition differs`);return matches[0]};
 const latest=(step:MarketExecutionStep)=>{const attempt=view.attempts.find(value=>value.id===step.latestAttemptId&&value.stepId===step.id);if(!attempt||attempt.status!==step.status&&!(step.status==='failed'&&attempt.status==='interrupted'))throw new TypeError('Shape explanation latest attempt differs');return attempt};
 const anchor=find(marketShapeExplanationInitialSteps(view.run)[0],'anchor');if(!anchor)throw new TypeError('Shape explanation anchor is missing');if(!terminal.has(anchor.status))return done();const windowAttempt=latest(anchor);if(anchor.status!=='succeeded')return done();
 const rawManifest=obj(windowAttempt.output);if(rawManifest.manifestVersion==='shape-explanation-windows/v1'){for(const step of view.steps)if(!currentStepKeys.includes(step.stepKey))currentStepKeys.push(step.stepKey);return done()}
 const manifest=MarketShapeExplanationWindowManifestSchema.parse(rawManifest),params=obj(view.run.params);if(manifest.explanationCatalogId!==params.explanationCatalogId||manifest.revisionId!==params.revisionId)throw new TypeError('Shape explanation window manifest identity differs');
 unique(manifest.sourceRefs,'window sources');validateWindows(manifest.windows);const cutoff=manifest.windows[0].source.dataCutoffAt;
 const {organizationId:_organizationId,researchId:_researchId,...publicScope}=view.run.scope;
 if(manifest.windows.some(window=>window.explanationCatalogId!==manifest.explanationCatalogId||window.revisionId!==manifest.revisionId||window.source.dataCutoffAt!==cutoff||digest(window.scope)!==digest(publicScope)))throw new TypeError('Shape explanation windows differ from manifest');
 const leafAttempts:MarketExecutionAttempt[]=[];let leavesReady=true;
 for(const window of manifest.windows){const snapshot=createMarketInputSnapshot({scope:view.run.scope,kind:'overview',sourceVersion:view.run.versions.source,ruleVersion:'shape-explanation/v1',collectedAt:cutoff,expectedRecordIds:[window.windowId],records:[{id:window.windowId,scope:view.run.scope,data:{semantic:{task:'market-shape-structure-explanation',window,sourceRefs:manifest.sourceRefs}} as MarketJsonValue}]});const preparation=find(windowPreparation(snapshot.snapshotId,manifest.revisionId,cutoff),'window preparation');if(!preparation)throw new TypeError('Shape explanation window preparation is missing');if(!terminal.has(preparation.status)){leavesReady=false;continue}const prepared=latest(preparation);if(preparation.status!=='succeeded'){leavesReady=false;continue}const models=modelSteps(view,prepared,currentStepKeys,'market-shape-structure-explanation',snapshot.snapshotId,window.windowId);if(models.length!==1)throw new TypeError('Shape explanation window requires exactly one model batch');if(!terminal.has(models[0].status)){leavesReady=false;continue}const modelAttempt=latest(models[0]);if(models[0].status!=='succeeded'){leavesReady=false;continue}leafAttempts.push(modelAttempt)}
 if(!leavesReady)return done();
 let childLeaves=new Map(manifest.windows.map(window=>[window.windowId,[window.windowId]])),basis=leafAttempts.map(value=>value.id);
 for(let ordinal=0;ordinal<=manifest.windows.length*2+6;ordinal++){
  const roundInput={phase:'prepare-shape-synthesis' as const,windowAttemptId:windowAttempt.id,basisAttemptIds:basis,childIds:[...childLeaves.keys()]},definition=marketShapeSynthesisRoundDefinition(roundInput),round=find(definition,'synthesis round');
  if(!round){children.push(definition);return done()}if(!terminal.has(round.status))return done();const roundAttempt=latest(round);if(round.status!=='succeeded')return done();const roundManifest=validateRound(roundAttempt.output,roundInput,childLeaves);
  const modelAttempts:MarketExecutionAttempt[]=[];let nodesReady=true;
  for(const node of roundManifest.nodes){const preparation=find(marketShapeSynthesisPreparation(node.inputSnapshotId,manifest.revisionId,cutoff),'synthesis preparation');if(!preparation)throw new TypeError('Shape synthesis preparation is missing');if(!terminal.has(preparation.status)){nodesReady=false;continue}const prepared=latest(preparation);if(preparation.status!=='succeeded'){nodesReady=false;continue}const models=modelSteps(view,prepared,currentStepKeys,'market-shape-synthesis',node.inputSnapshotId,node.nodeId);if(models.length!==1)throw new TypeError('Shape synthesis requires exactly one model batch');if(!terminal.has(models[0].status)){nodesReady=false;continue}const modelAttempt=latest(models[0]);if(models[0].status!=='succeeded'){nodesReady=false;continue}modelAttempts.push(modelAttempt)}
  if(!nodesReady)return done();
  if(roundManifest.nodes.length===1&&roundManifest.nodes[0].mode==='final'){const node=roundManifest.nodes[0],report=marketShapeExplanationReportDefinition({phase:'shape-explanation-report',windowAttemptId:windowAttempt.id,roundAttemptId:roundAttempt.id,modelAttemptId:modelAttempts[0].id,inputSnapshotId:node.inputSnapshotId}),saved=find(report,'report');if(!saved)children.push(report);return done()}
  const next=new Map<string,string[]>();for(const carried of roundManifest.carriedChildIds)next.set(carried,childLeaves.get(carried)!);for(const node of roundManifest.nodes)next.set(node.nodeId,node.leafWindowIds);childLeaves=next;basis=[roundAttempt.id,...modelAttempts.map(value=>value.id)];
 }
 throw new TypeError('Shape synthesis continuation exceeds its reduction bound');
}

function windowPreparation(snapshotId:string,revisionId:string,dataCutoffAt:string):MarketStepDefinition{return {stepKey:`shape-explanation/model-input/${snapshotId}`,kind:'prepare-model-batches',subject:{task:'market-shape-structure-explanation'},input:{task:'market-shape-structure-explanation',inputSnapshotId:snapshotId,selectionRevision:revisionId,dataCutoffAt},inputRefs:[{kind:'input',id:snapshotId}]}}
function validateWindows(windows:z.infer<typeof MarketShapeExplanationWindowSchema>[]){unique(windows.map(window=>window.windowId),'window identities');unique(windows.flatMap(window=>window.coverage.rowIds),'window rows');for(const window of windows){const {windowId,...body}=window;if(windowId!==`market-shape-explanation-window:${digest(body)}`)throw new TypeError('Shape explanation window digest differs')}for(const dimension of MARKET_SHAPE_EXPLANATION_DIMENSIONS){const parts=windows.filter(window=>window.dimension===dimension).sort((a,b)=>a.fragment.ordinal-b.fragment.ordinal);if(!parts.length||parts.some((part,index)=>part.fragment.count!==parts.length||part.fragment.ordinal!==index+1)||parts.reduce((count,part)=>count+part.coverage.rowIds.length,0)!==parts[0].coverage.dimensionRowCount)throw new TypeError('Shape explanation window dimension coverage differs')}}
function modelSteps(view:MarketModuleRunView,attempt:MarketExecutionAttempt,current:string[],task:'market-shape-structure-explanation'|'market-shape-synthesis',snapshotId:string,memberId:string){const manifest=z.object({plannerVersion:z.string(),basisHash:z.string(),task:z.literal(task),inputSnapshotId:inputId,expectedMemberIds:z.array(id),missingMemberIds:z.array(id),rejectedMembers:z.array(z.unknown()),batches:z.array(z.object({bindingId:uuid,batchKey:z.string(),inputDigest:hash,memberRefs:z.array(id)}).strict())}).strict().parse(attempt.output);if(manifest.inputSnapshotId!==snapshotId||digest(manifest.expectedMemberIds)!==digest([memberId])||manifest.missingMemberIds.length||manifest.rejectedMembers.length||manifest.batches.length!==1)throw new TypeError('Shape model preparation manifest differs');unique(manifest.batches.map(value=>value.bindingId),'model bindings');return manifest.batches.map(binding=>{if(digest(binding.memberRefs)!==digest([memberId]))throw new TypeError('Shape model batch members differ');const definition:MarketStepDefinition={stepKey:`model/${binding.batchKey}`,kind:'model-batch',subject:{task},input:{task,bindingId:binding.bindingId,inputDigest:binding.inputDigest},inputRefs:[{kind:'input',id:snapshotId}]},matches=view.steps.filter(step=>step.stepKey===definition.stepKey);if(matches.length!==1||matches[0].inputHash!==digest(definition))throw new TypeError('Shape explanation model step is missing or conflicting');current.push(matches[0].stepKey);return matches[0]})}
function validateRound(value:unknown,input:MarketShapeSynthesisRoundInput,current:Map<string,string[]>){
 const manifest=MarketShapeSynthesisRoundManifestSchema.parse(value);
 const lineage=(source:{windowAttemptId:string;basisAttemptIds:string[];childIds:string[]})=>({windowAttemptId:source.windowAttemptId,basisAttemptIds:source.basisAttemptIds,childIds:source.childIds});
 if(digest(lineage(manifest))!==digest(lineage(input)))throw new TypeError('Shape synthesis round basis differs');
 unique(manifest.childIds,'round children');if(digest(manifest.childIds)!==digest([...current.keys()]))throw new TypeError('Shape synthesis round children differ');
 unique(manifest.carriedChildIds,'carried children');unique(manifest.nodes.map(node=>node.nodeId),'round nodes');unique(manifest.nodes.map(node=>node.inputSnapshotId),'round snapshots');
 if(manifest.carriedChildIds.some(child=>!current.has(child))||manifest.nodes.some(node=>current.has(node.nodeId)||manifest.carriedChildIds.includes(node.nodeId)))throw new TypeError('Unknown or reused synthesis child');
 const expected=[...current.values()].flat(),actual=[...manifest.carriedChildIds.flatMap(child=>current.get(child)!),...manifest.nodes.flatMap(node=>node.leafWindowIds)];
 unique(actual,'round leaves');if(actual.length!==expected.length||actual.some(leaf=>!expected.includes(leaf)))throw new TypeError('Shape synthesis round leaf coverage differs');
 if(manifest.carriedChildIds.length+manifest.nodes.length>=current.size)throw new TypeError('Shape synthesis round does not reduce');
 for(const node of manifest.nodes)if((node.mode==='final')!==(node.dimension==='final'))throw new TypeError('Shape synthesis node mode differs');
 if(manifest.nodes.some(node=>node.mode==='final')&&(manifest.nodes.length!==1||manifest.carriedChildIds.length))throw new TypeError('Final synthesis round must have one node');
 return manifest;
}
function unique(values:readonly string[],label:string){if(new Set(values).size!==values.length)throw new TypeError(`Duplicate ${label}`)}
