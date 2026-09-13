import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { collectMarketProductPool } from '../../server/services/market-product-pool-collector';
import { collectMarketCustomerThemes } from '../../server/services/market-customer-themes-collector';
import { createMarketInputSnapshot } from '../../server/domain/market-research/snapshot';
import { selectMarketThemeMembers, assembleMarketThemePool } from '../../server/domain/market-research/customer-theme-source-pool';
import { planMarketSemanticBatches } from '../../server/domain/market-research/semantic-batch-plan';
import { calculateMarketThemeMappingRules } from '../../server/domain/market-research/customer-theme-mapping-rules';
import { MARKET_SOURCE_HANDLER_VERSION } from '../../shared/market-source-contracts';
import { MarketCustomerThemeMappingInputSchema, type MarketCustomerThemeMappingOutput } from '../../shared/market-semantic-contracts';
import type { CustomerThemesAsinInput } from '../../server/domain/market-research/customer-themes';
import { canonicalJsonSha256 as digest } from '../../server/runtime/model-request-accounting';
import { planMarketThemeReconciliation } from '../../server/domain/market-research/customer-theme-reconciliation';
import { marketThemeReconciliationPage, MARKET_THEME_RECONCILIATION_PAGE_SIZE, MarketThemeReconciliationPageInputSchema } from '../../server/runtime/market-theme-reconciliation-step';
import { createMarketThemeEvaluationArtifact } from '../../server/domain/market-research/customer-theme-reconciliation-artifact';
import { restoreMarketThemeEvaluation } from '../../server/domain/market-research/customer-theme-evaluation-reader';

const at = '2026-09-01T00:00:00.000Z', asin = 'B000000001';
async function fixture(count = 13) {
  const scope = { organizationId: randomUUID(), researchId: randomUUID(), marketplace: 'US' as const, nodeIdPath: '12:34', fromMonth: '2026-07', toMonth: '2026-08', currency: 'USD' as const };
  const p = await collectMarketProductPool({ scope, month: '2026-08', poolSize: 100, newProductMonths: 6, jobId: 'synthetic', connector: {
    id: 'sellerSprite', probe: async () => { throw new Error('unused'); }, execute: async r => ({ data: { code: 'OK', data: [{ asin }, { asin: 'B000000002' }] }, source: { connectorId: 'sellerSprite', operation: r.operation, fetchedAt: at, attemptCount: 1 } }) } });
  assert.ok(p.evidence); const productRef = `market-source:${digest(p.evidence)}`;
  const products = createMarketInputSnapshot({ scope, kind: 'products', sourceVersion: MARKET_SOURCE_HANDLER_VERSION, ruleVersion: 'source-normalization/v1', collectedAt: at,
    expectedRecordIds: p.products.map(p => p.asin), records: p.products.map(product => ({ id: product.asin, scope, data: { collection: 'product-month', month: '2026-08', product, sourceRef: productRef } })) });
  const selection = selectMarketThemeMembers({ snapshot: products, sources: { [productRef]: p.evidence }, count: 20 });
  const t = await collectMarketCustomerThemes({ scope, asin, jobId: 'synthetic', connector: { id: 'sorftime', probe: async () => { throw new Error('unused'); },
    execute: async r => ({ data: { data: { details: Array.from({ length: count }, (_, i) => ({ keyword: `Assembly ${i}`, content: 'Easy assembly', mention: i + 1, positive: i + 1, negative: 0, update_time: '2026-08-01' })) } }, source: { connectorId: 'sorftime', operation: r.operation, fetchedAt: at, attemptCount: 1 } }) } });
  assert.ok(t.evidence); const sourceRef = `market-source:${digest(t.evidence)}`, sources = { [sourceRef]: t.evidence };
  const observation = createMarketInputSnapshot({ scope, kind: 'customer-themes', sourceVersion: MARKET_SOURCE_HANDLER_VERSION, ruleVersion: 'source-normalization/v1', collectedAt: at,
    expectedRecordIds: [asin], records: [{ id: asin, scope, data: { collection: 'customer-themes', result: t.result, sourceRef } }] });
  const catalog = { task: 'market-customer-theme-mapping' as const, mappingVersion: 'mapping/v1', groupCatalog: [{ groupId: 'assembly', labelZh: '组装', definition: '组装体验' }] };
  const poolInput = { selection: selection.snapshot, selectedAsins: selection.manifest.selectedAsins, catalog, dataCutoffAt: at, observations: [{ snapshot: observation, sourceRef }], sources, failures: [] };
  const pool = assembleMarketThemePool(poolInput);
  const plan = await planMarketSemanticBatches({ task: catalog.task, moduleRunId: randomUUID(), snapshot: pool.semanticSnapshot, sources, selectionRevision: 'selection/v1', configurationVersion: 'config/v1', dataCutoffAt: at }, async () => true);
  const batches = plan.batches.map(b => {
    const input = MarketCustomerThemeMappingInputSchema.parse(b.input);
    const themes = input.themes.map(t => {
      assert.equal(t.keyword.state, 'known'); if (t.keyword.state !== 'known') throw new Error('fixture');
      const text = t.keyword.value;
      return { sourceThemeId: t.sourceThemeId, decision: { status: 'mapped', target: { kind: 'proposed', proposalId: 'p1' }, labelZh: '组装', explanationZh: '原主题提到组装', evidence: [{ refId: text.refId, start: 0, end: 8, quote: 'Assembly' }] } };
    });
    const output: MarketCustomerThemeMappingOutput = { schemaVersion: '1.0.0', task: input.task, batchId: input.batchId, inputDigest: input.inputDigest,
      themes: themes as MarketCustomerThemeMappingOutput['themes'], proposals: [{ proposalId: 'p1', labelZh: '组装', definition: '组装体验', evidence: themes[0].decision.evidence }] };
    return { input, binding: b.validationBinding, output };
  });
  return { poolInput, batches };
}

