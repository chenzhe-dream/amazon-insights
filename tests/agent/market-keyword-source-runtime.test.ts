import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { runPostgresMigrations } from '../../server/db/postgres/migrations';
import { PostgresQueryContext } from '../../server/db/postgres/query-context';
import { PostgresMarketModuleExecutionStore } from '../../server/db/postgres/market-module-execution-store';
import { PostgresMarketAnalysisSnapshotStore } from '../../server/db/postgres/market-analysis-snapshot-store';
import { MarketModuleStepWorker } from '../../server/runtime/market-module-step-worker';
import { createMarketSourceStepHandlers } from '../../server/runtime/market-source-step-handlers';
import { createMarketKeywordPoolStep } from '../../server/runtime/market-keyword-pool-step';
import { MARKET_SOURCE_HANDLER_VERSION } from '../../shared/market-source-contracts';
import { ConnectorError, type RemoteMcpConnector } from '../../server/connectors/connector-contract';
import { startPostgresTestContainer } from './helpers/postgres-test-container';
import { MARKET_KEYWORD_FLOW_VERSION, marketKeywordFlowInitialSteps, inspectMarketKeywordContinuation } from '../../server/domain/market-research/keyword-flow';
import { MarketModuleService } from '../../server/services/market-module-service';
import { loadVocPositioningRuntimeConfig } from '../../server/config';
import { createMarketModelRuntime } from '../../server/runtime/market-model-runtime';
import type { OpenAIProviderOptions } from '../../server/runtime/openai-provider';
import { createAgentService } from '../../server/agent-service';
import { PostgresAgentRepository } from '../../server/db/postgres-repository';

const catalog = { task: 'market-keyword-semantics' as const, dictionaryVersion: 'synthetic/v1',
  categoryContext: 'Synthetic shelf lamps', dimensionLabels: { W1: [], W2: [], W3: [], W4: [] }, clusterCatalog: [] };

