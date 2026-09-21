import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { marketKeywordReconciliationPage as page, marketKeywordReconciliationPageDefinition as definition, MARKET_KEYWORD_RECONCILIATION_EVALUATION_VERSION } from '../../server/domain/market-research/keyword-reconciliation-pages';
import { inspectMarketKeywordReconciliationFlow as inspect } from '../../server/domain/market-research/keyword-reconciliation-flow';
import { canonicalJsonSha256 as digest } from '../../server/runtime/model-request-accounting';
import type { MarketModuleRunView, MarketStepDefinition, MarketExecutionStep } from '../../server/db/market-module-execution-repository';
const hash='a'.repeat(64), date='2020-03-01T00:00:00.000Z';
const anchor={poolAttemptId:randomUUID(),preparationAttemptId:randomUUID(),modelAttemptIds:[randomUUID()]};
function plan(n=5,round=0){let materialized=0;return {get materialized(){return materialized;},value:{status:'needs-model',round,planHash:hash,baseHash:hash,initialResultHash:hash,result:null,windows:Array.from({length:n},(_,i)=>({id:`window-${round}-${i}`,dimension:'W1',selectionRevision:`selection-${round}-${i}`,memberIds:['k'],candidateIds:['c'],materializeSnapshot:()=>{materialized++;return {snapshotId:`market-input:${digest({round,i})}`,scope:{},kind:'keywords',sourceVersion:'v1',ruleVersion:'v1',collectedAt:date,expectedRecordIds:['k'],records:[]};}}))} as any};}
function view(){return {run:{},steps:[],attempts:[]} as unknown as MarketModuleRunView;}
function save(v:MarketModuleRunView,d:MarketStepDefinition,output:any={},status:'succeeded'|'failed'|'running'='succeeded'){
 const id=randomUUID(),aid=randomUUID(); const s:MarketExecutionStep={...d,id,inputHash:digest(d),status,attemptCount:1,retryRound:0,latestAttemptId:aid}; v.steps.push(s);v.attempts.push({id:aid,stepId:id,attemptNumber:1,retryRound:0,leaseGeneration:1,status,output,error:null});return s;
}
function addPage(v:MarketModuleRunView,d:MarketStepDefinition,p:any){const built=page(p,(d.input as any).offset);const s=save(v,d,built.output);for(const c of built.children){const batchKey=randomUUID(),bindingId=randomUUID();save(v,c,{task:'market-keyword-semantics',inputSnapshotId:(c.input as any).inputSnapshotId,batches:[{batchKey,bindingId,inputDigest:hash}]});save(v,{stepKey:`model/${batchKey}`,kind:'model-batch',subject:{task:'market-keyword-semantics'},input:{task:'market-keyword-semantics',bindingId,inputDigest:hash},inputRefs:c.inputRefs});}return s;}
test('cancelled runs retain an unstarted reconciliation frontier without accepting forged history',()=>{
 const v=view(),d=definition(anchor,[]);v.run.status='cancelled';
 v.steps.push({...d,id:randomUUID(),inputHash:digest(d),status:'cancelled',attemptCount:0,retryRound:0,latestAttemptId:null});
 const read=inspect(v,anchor,new Set());assert.deepEqual(read.children,[]);assert.deepEqual(read.currentStepKeys,[d.stepKey]);
 for(const mutate of [(x:MarketModuleRunView)=>{x.run.status='running';},(x:MarketModuleRunView)=>{x.steps[0].attemptCount=1;},(x:MarketModuleRunView)=>{x.steps[0].inputHash=hash;},(x:MarketModuleRunView)=>{x.steps[0].inputRefs=[];},(x:MarketModuleRunView)=>{x.steps[0].latestAttemptId=randomUUID();}]){
  const bad=structuredClone(v);mutate(bad);assert.throws(()=>inspect(bad,anchor,new Set()));
 }
});
test('page materializes exactly the selected four snapshots once and never touches other windows',()=>{const p=plan();const b=page(p.value,0);assert.equal(p.materialized,4);assert.equal(b.inputs.length,4);assert.equal(b.output.nextOffset,4);assert.equal(b.children.length,4);assert.throws(()=>page(p.value,1));});
test('page keys bind every prior authority including previous-page attempt',()=>{const a=definition(anchor,[],{offset:4,planHash:hash,previousPageAttemptId:randomUUID()});const b=definition(anchor,[],{offset:4,planHash:hash,previousPageAttemptId:randomUUID()});assert.notEqual(a.stepKey,b.stepKey);assert.throws(()=>definition({...anchor,modelAttemptIds:[anchor.modelAttemptIds[0],anchor.modelAttemptIds[0]]},[]));});
test('waiting and terminal planner outputs need no model or evaluation child',()=>{for(const status of ['waiting-initial-models','ready','partial']){const v=view(),p=plan(0).value;p.status=status;p.result=status==='waiting-initial-models'?null:{resultHash:hash};const d=definition(anchor,[]),b=page(p,0);save(v,d,b.output);const r=inspect(v,anchor,new Set());assert.equal(r.status,status);assert.deepEqual(r.children,[]);}});
test('multiple pages schedule evaluation only after all exact model children terminate',()=>{const v=view(),p=plan();let r=inspect(v,anchor,new Set());addPage(v,r.children[0],p.value);r=inspect(v,anchor,new Set());assert.equal((r.children[0].input as any).offset,4);addPage(v,r.children[0],p.value);r=inspect(v,anchor,new Set());assert.equal((r.children[0].input as any).task,'keyword-reconciliation-evaluate');const evalStep=save(v,r.children[0],{version:MARKET_KEYWORD_RECONCILIATION_EVALUATION_VERSION,completedRound:0,anchorHash:digest(anchor),frontierHash:(r.children[0].input as any).frontierHash,status:'partial',planHash:hash,resultHash:hash,inputSnapshotId:`market-input:${hash}`});assert.equal(inspect(v,anchor,new Set()).status,'partial');const model=v.steps.find(s=>s.kind==='model-batch')!;const oldEval=evalStep.stepKey;const a=v.attempts.find(a=>a.id===model.latestAttemptId)!;a.id=randomUUID();model.latestAttemptId=a.id;assert.notEqual(inspect(v,anchor,new Set()).children[0].stepKey,oldEval);});
test('reject forged refs, input hashes, status mismatches and missing model children',()=>{for(const mutate of [(v:any)=>{v.steps[1].inputRefs=[];const {stepKey,kind,subject,input,inputRefs}=v.steps[1];v.steps[1].inputHash=digest({stepKey,kind,subject,input,inputRefs});},(v:any)=>{v.steps[0].inputHash=hash;},(v:any)=>{v.attempts[0].status='running';},(v:any)=>{v.steps.splice(2,1);},(v:any)=>{v.steps[2].inputRefs=[];const {stepKey,kind,subject,input,inputRefs}=v.steps[2];v.steps[2].inputHash=digest({stepKey,kind,subject,input,inputRefs});}]){const v=view();addPage(v,definition(anchor,[]),plan(1).value);mutate(v);assert.throws(()=>inspect(v,anchor,new Set()));}});
test('finite rounds append the current evaluation attempt and page retry invalidates later pages',()=>{const v=view(),p=plan();const first=addPage(v,definition(anchor,[]),p.value);const next=inspect(v,anchor,new Set()).children[0];addPage(v,next,p.value);const e=inspect(v,anchor,new Set()).children[0];const saved=save(v,e,{version:MARKET_KEYWORD_RECONCILIATION_EVALUATION_VERSION,completedRound:0,anchorHash:digest(anchor),frontierHash:(e.input as any).frontierHash,status:'needs-model',planHash:hash,resultHash:null,inputSnapshotId:`market-input:${hash}`});const r=inspect(v,anchor,new Set());assert.deepEqual((r.children[0].input as any).priorEvaluationAttemptIds,[saved.latestAttemptId]);const a=v.attempts.find(a=>a.id===first.latestAttemptId)!;a.id=randomUUID();first.latestAttemptId=a.id;assert.notEqual(inspect(v,anchor,new Set()).children[0].stepKey,next.stepKey);});