async function reconciliationRound(f:Awaited<ReturnType<typeof fixture>>,plan:ReturnType<typeof planMarketThemeReconciliation>) {
  const batches=[];
  for(const window of plan.windows){
    const prepared=await planMarketSemanticBatches({task:'market-customer-theme-mapping',moduleRunId:'10000000-0000-4000-8000-000000000001',snapshot:window.snapshot,sources:f.poolInput.sources,selectionRevision:window.selectionRevision,configurationVersion:'config/v1',dataCutoffAt:window.snapshot.collectedAt},async()=>true);
    for(const b of prepared.batches){const input=MarketCustomerThemeMappingInputSchema.parse(b.input);
      const output:MarketCustomerThemeMappingOutput={schemaVersion:'1.0.0',task:input.task,batchId:input.batchId,inputDigest:input.inputDigest,proposals:[],themes:input.themes.map(t=>{
        if(t.keyword.state!=='known')throw new Error('fixture');return {sourceThemeId:t.sourceThemeId,decision:{status:'mapped',target:{kind:'existing',groupId:input.groupCatalog[0].groupId},labelZh:'组装',explanationZh:'主题指向候选的组装体验',evidence:[{refId:t.keyword.value.refId,start:0,end:8,quote:'Assembly'}]}};
      })};batches.push({input,output,binding:b.validationBinding});
    }
  }
  return {planHash:plan.planHash,batches};
}

test('saved reconciliation restores all source counts and rejects a rehashed forged result',async()=>{
  const f=await fixture(),plan=planMarketThemeReconciliation({...f,rounds:[]}),receipt=await reconciliationRound(f,plan);
  const result=planMarketThemeReconciliation({...f,rounds:[receipt],topN:0}),frontierHash=digest([]);
  const artifact=createMarketThemeEvaluationArtifact(f.poolInput.selection.scope,MARKET_SOURCE_HANDLER_VERSION,at,
    {task:'customer-theme-reconciliation-evaluate',initialRulesAttemptId:randomUUID(),lastPageAttemptId:randomUUID(),frontierHash},
    {status:'settled',plan,receipt,result,frontier:[],frontierHash,pendingStepIds:[],auditRefs:[]});
  const restored=restoreMarketThemeEvaluation(artifact.snapshot);
  assert.equal(restored.result.resultHash,result.result!.resultHash);assert.equal(restored.aggregation.totals!.mention,91);
  assert.equal(restored.aggregation.groups.length,0);assert.equal(restored.decisions.length,13);assert.equal(restored.labels.length,1);
  for(const mutate of [
    (factory:typeof artifact.factory)=>{(factory.records.find(r=>r.id==='summary')!.data as any).aggregation.totals.mention=900;},
    (factory:typeof artifact.factory)=>{(factory.records.find(r=>r.id==='decisions:0')!.data as any).items[0].inputDigest='0'.repeat(64);},
    (factory:typeof artifact.factory)=>{factory.records.find(r=>r.id==='labels:0')!.id='labels:1';},
  ]){const factory=structuredClone(artifact.factory);mutate(factory);factory.expectedRecordIds=factory.records.map(r=>r.id);
    assert.throws(()=>restoreMarketThemeEvaluation(createMarketInputSnapshot(factory)));}
});

