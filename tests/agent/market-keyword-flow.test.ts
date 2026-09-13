import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { MarketKeywordStartRequestSchema, marketKeywordFlowInitialSteps, inspectMarketKeywordContinuation } from '../../server/domain/market-research/keyword-flow';
import { canonicalJsonSha256 as digest } from '../../server/runtime/model-request-accounting';
import type { MarketModuleRunView, MarketStepDefinition } from '../../server/db/market-module-execution-repository';
const now = '2026-09-13T00:00:00.000Z';
const catalog = { task: 'market-keyword-semantics', dictionaryVersion: 'test/v1', categoryContext: 'lamps', dimensionLabels: { W1: [], W2: [], W3: [], W4: [] }, clusterCatalog: [] };
const request = () => ({ scope: { organizationId: 'org', researchId: '11111111-1111-4111-8111-111111111111', marketplace: 'US' as const, currency: 'USD' as const, nodeIdPath: '123', fromMonth: '2026-07', toMonth: '2026-08' }, moduleKind: 'keywords' as const, params: { flow: 'market-keyword-flow/v1', plannedPages: [{ seed: 'lamp', page: 1 }, { seed: 'lamp', page: 2 }], maxMembers: 100, catalog }, versions: { source: 'market-source-handlers/v1', planner: 'market-keyword-flow/v1', rule: 'market-keyword-pool/v1', mapping: 'test/v1', model: null, prompt: null, configuration: null } });
function fixture() { const r = request(); const v = { run: { ...r, status: 'running' }, steps: [], attempts: [] } as unknown as MarketModuleRunView; for (const d of marketKeywordFlowInitialSteps(r)) add(v, d); return v; }
function add(v: MarketModuleRunView, d: MarketStepDefinition) { const s = { ...d, id: randomUUID(), inputHash: digest(d), status: 'queued' as const, latestAttemptId: null, attemptCount: 0, retryRound: 0 }; v.steps.push(s); return s; }
function settle(v: MarketModuleRunView, index: number, status: 'succeeded' | 'empty' | 'failed', output: any = null) { const s = v.steps[index], id = randomUUID(); Object.assign(s, { status, latestAttemptId: id }); v.attempts.push({ id, stepId: s.id, status, output, error: null, attemptNumber: 1, retryRound: 0, leaseGeneration: 1 }); }
const pageOutput = (n: number) => ({ inputSnapshotId: 'market-input:' + String(n).repeat(64), sourceRef: 'market-source:' + String(n).repeat(64) });
test('fixed pages normalize whitespace and reject duplicates, mixed model identities and version mismatches', () => {
 const p = request().params; const {flow, ...start} = p;
 assert.equal(MarketKeywordStartRequestSchema.parse({...start, plannedPages:[{seed:'  floor   Lamp ',page:1}]}).plannedPages[0].seed,'floor Lamp');
 assert.throws(()=>MarketKeywordStartRequestSchema.parse({...start,plannedPages:[{seed:'lamp ',page:1},{seed:'lamp',page:1}]}));
 assert.equal(marketKeywordFlowInitialSteps(request()).length,2);
 assert.throws(()=>marketKeywordFlowInitialSteps({...request(), versions:{...request().versions, model:'market.semantic.text.v1'}}));
 assert.throws(()=>marketKeywordFlowInitialSteps({...request(), versions:{...request().versions, rule:'wrong'}}));
});
test('wait for all pages, retain failed retry target and freeze partial pool across rereads', () => {
 const v=fixture(); settle(v,0,'succeeded',pageOutput(1));
 assert.deepEqual(inspectMarketKeywordContinuation(v,now).children,[]);
 settle(v,1,'failed'); const first=inspectMarketKeywordContinuation(v,now); assert.equal(first.children.length,1);
 assert.deepEqual((first.children[0].input as any).pages,[pageOutput(1)]);
 add(v,first.children[0]); assert.deepEqual(inspectMarketKeywordContinuation(v,'2026-09-14T00:00:00.000Z').children,[]);
 assert.ok(inspectMarketKeywordContinuation(v,now).currentStepKeys.includes(v.steps[1].stepKey));
 settle(v,1,'succeeded',pageOutput(2)); const retry=inspectMarketKeywordContinuation(v,now);
 assert.equal(retry.children.length,1); assert.notEqual(retry.children[0].stepKey,first.children[0].stepKey);
 assert.ok(!retry.currentStepKeys.includes(first.children[0].stepKey));
});
test('cancelled flows dispatch nothing and tampered initial definition fails closed',()=>{
 const v=fixture(); v.run.status='cancelled'; assert.deepEqual(inspectMarketKeywordContinuation(v,now),{children:[],currentStepKeys:[]});
 v.run.status='running'; v.steps[0].inputHash='bad'; assert.throws(()=>inspectMarketKeywordContinuation(v,now));
});

