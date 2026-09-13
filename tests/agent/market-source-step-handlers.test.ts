import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { runPostgresMigrations } from '../../server/db/postgres/migrations';
import { createMarketSourceStepHandlers, MARKET_SOURCE_HANDLER_VERSION } from '../../server/runtime/market-source-step-handlers';
import { MarketModuleStepWorker } from '../../server/runtime/market-module-step-worker';
import { ConnectorError,type ConnectorRequest,type RemoteMcpConnector } from '../../server/connectors/connector-contract';
import type { MarketStepKind, MarketStepInputRef } from '../../server/db/market-module-execution-repository';
import type { MarketJsonValue } from '../../shared/market-analysis-contracts';
import { createMarketSemanticFixture } from './helpers/market-semantic-fixture';
import { startPostgresTestContainer } from './helpers/postgres-test-container';
import { createAgentService } from '../../server/agent-service';
import { PostgresAgentRepository } from '../../server/db/postgres-repository';
import type { OpenAIProviderOptions } from '../../server/runtime/openai-provider';
import {marketShapeFlowInitialSteps} from '../../server/domain/market-research/shape-price-flow';

test('source steps persist governed collections without requiring a model', { timeout: 120000 }, async t => {
  const pg = await startPostgresTestContainer(); t.after(() => pg.close()); await runPostgresMigrations(pg.pool);
  const f = await createMarketSemanticFixture(pg.pool);
  await f.stores.steps.cancelModuleRun({ actor: f.actor, moduleRunId: f.subject.moduleRunId, idempotencyKey: randomUUID() });
  const calls: ConnectorRequest[] = []; const asin = 'B000000001';
  let productPayload: Record<string, unknown> = { code: 'OK', data: [{ asin, title: 'Synthetic lamp', brand: 'Fixture', totalUnits: 0,
    price: null, totalRevenue: null, ranking: 1, sellerName: 'Fixture', sellerType: 'FBA', shelfDate: '2025-01-01', rating: 4, ratings: 5 }] };
  let failOverviewStatistics=false;
  const connector = (id: 'sellerSprite' | 'sorftime'): RemoteMcpConnector => ({ id, probe: async () => { throw new Error('not used'); }, execute: async request => {
    calls.push(request);
    if(failOverviewStatistics&&request.operation==='market_research_statistics')throw new ConnectorError('sellerSprite','upstream-permanent',false);
    const overview={nodeIdPath:f.scope.nodeIdPath,nodeId:'34',month:'202608',marketplace:'US',currency:'USD',topProducts:100,totalUnits:0,totalRevenue:0};
    const data = request.operation === 'market_research'?{code:'OK',data:{items:[overview]}}:request.operation==='market_research_statistics'?{code:'OK',data:{...overview,brands:5}}:request.operation === 'market_product_concentration' ? productPayload
      : request.operation === 'keyword_extends' ? { doc: { recommended_cpc_bid: 'USD' }, data: [{ keyword: 'fixture lamp', weekly_search_volume: 10, monthly_search_volume: 20, recommended_cpc_bid: '1.5' }] }
      : request.operation === 'keyword_trend' ? { doc: {}, data: { keyword: 'fixture lamp', search_volume_trend: ['2026-08 search volume 20'], search_rank_trend: [], recommended_bid_trend: [] } }
      : { data: { customer_say: 'Synthetic summary', details: [{ keyword: 'assembly', content: 'Easy assembly', mention: 2, positive: 2, negative: 0, update_time: '2026-08-01' }] } };
    return { data, source: { connectorId: id, operation: request.operation, fetchedAt: new Date().toISOString(), attemptCount: 1 } };
  } });
  const handlers = createMarketSourceStepHandlers({ context: f.context, connectors: { sellerSprite: connector('sellerSprite'), sorftime: connector('sorftime') } });
  const worker = new MarketModuleStepWorker({ steps: f.stores.steps, handlers }); t.after(() => worker.stop());
  async function create(kind: MarketStepKind, input: MarketJsonValue, inputRefs: MarketStepInputRef[] = [], sourceVersion = MARKET_SOURCE_HANDLER_VERSION) {
    return (await f.stores.steps.createModuleRun({ actor: f.actor, scope: f.scope, moduleKind: kind === 'collect-overview-month'?'overview':kind === 'collect-product-month' ? 'shape-price' : kind === 'collect-customer-themes' ? 'customer-themes' : 'keywords',
      params: {}, versions: { source: sourceVersion, rule: 'rules/v1', mapping: 'mapping/v1', planner: 'planner/v1', model: null, prompt: null, configuration: null },
      collectionRevision: randomUUID(), idempotencyKey: randomUUID(), initialSteps: [{ stepKey: 'collect/one', kind, subject: {}, input, inputRefs }] })).run;
  }
  const view = (id: string) => f.stores.steps.findModuleRun({ actor: f.actor, moduleRunId: id });
  let productInputId = '', keywordInputId = '', keywordId = '';
  await t.test('overview endpoints persist raw sources atomically and retry only the failed sibling',async sub=>{
    failOverviewStatistics=true;sub.after(()=>{failOverviewStatistics=false;});
    const operations=['market_research','market_research_statistics'] as const;
    const run=(await f.stores.steps.createModuleRun({actor:f.actor,scope:f.scope,moduleKind:'overview',params:{headTopN:10,newProductMonths:6},
      versions:{source:MARKET_SOURCE_HANDLER_VERSION,rule:'overview/v1',mapping:'overview/v1',planner:'overview/v1',model:null,prompt:null,configuration:null},collectionRevision:randomUUID(),idempotencyKey:randomUUID(),
      initialSteps:operations.map(operation=>({stepKey:operation,kind:'collect-overview-month' as const,subject:{},input:{month:'2026-08',operation,headTopN:10,newProductMonths:6},inputRefs:[]}))})).run;
    const before=calls.length;await worker.tick();await worker.tick();const saved=(await view(run.id))!;
    const succeeded=saved.steps.find(s=>s.status==='succeeded')!,failed=saved.steps.find(s=>s.status==='failed')!;assert.ok(succeeded,JSON.stringify({steps:saved.steps,attempts:saved.attempts,diagnostics:(await pg.pool.query('SELECT diagnostic_json FROM market_analysis_step_attempts WHERE run_id=$1',[run.id])).rows}));assert.ok(failed);
    assert.deepEqual(saved.attempts.find(a=>a.id===failed.latestAttemptId)!.error,{code:'invalid-data',retryable:false});
    assert.equal((await pg.pool.query('SELECT diagnostic_json FROM market_analysis_step_attempts WHERE id=$1',[failed.latestAttemptId])).rows[0].diagnostic_json.sourceCode,'upstream-permanent');
    const output=saved.attempts.find(a=>a.id===succeeded.latestAttemptId)!.output as any;
    const source=await f.stores.snapshots.findSource({actor:f.actor,studyId:f.scope.researchId,id:output.sourceRef});assert.ok(source);assert.equal((source.evidence.payload as any).data.items[0].totalUnits,0);
    const snapshot=await f.stores.snapshots.findInput({actor:f.actor,studyId:f.scope.researchId,id:output.inputSnapshotId});assert.equal(snapshot!.snapshot.kind,'overview');assert.equal(snapshot!.snapshot.records[0].id,'2026-08:market_research');assert.equal((snapshot!.snapshot.records[0].data as any).sourceRef,source.id);
    failOverviewStatistics=false;await f.stores.steps.retryFailedSteps({actor:f.actor,moduleRunId:run.id,steps:[{stepId:failed.id,failedAttemptId:failed.latestAttemptId!}],idempotencyKey:randomUUID()});await worker.tick();
    const recovered=(await view(run.id))!;assert.equal(recovered.steps.find(s=>s.id===succeeded.id)!.latestAttemptId,succeeded.latestAttemptId);assert.equal(recovered.steps.find(s=>s.id===failed.id)!.attemptCount,2);
    assert.deepEqual(calls.slice(before).map(c=>c.operation),['market_research','market_research_statistics','market_research_statistics']);assert.notEqual(recovered.run.status,'succeeded');
  });
  await t.test('product month retains zero and unknown fields with source/sampling provenance', async () => {
    const run = await create('collect-product-month', { month: '2026-08', poolSize: 100, newProductMonths: 6 });
    assert.equal(await worker.tick(), true); const saved = (await view(run.id))!;
    assert.equal(saved.steps[0].status, 'succeeded');
    const output = saved.attempts[0].output as { inputSnapshotId: string; collectionStatus: string; sampling: { bsrTopVerified: boolean } };
    assert.equal(output.collectionStatus, 'partial'); assert.equal(output.sampling.bsrTopVerified, false); productInputId = output.inputSnapshotId;
    const input = await f.stores.snapshots.findInput({ actor: f.actor, studyId: f.scope.researchId, id: productInputId });
    const data = input!.snapshot.records[0].data as { product: { units: number; price: null }; sourceRef: string };
    assert.equal(data.product.units, 0); assert.equal(data.product.price, null);
    const evidence = await f.stores.snapshots.findSource({ actor: f.actor, studyId: f.scope.researchId, id: data.sourceRef });
    assert.equal(evidence!.evidence.responseIdentity.month.status, 'unverified');
    assert.deepEqual(calls.at(-1)!.governorScope, { organizationId: f.actor.organizationId, jobId: run.id });
    assert.equal((await pg.pool.query('SELECT count(*) FROM model_budget_reservations WHERE market_module_run_id=$1', [run.id])).rows[0].count, '0');
  });
  await t.test('overview receipt failure rolls back both source and input without touching earlier snapshots',async()=>{
    const counts=async()=> (await pg.pool.query('SELECT (SELECT count(*) FROM market_analysis_sources) AS sources,(SELECT count(*) FROM market_analysis_inputs) AS inputs')).rows[0];
    const before=await counts();const run=await create('collect-overview-month',{month:'2026-08',operation:'market_research_statistics',headTopN:5,newProductMonths:3});
    await pg.pool.query(`CREATE FUNCTION reject_overview_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.run_id='${run.id}' AND NEW.status='succeeded' THEN RAISE EXCEPTION 'synthetic overview receipt failure'; END IF; RETURN NEW; END; $$`);
    await pg.pool.query('CREATE TRIGGER reject_overview_receipt BEFORE UPDATE ON market_analysis_step_attempts FOR EACH ROW EXECUTE FUNCTION reject_overview_receipt()');
    try{await worker.tick();}finally{await pg.pool.query('DROP TRIGGER reject_overview_receipt ON market_analysis_step_attempts');await pg.pool.query('DROP FUNCTION reject_overview_receipt()');}
    const saved=(await view(run.id))!;assert.equal(saved.steps[0].status,'failed');assert.equal(saved.attempts[0].output,null);assert.deepEqual(await counts(),before);
  });
  await t.test('keyword page creates stable members and trend must match one saved page member', async () => {
    const page = await create('collect-keyword-page', { seed: 'shelf lamp', page: 1 }); await worker.tick();
    const pageOutput = (await view(page.id))!.attempts[0].output as { inputSnapshotId: string }; keywordInputId = pageOutput.inputSnapshotId;
    const saved = await f.stores.snapshots.findInput({ actor: f.actor, studyId: f.scope.researchId, id: keywordInputId }); keywordId = saved!.snapshot.records[0].id;
    const trend = await create('collect-keyword-trend', { keyword: 'fixture lamp', keywordId, poolInputSnapshotId: keywordInputId }, [{ kind: 'input', id: keywordInputId }]); await worker.tick();
    assert.equal((await view(trend.id))!.steps[0].status, 'succeeded');
    const prior = calls.length;
    const wrong = await create('collect-keyword-trend', { keyword: 'other lamp', keywordId, poolInputSnapshotId: keywordInputId }, [{ kind: 'input', id: keywordInputId }]); await worker.tick();
    assert.equal((await view(wrong.id))!.steps[0].status, 'failed'); assert.equal(calls.length, prior);
  });
  await t.test('themes require the saved product selection and retain Customers Say source counts', async () => {
    const run = await create('collect-customer-themes', { asin, selectionInputSnapshotId: productInputId }, [{ kind: 'input', id: productInputId }]); await worker.tick();
    const output = (await view(run.id))!.attempts[0].output as { inputSnapshotId: string };
    const saved = await f.stores.snapshots.findInput({ actor: f.actor, studyId: f.scope.researchId, id: output.inputSnapshotId });
    const data = saved!.snapshot.records[0].data as { collection: string; result: { status: string; themes: { mention: number }[] } };
    assert.equal(data.collection, 'customer-themes'); assert.equal(data.result.status, 'success'); assert.equal(data.result.themes[0].mention, 2);
    const before = calls.length;
    const wrong = await create('collect-customer-themes', { asin: 'B000000002', selectionInputSnapshotId: productInputId }, [{ kind: 'input', id: productInputId }]); await worker.tick();
    assert.equal((await view(wrong.id))!.steps[0].status, 'failed'); assert.equal(calls.length, before);
  });
  await t.test('fixed missing products remain in the expected input pool rather than becoming zero', async () => {
    productPayload = { code: 'OK', data: [] };
    const run = await create('collect-product-month', { month: '2026-07', poolSize: 1, newProductMonths: 6, selectedAsins: [asin], selectionInputSnapshotId: productInputId }, [{ kind: 'input', id: productInputId }]);
    await worker.tick(); const saved = (await view(run.id))!; assert.equal(saved.steps[0].status, 'empty');
    const output = saved.attempts[0].output as { inputSnapshotId: string };
    const input = await f.stores.snapshots.findInput({ actor: f.actor, studyId: f.scope.researchId, id: output.inputSnapshotId });
    assert.deepEqual(input!.snapshot.expectedRecordIds, [asin]); assert.deepEqual(input!.snapshot.records, []);
  });
  await t.test('wrong scope is a failed attempt with no accepted source or input', async () => {
    productPayload = { code: 'OK', site: 'UK', data: [] };
    const before = (await pg.pool.query('SELECT count(*) FROM market_analysis_sources')).rows[0].count;
    const run = await create('collect-product-month', { month: '2026-08', poolSize: 100, newProductMonths: 6 }); await worker.tick();
    const saved = (await view(run.id))!; assert.equal(saved.steps[0].status, 'failed'); assert.equal(saved.attempts[0].output, null);
    assert.deepEqual(saved.attempts[0].error, { code: 'scope-mismatch', retryable: false });
    assert.equal((await pg.pool.query('SELECT count(*) FROM market_analysis_sources')).rows[0].count, before);
  });
  await t.test('source/input writes and successful collection receipt roll back together on persistence failure', async () => {
    productPayload = { code: 'OK', marker: 'synthetic-rollback', data: [] };
    const run = await create('collect-product-month', { month: '2026-08', poolSize: 100, newProductMonths: 6 });
    await pg.pool.query(`CREATE FUNCTION reject_source_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.run_id='${run.id}' AND NEW.status='empty' THEN RAISE EXCEPTION 'synthetic write failure'; END IF; RETURN NEW; END; $$`);
    await pg.pool.query('CREATE TRIGGER reject_source_receipt BEFORE UPDATE ON market_analysis_step_attempts FOR EACH ROW EXECUTE FUNCTION reject_source_receipt()');
    try { await worker.tick(); }
    finally { await pg.pool.query('DROP TRIGGER reject_source_receipt ON market_analysis_step_attempts'); await pg.pool.query('DROP FUNCTION reject_source_receipt()'); }
    const saved = (await view(run.id))!; assert.equal(saved.steps[0].status, 'failed');
    assert.equal((await pg.pool.query("SELECT count(*) FROM market_analysis_sources WHERE document_json->'payload'->>'marker'='synthetic-rollback'")).rows[0].count, '0');
  });
  await t.test('real Agent Service consumes source tasks even with no model configuration', async () => {
    productPayload = { code: 'OK', data: [] };
    const run = await create('collect-product-month', { month: '2026-08', poolSize: 100, newProductMonths: 6 }); const prior = calls.length;
    const overviewRun=await create('collect-overview-month',{month:'2026-08',operation:'market_research',headTopN:10,newProductMonths:6});
    const shapeRequest={actor:f.actor,scope:f.scope,moduleKind:'shape-price' as const,params:{flow:'market-shape-price-flow/v1',poolSize:100,newProductMonths:6,catalog:{task:'market-product-shape-suggestion',taxonomyVersion:'empty-shapes/v1',allowedLabels:[]}},versions:{source:MARKET_SOURCE_HANDLER_VERSION,rule:'market-shape-price-catalog/v1',mapping:'empty-shapes/v1',planner:'market-shape-price-flow/v1',model:null,prompt:null,configuration:null},collectionRevision:'initial/v1',idempotencyKey:randomUUID()};
    const shapeRun=(await f.stores.steps.createModuleRun({...shapeRequest,initialSteps:marketShapeFlowInitialSteps(shapeRequest)})).run;
    const service = await createAgentService({ repository: new PostgresAgentRepository(pg.pool), logger: false,
      connectors: { sellerSprite: connector('sellerSprite'), sorftime: connector('sorftime'), sif: { id: 'sif', execute: async () => { throw new Error('unused'); }, probe: async () => { throw new Error('unused'); } } },
      env: { AGENT_SERVICE_PROXY_TOKEN: 'synthetic-service-token', AGENT_SERVICE_TRUSTED_ORIGINS: 'http://127.0.0.1:3001', AGENT_AUTH_ALLOW_ANONYMOUS_LOOPBACK: '1' } });
    try {
      await service.start({ host: '127.0.0.1', port: 0 }); const deadline = Date.now() + 10000;
      while (((await view(run.id))!.steps[0].status !== 'empty'||(await view(overviewRun.id))!.steps[0].status!=='succeeded'||!(await view(shapeRun.id))!.steps.some(s=>s.kind==='prepare-members'&&s.status==='empty')) && Date.now() < deadline) await new Promise(r => setTimeout(r, 25));
      assert.equal((await view(run.id))!.steps[0].status, 'empty');assert.equal((await view(overviewRun.id))!.steps[0].status,'succeeded'); assert.equal(calls.length, prior + 3);
      const emptyShape=(await view(shapeRun.id))!;assert.equal(emptyShape.steps.length,2);assert.ok(emptyShape.steps.every(s=>s.status==='empty'));assert.equal(emptyShape.run.status,'partial');
    } finally { await service.stop(); }
  });
  await t.test('caller scope overrides and unbound saved input references reject before collection', async () => {
    const before = calls.length;
    const override = await create('collect-product-month', { month: '2026-08', poolSize: 100, newProductMonths: 6, scope: { marketplace: 'UK' } }); await worker.tick();
    assert.equal((await view(override.id))!.steps[0].status, 'failed');
    const unbound = await create('collect-customer-themes', { asin, selectionInputSnapshotId: productInputId }); await worker.tick();
    assert.equal((await view(unbound.id))!.steps[0].status, 'failed');
    const obsolete = await create('collect-product-month', { month: '2026-08', poolSize: 100, newProductMonths: 6 }, [], 'obsolete/source-policy'); await worker.tick();
    assert.equal((await view(obsolete.id))!.steps[0].status, 'failed'); assert.equal(calls.length, before);
  });
  await t.test('configured Agent Service registers collections in its combined runtime without invoking a model', async () => {
    productPayload = { code: 'OK', data: [] };
    const run = await create('collect-product-month', { month: '2026-08', poolSize: 100, newProductMonths: 6 }); const prior = calls.length; let modelCalls = 0;
    const client = { responses: { create: async () => { modelCalls++; throw new Error('Collection must not invoke model'); } } } as unknown as OpenAIProviderOptions['client'];
    const service = await createAgentService({ repository: new PostgresAgentRepository(pg.pool), logger: false, marketModelClient: client,
      connectors: { sellerSprite: connector('sellerSprite'), sorftime: connector('sorftime'), sif: { id: 'sif', execute: async () => { throw new Error('unused'); }, probe: async () => { throw new Error('unused'); } } },
      env: { AGENT_SERVICE_PROXY_TOKEN: 'synthetic-service-token', AGENT_SERVICE_TRUSTED_ORIGINS: 'http://127.0.0.1:3001', AGENT_AUTH_ALLOW_ANONYMOUS_LOOPBACK: '1',
        AGENT_VOC_LOCAL_FAKE: '1', OPENAI_API_KEY: 'synthetic-key', AGENT_VOC_MODEL: 'synthetic-model', AGENT_VOC_ESTIMATED_INPUT_TOKENS: '10000',
        AGENT_VOC_MAX_OUTPUT_TOKENS: '4000', AGENT_VOC_TIMEOUT_MS: '90000', AGENT_VOC_INPUT_USD_PER_MILLION_TOKENS: '1', AGENT_VOC_OUTPUT_USD_PER_MILLION_TOKENS: '2',
        AGENT_VOC_CALL_MAX_TOKENS: '100000', AGENT_VOC_CALL_MAX_COST_MICROS: '1000000', AGENT_VOC_RUN_MAX_TOKENS: '100000', AGENT_VOC_RUN_MAX_COST_MICROS: '1000000',
        AGENT_VOC_DAILY_MAX_TOKENS: '100000', AGENT_VOC_DAILY_MAX_COST_MICROS: '1000000', AGENT_VOC_WORKER_OWNER_ID: 'synthetic-worker' } });
    try {
      await service.start({ host: '127.0.0.1', port: 0 }); const deadline = Date.now() + 10000;
      while ((await view(run.id))!.steps[0].status !== 'empty' && Date.now() < deadline) await new Promise(r => setTimeout(r, 25));
      assert.equal((await view(run.id))!.steps[0].status, 'empty'); assert.equal(calls.length, prior + 1); assert.equal(modelCalls, 0);
    } finally { await service.stop(); }
  });
});