test('cross-batch matching freezes all candidates and only aggregates after validated model remapping',async()=>{
  const f=await fixture(),first=planMarketThemeReconciliation({...f,rounds:[]});
  assert.equal(first.status,'needs-model');assert.equal(first.candidates.length,3);assert.equal(first.windows.length,2);assert.equal(first.result,null);
  const round=await reconciliationRound(f,first),done=planMarketThemeReconciliation({...f,rounds:[round]});
  assert.equal(done.status,'ready');assert.equal(done.windows.length,0);assert.equal(done.result!.aggregation.groups.length,1);
  assert.equal(done.result!.aggregation.totals!.mention,91);assert.equal(done.result!.aggregation.groups[0].topicShare.denominator,91);
  assert.equal(done.result!.aggregation.coverage.missingAsinCount,1);
  assert.equal(planMarketThemeReconciliation({...f,batches:[...f.batches].reverse(),rounds:[]}).planHash,first.planHash);
});

test('large candidate catalogues use every small window and a bounded next round instead of dropping tail candidates',async()=>{
  const f=await fixture(397),first=planMarketThemeReconciliation({...f,rounds:[]});
  assert.equal(first.candidates.length,35);assert.equal(first.windows.length,170);assert.ok(first.windows.every(w=>w.memberIds.length<=12&&w.candidateIds.length<=8));
  assert.deepEqual([...new Set(first.windows.flatMap(w=>w.candidateIds))].sort(),first.candidates.map(c=>c.groupId).sort());
  const savedIds:string[]=[];
  for(let offset=0;offset<first.windows.length;offset+=MARKET_THEME_RECONCILIATION_PAGE_SIZE){
    const page=marketThemeReconciliationPage(first,offset);
    assert.ok(page.inputs.length<=MARKET_THEME_RECONCILIATION_PAGE_SIZE);assert.equal(page.children.length,page.inputs.length);
    const snapshots=page.inputs.map(value=>createMarketInputSnapshot(value));
    assert.deepEqual(snapshots.map(s=>s.snapshotId),page.output.windows.map(w=>w.inputSnapshotId));
    savedIds.push(...snapshots.map(s=>s.snapshotId));
    assert.equal(page.output.nextOffset,offset+snapshots.length<first.windows.length?offset+snapshots.length:null);
  }
  assert.deepEqual(savedIds,first.windows.map(w=>w.snapshot.snapshotId));assert.equal(new Set(savedIds).size,savedIds.length);
  assert.throws(()=>marketThemeReconciliationPage(first,1));assert.throws(()=>marketThemeReconciliationPage(first,first.windows.length));
  assert.equal(MarketThemeReconciliationPageInputSchema.safeParse({task:'customer-theme-reconciliation-page',initialRulesAttemptId:randomUUID(),offset:8}).success,false);
  const one=await reconciliationRound(f,first),second=planMarketThemeReconciliation({...f,rounds:[one]});
  assert.equal(second.status,'needs-model');assert.equal(second.windows.length,34);assert.equal(second.windows[0].candidateIds.length,5);
  const two=await reconciliationRound(f,second),done=planMarketThemeReconciliation({...f,rounds:[one,two],topN:0});
  assert.equal(done.status,'ready');assert.equal(done.result!.aggregation.groups.length,0);assert.equal(done.result!.aggregation.totals!.mention,397*398/2);
  assert.equal(done.result!.decisions.filter(d=>d.status==='mapped').length,397);
  // A negative membership result may exclude one window. Ambiguity may not.
  for(const reason of ['outside-taxonomy','ambiguous'] as const){
    const altered=structuredClone(one);
    for(const b of altered.batches)if(!b.input.groupCatalog.some(c=>c.groupId===first.candidates[0].groupId))for(const t of b.output.themes)t.decision={status:'unknown',reason,evidence:[]};
    const resolved=planMarketThemeReconciliation({...f,rounds:[altered]});
    assert.equal(resolved.status,reason==='outside-taxonomy'?'ready':'partial');
    assert.equal(resolved.result!.decisions.filter(d=>d.status==='mapped').length,reason==='outside-taxonomy'?397:0);
    assert.equal(resolved.result!.aggregation.totals!.mention,397*398/2);
  }
});

