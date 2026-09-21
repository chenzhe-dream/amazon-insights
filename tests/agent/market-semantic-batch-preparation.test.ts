import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { runPostgresMigrations } from '../../server/db/postgres/migrations';
import { MarketSemanticBatchPreparationService } from '../../server/runtime/market-semantic-batch-preparation';
import { MarketSemanticExecutionService, type ResolvedMarketSemanticConfiguration } from '../../server/runtime/market-semantic-execution-service';
import { SkillRegistry } from '../../server/skills/registry';
import { marketSemanticTaskDefinitions } from '../../server/skills/market-semantic-task-definitions';
import type { MarketSemanticRecord, MarketSemanticInput } from '../../shared/market-semantic-contracts';
import type { OpenAIProviderOptions } from '../../server/runtime/openai-provider';
import { createMarketSemanticFixture } from './helpers/market-semantic-fixture';
import { startPostgresTestContainer } from './helpers/postgres-test-container';
import {buildMarketOverviewSourceCatalog} from '../../server/domain/market-research/overview-source-catalog';
import {planMarketOverviewSemanticWindows} from '../../server/domain/market-research/overview-semantic-windows';
import {planMarketSemanticBatches} from '../../server/domain/market-research/semantic-batch-plan';
import {createMarketSemanticBatchMeter} from '../../server/runtime/market-semantic-batch-meter';
import {createMarketSemanticSkillRunner} from '../../server/runtime/market-semantic-runner';
import { measureMarketRequestInput } from '../../server/runtime/market-request-admission';
import { createRelayJsonSchemaInstruction } from '../../server/runtime/openai-provider';
import type { StructuredGenerationRequest } from '../../server/runtime/model-provider';
import type { StrictJsonSchemaResponseFormat } from '../../server/runtime/structured-response-format';