function publishedPool(v: MarketModuleRunView, members = ['keyword-1'], model = false) {
 if (model) Object.assign(v.run.versions,{model:'market.semantic.text.v1',prompt:'prompt/v1',configuration:'config/v1'});
 settle(v,0,members.length?'succeeded':'empty',pageOutput(1)); settle(v,1,members.length?'failed':'empty',members.length?null:pageOutput(2));
 const definition=inspectMarketKeywordContinuation(v,now).children[0]; add(v,definition);
 const input=definition.input as any;
 const pageBindings=[{seed:'lamp',page:1,...pageOutput(1)},{seed:'lamp',page:2,...(members.length?{inputSnapshotId:null,sourceRef:null}:pageOutput(2))}];
 const basisHash=digest({version:'market-keyword-pool/v1',scope:v.run.scope,catalog,maxMembers:100,dataCutoffAt:now,pageBindings});
 const pool={poolVersion:'market-keyword-pool/v1',scope:v.run.scope,catalogHash:digest(catalog),maxMembers:100,dataCutoffAt:now,pageBindings,basisHash,
 rawInputSnapshotId:'market-input:'+'a'.repeat(64),semanticInputSnapshotId:'market-input:'+'b'.repeat(64),selectedMemberIds:members,selectedKeywords:members.map((_,i)=>`lamp ${i}`)};
 settle(v,2,members.length?'succeeded':'empty',pool);
 if (members.length) {
  add(v,{stepKey:`pool-trends/${basisHash}`,kind:'prepare-keyword-pool',subject:{},input:{phase:'dispatch-trends',inputSnapshotId:pool.rawInputSnapshotId,basisHash},inputRefs:[{kind:'input',id:pool.rawInputSnapshotId},{kind:'step-output',id:v.steps[2].latestAttemptId!}]});
  if(model) add(v,{stepKey:`pool-model/${basisHash}`,kind:'prepare-model-batches',subject:{task:catalog.task},input:{task:catalog.task,inputSnapshotId:pool.semanticInputSnapshotId,selectionRevision:input.selectionRevision,dataCutoffAt:now},inputRefs:[{kind:'input',id:pool.semanticInputSnapshotId}]});
 }
 return pool;
}
test('legitimate all-empty pool ends source frontier without trend or model children',()=>{
 const v=fixture(); publishedPool(v,[]); const out=inspectMarketKeywordContinuation(v,now);
 assert.deepEqual(out.children,[]); assert.equal(out.currentStepKeys.length,3);
});