test('missing initial batches wait; missing reconciliation results retain all denominators and source members',async()=>{
  const f=await fixture();assert.equal(planMarketThemeReconciliation({...f,batches:f.batches.slice(0,1),rounds:[]}).status,'waiting-initial-models');
  const first=planMarketThemeReconciliation({...f,rounds:[]}),round=await reconciliationRound(f,first);round.batches.pop();
  const partial=planMarketThemeReconciliation({...f,rounds:[round]});assert.equal(partial.status,'partial');assert.equal(partial.result!.aggregation.totals!.mention,91);
  assert.equal(partial.result!.decisions.filter(d=>d.status==='unavailable').length,1);
});

test('reconciliation rejects stale plans, invented targets, duplicate batches and invalid citations',async()=>{
  const f=await fixture(),first=planMarketThemeReconciliation({...f,rounds:[]}),valid=await reconciliationRound(f,first);
  assert.throws(()=>planMarketThemeReconciliation({...f,rounds:[{...valid,planHash:'f'.repeat(64)}]}));
  assert.throws(()=>planMarketThemeReconciliation({...f,rounds:[{...valid,batches:[...valid.batches,valid.batches[0]]}]}));
  for(const change of [(d:any)=>{d.target.groupId='outside';},(d:any)=>{d.evidence[0].quote='invented';}]){
    const bad=structuredClone(valid);change(bad.batches[0].output.themes[0].decision);assert.throws(()=>planMarketThemeReconciliation({...f,rounds:[bad]}));
  }
  const invented=structuredClone(valid),batch=invented.batches[0],decision=batch.output.themes[0].decision;
  assert.equal(decision.status,'mapped');if(decision.status!=='mapped')throw new Error('fixture');
  decision.target={kind:'proposed',proposalId:'new'};batch.output.proposals=[{proposalId:'new',labelZh:'新增提案',definition:'不得在归并中新增',evidence:decision.evidence}];
  assert.throws(()=>planMarketThemeReconciliation({...f,rounds:[invented]}),/catalog_only_proposal/);
  assert.throws(()=>planMarketThemeReconciliation({...f,rounds:[valid,valid]}),/extra reconciliation round/);
});

test('different confirmed targets remain separate and reordered accepted batches preserve the final result',async()=>{
  const f=await fixture(),first=planMarketThemeReconciliation({...f,rounds:[]}),round=await reconciliationRound(f,first);
  const last=round.batches.at(-1)!;
  for(const t of last.output.themes){assert.equal(t.decision.status,'mapped');if(t.decision.status==='mapped')t.decision.target={kind:'existing',groupId:last.input.groupCatalog[1].groupId};}
  const final=planMarketThemeReconciliation({...f,rounds:[round]});assert.equal(final.result!.aggregation.groups.length,2);
  assert.equal(planMarketThemeReconciliation({...f,rounds:[{...round,batches:[...round.batches].reverse()}]}).result!.resultHash,final.result!.resultHash);
});

test('batch-local proposals never silently merge; all source counts and coverage remain authoritative', async () => {
  const f = await fixture(), result = calculateMarketThemeMappingRules(f);
  assert.equal(result.aggregation.totals!.mention, 91); assert.equal(result.aggregation.groups.length, 2);
  assert.equal(new Set(result.groups.map(g => g.groupId)).size, 2);
  assert.equal(result.semantics.status, 'awaiting-reconciliation'); assert.equal(result.semantics.validatedMemberCount, 13);
  assert.equal(result.aggregation.coverage.status, 'partial'); assert.equal(result.aggregation.coverage.missingAsinCount, 1);
  assert.ok(result.aggregation.groups.every(g => g.topicShare.denominator === 91));
  assert.deepEqual(calculateMarketThemeMappingRules({ ...f, batches: [...f.batches].reverse() }), result);
  const top = calculateMarketThemeMappingRules({ ...f, topN: 1 });
  assert.equal(top.aggregation.groups.length, 1); assert.equal(top.aggregation.groups[0].topicShare.denominator, 91);
  assert.equal(top.aggregation.display.omittedGroupCount, 1); assert.notEqual(top.resultHash, result.resultHash);
});