test('preparation retry invalidates evaluation and running attempts hold reconciliation',()=>{
 const v=view();addPage(v,definition(anchor,[]),plan(1).value);const original=inspect(v,anchor,new Set()).children[0];
 const prep=v.steps.find(s=>s.kind==='prepare-model-batches')!,attempt=v.attempts.find(a=>a.id===prep.latestAttemptId)!;
 attempt.id=randomUUID();prep.latestAttemptId=attempt.id;assert.notEqual(inspect(v,anchor,new Set()).children[0].stepKey,original.stepKey);
 prep.status='running';attempt.status='running';assert.deepEqual(inspect(v,anchor,new Set()).children,[]);
 prep.status='failed';attempt.status='failed';assert.equal((inspect(v,anchor,new Set()).children[0].input as any).task,'keyword-reconciliation-evaluate');
});
test('completes two full rounds and terminal evaluation retains no final report child',()=>{
 const v=view();let d=definition(anchor,[]);
 for(let round=0;round<2;round++){
  addPage(v,d,plan(1,round).value);const e=inspect(v,anchor,new Set()).children[0];
  save(v,e,{version:MARKET_KEYWORD_RECONCILIATION_EVALUATION_VERSION,completedRound:round,anchorHash:digest(anchor),frontierHash:(e.input as any).frontierHash,status:round?'ready':'needs-model',planHash:hash,resultHash:round?hash:null,inputSnapshotId:`market-input:${hash}`});
  const next=inspect(v,anchor,new Set());if(round){assert.equal(next.status,'ready');assert.deepEqual(next.children,[]);}else d=next.children[0];
 }
});
test('initial anchor retry invalidates all descendants and malformed terminal statuses reject',()=>{
 const v=view();addPage(v,definition(anchor,[]),plan(1).value);
 for(const changed of [{...anchor,poolAttemptId:randomUUID()},{...anchor,preparationAttemptId:randomUUID()},{...anchor,modelAttemptIds:[randomUUID()]}])assert.equal(inspect(v,changed,new Set()).children[0].stepKey,definition(changed,[]).stepKey);
 const broken=view();const p=plan(0).value;p.status='ready';p.result=null;assert.throws(()=>page(p,0));
 const d=definition(anchor,[]);save(broken,d,{...page({...p,status:'waiting-initial-models'},0).output,resultHash:hash});assert.throws(()=>inspect(broken,anchor,new Set()));
});