test('category keyword flow persists page mode, stops at a short page and restores a real rule report', {timeout:120000}, async t=>{
  const pg=await startPostgresTestContainer();t.after(()=>pg.close());await runPostgresMigrations(pg.pool);
  const context=new PostgresQueryContext(pg.pool),steps=new PostgresMarketModuleExecutionStore(context),snapshots=new PostgresMarketAnalysisSnapshotStore(context);
  const actor={organizationId:randomUUID(),userId:randomUUID()};
  await pg.pool.query("INSERT INTO users(id,organization_id,email,display_name,role,status,created_at,updated_at) VALUES($1,$2,$3,'Category keyword fixture','member','active',clock_timestamp(),clock_timestamp())",[actor.userId,actor.organizationId,`${actor.userId}@example.com`]);
  const scope={organizationId:actor.organizationId,researchId:randomUUID(),marketplace:'CA' as const,nodeIdPath:'12:3024183011',fromMonth:'2026-09',toMonth:'2026-09',currency:'CAD' as const};
  await snapshots.createStudy({actor,scope,idempotencyKey:randomUUID(),now:new Date().toISOString()});
  const service=new MarketModuleService({context,modelIdentity:()=>null});
  const created=await service.startKeywords(actor,scope.researchId,{catalog,maxMembers:100,paginationMode:'until-short-page/v1',plannedPages:[1,2,3].map(page=>({seed:'Synthetic car seats',page,sourceMode:'category-keywords'}))},randomUUID());
  const calls:Array<{operation:string;input:Record<string,unknown>}>=[];
  const connector:RemoteMcpConnector={id:'sorftime',probe:async()=>{throw Error('Unused');},execute:async request=>{
    calls.push({operation:request.operation,input:request.input});
    const data=request.operation==='category_keywords'?{data:Array.from({length:request.input.page===1?20:1},(_,i)=>({keyword:`synthetic seat ${request.input.page}-${i}`,monthly_search_volume:'100',weekly_search_volume:'20',weekly_search_rank:'10',cpc_exact_bid:'1.53'}))}:{data:{keyword:request.input.keyword,search_volume_trend:['2026-09 search volume 100'],search_rank_trend:[],recommended_bid_trend:[]}};
    return {data,source:{connectorId:'sorftime',operation:request.operation,fetchedAt:new Date().toISOString(),attemptCount:1}};
  }};
  const worker=new MarketModuleStepWorker({steps,handlers:{...createMarketSourceStepHandlers({context,connectors:{sorftime:connector,sellerSprite:{...connector,id:'sellerSprite'}}}),'prepare-keyword-pool':createMarketKeywordPoolStep(context)}});
  t.after(()=>worker.stop());
  for(let i=0;i<60;i++){if(!await worker.tick())break;if(i===59)assert.fail('Category keyword flow did not settle');}
  const {run}=await service.findKeywords(actor,created.run.id);
  assert.equal(run.status,'succeeded',JSON.stringify(run.steps));
  assert.equal(run.facts?.members.length,21);
  assert.equal(run.facts?.pool.receivedPageCount,2);
  assert.ok(run.facts?.members.every(m=>m.occurrences.every(o=>o.sourceMode==='category-keywords')&&m.pageMetrics.recommendedCpcUsd.value===null));
  assert.ok(run.originalEstimate);assert.ok(run.ruleReport);
  assert.deepEqual(calls.filter(c=>c.operation==='category_keywords').map(c=>c.input),[1,2].map(page=>({node_id:'3024183011',amz_site:'CA',page})));
  assert.equal(calls.filter(c=>c.operation==='keyword_trend').length,21);
  assert.equal(calls.some(c=>c.operation==='keyword_extends'),false);
  const restored=await new MarketModuleService({context:new PostgresQueryContext(pg.pool),modelIdentity:()=>null}).findKeywords(actor,run.id);
  assert.deepEqual(restored.run.facts,run.facts);
  assert.deepEqual(restored.run.ruleReport,run.ruleReport);
});

