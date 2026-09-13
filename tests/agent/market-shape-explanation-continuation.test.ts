import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {buildMarketShapeExplanationCatalog} from '../../server/domain/market-research/shape-explanation-catalog';
import {buildMarketShapeExplanationWindows} from '../../server/domain/market-research/shape-explanation-wire';
import {createMarketInputSnapshot} from '../../server/domain/market-research/snapshot';
import {marketShapeExplanationInitialSteps} from '../../server/domain/market-research/shape-explanation-flow';
import {inspectMarketShapeExplanationContinuation, marketShapeExplanationReportDefinition, marketShapeSynthesisPreparation, marketShapeSynthesisRoundDefinition} from '../../server/domain/market-research/shape-explanation-continuation';
import {canonicalJsonSha256 as digest} from '../../server/runtime/model-request-accounting';
import type {MarketModuleRunView, MarketStepDefinition} from '../../server/db/market-module-execution-repository';
import {sourceCatalog} from './helpers/market-shape-explanation-fixture';

const now='2026-09-13T00:00:00.000Z';
const succeeded=(definition:MarketStepDefinition,output:any)=>{const id=randomUUID(),attemptId=randomUUID();return {step:{...definition,id,inputHash:digest(definition),status:'succeeded' as const,attemptCount:1,retryRound:0,latestAttemptId:attemptId},attempt:{id:attemptId,stepId:id,attemptNumber:1,retryRound:0,leaseGeneration:1,status:'succeeded' as const,output,error:null}}};

test('synthesis definitions freeze their complete lineage',()=>{
 const windowAttemptId=randomUUID(),basisAttemptIds=[randomUUID(),randomUUID()],childIds=['a','b'];
 const round=marketShapeSynthesisRoundDefinition({phase:'prepare-shape-synthesis',windowAttemptId,basisAttemptIds,childIds});
 assert.equal(round.stepKey,`shape-explanation/synthesis-plan/${digest(round.input)}`);assert.deepEqual(round.inputRefs.map(ref=>ref.id),[windowAttemptId,...basisAttemptIds]);
 const preparation=marketShapeSynthesisPreparation('market-input:'+'a'.repeat(64),'market-shape-revision:'+'b'.repeat(64),now);assert.equal(preparation.inputRefs[0].id,'market-input:'+'a'.repeat(64));
 const report=marketShapeExplanationReportDefinition({phase:'shape-explanation-report',windowAttemptId,roundAttemptId:randomUUID(),modelAttemptId:randomUUID(),inputSnapshotId:'market-input:'+'c'.repeat(64)});assert.equal(report.inputRefs.length,4);
 assert.throws(()=>marketShapeSynthesisRoundDefinition({phase:'prepare-shape-synthesis',windowAttemptId,basisAttemptIds:[basisAttemptIds[0],basisAttemptIds[0]],childIds}),/Duplicate/);
});

