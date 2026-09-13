import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { MARKET_THEME_FLOW_VERSION, MARKET_THEME_RECONCILED_FLOW_VERSION, marketThemeFlowInitialSteps, planMarketThemeContinuation, inspectMarketThemeContinuation } from '../../server/domain/market-research/customer-theme-flow';
import type { MarketModuleRunView, MarketStepDefinition, MarketExecutionStep } from '../../server/db/market-module-execution-repository';
import type { MarketJsonValue } from '../../shared/market-analysis-contracts';
import { canonicalJsonSha256 as digest } from '../../server/runtime/model-request-accounting';

const at = '2026-09-01T00:00:00.000Z', id = (n: number) => `market-input:${String(n).padStart(64, '0')}`;
function fixture(flow=MARKET_THEME_FLOW_VERSION) {
  const scope = { organizationId: randomUUID(), researchId: randomUUID(), marketplace: 'US' as const, nodeIdPath: '12:34', fromMonth: '2026-07', toMonth: '2026-08', currency: 'USD' as const };
  const params = { flow, memberCount: 3, poolSize: 20, newProductMonths: 6, topN: 0,
    catalog: { task: 'market-customer-theme-mapping', mappingVersion: 'mapping/v1', groupCatalog: [] } };
  const view: MarketModuleRunView = { run: { id: randomUUID(), scope, moduleKind: 'customer-themes', params,
    versions: { source: 'market-source-handlers/v1', planner: flow, rule: 'market-theme-mapping-rules/v1', mapping: 'mapping/v1', model: 'market.semantic.text.v1', prompt: 'prompt/v1', configuration: 'config/v1' },
    collectionRevision: randomUUID(), requestFingerprint: digest(params), status: 'queued', createdBy: randomUUID(), createdAt: at, planRevision: 0, latestReportAttemptId: null }, steps: [], attempts: [] };
  const add = (d: MarketStepDefinition) => { const s: MarketExecutionStep = { ...d, id: randomUUID(), inputHash: digest(d), status: 'queued', attemptCount: 0, retryRound: 0, latestAttemptId: null }; view.steps.push(s); return s; };
  const finish = (s: MarketExecutionStep, output: MarketJsonValue, status: 'succeeded' | 'empty' | 'failed' = 'succeeded') => {
    s.status = status; s.latestAttemptId = randomUUID(); s.attemptCount++;
    view.attempts.push({ id: s.latestAttemptId, stepId: s.id, attemptNumber: s.attemptCount, retryRound: s.retryRound, leaseGeneration: s.attemptCount, status, output: status === 'failed' ? null : output, error: status === 'failed' ? { code: 'timeout', retryable: false } : null });
  };
  const anchor = add(marketThemeFlowInitialSteps(view.run)[0]);
  const next = () => planMarketThemeContinuation(view, at);
  return { view, add, finish, anchor, next };
}
function selected(f: ReturnType<typeof fixture>) {
  f.finish(f.anchor, { inputSnapshotId: id(1) }); const selection = f.add(f.next()[0]);
  const asins = ['B000000001', 'B000000002', 'B000000003']; f.finish(selection, { selectionInputSnapshotId: id(2), selectedAsins: asins });
  const sources = asins.map(asin => f.add({ stepKey: `source/${asin}`, kind: 'collect-customer-themes', subject: {}, input: { asin, selectionInputSnapshotId: id(2) }, inputRefs: [] }));
  return { selection, sources };
}

test('terminal source barrier forms one immutable pool and retries create a new basis without rescheduling successful members', () => {
  const f = fixture(); assert.deepEqual(f.next(), []); const { sources } = selected(f);
  f.finish(sources[0], { inputSnapshotId: id(3), sourceRef: `market-source:${'a'.repeat(64)}` });
  f.finish(sources[1], {}, 'failed'); assert.deepEqual(f.next(), []);
  f.finish(sources[2], { inputSnapshotId: id(4), sourceRef: `market-source:${'b'.repeat(64)}` }, 'empty');
  const d = f.next()[0]; assert.equal(d.kind, 'prepare-members'); assert.deepEqual((d.input as any).failedAttemptIds, [sources[1].latestAttemptId]);
  const pool = f.add(d); assert.deepEqual(planMarketThemeContinuation(f.view, '2026-09-02T00:00:00.000Z'), []);
  sources[1].status = 'queued'; assert.deepEqual(f.next(), []);
  f.finish(sources[1], { inputSnapshotId: id(5), sourceRef: `market-source:${'c'.repeat(64)}` });
  assert.notEqual(f.next()[0].stepKey, pool.stepKey); assert.deepEqual((f.next()[0].input as any).failedAttemptIds, []);
  assert.equal(sources[0].attemptCount, 1); assert.equal(sources[2].attemptCount, 1);
});