test('persisted semantic batch preparation and governed execution', { timeout: 120000 }, async t => {
  const pg = await startPostgresTestContainer(); t.after(() => pg.close()); await runPostgresMigrations(pg.pool);
  const registry = await SkillRegistry.open('skills-src'); const manifest = (await registry.load('market-classify-keyword-demand', '1.0.0')).manifest;
  async function fixture(count = 9) {
    const f = await createMarketSemanticFixture(pg.pool, { manifest });
    await f.stores.steps.cancelModuleRun({ actor: f.actor, moduleRunId: f.subject.moduleRunId, idempotencyKey: randomUUID() });
    const semantic = (f.inputSnapshot.records[0].data as { semantic: { task: string; keyword: { keywordId: string; text: { recordId: string; refId: string; text: string; sourceRef: string; field: string } } } }).semantic;
    const records = Array.from({ length: count }, (_, i) => { const id = `keyword-${String(i).padStart(3, '0')}`;
      return { id, scope: f.scope, data: { semantic: { ...semantic, keyword: { ...semantic.keyword, keywordId: id,
        text: { ...semantic.keyword.text, refId: `${id}-text`, recordId: id } } } } }; });
    const saved = await f.stores.snapshots.saveInput({ actor: f.actor, studyId: f.scope.researchId, now: new Date().toISOString(), input: {
      scope: f.scope, kind: 'keywords', sourceVersion: 'synthetic/v1', ruleVersion: 'semantic/v1', collectedAt: f.inputSnapshot.collectedAt,
      expectedRecordIds: [...records.map(r => r.id), 'missing-keyword'], records } });
    const created = await f.stores.steps.createModuleRun({ actor: f.actor, scope: f.scope, moduleKind: 'keywords', params: {},
      versions: { source: 'synthetic/v1', rule: 'semantic/v1', mapping: 'mapping/v1', planner: 'planner/v1', model: 'market.semantic.text.v1', prompt: 'prompt/v1', configuration: 'fixture/v1' },
      collectionRevision: randomUUID(), idempotencyKey: randomUUID(), initialSteps: [{ stepKey: 'prepare/keywords', kind: 'prepare-model-batches', subject: { task: semantic.task },
        input: { task: semantic.task, inputSnapshotId: saved.snapshot.snapshotId, selectionRevision: 'selection/v1', dataCutoffAt: f.inputProjection.dataCutoffAt },
        inputRefs: [{ kind: 'input', id: saved.snapshot.snapshotId }] }] });
    const claim = await f.stores.steps.claimStep({ moduleRunId: created.run.id, leaseOwnerId: randomUUID(), leaseMs: 120000 }); assert.ok(claim);
    let calls = 0; const bodies: unknown[] = [];
    const client = { responses: { create: async (body: { input: string }) => {
      calls++; bodies.push(body); const input = JSON.parse(body.input), unknown = { status: 'unknown', reason: 'insufficient-evidence', evidence: [] };
      const output = { schemaVersion: '1.0.0', task: input.task, batchId: input.batchId, inputDigest: input.inputDigest,
        keywords: input.keywords.map((k: { keywordId: string }) => ({ keywordId: k.keywordId, W1: unknown, W2: unknown, W3: unknown, W4: unknown, cluster: unknown })), proposals: [], synonymRelations: [] };
      return { id: 'synthetic-response', status: 'completed', usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
        output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(output) }] }] };
    } } } as unknown as OpenAIProviderOptions['client'];
    const cap = { maxTokens: 100000, maxCostMicros: 1000000 };
    const configuration: ResolvedMarketSemanticConfiguration = { task: 'market-keyword-semantics', configurationVersion: 'fixture/v1',
      model: { name: 'gpt-5.6', estimatedInputTokens: 10000, maxOutputTokens: 4000, timeoutMs: 90000,
        pricing: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 2 } }, providerName: 'synthetic', transport: 'responses-strict',
      limits: { call: cap, run: cap, organizationUtcDay: cap }, openAI: { client } };
    return { ...f, saved, claim, configuration, calls: () => calls, bodies, service: new MarketSemanticBatchPreparationService(f.context, registry) };
  }
  await t.test('full-request sizing creates persisted partition, preserves missing members and executes every accepted batch', async () => {
    const f = await fixture(81); const prepared = await f.service.prepareBatches(f.claim, f.configuration);
    assert.equal(prepared.replayed, false); const result = prepared.manifest as { missingMemberIds: string[]; batches: { bindingId: string; memberRefs: string[] }[] };
    assert.deepEqual(result.missingMemberIds, ['missing-keyword']); assert.ok(result.batches.length > 1);
    assert.deepEqual(result.batches.flatMap(b => b.memberRefs), f.saved.snapshot.records.map(r => r.id));
    assert.equal(f.calls(), 0);
    assert.equal((await pg.pool.query('SELECT count(*) FROM model_budget_reservations WHERE market_module_run_id=$1', [f.claim.moduleRunId])).rows[0].count, '0');
    const replay = await f.service.prepareBatches(f.claim, f.configuration); assert.equal(replay.replayed, true); assert.deepEqual(replay.manifest, prepared.manifest);
    const execution = new MarketSemanticExecutionService(f.context, registry);
    for (const batch of result.batches) {
      const binding = await f.stores.audit.findSnapshotBinding({ actor: f.actor, studyId: f.scope.researchId, moduleRunId: f.claim.moduleRunId, bindingId: batch.bindingId });
      assert.deepEqual(binding!.memberRefs, batch.memberRefs);
      const model = await f.stores.steps.claimStep({ moduleRunId: f.claim.moduleRunId, leaseOwnerId: randomUUID(), leaseMs: 30000, kinds: ['model-batch'] }); assert.ok(model);
      assert.equal((await execution.executeBatch(model, f.configuration)).status, 'succeeded');
    }
    assert.equal(f.calls(), result.batches.length);
    for (const value of f.bodies) {
      const body = value as { model: string; instructions: string; input: string; max_output_tokens: number; text: { format: StrictJsonSchemaResponseFormat } };
      const schemaAppendix = `\n\n${createRelayJsonSchemaInstruction(body.text.format)}`;
      assert.ok(body.instructions.endsWith(schemaAppendix));
      const measured = measureMarketRequestInput({ model: body.model, instructions: body.instructions.slice(0, -schemaAppendix.length),
        input: JSON.parse(body.input), maxOutputTokens: body.max_output_tokens, responseFormat: { format: body.text.format } } as StructuredGenerationRequest<unknown>, 'responses-strict');
      assert.equal(measured.serializedBytes, Buffer.byteLength(JSON.stringify(value), 'utf8'));
      assert.equal(measured.encoding, 'o200k_base');
      assert.ok(measured.estimatedInputTokens + 512 <= f.configuration.model.estimatedInputTokens);
    }
    assert.equal(await f.stores.steps.claimStep({ moduleRunId: f.claim.moduleRunId, leaseOwnerId: randomUUID(), leaseMs: 30000 }), null);
    const view = await f.stores.steps.findModuleRun({ actor: f.actor, moduleRunId: f.claim.moduleRunId });
    assert.notEqual(view!.run.status, 'succeeded'); // Required report publication has not happened.
  });
  await t.test('failure inserting children rolls back every binding and the preparation receipt', async () => {
    const f = await fixture(4);
    await pg.pool.query(`CREATE FUNCTION reject_prepared_child() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.run_id='${f.claim.moduleRunId}' AND NEW.kind='model-batch' THEN RAISE EXCEPTION 'synthetic child failure'; END IF; RETURN NEW; END; $$`);
    await pg.pool.query('CREATE TRIGGER reject_prepared_child BEFORE INSERT ON market_analysis_steps FOR EACH ROW EXECUTE FUNCTION reject_prepared_child()');
    try { await assert.rejects(() => f.service.prepareBatches(f.claim, f.configuration)); }
    finally { await pg.pool.query('DROP TRIGGER reject_prepared_child ON market_analysis_steps'); await pg.pool.query('DROP FUNCTION reject_prepared_child()'); }
    const view = await f.stores.steps.findModuleRun({ actor: f.actor, moduleRunId: f.claim.moduleRunId });
    assert.equal(view!.steps.length, 1); assert.equal(view!.steps[0].status, 'running'); assert.equal(f.calls(), 0);
    assert.equal((await pg.pool.query('SELECT count(*) FROM market_analysis_semantic_snapshot_bindings WHERE module_run_id=$1', [f.claim.moduleRunId])).rows[0].count, '0');
    assert.equal((await f.service.prepareBatches(f.claim, f.configuration)).replayed, false);
  });
  await t.test('lost preparation lease rejects all output, input identity tampering rejects before model work', async () => {
    const f = await fixture(1);
    await assert.rejects(() => f.service.prepareBatches({ ...f.claim, studyId: randomUUID() }, f.configuration));
    await assert.rejects(() => f.service.prepareBatches(f.claim, { ...f.configuration, configurationVersion: 'changed' }));
    await pg.pool.query("UPDATE market_analysis_steps SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [f.claim.stepId]);
    await assert.rejects(() => f.service.prepareBatches(f.claim, f.configuration));
    assert.equal((await pg.pool.query('SELECT count(*) FROM market_analysis_semantic_snapshot_bindings WHERE module_run_id=$1', [f.claim.moduleRunId])).rows[0].count, '0'); assert.equal(f.calls(), 0);
  });
  await t.test('no source members and oversized input remain explicit and never call a model', async () => {
    const f = await fixture(0), empty = await f.service.prepareBatches(f.claim, f.configuration);
    assert.deepEqual((empty.manifest as { batches: unknown[] }).batches, []); assert.equal(f.calls(), 0);
    const oversized = await fixture(1), result = await oversized.service.prepareBatches(oversized.claim, { ...oversized.configuration, model: { ...oversized.configuration.model, estimatedInputTokens: 1000 } });
    assert.deepEqual((result.manifest as { rejectedMembers: unknown[] }).rejectedMembers, [{ memberId: 'keyword-000', reason: 'request-too-large' }]);
    assert.equal(oversized.calls(), 0);
  });
  await t.test('overview, shape and theme batches use their own persisted contracts and audited execution', async () => {
    for (const task of ['market-overview-explanation', 'market-product-shape-suggestion', 'market-customer-theme-mapping'] as const) {
      const f = await fixture(0), asin = 'B000000001', memberId = task === 'market-product-shape-suggestion' ? asin : 'synthetic-member';
      const sourceRef = f.source.id, definition = marketSemanticTaskDefinitions.find(d => d.id === task)!;
      let semantic: MarketSemanticRecord;
      if (task === 'market-overview-explanation') semantic = { task, metrics: [{ metricId: 'units', state: 'known', value: 10,
        unit: { status: 'known', unit: 'count', rawUnit: 'count' }, period: { kind: 'calendar-months', fromMonth: f.scope.fromMonth, toMonth: f.scope.toMonth }, sourceRefs: [sourceRef],
        formulaVersion: 'synthetic/v1', numeratorRef: null, denominatorRef: null, coverage: { status: 'complete', expectedCount: 1, availableCount: 1 } }],
        gaps: [], facts: [{ factId: 'units-value', kind: 'value', metricRefs: ['units'], sourceRefs: [sourceRef], statementTemplateId: 'metric-value' }], interpretationOptions: [], validationOptions: [] };
      else if (task === 'market-product-shape-suggestion') semantic = { task, taxonomyVersion: 'synthetic/v1', allowedLabels: [],
        product: { productId: asin, asin, title: { state: 'known', value: { recordId: asin, refId: 'synthetic-title', sourceRef, field: 'title', text: 'shelf lamp' } }, parameters: { state: 'missing', reason: 'field-absent' } } };
      else semantic = { task, mappingVersion: 'synthetic/v1', selectedAsins: [asin], groupCatalog: [], theme: { sourceThemeId: memberId, asin,
        keyword: { state: 'known', value: { recordId: memberId, refId: 'synthetic-theme', sourceRef, field: 'keyword', text: 'shelf' } }, content: { state: 'missing', reason: 'field-absent' } } };
      const kind = task === 'market-product-shape-suggestion' ? 'products' : task === 'market-overview-explanation' ? 'overview' : 'customer-themes';
      const saved = await f.stores.snapshots.saveInput({ actor: f.actor, studyId: f.scope.researchId, now: new Date().toISOString(), input: { scope: f.scope, kind,
        sourceVersion: 'synthetic/v1', ruleVersion: 'semantic/v1', collectedAt: f.inputSnapshot.collectedAt, expectedRecordIds: [memberId], records: [{ id: memberId, scope: f.scope, data: { semantic } }] } });
      const previous = (await f.stores.steps.findModuleRun({ actor: f.actor, moduleRunId: f.claim.moduleRunId }))!.run;
      const created = await f.stores.steps.createModuleRun({ actor: f.actor, scope: f.scope, moduleKind: kind === 'products' ? 'shape-price' : kind, params: {},
        versions: previous.versions, collectionRevision: randomUUID(), idempotencyKey: randomUUID(), initialSteps: [{ stepKey: 'prepare/model', kind: 'prepare-model-batches', subject: { task },
          input: { task, inputSnapshotId: saved.snapshot.snapshotId, selectionRevision: 'selection/v1', dataCutoffAt: f.inputProjection.dataCutoffAt }, inputRefs: [{ kind: 'input', id: saved.snapshot.snapshotId }] }] });
      const claim = await f.stores.steps.claimStep({ moduleRunId: created.run.id, leaseOwnerId: randomUUID(), leaseMs: 120000 }); assert.ok(claim);
      let calls = 0;
      const client = { responses: { create: async (body: { input: string }) => {
        calls++; const input = JSON.parse(body.input) as MarketSemanticInput, unknown = { status: 'unknown', reason: 'insufficient-evidence', evidence: [] };
        const fields = input.task === 'market-overview-explanation' ? { findings: [{ findingId: 'finding', mode: 'observed', factIds: ['units-value'], evidenceRefs: [sourceRef] }], risks: [], validationTasks: [] }
          : input.task === 'market-product-shape-suggestion' ? { products: input.products.map(p => ({ productId: p.productId, decision: unknown })) }
          : input.task === 'market-customer-theme-mapping' ? { themes: input.themes.map(p => ({ sourceThemeId: p.sourceThemeId, decision: unknown })), proposals: [] } : {};
        return { id: 'synthetic-response', status: 'completed', usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
          output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify({ schemaVersion: '1.0.0', task,
            batchId: input.batchId, inputDigest: input.inputDigest, ...fields }) }] }] };
      } } } as unknown as OpenAIProviderOptions['client'];
      const configuration = { ...f.configuration, task, model: { ...f.configuration.model, estimatedInputTokens: definition.budget.maxInputTokens, timeoutMs: definition.budget.timeoutMs }, openAI: { client } };
      const prepared = await f.service.prepareBatches(claim, configuration);
      assert.equal((prepared.manifest as { batches: unknown[] }).batches.length, 1); assert.equal(calls, 0);
      const model = await f.stores.steps.claimStep({ moduleRunId: created.run.id, leaseOwnerId: randomUUID(), leaseMs: 30000, kinds: ['model-batch'] }); assert.ok(model);
      const result = await new MarketSemanticExecutionService(f.context, registry).executeBatch(model, configuration);
      assert.equal(result.status, 'succeeded', JSON.stringify(result.agentRun.outcome?.error)); assert.equal(result.agentRun.task, task); assert.equal(calls, 1);
    }
  });
  await t.test('raw monthly overview evidence becomes an admitted A1 batch and persisted audited result',async()=>{
    const f=await fixture(0),cutoff=f.inputSnapshot.collectedAt;
    const sourceRows:Array<Awaited<ReturnType<typeof f.stores.snapshots.saveSource>>>=[];
    for(const month of ['2026-07','2026-08']){
      const data={nodeIdPath:f.scope.nodeIdPath,month,marketplace:'US',currency:'USD',topProducts:100,totalUnits:month==='2026-07'?1000:200,totalRevenue:month==='2026-07'?20000:4000,
        brands:12,sellers:15,avgPrice:20,avgUnits:month==='2026-07'?10:2,avgRatings:125,avgRating:4.5,top10ProductCrn:0.42,top10BrandCrn:0.5,top10SellerCrn:0.6,l6NewCount:10,l6NewAvgPrice:18,l6NewAvgSales:3};
      const units=Object.fromEntries(Object.entries(data).filter(([,v])=>typeof v==='number').map(([key])=>[key,
        ['totalRevenue','avgPrice','l6NewAvgPrice'].includes(key)?{status:'known' as const,unit:'currency' as const,rawUnit:'USD',currency:'USD'}:
        key.endsWith('Crn')?{status:'known' as const,unit:'ratio' as const,rawUnit:'ratio'}:{status:'known' as const,unit:'count' as const,rawUnit:'count'}]));
      sourceRows.push(await f.stores.snapshots.saveSource({actor:f.actor,studyId:f.scope.researchId,now:new Date().toISOString(),input:{scope:f.scope,provider:'sellerSprite',operation:'market_research',requestIdentity:{nodeIdPath:f.scope.nodeIdPath,marketplace:'US',currency:'USD',month},
        responseIdentityPaths:{nodeIdPath:[['data','items',0,'nodeIdPath']],month:[['data','items',0,'month']],marketplace:[['data','items',0,'marketplace']],currency:[['data','items',0,'currency']]},payload:{code:'OK',data:{items:[data]}},fetchedAt:cutoff,observationPeriod:{kind:'calendar-months',fromMonth:month,toMonth:month},
        units,coverage:{receivedCount:1,expectedCount:1,truncation:{status:'not-truncated'}}}}));
    }
    const catalog=buildMarketOverviewSourceCatalog({scope:f.scope,parameters:{headTopN:10,newProductMonths:6},dataCutoffAt:cutoff,sources:sourceRows.map(s=>s.evidence)});
    assert.ok(catalog.semanticSnapshot);const {scope,kind,sourceVersion,ruleVersion,collectedAt,expectedRecordIds,records}=catalog.semanticSnapshot;
    await f.stores.snapshots.saveInput({actor:f.actor,studyId:f.scope.researchId,now:new Date().toISOString(),input:{scope,kind,sourceVersion,ruleVersion,collectedAt,expectedRecordIds,records}});
    let calls=0,declines=0;const client={responses:{create:async(body:{input:string})=>{calls++;const input=JSON.parse(body.input) as Extract<MarketSemanticInput, { task: 'market-overview-explanation' }>;
      const decline=input.facts.find(v=>v.factId==='fact:2026-08/totalUnitsChangePct'),fact=decline??input.facts[0];assert.ok(fact);
      if(decline){assert.equal(input.metrics.find(m=>m.metricId==='2026-08/totalUnitsChangePct')!.value,-80);declines++;}
      return {id:'synthetic-overview',status:'completed',usage:{input_tokens:100,output_tokens:50,total_tokens:150},output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify({schemaVersion:'1.0.0',task:input.task,batchId:input.batchId,inputDigest:input.inputDigest,findings:[{findingId:'sample-decline',mode:'observed',factIds:[fact.factId],evidenceRefs:fact.sourceRefs}],risks:[],validationTasks:[]})}]}]};}}} as unknown as OpenAIProviderOptions['client'];
    const definition=marketSemanticTaskDefinitions.find(d=>d.id==='market-overview-explanation')!;
    const configuration={...f.configuration,task:definition.id,model:{...f.configuration.model,estimatedInputTokens:definition.budget.maxInputTokens,timeoutMs:definition.budget.timeoutMs},openAI:{client}};
    const meter=createMarketSemanticBatchMeter(createMarketSemanticSkillRunner(f.context,registry,configuration),configuration);
    const windows=await planMarketOverviewSemanticWindows(catalog.semanticSnapshot,async snapshot=>(await planMarketSemanticBatches({task:'market-overview-explanation',moduleRunId:f.claim.moduleRunId,snapshot,
      sources:Object.fromEntries(sourceRows.map(s=>[s.id,s.evidence])),selectionRevision:'overview/v1',configurationVersion:configuration.configurationVersion,dataCutoffAt:cutoff},meter)).batches.length===1);
    assert.deepEqual(windows.rejected,[]);assert.ok(windows.windows.length>=1);assert.equal(calls,0);
    assert.equal(windows.windows.flatMap(w=>w.primaryFactIds).length,20);
    t.diagnostic(JSON.stringify({overviewFactCount:20,overviewWindows:windows.windows.length,rejected:windows.rejected.length}));
    const savedWindows=[];for(const w of windows.windows){const {scope,kind,sourceVersion,ruleVersion,collectedAt,expectedRecordIds,records}=w.snapshot;
      savedWindows.push(await f.stores.snapshots.saveInput({actor:f.actor,studyId:f.scope.researchId,now:new Date().toISOString(),input:{scope,kind,sourceVersion,ruleVersion,collectedAt,expectedRecordIds,records}}));}
    const request={actor:f.actor,scope:f.scope,moduleKind:'overview' as const,params:{},versions:{source:sourceVersion,rule:ruleVersion,mapping:'overview/v1',planner:'overview/v1',model:'market.semantic.text.v1',prompt:'prompt/v1',configuration:'fixture/v1'},collectionRevision:randomUUID(),idempotencyKey:randomUUID(),
      initialSteps:savedWindows.map((saved,index)=>({stepKey:`prepare/overview/${index}`,kind:'prepare-model-batches' as const,subject:{},input:{task:'market-overview-explanation',inputSnapshotId:saved.snapshot.snapshotId,selectionRevision:'overview/v1',dataCutoffAt:cutoff},inputRefs:[{kind:'input' as const,id:saved.snapshot.snapshotId}]}))};
    const run=(await f.stores.steps.createModuleRun(request)).run;
    for(let remaining=windows.windows.length;remaining>0;remaining--){
      const claim=await f.stores.steps.claimStep({moduleRunId:run.id,kinds:['prepare-model-batches'],leaseOwnerId:randomUUID(),leaseMs:120000});assert.ok(claim);
      const prepared=await f.service.prepareBatches(claim,configuration);assert.equal((prepared.manifest as { batches: unknown[] }).batches.length,1,JSON.stringify(prepared.manifest));
      const model=await f.stores.steps.claimStep({moduleRunId:run.id,kinds:['model-batch'],leaseOwnerId:randomUUID(),leaseMs:30000});assert.ok(model);
      const result=await new MarketSemanticExecutionService(f.context,registry).executeBatch(model,configuration);assert.equal(result.status,'succeeded',JSON.stringify(result.agentRun.outcome?.error));
    }
    assert.equal(calls,windows.windows.length);assert.ok(declines>0);
    assert.notEqual((await f.stores.steps.findModuleRun({actor:f.actor,moduleRunId:run.id}))!.run.status,'succeeded','An A1 batch is not yet a complete overview report');
  });
});