test('ABA collection uses bounded exact pool batches and old runs do not acquire new sources',()=>{
 const legacy=fixture();publishedPool(legacy);
 assert.equal(inspectMarketKeywordContinuation(legacy,now).children.length,0);
 const v=fixture();v.run.params={...v.run.params as object,supplementalSources:'sif-aba/v1'};
 const pool=publishedPool(v,Array.from({length:23},(_,i)=>`keyword-${i}`));
 const frontier=inspectMarketKeywordContinuation(v,now);
 assert.equal(frontier.children.length,3);
 assert.deepEqual(frontier.children.map(d=>(d.input as {members:unknown[]}).members.length),[10,10,3]);
 assert.ok(frontier.children.every(d=>d.kind==='collect-keyword-aba'&&d.inputRefs.some(r=>r.id===pool.rawInputSnapshotId)));
 for(const d of frontier.children)add(v,d);
 assert.deepEqual(inspectMarketKeywordContinuation(v,now).children,[]);
 assert.ok(frontier.children.every(d=>inspectMarketKeywordContinuation(v,now).currentStepKeys.includes(d.stepKey)));
 // A replaced source page invalidates the old ABA pool just like its trend descendants.
 v.steps[1].status='queued';v.steps[1].latestAttemptId=null;
 assert.ok(frontier.children.every(d=>!inspectMarketKeywordContinuation(v,now).currentStepKeys.includes(d.stepKey)));
});
test('no-model trends remain retryable; page retry excludes complete old frontier without repeating successful page',()=>{
 const v=fixture(),p=publishedPool(v); settle(v,3,'succeeded',{poolInputSnapshotId:p.rawInputSnapshotId,scheduledKeywordIds:p.selectedMemberIds});
 const d:MarketStepDefinition={stepKey:`trend/${digest({pool:p.rawInputSnapshotId,keywordId:'keyword-1'})}`,kind:'collect-keyword-trend',subject:{keywordId:'keyword-1'},input:{keywordId:'keyword-1',keyword:'lamp 0',poolInputSnapshotId:p.rawInputSnapshotId},inputRefs:[{kind:'input',id:p.rawInputSnapshotId}]};
 add(v,d); settle(v,4,'failed'); const out=inspectMarketKeywordContinuation(v,now);
 assert.ok(out.currentStepKeys.includes(d.stepKey)); assert.deepEqual(out.children,[]);
 settle(v,4,'succeeded',{}); assert.ok(inspectMarketKeywordContinuation(v,now).currentStepKeys.includes(d.stepKey));
 v.steps[1].status='queued'; v.steps[1].latestAttemptId=null;
 const waiting=inspectMarketKeywordContinuation(v,now); assert.deepEqual(waiting.currentStepKeys,v.steps.slice(0,2).map(s=>s.stepKey));
 assert.deepEqual(waiting.children,[]);
 settle(v,1,'succeeded',pageOutput(2)); const next=inspectMarketKeywordContinuation(v,now);
 assert.equal(next.children[0].kind,'prepare-keyword-pool'); assert.ok(!next.currentStepKeys.includes(d.stepKey));
});
test('trend dispatch accepts the complete scheduled member set regardless of snapshot order',()=>{
 const members=['keyword-b','keyword-a'],v=fixture(),p=publishedPool(v,members);
 settle(v,3,'succeeded',{poolInputSnapshotId:p.rawInputSnapshotId,scheduledKeywordIds:[...members].reverse()});
 members.forEach((id,i)=>add(v,{stepKey:`trend/${digest({pool:p.rawInputSnapshotId,keywordId:id})}`,kind:'collect-keyword-trend',subject:{keywordId:id},
  input:{keywordId:id,keyword:`lamp ${i}`,poolInputSnapshotId:p.rawInputSnapshotId},inputRefs:[{kind:'input',id:p.rawInputSnapshotId}]}));
 const out=inspectMarketKeywordContinuation(v,now);
 assert.ok(members.every(id=>out.currentStepKeys.includes(`trend/${digest({pool:p.rawInputSnapshotId,keywordId:id})}`)));
});
test('trend dispatch rejects duplicate, missing, or extra scheduled member ids',()=>{
 const members=['keyword-1','keyword-2'];
 for(const scheduledKeywordIds of [['keyword-1','keyword-1'],['keyword-1'],['keyword-1','keyword-2','keyword-3']]) {
  const v=fixture(),p=publishedPool(v,members);
  settle(v,3,'succeeded',{poolInputSnapshotId:p.rawInputSnapshotId,scheduledKeywordIds});
  assert.throws(()=>inspectMarketKeywordContinuation(v,now),TypeError);
 }
});
test('configured model follows only current preparation receipt and rejects cross-pool model definitions',()=>{
 const v=fixture(),p=publishedPool(v,['keyword-1'],true), bindingId=randomUUID();
 const batch={bindingId,batchKey:'batch-current',inputDigest:'c'.repeat(64)};
 settle(v,4,'succeeded',{task:catalog.task,inputSnapshotId:p.semanticInputSnapshotId,batches:[batch]});
 const d:MarketStepDefinition={stepKey:'model/batch-current',kind:'model-batch',subject:{task:catalog.task},input:{task:catalog.task,bindingId,inputDigest:batch.inputDigest},inputRefs:[{kind:'input',id:p.semanticInputSnapshotId}]};
 const step=add(v,d); assert.ok(inspectMarketKeywordContinuation(v,now).currentStepKeys.includes(d.stepKey));
 step.inputRefs=[{kind:'input',id:p.rawInputSnapshotId}]; step.inputHash=digest({...d,inputRefs:step.inputRefs});
 assert.throws(()=>inspectMarketKeywordContinuation(v,now),/binding differs/);
});
test('pool manifest scope, current pages and raw-semantic separation are enforced',()=>{
 for(const mutate of [(p:any)=>p.pageBindings.reverse(),(p:any)=>p.semanticInputSnapshotId=p.rawInputSnapshotId,(p:any)=>p.catalogHash='d'.repeat(64)]) {
  const v=fixture(),p=publishedPool(v); mutate(p); assert.throws(()=>inspectMarketKeywordContinuation(v,now));
 }
});