test('model barrier waits for every prepared batch and uses a preparation receipt for bounded transitive references', () => {
  const f = fixture(), { sources } = selected(f);
  sources.forEach((s, i) => f.finish(s, { inputSnapshotId: id(i + 3), sourceRef: `market-source:${String(i).repeat(64)}` }));
  const pool = f.add(f.next()[0]); f.finish(pool, { semanticInputSnapshotId: id(9), semanticStatus: 'pending' });
  const prep = f.add({ stepKey: 'prepare', kind: 'prepare-model-batches', subject: {}, input: { inputSnapshotId: id(9) }, inputRefs: [] });
  assert.deepEqual(f.next(), []); const bindingId = randomUUID(), inputDigest = 'd'.repeat(64);
  f.finish(prep, { batches: [{ bindingId, inputDigest }] });
  assert.throws(f.next, /missing or ambiguous/);
  const model = f.add({ stepKey: 'model', kind: 'model-batch', subject: {}, input: { bindingId, inputDigest }, inputRefs: [] });
  assert.deepEqual(f.next(), []); f.finish(model, {});
  const rules = f.next()[0]; assert.equal(rules.kind, 'rules'); assert.equal((rules.input as any).topN, 0);
  assert.deepEqual((rules.input as any).modelAttemptIds, [model.latestAttemptId]); assert.equal((rules.input as any).preparationAttemptId, prep.latestAttemptId);
  assert.equal(rules.inputRefs.length, 2); f.add(rules); assert.deepEqual(f.next(), []);
  f.view.run.status = 'cancelled'; assert.deepEqual(f.next(), []);
});

test('all-empty pool creates no model calls, while opt-in and version checks keep other runs separate', () => {
  const f = fixture(), { sources } = selected(f);
  sources.forEach((s, i) => f.finish(s, { inputSnapshotId: id(i + 3), sourceRef: `market-source:${String(i).repeat(64)}` }, 'empty'));
  const pool = f.add(f.next()[0]); f.finish(pool, { semanticInputSnapshotId: id(9), semanticStatus: 'no-input' }, 'empty');
  assert.deepEqual((f.next()[0].input as any).modelAttemptIds, []);
  f.view.run.versions.planner = 'old/v1'; assert.throws(f.next, /versions differ/);
  f.view.run.params = {}; assert.deepEqual(f.next(), []);
});

test('report frontier follows accepted rules and empty selections, never reuses a report after source retry', () => {
  const f = fixture(), { sources } = selected(f);
  sources.forEach((s, i) => f.finish(s, { inputSnapshotId: id(i + 3), sourceRef: `market-source:${String(i).repeat(64)}` }, 'empty'));
  const pool = f.add(f.next()[0]); f.finish(pool, { semanticInputSnapshotId: id(9), semanticStatus: 'no-input' }, 'empty');
  const rules = f.add(f.next()[0]); f.finish(rules, { inputSnapshotId: id(10) }, 'empty');
  const report = f.add(f.next()[0]); assert.equal(report.kind, 'report');
  assert.equal((report.input as any).rulesAttemptId, rules.latestAttemptId);
  f.finish(report, { status: 'no-data' }); assert.deepEqual(f.next(), []);
  sources[0].status = 'queued'; assert.deepEqual(f.next(), []);
  const empty = fixture(); empty.finish(empty.anchor, { inputSnapshotId: id(1) }, 'empty');
  const selection = empty.add(empty.next()[0]); empty.finish(selection, { selectionInputSnapshotId: id(2), selectedAsins: [] }, 'empty');
  assert.equal(empty.next()[0].kind, 'report'); assert.equal((empty.next()[0].input as any).selectionAttemptId, selection.latestAttemptId);
});