test('keyword pool without a model retains sources and trends, and does not create semantic work', { timeout: 120000 }, async t => {
  const pg = await startPostgresTestContainer(); t.after(() => pg.close());
  await runPostgresMigrations(pg.pool);
  const context = new PostgresQueryContext(pg.pool), steps = new PostgresMarketModuleExecutionStore(context);
  const snapshots = new PostgresMarketAnalysisSnapshotStore(context);
  const actor = { organizationId: randomUUID(), userId: randomUUID() };
  await pg.pool.query("INSERT INTO users(id,organization_id,email,display_name,role,status,created_at,updated_at) VALUES($1,$2,$3,'Keyword fixture','member','active',clock_timestamp(),clock_timestamp())",
    [actor.userId, actor.organizationId, `${actor.userId}@example.com`]);
  const scope = { organizationId: actor.organizationId, researchId: randomUUID(), marketplace: 'US' as const,
    nodeIdPath: '12:34', fromMonth: '2026-07', toMonth: '2026-08', currency: 'USD' as const };
  await snapshots.createStudy({ actor, scope, idempotencyKey: randomUUID(), now: new Date().toISOString() });
  const versions = { source: MARKET_SOURCE_HANDLER_VERSION, rule: 'market-keyword-pool/v1', mapping: catalog.dictionaryVersion,
    planner: 'synthetic/v1', model: null, prompt: null, configuration: null };
  const calls: string[] = [];
  const connector: RemoteMcpConnector = { id: 'sorftime', probe: async () => { throw new Error('Unused'); }, execute: async request => {
    calls.push(request.operation);
    const data = request.operation === 'keyword_extends' ? { data: [{ keyword: 'synthetic shelf lamp', monthly_search_volume: 0 }] }
      : { data: { keyword: request.input.keyword, search_volume_trend: ['2026-08 search volume 20'], search_rank_trend: [], recommended_bid_trend: [] } };
    return { data, source: { connectorId: 'sorftime', operation: request.operation, fetchedAt: new Date().toISOString(), attemptCount: 1 } };
  } };
  const worker = new MarketModuleStepWorker({ steps, handlers: { ...createMarketSourceStepHandlers({ context,
    connectors: { sorftime: connector, sellerSprite: { ...connector, id: 'sellerSprite' } } }), 'prepare-keyword-pool': createMarketKeywordPoolStep(context) } });
  t.after(() => worker.stop());
  const source = await steps.createModuleRun({ actor, scope, moduleKind: 'keywords', params: {}, versions,
    collectionRevision: 'fixture/v1', idempotencyKey: randomUUID(), initialSteps: [
      { stepKey: 'source', kind: 'collect-keyword-page', subject: {}, input: { seed: 'lamp', page: 1 }, inputRefs: [] },
    ] });
  assert.equal(await worker.tick(), true);
  const sourceView = (await steps.findModuleRun({ actor, moduleRunId: source.run.id }))!;
  assert.equal(sourceView.steps[0].status, 'succeeded');
  const page = sourceView.attempts[0].output as { inputSnapshotId: string; sourceRef: string };
  const pooled = await steps.createModuleRun({ actor, scope, moduleKind: 'keywords', params: {}, versions,
    collectionRevision: 'pool/v1', idempotencyKey: randomUUID(), initialSteps: [{ stepKey: 'pool', kind: 'prepare-keyword-pool', subject: {},
      input: { phase: 'assemble', plannedPages: [{ seed: 'lamp', page: 1 }], maxMembers: 20, pages: [page].map(p => ({ inputSnapshotId: p.inputSnapshotId, sourceRef: p.sourceRef })),
        catalog, selectionRevision: 'selection/v1', dataCutoffAt: new Date().toISOString() },
      inputRefs: [{ kind: 'input', id: page.inputSnapshotId }, { kind: 'source', id: page.sourceRef }] }] });
  assert.equal(await worker.tick(), true);
  let view = (await steps.findModuleRun({ actor, moduleRunId: pooled.run.id }))!;
  assert.equal(view.steps.find(s => s.stepKey === 'pool')!.status, 'succeeded');
  assert.equal(view.steps.some(s => s.kind === 'prepare-model-batches'), false);
  assert.equal(await worker.tick(), true); // Durable bounded trend fanout.
  assert.equal(await worker.tick(), true); // Original source text drives trend request.
  assert.equal(await worker.tick(), false);
  view = (await steps.findModuleRun({ actor, moduleRunId: pooled.run.id }))!;
  assert.equal(view.steps.find(s => s.kind === 'collect-keyword-trend')!.status, 'succeeded');
  const receipt = view.attempts.find(a => a.stepId === view.steps.find(s => s.stepKey === 'pool')!.id)!.output as { rawInputSnapshotId: string };
  const raw = (await snapshots.findInput({ actor, studyId: scope.researchId, id: receipt.rawInputSnapshotId }))!;
  assert.equal((raw.snapshot.records[0].data as any).member.monthlySearchVolume.value, 0);
  const poolOutput = view.attempts.find(a => a.stepId === view.steps.find(s => s.stepKey === 'pool')!.id)!.output as { ruleBaseline: { module: string; ruleVersion: string; metrics: { key: string; value: number | null; missingReason: string | null }[] } };
  assert.equal(poolOutput.ruleBaseline.module, 'keywords');
  assert.equal(poolOutput.ruleBaseline.ruleVersion.startsWith('calendar-three-month-growth/v1'), true);
  assert.equal(poolOutput.ruleBaseline.metrics.find(metric => metric.key.endsWith(':searchVolume'))?.value, 0);
  assert.equal(poolOutput.ruleBaseline.metrics.find(metric => metric.key.endsWith(':threeMonthGrowth'))?.missingReason, 'missing-baseline');
  assert.equal(poolOutput.ruleBaseline.metrics.find(metric => metric.key === 'cpc')?.missingReason, 'source-provides-recommended-bid-only');
  assert.deepEqual(calls, ['keyword_extends', 'keyword_trend']);
  assert.equal(view.steps.some(s => s.kind === 'model-batch'), false);
});