test('missing batches and explicit unknown decisions remain separate from mapped members and source gaps', async () => {
  const f = await fixture(), first = structuredClone(f.batches[0]);
  first.output.themes[0].decision = { status: 'unknown', reason: 'ambiguous', evidence: [] };
  first.output.proposals[0].evidence = first.output.themes[1].decision.evidence;
  const result = calculateMarketThemeMappingRules({ ...f, batches: [first] });
  assert.equal(result.aggregation.totals!.mention, 91); assert.equal(result.semantics.status, 'partial');
  assert.equal(result.semantics.unknownMemberIds.length, 1); assert.equal(result.semantics.unavailableMemberIds.length, 1);
  assert.equal(result.semantics.mappedMemberCount, 11); assert.equal(result.aggregation.mappings.length, 11);
  assert.equal(result.decisions.find(d => d.sourceThemeId === first.output.themes[0].sourceThemeId)!.reason, 'ambiguous');
  const none = calculateMarketThemeMappingRules({ ...f, batches: [] });
  assert.equal(none.aggregation.totals!.mention, 91); assert.equal(none.semantics.status, 'unavailable');
  assert.equal(none.aggregation.mappings.length, 0); assert.equal(none.semantics.unavailableMemberIds.length, 13);
});

test('frozen existing groups can join across batches without adopting model labels as catalog definitions', async () => {
  const f = await fixture();
  for (const b of f.batches) { b.output.proposals = []; for (const t of b.output.themes) { assert.equal(t.decision.status, 'mapped'); if (t.decision.status === 'mapped') t.decision.target = { kind: 'existing', groupId: 'assembly' }; } }
  const result = calculateMarketThemeMappingRules(f);
  assert.equal(result.aggregation.groups.length, 1); assert.equal(result.aggregation.groups[0].topicShare.valuePct, 100);
  assert.equal(result.semantics.status, 'mapped'); assert.equal(result.groups[0].definition, '组装体验');
  assert.equal(result.groups[0].origin, 'catalog');
});

test('duplicate batch members, invented evidence/counts, foreign pools and forged numeric inputs reject', async () => {
  const f = await fixture();
  assert.throws(() => calculateMarketThemeMappingRules({ ...f, batches: [...f.batches, f.batches[0]] }));
  const bad = structuredClone(f); (bad.batches[0].output.themes[0].decision as Record<string, unknown>).mention = 999;
  assert.throws(() => calculateMarketThemeMappingRules(bad));
  const quote = structuredClone(f); quote.batches[0].output.themes[0].decision.evidence[0].quote = 'FAKE';
  assert.throws(() => calculateMarketThemeMappingRules(quote));
  const foreign = await fixture(); assert.throws(() => calculateMarketThemeMappingRules({ ...f, batches: foreign.batches }));
  const forged = structuredClone(f), obs = forged.poolInput.observations[0].snapshot;
  const raw = (obs.records[0].data as { result: CustomerThemesAsinInput }).result; assert.equal(raw.status, 'success');
  if (raw.status === 'success') raw.themes[0].mention = 999;
  forged.poolInput.observations[0].snapshot = createMarketInputSnapshot({ scope: obs.scope, kind: obs.kind, sourceVersion: obs.sourceVersion,
    ruleVersion: obs.ruleVersion, collectedAt: obs.collectedAt, expectedRecordIds: obs.expectedRecordIds, records: obs.records });
  assert.throws(() => calculateMarketThemeMappingRules(forged));
});

test('empty source pools expose no-input with null totals rather than a successful zero or model mapping', async () => {
  const f = await fixture(0), result = calculateMarketThemeMappingRules(f);
  assert.equal(result.semantics.status, 'no-input'); assert.equal(result.aggregation.totals, null);
  assert.equal(result.aggregation.coverage.emptyAsinCount, 1); assert.equal(result.aggregation.coverage.missingAsinCount, 1);
  assert.deepEqual(result.groups, []); assert.deepEqual(result.decisions, []);
});