function needingReconciliation(){
  const f=fixture(MARKET_THEME_RECONCILED_FLOW_VERSION),{sources}=selected(f);
  sources.forEach((s,i)=>f.finish(s,{inputSnapshotId:id(i+3),sourceRef:`market-source:${String(i).repeat(64)}`}));
  const pool=f.add(f.next()[0]);f.finish(pool,{semanticInputSnapshotId:id(9),semanticStatus:'pending'});
  const prep=f.add({stepKey:'prepare',kind:'prepare-model-batches',subject:{},input:{inputSnapshotId:id(9)},inputRefs:[]});
  const bindingId=randomUUID(),inputDigest='d'.repeat(64);f.finish(prep,{batches:[{bindingId,inputDigest}]});
  const originalModel=f.add({stepKey:'initial-model',kind:'model-batch',subject:{},input:{bindingId,inputDigest},inputRefs:[]});f.finish(originalModel,{});
  const rules=f.add(f.next()[0]);f.finish(rules,{inputSnapshotId:id(10),semantics:{reconciliationRequired:true,unavailableMemberIds:[]}});
  return {...f,rules,originalModel,sources};
}
function reconciliationPage(f:ReturnType<typeof needingReconciliation>,round:number){
  const page=f.add(f.next()[0]),n=20+round,planHash=String(round+1).repeat(64);
  assert.equal((page.input as any).task,'customer-theme-reconciliation-page');
  const prep=f.add({stepKey:`round-prepare/${round}`,kind:'prepare-model-batches',subject:{},input:{inputSnapshotId:id(n),selectionRevision:`round/${round}`},inputRefs:[]});
  f.finish(page,{version:'theme-reconciliation-page/v1',planHash,baseHash:'b'.repeat(64),initialResultHash:'c'.repeat(64),round,offset:0,nextOffset:null,totalWindows:1,
    windows:[{id:`window/${round}`,inputSnapshotId:id(n),selectionRevision:`round/${round}`,memberIds:['member'],candidateIds:['group'],preparationStepKey:prep.stepKey}]});
  assert.deepEqual(f.next(),[]);const bindingId=randomUUID(),inputDigest='d'.repeat(64);f.finish(prep,{batches:[{bindingId,inputDigest}]});
  const model=f.add({stepKey:`round-model/${round}`,kind:'model-batch',subject:{},input:{bindingId,inputDigest},inputRefs:[]});assert.deepEqual(f.next(),[]);
  return {page,prep,model};
}
function evaluationOutput(step:MarketExecutionStep,round:number,status:'needs-model'|'ready'|'partial'){
  const input=step.input as any;return {version:'theme-reconciliation-evaluation/v1',inputSnapshotId:id(40+round),evaluationHash:'e'.repeat(64),completedRound:round,
    initialRulesAttemptId:input.initialRulesAttemptId,frontierHash:input.frontierHash,status,planHash:'f'.repeat(64),resultHash:status==='needs-model'?null:'a'.repeat(64)};
}

test('versioned reconciliation flow waits for complete rounds, persists the next-round basis and queues a distinct report',()=>{
  const f=needingReconciliation(),one=reconciliationPage(f,0);f.finish(one.model,{});
  const first=f.add(f.next()[0]);assert.equal((first.input as any).task,'customer-theme-reconciliation-evaluate');assert.deepEqual(f.next(),[]);
  f.finish(first,evaluationOutput(first,0,'needs-model'));const pageDefinition=f.next()[0];
  assert.deepEqual((pageDefinition.input as any).priorEvaluationAttemptIds,[first.latestAttemptId]);
  const two=reconciliationPage(f,1);f.finish(two.model,{});const second=f.add(f.next()[0]);f.finish(second,evaluationOutput(second,1,'ready'));
  const report=f.add(f.next()[0]);assert.equal(report.kind,'report');assert.equal((report.input as any).basis,'reconciliation-evaluation');
  assert.equal((report.input as any).evaluationAttemptId,second.latestAttemptId);assert.deepEqual(f.next(),[]);
  const current=inspectMarketThemeContinuation(f.view,at).currentStepKeys;
  for(const step of [f.originalModel,one.model,two.model,first,second,report])assert.ok(current.includes(step.stepKey));
  assert.equal(f.originalModel.attemptCount,1);
});