test('automatic keyword flow persists partial sources, resumes after restart and retries the current failed page', { timeout: 120000 }, async t => {
  const pg = await startPostgresTestContainer(); t.after(() => pg.close());
  await runPostgresMigrations(pg.pool);
  const context = new PostgresQueryContext(pg.pool), steps = new PostgresMarketModuleExecutionStore(context);
  const snapshots = new PostgresMarketAnalysisSnapshotStore(context);
  const actor = { organizationId: randomUUID(), userId: randomUUID() };
  await pg.pool.query("INSERT INTO users(id,organization_id,email,display_name,role,status,created_at,updated_at) VALUES($1,$2,$3,'Keyword fixture','member','active',clock_timestamp(),clock_timestamp())",
    [actor.userId, actor.organizationId, `${actor.userId}@example.com`]);
  const scope = { organizationId: actor.organizationId, researchId: randomUUID(), marketplace: 'US' as const,
    nodeIdPath: '12:34', fromMonth: '2026-07', toMonth: '2026-08', currency: 'USD' as const };
  await snapshots.createStudy({ actor, scope, idempotencyKey: randomUUID(), now: new Date().toISOString() });
  const request = { actor, scope, moduleKind: 'keywords' as const,
    params: { plannedPages: [{ seed: 'lamp', page: 1 }, { seed: 'lamp', page: 2 }], maxMembers: 20, catalog, flow: MARKET_KEYWORD_FLOW_VERSION },
    versions: { source: MARKET_SOURCE_HANDLER_VERSION, rule: 'market-keyword-pool/v1', mapping: catalog.dictionaryVersion,
      planner: MARKET_KEYWORD_FLOW_VERSION, model: null, prompt: null, configuration: null },
    collectionRevision: 'initial/v1', idempotencyKey: randomUUID() };
  const created = await steps.createModuleRun({ ...request, initialSteps: marketKeywordFlowInitialSteps(request) });
  const replay = await steps.createModuleRun({ ...request, initialSteps: marketKeywordFlowInitialSteps(request) });
  assert.equal(replay.created, false); assert.equal(replay.run.id, created.run.id);
  const calls: { operation: string; page: unknown }[] = []; let failPage = true;
  const connector: RemoteMcpConnector = { id: 'sorftime', probe: async () => { throw new Error('Unused'); }, execute: async r => {
    calls.push({ operation: r.operation, page: r.input.page });
    if (r.operation === 'keyword_extends' && r.input.page === 2 && failPage) throw new ConnectorError('sorftime', 'upstream-permanent', false);
    const data = r.operation === 'keyword_extends'
      ? { data: [{ keyword: `synthetic lamp ${r.input.page}`, monthly_search_volume: r.input.page === 1 ? 0 : 10 }] }
      : { data: { keyword: r.input.keyword, search_volume_trend: ['2026-08 search volume 20'], search_rank_trend: [], recommended_bid_trend: [] } };
    return { data, source: { connectorId: 'sorftime', operation: r.operation, fetchedAt: new Date().toISOString(), attemptCount: 1 } };
  } };
  const events: unknown[] = [];
  const workerFor = (ctx: PostgresQueryContext) => new MarketModuleStepWorker({ steps: new PostgresMarketModuleExecutionStore(ctx),
    onEvent: event => events.push(event), handlers: { ...createMarketSourceStepHandlers({ context: ctx,
      connectors: { sorftime: connector, sellerSprite: { ...connector, id: 'sellerSprite' } } }), 'prepare-keyword-pool': createMarketKeywordPoolStep(ctx) } });
  const first = workerFor(context); t.after(() => first.stop());
  assert.equal(await first.tick(), true); await first.stop(); // Restart in the middle of collecting pages.
  const resumedContext = new PostgresQueryContext(pg.pool), resumed = workerFor(resumedContext); t.after(() => resumed.stop());
  async function drain() { for (let i = 0; i < 30; i++) if (!await resumed.tick()) return; assert.fail('Keyword flow did not quiesce'); }
  await drain();
  const read = () => steps.findModuleRun({ actor, moduleRunId: created.run.id }).then(v => { assert.ok(v); return v; });
  let view = await read();
  const pools = () => view.steps.filter(s => s.kind === 'prepare-keyword-pool' && (s.input as any).phase === 'assemble');
  assert.equal(pools().length, 1, JSON.stringify(events)); assert.equal(pools()[0].status, 'succeeded', JSON.stringify(events));
  const oldPool = pools()[0], oldReceipt = view.attempts.find(a => a.id === oldPool.latestAttemptId)!;
  assert.equal((oldReceipt.output as any).collectionCoverage, 'partial');
  assert.deepEqual((oldReceipt.output as any).missingPages, [{ seed: 'lamp', page: 2 }]);
  const oldSnapshotId = (oldReceipt.output as any).rawInputSnapshotId;
  const oldSnapshot = (await snapshots.findInput({ actor, studyId: scope.researchId, id: oldSnapshotId }))!.snapshot;
  const oldTrends = view.steps.filter(s => s.kind === 'collect-keyword-trend').map(s => s.stepKey);
  assert.equal(oldTrends.length, 1); assert.notEqual(view.run.status, 'succeeded');
  const failed = view.steps.find(s => s.kind === 'collect-keyword-page' && s.status === 'failed')!;
  assert.ok(failed);
  const service = new MarketModuleService({ context: resumedContext, modelIdentity: () => null });
  const retryBody = { steps: [{ stepId: failed.id, failedAttemptId: failed.latestAttemptId! }] }, retryKey = randomUUID();
  failPage = false;
  await service.retry(actor, created.run.id, retryBody, retryKey);
  await service.retry(actor, created.run.id, retryBody, retryKey); // ACK loss does not produce another attempt.
  view = await read();
  let current = inspectMarketKeywordContinuation(view, new Date().toISOString()).currentStepKeys;
  assert.equal(current.includes(oldPool.stepKey), false);
  await drain(); view = await read();
  current = inspectMarketKeywordContinuation(view, new Date().toISOString()).currentStepKeys;
  const activePool = pools().find(s => current.includes(s.stepKey))!;
  assert.ok(activePool); assert.notEqual(activePool.id, oldPool.id); assert.equal(activePool.status, 'succeeded');
  const newReceipt = view.attempts.find(a => a.id === activePool.latestAttemptId)!;
  assert.equal((newReceipt.output as any).collectionCoverage, 'complete');
  assert.equal((newReceipt.output as any).selectedMemberIds.length, 2);
  assert.deepEqual(oldTrends.filter(k => current.includes(k)), []);
  assert.equal(calls.filter(c => c.operation === 'keyword_extends' && c.page === 1).length, 1);
  assert.equal(calls.filter(c => c.operation === 'keyword_extends' && c.page === 2).length, 2);
  assert.equal(view.steps.find(s => s.id === failed.id)!.attemptCount, 2);
  assert.equal(view.steps.some(s => ['prepare-model-batches', 'model-batch', 'report'].includes(s.kind)), false);
  assert.deepEqual((await snapshots.findInput({ actor, studyId: scope.researchId, id: oldSnapshotId }))!.snapshot, oldSnapshot);
  assert.equal(await steps.findModuleRun({ actor: { ...actor, organizationId: randomUUID() }, moduleRunId: created.run.id }), null);
  assert.equal(view.steps.filter(s => current.includes(s.stepKey)).every(s => s.status === 'succeeded'), true);
  await service.cancel(actor, created.run.id, {}, randomUUID());
  assert.equal(await resumed.tick(), false);
  assert.deepEqual(inspectMarketKeywordContinuation(await read(), new Date().toISOString()), { children: [], currentStepKeys: [] });
  assert.deepEqual((await snapshots.findInput({ actor, studyId: scope.researchId, id: oldSnapshotId }))!.snapshot, oldSnapshot);
  await resumed.stop();

  // Use the production combined runtime as well: real queue and audit storage,
  // synthetic SDK only. Unknown fixture output is not a semantic quality claim.
  let modelCalls = 0;
  const base = loadVocPositioningRuntimeConfig({ OPENAI_API_KEY: 'synthetic-key', AGENT_VOC_MODEL: 'gpt-5.6',
    AGENT_VOC_ESTIMATED_INPUT_TOKENS: '10000', AGENT_VOC_MAX_OUTPUT_TOKENS: '4000', AGENT_VOC_TIMEOUT_MS: '90000',
    AGENT_VOC_INPUT_USD_PER_MILLION_TOKENS: '1', AGENT_VOC_OUTPUT_USD_PER_MILLION_TOKENS: '2', AGENT_VOC_CALL_MAX_TOKENS: '100000',
    AGENT_VOC_CALL_MAX_COST_MICROS: '1000000', AGENT_VOC_RUN_MAX_TOKENS: '100000', AGENT_VOC_RUN_MAX_COST_MICROS: '1000000',
    AGENT_VOC_DAILY_MAX_TOKENS: '100000', AGENT_VOC_DAILY_MAX_COST_MICROS: '1000000', AGENT_VOC_WORKER_OWNER_ID: 'synthetic-worker' });
  const client = { responses: { create: async (body: { input: string }) => {
    modelCalls++; const input = JSON.parse(body.input), unknown = { status: 'unknown', reason: 'insufficient-evidence', evidence: [] };
    const output = { schemaVersion: '1.0.0', task: input.task, batchId: input.batchId, inputDigest: input.inputDigest,
      keywords: input.keywords.map((k: { keywordId: string }) => ({ keywordId: k.keywordId, W1: unknown, W2: unknown, W3: unknown, W4: unknown, cluster: unknown })),
      proposals: [], synonymRelations: [] };
    return { id: 'synthetic-response', status: 'completed', usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
      output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(output) }] }] };
  } } } as unknown as OpenAIProviderOptions['client'];
  const runtime = await createMarketModelRuntime(context, base, { client,
    connectors: { sorftime: connector, sellerSprite: { ...connector, id: 'sellerSprite' } } });
  t.after(() => runtime.stop());
  const configuredRequest = { ...request, idempotencyKey: randomUUID(), collectionRevision: 'model/v1',
    params: { ...request.params, flow: MARKET_KEYWORD_FLOW_VERSION },
    versions: { ...request.versions, planner: MARKET_KEYWORD_FLOW_VERSION, model: 'market.semantic.text.v1', prompt: runtime.promptVersion, configuration: runtime.configurationVersion } };
  const configured = await steps.createModuleRun({ ...configuredRequest, initialSteps: marketKeywordFlowInitialSteps(configuredRequest) });
  for (let i = 0; i < 30; i++) { if (!await runtime.tick()) break; assert.ok(i < 29); }
  const configuredView = (await steps.findModuleRun({ actor, moduleRunId: configured.run.id }))!;
  assert.ok(modelCalls > 0, JSON.stringify({ steps: configuredView.steps.map(s => ({kind:s.kind,status:s.status})), errors: configuredView.attempts.filter(a => a.error) }));
  assert.ok(configuredView.steps.every(s => s.status === 'succeeded'), JSON.stringify(configuredView.attempts.filter(a => a.error)));
  const configuredCurrent = inspectMarketKeywordContinuation(configuredView, new Date().toISOString()).currentStepKeys;
  assert.equal(configuredCurrent.length, configuredView.steps.length);
  assert.equal((await pg.pool.query("SELECT count(*) FROM market_agent_runs WHERE module_run_id=$1 AND validation_status='passed'", [configured.run.id])).rows[0].count, String(modelCalls));
  assert.notEqual(configuredView.run.status, 'succeeded'); // No final A3 report is published by this frontier.
  await runtime.stop();

  const fallbackRequest = { ...request, idempotencyKey: randomUUID(), collectionRevision: 'service-start/v1' };
  const fallbackRun = await steps.createModuleRun({ ...fallbackRequest, initialSteps: marketKeywordFlowInitialSteps(fallbackRequest) });
  const agentService = await createAgentService({ repository: new PostgresAgentRepository(pg.pool), logger: false,
    connectors: { sorftime: connector, sellerSprite: { ...connector, id: 'sellerSprite' }, sif: { ...connector, id: 'sif' } },
    env: { AGENT_SERVICE_PROXY_TOKEN: 'synthetic-service-token', AGENT_SERVICE_TRUSTED_ORIGINS: 'http://127.0.0.1:3001', AGENT_AUTH_ALLOW_ANONYMOUS_LOOPBACK: '1' } });
  try {
    await agentService.start({ host: '127.0.0.1', port: 0 });
    const deadline = Date.now() + 20000;
    let fallbackView = (await steps.findModuleRun({ actor, moduleRunId: fallbackRun.run.id }))!;
    while (Date.now() < deadline) {
      fallbackView = (await steps.findModuleRun({ actor, moduleRunId: fallbackRun.run.id }))!;
      if (fallbackView.steps.length > 2 && fallbackView.steps.every(s => s.status === 'succeeded')) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(fallbackView.steps.filter(s => s.kind === 'collect-keyword-trend' && s.status === 'succeeded').length, 2);
    assert.equal(fallbackView.steps.some(s => s.kind === 'prepare-model-batches'), false);
    assert.ok(fallbackView.steps.every(s => s.status === 'succeeded'));
  } finally { await agentService.stop(); }
});