test('v2 completed leaf frontier schedules one lineage-bound synthesis round and rejects non-reduction',async()=>{
 const catalog=buildMarketShapeExplanationCatalog(await sourceCatalog()),windows=await buildMarketShapeExplanationWindows(catalog,()=>true),sourceRefs=catalog.source.sourceRefs,{requestedAsins:_requested,eligibleAsins:_eligible,...scope}=catalog.scope;
 const run:any={id:randomUUID(),scope,moduleKind:'shape-price',params:{flow:'shape-explanation/v1',parentRunId:randomUUID(),revisionId:catalog.revisionId,explanationCatalogId:catalog.explanationCatalogId},versions:{source:catalog.version,rule:catalog.version,mapping:catalog.explanationCatalogId,planner:'shape-explanation/v1',model:'market.semantic.text.v1',prompt:'p',configuration:'c'},collectionRevision:catalog.revisionId,status:'running',createdBy:randomUUID(),createdAt:now,planRevision:1,latestReportAttemptId:null};
 const anchor=succeeded(marketShapeExplanationInitialSteps(run)[0],{manifestVersion:'shape-explanation-windows/v2',explanationCatalogId:catalog.explanationCatalogId,revisionId:catalog.revisionId,sourceRefs,windows});
 const steps:any[]=[anchor.step],attempts:any[]=[anchor.attempt];
 for(const [index,window] of windows.entries()){
  const snapshot=createMarketInputSnapshot({scope:run.scope,kind:'overview',sourceVersion:run.versions.source,ruleVersion:'shape-explanation/v1',collectedAt:catalog.source.dataCutoffAt,expectedRecordIds:[window.windowId],records:[{id:window.windowId,scope:run.scope,data:{semantic:{task:'market-shape-structure-explanation',window,sourceRefs}}}]});
  const bindingId=randomUUID(),inputDigest=String(index).padStart(64,'0'),batchKey=`market-batch:${digest(window.windowId)}`,batch={bindingId,batchKey,inputDigest,memberRefs:[window.windowId]},preparation=succeeded({stepKey:`shape-explanation/model-input/${snapshot.snapshotId}`,kind:'prepare-model-batches',subject:{task:'market-shape-structure-explanation'},input:{task:'market-shape-structure-explanation',inputSnapshotId:snapshot.snapshotId,selectionRevision:catalog.revisionId,dataCutoffAt:catalog.source.dataCutoffAt},inputRefs:[{kind:'input',id:snapshot.snapshotId}]},{plannerVersion:'market-semantic-batches/v1',basisHash:'b'.repeat(64),task:'market-shape-structure-explanation',inputSnapshotId:snapshot.snapshotId,expectedMemberIds:[window.windowId],missingMemberIds:[],rejectedMembers:[],batches:[batch]});
  const model=succeeded({stepKey:`model/${batchKey}`,kind:'model-batch',subject:{task:'market-shape-structure-explanation'},input:{task:'market-shape-structure-explanation',bindingId,inputDigest},inputRefs:[{kind:'input',id:snapshot.snapshotId}]},{ok:true});steps.push(preparation.step,model.step);attempts.push(preparation.attempt,model.attempt);
 }
 const view:MarketModuleRunView={run,steps,attempts},first=inspectMarketShapeExplanationContinuation(view,now);assert.equal(first.children.length,1);assert.equal(first.children[0].kind,'prepare-members');assert.deepEqual((first.children[0].input as any).childIds,windows.map(window=>window.windowId));
 const emptyView=structuredClone(view),firstPreparation=emptyView.steps.find(step=>step.kind==='prepare-model-batches')!,firstPreparationAttempt=emptyView.attempts.find(attempt=>attempt.id===firstPreparation.latestAttemptId)!;(firstPreparationAttempt.output as any).batches=[];assert.throws(()=>inspectMarketShapeExplanationContinuation(emptyView,now),/preparation manifest/);
 const round=succeeded(first.children[0],{manifestVersion:'shape-synthesis-round/v1',windowAttemptId:anchor.attempt.id,basisAttemptIds:(first.children[0].input as any).basisAttemptIds,childIds:windows.map(window=>window.windowId),carriedChildIds:windows.map(window=>window.windowId),nodes:[{nodeId:'n',inputSnapshotId:'market-input:'+'d'.repeat(64),leafWindowIds:[windows[0].windowId],dimension:windows[0].dimension,mode:'dimension-reduce'}]});
 assert.throws(()=>inspectMarketShapeExplanationContinuation({run,steps:[...steps,round.step],attempts:[...attempts,round.attempt]},now),/round leaves|leaf coverage|does not reduce/);
});

test('cancelled and legacy runs never schedule synthesis',async()=>{
 const catalog=buildMarketShapeExplanationCatalog(await sourceCatalog()),windows=await buildMarketShapeExplanationWindows(catalog,()=>true),run:any={id:randomUUID(),scope:catalog.scope,moduleKind:'shape-price',params:{flow:'shape-explanation/v1',parentRunId:randomUUID(),revisionId:catalog.revisionId,explanationCatalogId:catalog.explanationCatalogId},versions:{source:catalog.version,rule:catalog.version,mapping:catalog.explanationCatalogId,planner:'shape-explanation/v1',model:'market.semantic.text.v1',prompt:'p',configuration:'c'},collectionRevision:catalog.revisionId,status:'cancelled',createdBy:randomUUID(),createdAt:now,planRevision:1,latestReportAttemptId:null};
 assert.deepEqual(inspectMarketShapeExplanationContinuation({run,steps:[],attempts:[]},now),{children:[],currentStepKeys:[]});run.status='running';const anchor=succeeded(marketShapeExplanationInitialSteps(run)[0],{manifestVersion:'shape-explanation-windows/v1',explanationCatalogId:catalog.explanationCatalogId,revisionId:catalog.revisionId,windows}),legacy=inspectMarketShapeExplanationContinuation({run,steps:[anchor.step],attempts:[anchor.attempt]},now);assert.deepEqual(legacy.children,[]);assert.deepEqual(legacy.currentStepKeys,[anchor.step.stepKey]);
});