test('large valid page offsets are not truncated by an unrelated page-count cap',()=>{
 const d=definition(anchor,[],{offset:200004,planHash:hash,previousPageAttemptId:randomUUID()});assert.equal((d.input as any).offset,200004);
 assert.throws(()=>definition(anchor,[],{offset:Number.MAX_SAFE_INTEGER+1,planHash:hash,previousPageAttemptId:randomUUID()}));
});
test('2000 initial models fit native reference limits while every model attempt binds page and evaluation identity',()=>{
 const large={...anchor,modelAttemptIds:Array.from({length:2000},()=>randomUUID()).sort()};
 const d=definition(large,[]),v=view();addPage(v,d,plan(1).value);const e=inspect(v,large,new Set()).children[0];
 assert.ok(d.inputRefs.length<2000);assert.ok(e.inputRefs.length<2000);
 assert.deepEqual((d.input as any).anchor.modelAttemptIds,large.modelAttemptIds);
 assert.deepEqual((e.input as any).anchor.modelAttemptIds,large.modelAttemptIds);
 assert.equal(e.stepKey,`keyword-reconcile-evaluate/${digest(e.input)}`);
 for(let i=0;i<large.modelAttemptIds.length;i++){
  const ids=[...large.modelAttemptIds];ids[i]=randomUUID();ids.sort();const changed={...large,modelAttemptIds:ids};
  assert.notEqual(definition(changed,[]).stepKey,d.stepKey);
  assert.notEqual(`keyword-reconcile-evaluate/${digest({...e.input as any,anchor:changed})}`,e.stepKey);
 }
});