test('malformed trend can be manually retried without recollecting successful and empty keywords', { timeout: 120000 }, async t => {
  const pg = await startPostgresTestContainer(); t.after(() => pg.close()); await runPostgresMigrations(pg.pool);
  const context = new PostgresQueryContext(pg.pool), steps = new PostgresMarketModuleExecutionStore(context);
  const snapshots = new PostgresMarketAnalysisSnapshotStore(context);
  const actor = { organizationId: randomUUID(), userId: randomUUID() };
  await pg.pool.query("INSERT INTO users(id,organization_id,email,display_name,role,status,created_at,updated_at) VALUES($1,$2,$3,'Keyword retry fixture','member','active',clock_timestamp(),clock_timestamp())", [actor.userId, actor.organizationId, `${actor.userId}@example.com`]);
  const scope = { organizationId: actor.organizationId, researchId: randomUUID(), marketplace: 'US' as const, nodeIdPath: '12:34', fromMonth: '2026-08', toMonth: '2026-08', currency: 'USD' as const };
  await snapshots.createStudy({ actor, scope, idempotencyKey: randomUUID(), now: new Date().toISOString() });
  const request = { actor, scope, moduleKind: 'keywords' as const,
    params: { plannedPages: [{ seed: 'lamp', page: 1 }], maxMembers: 20, catalog, flow: MARKET_KEYWORD_FLOW_VERSION },
    versions: { source: MARKET_SOURCE_HANDLER_VERSION, rule: 'market-keyword-pool/v1', mapping: catalog.dictionaryVersion, planner: MARKET_KEYWORD_FLOW_VERSION, model: null, prompt: null, configuration: null },
    collectionRevision: 'initial/v1', idempotencyKey: randomUUID() };
  const created = await steps.createModuleRun({ ...request, initialSteps: marketKeywordFlowInitialSteps(request) });
  const calls: string[] = []; let failing = true;
  const connector: RemoteMcpConnector = { id: 'sorftime', probe: async () => { throw Error('unused'); }, execute: async r => {
    const key = r.operation === 'keyword_extends' ? 'page' : String(r.input.keyword); calls.push(key);
    const data = key === 'page' ? { data: ['good lamp', 'empty lamp', 'failed lamp'].map(keyword => ({ keyword, monthly_search_volume: 10 })) }
      : key === 'failed lamp' && failing ? { unexpected: 'synthetic temporary malformed body' }
      : { data: { keyword: key, search_volume_trend: key === 'empty lamp' ? [] : ['202608', '20'], rank_trend: [], cpc_trend: [] } };
    return { data, source: { connectorId: 'sorftime', operation: r.operation, fetchedAt: new Date().toISOString(), attemptCount: 1 } };
  } };
  const worker = new MarketModuleStepWorker({ steps, handlers: { ...createMarketSourceStepHandlers({ context, connectors: { sorftime: connector, sellerSprite: { ...connector, id: 'sellerSprite' } } }), 'prepare-keyword-pool': createMarketKeywordPoolStep(context) } });
  t.after(() => worker.stop());
  const drain = async () => { for (let i = 0; i < 30; i++) if (!await worker.tick()) return; assert.fail('did not settle'); };
  await drain();
  const before = (await steps.findModuleRun({ actor, moduleRunId: created.run.id }))!;
  const failed = before.steps.find(s => s.kind === 'collect-keyword-trend' && s.status === 'failed')!; assert.ok(failed);
  const failedAttempt = before.attempts.find(a => a.id === failed.latestAttemptId)!;
  assert.deepEqual(failedAttempt.error, { code: 'invalid-data', retryable: false });
  assert.equal((await pg.pool.query('SELECT diagnostic_json FROM market_analysis_step_attempts WHERE id=$1', [failedAttempt.id])).rows[0].diagnostic_json.sourceCode, 'malformed-response');
  const untouched = before.steps.filter(s => s.status === 'succeeded' || s.status === 'empty').map(s => ({ id: s.id, latestAttemptId: s.latestAttemptId, attemptCount: s.attemptCount }));
  const service = new MarketModuleService({ context, modelIdentity: () => null });
  const publicBefore = await service.findKeywords(actor, created.run.id);
  assert.equal(publicBefore.run.steps.find(s => s.id === failed.id)?.canRetry, true);
  const retry = { steps: [{ stepId: failed.id, failedAttemptId: failed.latestAttemptId! }] }, key = randomUUID();
  failing = false;
  await service.retry(actor, created.run.id, retry, key);
  await service.retry(actor, created.run.id, retry, key);
  await drain();
  const after = (await steps.findModuleRun({ actor, moduleRunId: created.run.id }))!;
  assert.equal(after.steps.find(s => s.id === failed.id)!.status, 'succeeded');
  assert.equal(after.steps.find(s => s.id === failed.id)!.attemptCount, 2);
  for (const old of untouched) { const current = after.steps.find(s => s.id === old.id)!; assert.equal(current.latestAttemptId, old.latestAttemptId); assert.equal(current.attemptCount, old.attemptCount); }
  for (const name of ['page', 'good lamp', 'empty lamp']) assert.equal(calls.filter(c => c === name).length, 1);
  assert.equal(calls.filter(c => c === 'failed lamp').length, 2);
  assert.deepEqual(after.attempts.find(a => a.id === failedAttempt.id), failedAttempt);
  assert.equal((await service.findKeywords(actor, created.run.id)).run.steps.find(s => s.id === failed.id)?.canRetry, false);
});