test('retrying a failed window fences old evaluations and reports while keeping successful batches current',()=>{
  const f=needingReconciliation(),one=reconciliationPage(f,0);f.finish(one.model,{},'failed');
  const old=f.add(f.next()[0]);f.finish(old,evaluationOutput(old,0,'partial'));const report=f.add(f.next()[0]);
  one.model.status='queued';let current=inspectMarketThemeContinuation(f.view,at);
  assert.deepEqual(current.children,[]);assert.ok(current.currentStepKeys.includes(one.model.stepKey));
  assert.ok(!current.currentStepKeys.includes(old.stepKey));assert.ok(!current.currentStepKeys.includes(report.stepKey));
  f.finish(one.model,{});const replacement=f.next()[0];assert.notEqual(replacement.stepKey,old.stepKey);
  assert.notEqual((replacement.input as any).frontierHash,(old.input as any).frontierHash);
  assert.equal(f.originalModel.attemptCount,1);assert.ok(inspectMarketThemeContinuation(f.view,at).currentStepKeys.includes(f.originalModel.stepKey));
  f.sources[0].status='queued';current=inspectMarketThemeContinuation(f.view,at);
  assert.ok(!current.currentStepKeys.includes(one.model.stepKey));assert.ok(!current.currentStepKeys.includes(replacement.stepKey));
});

test('a forged evaluation frontier or mismatched flow version cannot advance a reconciled report',()=>{
  const f=needingReconciliation(),one=reconciliationPage(f,0);f.finish(one.model,{});
  const evaluation=f.add(f.next()[0]);f.finish(evaluation,{...evaluationOutput(evaluation,0,'ready'),frontierHash:'0'.repeat(64)});
  assert.throws(f.next,/lineage differs/);f.view.run.versions.planner=MARKET_THEME_FLOW_VERSION;assert.throws(f.next,/versions differ/);
});

test('multiple page frontiers include every preparation and fence evaluation while an earlier page is still pending',()=>{
  const f=needingReconciliation(),first=f.add(f.next()[0]),preparations:MarketExecutionStep[]=[];
  const makeWindows=(start:number,count:number)=>Array.from({length:count},(_,j)=>{
    const i=start+j,prep=f.add({stepKey:`many-prepare/${i}`,kind:'prepare-model-batches',subject:{},input:{inputSnapshotId:id(60+i),selectionRevision:'multi-page'},inputRefs:[]});
    preparations.push(prep);return {id:`many-window/${i}`,inputSnapshotId:id(60+i),selectionRevision:'multi-page',memberIds:[`member/${i}`],candidateIds:['group'],preparationStepKey:prep.stepKey};
  });
  const common={version:'theme-reconciliation-page/v1',planHash:'a'.repeat(64),baseHash:'b'.repeat(64),initialResultHash:'c'.repeat(64),round:0,totalWindows:9};
  f.finish(first,{...common,offset:0,nextOffset:8,windows:makeWindows(0,8)});
  const last=f.add(f.next()[0]);assert.equal((last.input as any).offset,8);assert.equal((last.input as any).previousPageAttemptId,first.latestAttemptId);
  let current=inspectMarketThemeContinuation(f.view,at);assert.ok(preparations.every(s=>current.currentStepKeys.includes(s.stepKey)));
  f.finish(last,{...common,offset:8,nextOffset:null,windows:makeWindows(8,1)});
  preparations.slice(1).forEach(s=>f.finish(s,{},'failed'));assert.deepEqual(f.next(),[]);
  f.finish(preparations[0],{},'failed');const evaluation=f.next()[0];
  const frontier=preparations.map(s=>({stepId:s.id,attemptId:s.latestAttemptId,status:s.status,inputHash:s.inputHash})).sort((a,b)=>a.stepId.localeCompare(b.stepId));
  assert.equal((evaluation.input as any).frontierHash,digest(frontier));assert.equal((evaluation.input as any).lastPageAttemptId,last.latestAttemptId);
  const lastAttempt=f.view.attempts.find(a=>a.id===last.latestAttemptId)!;lastAttempt.output={...(lastAttempt.output as any),planHash:'d'.repeat(64)};
  assert.throws(f.next,/lineage differs/);
});
