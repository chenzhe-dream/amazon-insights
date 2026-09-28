import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { loadVocPositioningRuntimeConfig } from '../../server/config';
import { runPostgresMigrations } from '../../server/db/postgres/migrations';
import { PostgresQueryContext } from '../../server/db/postgres/query-context';
import { PostgresMarketModuleExecutionStore } from '../../server/db/postgres/market-module-execution-store';
import type { CreateMarketModuleRunInput } from '../../server/db/market-module-execution-repository';
import { MarketModuleService } from '../../server/services/market-module-service';
import {readMarketKeywordReconciliationSource} from '../../server/services/market-keyword-reconciliation-source';
import {MarketSemanticBatchPreparationService} from '../../server/runtime/market-semantic-batch-preparation';
import { registerMarketModuleRoutes } from '../../server/routes/market-modules';
import { MARKET_KEYWORD_FLOW_VERSION, MARKET_KEYWORD_RULES_FLOW_VERSION, marketKeywordFlowInitialSteps } from '../../server/domain/market-research/keyword-flow';
import { createMarketModelRuntime } from '../../server/runtime/market-model-runtime';
import { MarketKeywordRunResponseSchema } from '../../shared/market-keyword-public-contracts';
import {MarketKeywordRevisionEntrySchema} from '../../shared/market-keyword-revision-contracts';
import {assertKeywordScoreInputAuditBinding} from '../../shared/market-keyword-score-input-audit-contracts';
import { ConnectorError, type RemoteMcpConnector } from '../../server/connectors/connector-contract';
import type { OpenAIProviderOptions } from '../../server/runtime/openai-provider';
import { canonicalJsonSha256 as digest } from '../../server/runtime/model-request-accounting';
import { startPostgresTestContainer } from './helpers/postgres-test-container';
import {buildAgentApp} from '../../server/app';
import {createAgentServiceClient} from '../../app/lib/agent-service-client';
import {proxyAgentRequest} from '../../app/api/agent/[...path]/route';
import type {AuthenticationService} from '../../server/auth/authentication-service';

test('public keyword start and read bind source months and native audited batches without GET side effects', { timeout: 120000 }, async t => {
  const pg = await startPostgresTestContainer(); t.after(() => pg.close()); await runPostgresMigrations(pg.pool);
  const context = new PostgresQueryContext(pg.pool), steps = new PostgresMarketModuleExecutionStore(context);
  const actor = { organizationId: randomUUID(), userId: randomUUID() };
  await pg.pool.query("INSERT INTO users(id,organization_id,email,display_name,role,status,created_at,updated_at) VALUES($1,$2,$3,'Keyword fixture','member','active',clock_timestamp(),clock_timestamp())",
    [actor.userId, actor.organizationId, `${actor.userId}@example.com`]);
  let calls = 0, modelCalls = 0, globalCalls = 0, failGlobal = true, failSecond = true, missingHistory = false, failDiscovery = true;
  const connector: RemoteMcpConnector = { id: 'sorftime', probe: async () => { throw new Error('Unused'); }, execute: async r => {
    calls++;
    if (r.operation === 'keyword_extends' && r.input.page === 2 && failSecond) throw new ConnectorError('sorftime', 'upstream-permanent', false);
    const data = r.operation === 'keyword_extends' ? { data: r.input.keyword === 'empty' ? [] : [{ keyword: `synthetic lamp ${r.input.page}`, monthly_search_volume: 999, recommended_cpc_bid: '1.25', seasonality: '11月' }] }
      : { data: { keyword: r.input.keyword, search_volume_trend: missingHistory ? [] : ['2025-08 search volume 10', '2026-05 search volume 15', '2026-07 search volume 20', '2026-08 search volume 0'],
        search_rank_trend: [], recommended_bid_trend: ['2026-08 CPC recommended bid 2.5'] } };
    return { data, source: { connectorId: 'sorftime', operation: r.operation, fetchedAt: new Date().toISOString(), attemptCount: 1 } };
  } };
  const base = loadVocPositioningRuntimeConfig({ OPENAI_API_KEY: 'synthetic-key', AGENT_VOC_MODEL: 'gpt-5.6',
    AGENT_VOC_ESTIMATED_INPUT_TOKENS: '10000', AGENT_VOC_MAX_OUTPUT_TOKENS: '4000', AGENT_VOC_TIMEOUT_MS: '90000',
    AGENT_VOC_INPUT_USD_PER_MILLION_TOKENS: '1', AGENT_VOC_OUTPUT_USD_PER_MILLION_TOKENS: '2', AGENT_VOC_CALL_MAX_TOKENS: '100000',
    AGENT_VOC_CALL_MAX_COST_MICROS: '1000000', AGENT_VOC_RUN_MAX_TOKENS: '100000', AGENT_VOC_RUN_MAX_COST_MICROS: '1000000',
    AGENT_VOC_DAILY_MAX_TOKENS: '100000', AGENT_VOC_DAILY_MAX_COST_MICROS: '1000000', AGENT_VOC_WORKER_OWNER_ID: 'synthetic-worker' });
  const client = { responses: { create: async (body: { input: string }) => {
    modelCalls++; const input = JSON.parse(body.input), unknown = { status: 'unknown', reason: 'insufficient-evidence', evidence: [] };
    const discovery=input.discoveryMode==='labels-and-clusters/v1';
    if(input.reconciliationDimension){globalCalls++;if(failGlobal)throw new Error('Synthetic global failure');}
    if(discovery&&failDiscovery)throw new Error('Synthetic discovery failure');
    const lampEvidence=(k:any)=>({refId:k.text.refId,start:k.text.text.indexOf('lamp'),end:k.text.text.indexOf('lamp')+4,quote:'lamp'});
    const output = { schemaVersion: '1.0.0', task: input.task, batchId: input.batchId, inputDigest: input.inputDigest,
      keywords: input.keywords.map((k: { keywordId: string }) => ({ keywordId: k.keywordId, W1: discovery?{status:'supported',labelIds:['new-lamp'],evidence:[lampEvidence(k)]}:unknown, W2: unknown, W3: unknown, W4: unknown, cluster: unknown })),
      ...(discovery?{labelProposals:[{dimension:'W1',labelId:'new-lamp',label:'灯',definition:'原词明确包含 lamp',evidence:[lampEvidence(input.keywords[0])]}]}:{}),
      proposals: [], synonymRelations: [] };
    if(input.reconciliationDimension==='W1')for(const keyword of output.keywords)keyword.W1={status:'supported',labelIds:[input.dimensionLabels.W1.map((x:any)=>x.labelId).sort()[0]],evidence:[lampEvidence(input.keywords.find((x:any)=>x.keywordId===keyword.keywordId))]};
    return { id: 'synthetic-response', status: 'completed', usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
      output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(output) }] }] };
  } } } as unknown as OpenAIProviderOptions['client'];
  const runtime = await createMarketModelRuntime(context, base, { client, connectors: { sorftime: connector, sellerSprite: { ...connector, id: 'sellerSprite' } } });
  t.after(() => runtime.stop());
  const service = new MarketModuleService({ context, modelIdentity: () => ({ configurationVersion: runtime.configurationVersion, promptVersion: runtime.promptVersion }), keywordModelIdentity:()=>({configurationVersion:runtime.keywordDiscoveryConfigurationVersion,promptVersion:runtime.keywordDiscoveryPromptVersion}) });
  const study = await service.createStudy(actor, { marketplace: 'US', nodeIdPath: '12:34', fromMonth: '2026-07', toMonth: '2026-08', currency: 'USD' }, randomUUID());
  const body = { plannedPages: [{ seed: 'lamp', page: 1 }, { seed: 'lamp', page: 2 }], maxMembers: 20,
    catalog: { task: 'market-keyword-semantics', dictionaryVersion: 'synthetic/v1', categoryContext: 'Synthetic lamp', dimensionLabels: { W1: [], W2: [], W3: [], W4: [] }, clusterCatalog: [] } };
  await t.test('new public rule tasks ignore configured models and replay reads without collection', async () => {
    const key = randomUUID(), input = { ...body, plannedPages: [{ seed: 'lamp', page: 1 }] };
    const started = await service.startKeywords(actor, study.study.id, input, key);
    for (let i = 0; i < 30; i++) { if (!await runtime.tick()) break; assert.ok(i < 29); }
    const saved = (await service.findKeywords(actor, started.run.id)).run;
    assert.equal((await steps.findModuleRun({ actor, moduleRunId: started.run.id }))!.run.versions.planner, MARKET_KEYWORD_RULES_FLOW_VERSION);
    assert.equal(saved.semanticStatus, 'skipped');
    assert.equal(saved.automaticClassification?.factsId,saved.facts!.factsId);
    assert.equal(saved.ruleReport?.classification.kind,'local');
    assert.equal(saved.ruleReport?.classification.identity,saved.automaticClassification?.identity);
    assert.equal(saved.automaticClassification?.classification.assignments.length,saved.facts!.members.length);
    assert.ok(saved.ruleReport!.clusters.length>0);
    assert.ok(saved.ruleReport); assert.equal(saved.facts!.members[0].reference.searchVolume, 0);
    assert.equal(saved.facts!.members[0].pageMetrics.seasonality, '11月');
    assert.deepEqual(saved.facts!.members[0].trend.months.map(month=>month.month), ['2026-07','2026-08']);
    assert.deepEqual(saved.facts!.members[0].trend.historyMonths!.map(month=>month.month), ['2025-08','2026-05','2026-07','2026-08']);
    assert.equal(modelCalls, 0);
    assert.ok(saved.steps.every(step => !['model-batch', 'prepare-model-batches', 'reconcile'].includes(step.kind)));
    const beforeCalls = calls;
    assert.deepEqual((await service.findKeywords(actor, started.run.id)).run, saved);
    assert.equal((await service.startKeywords(actor, study.study.id, input, key)).run.id, started.run.id);
    assert.equal(calls, beforeCalls); assert.equal(modelCalls, 0);
  });
  await t.test('automatic pagination stops at a short page and survives read replay without new calls',async()=>{
    const beforeCalls=calls;
    const started=await service.startKeywords(actor,study.study.id,{...body,paginationMode:'until-short-page/v1',plannedPages:Array.from({length:5},(_,i)=>({seed:'lamp',page:i+1})),maxMembers:100},randomUUID());
    for(let i=0;i<30;i++){if(!await runtime.tick())break;assert.ok(i<29);}
    const saved=(await service.findKeywords(actor,started.run.id)).run;
    assert.equal(saved.params.plannedPages.length,5);assert.equal(saved.facts!.members.length,1);assert.equal(saved.facts!.pool.plannedPageCount,1);
    assert.equal(saved.steps.filter(s=>s.kind==='collect-keyword-page').length,1);assert.equal(calls-beforeCalls,2);
    assert.deepEqual((await service.findKeywords(actor,started.run.id)).run,saved);assert.equal(calls-beforeCalls,2);
  });
  // Seed historical semantic runs through the repository. New public commands stay rules-only.
  let seedLegacyModels = true;
  const createRun = PostgresMarketModuleExecutionStore.prototype.createModuleRun;
  t.mock.method(PostgresMarketModuleExecutionStore.prototype, 'createModuleRun', async function(this: PostgresMarketModuleExecutionStore, request: CreateMarketModuleRunInput) {
    const params = request.params as { flow?: string; analysisMode?: string; catalog?: { discoveryMode?: string; outputProtocol?: string } };
    if (!seedLegacyModels || request.moduleKind !== 'keywords' || params.flow !== MARKET_KEYWORD_RULES_FLOW_VERSION) return createRun.call(this, request);
    const global = params.analysisMode === 'global-reconciliation/v1' || params.analysisMode === 'global-reconciliation/v2';
    const explicit = params.catalog?.outputProtocol === 'explicit-shape/v1', discovery = params.catalog?.discoveryMode === 'labels-and-clusters/v1';
    const legacy = { ...request, params: { ...params, flow: MARKET_KEYWORD_FLOW_VERSION }, versions: { ...request.versions, planner: MARKET_KEYWORD_FLOW_VERSION,
      model: 'market.semantic.text.v1', configuration: explicit ? runtime.keywordExplicitConfigurationVersion : global ? runtime.keywordReconciliationConfigurationVersion : discovery ? runtime.keywordDiscoveryConfigurationVersion : runtime.configurationVersion,
      prompt: explicit ? runtime.keywordExplicitPromptVersion : global ? runtime.keywordReconciliationPromptVersion : discovery ? runtime.keywordDiscoveryPromptVersion : runtime.promptVersion } };
    return createRun.call(this, { ...legacy, initialSteps: marketKeywordFlowInitialSteps(legacy) });
  });
  const http = Fastify(); t.after(() => http.close()); http.decorateRequest('authPrincipal', null);
  let principal = actor;
  http.addHook('preHandler', async req => { req.authPrincipal = { kind: 'user', ...principal, role: 'member', email: 'native@example.test', sessionId: randomUUID() }; });
  registerMarketModuleRoutes(http, service);
  const browser=await import('../../app/lib/market-keyword-browser');
  const browserFetch=t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{
    assert.equal(typeof input,'string');assert.ok(String(input).startsWith('/api/agent/v1/market-analysis/'));
    const response=await http.inject({method:(init?.method??'GET') as 'GET'|'POST',url:String(input).replace('/api/agent',''),headers:Object.fromEntries(new Headers(init?.headers)),payload:typeof init?.body==='string'?init.body:undefined});
    return new Response(response.body,{status:response.statusCode,headers:{'content-type':'application/json'}});
  });
  const create = { method: 'POST' as const, url: `/v1/market-analysis/studies/${study.study.id}/keywords`, payload: body, headers: { 'idempotency-key': randomUUID() } };
  const created = await http.inject(create); assert.equal(created.statusCode, 201, created.body);
  const initial = MarketKeywordRunResponseSchema.parse(created.json()); assert.equal(initial.run.facts, null);
  const replay = await http.inject(create); assert.equal(replay.statusCode, 200, replay.body); assert.equal(replay.json().run.id, initial.run.id);
  assert.equal((await browser.startKeywordRun(study.study.id,body,create.headers['idempotency-key'])).id,initial.run.id);
  async function drain() { for (let i = 0; i < 100; i++) { if (!await runtime.tick()) return; } assert.fail('Runtime did not quiesce'); }
  const path = `/v1/market-analysis/runs/${initial.run.id}/keywords`;
  const read = async () => { const response = await http.inject({ method: 'GET', url: path }); assert.equal(response.statusCode, 200, response.body); return MarketKeywordRunResponseSchema.parse(response.json()); };
  await drain();
  const first = await read(), facts = first.run.facts!; assert.ok(facts, JSON.stringify(first.run.steps));
  assert.ok(first.run.ruleReport);assert.ok(first.run.scoreInputAudit,'Public read exposes versioned saved-input audit');
  assertKeywordScoreInputAuditBinding(first.run.scoreInputAudit,facts,first.run.ruleReport);
  assert.equal(first.run.scoreInputAudit.members[0].pageRecommendedBid.value,1.25);
  assert.equal(first.run.scoreInputAudit.members[0].pageRecommendedBid.referenceMonth,null);
  assert.equal(first.run.scoreInputAudit.members[0].trendRecommendedBid.value,2.5);
  assert.equal(first.run.scoreInputAudit.members[0].trendRecommendedBid.currency,null);
  assert.deepEqual(await browser.readKeywordRun(initial.run.id),first.run);
  assert.equal(facts.pool.collectionCoverage, 'partial'); assert.equal(facts.pool.exhaustive, false); assert.equal(facts.members.length, 1);
  assert.equal(facts.members[0].pageMetrics.monthlySearchVolume.value, 999);
  assert.equal(facts.referenceMonth, '2026-08'); assert.equal(facts.members[0].reference.searchVolume, 0);
  assert.equal(facts.members[0].reference.yoyGrowth, -1); assert.equal(facts.members[0].reference.recentGrowth, -1);
  assert.equal(facts.members[0].reference.actualCpcUsd, null); assert.equal(facts.members[0].trend.cpcCurrency, null);
  assert.equal(facts.members[0].pageMetrics.recommendedCpcUsd.value, 1.25);
  assert.equal(facts.members[0].trend.months.at(-1)!.recommendedBid.value, 2.5);
  assert.equal(facts.semantics.status, 'validated'); assert.equal(facts.semantics.unknownDimensionCount, 4); assert.equal(facts.semantics.unknownClusterCount, 1);
  assert.equal(facts.semantics.batches.length, 1); assert.ok(modelCalls > 0);
  const revisionPath = `${path}/revisions`;
  const classification = { labels: { W1: [{ labelId: 'lamp', label: '灯', definition: '人工校对的产品类型' }], W2: [], W3: [], W4: [] },
    clusters: [{ clusterId: 'corner', label: '角落照明', definition: '人工校对的需求簇' }],
    assignments: facts.members.map(m => ({ keywordId: m.keywordId, W1: ['lamp'], W2: [], W3: [], W4: [], clusterId: 'corner' })) };
  const revisionBody = { factsId: facts.factsId, expectedParentRevisionId: null, ...classification, note: '首次人工分类' };
  const save = { method: 'POST' as const, url: revisionPath, payload: revisionBody, headers: { 'idempotency-key': randomUUID() } };
  const saved = await http.inject(save); assert.equal(saved.statusCode, 201, saved.body);
  const revision = saved.json().revision, revisionId = revision.catalog.revision.revisionId;
  const checkedRevision=MarketKeywordRevisionEntrySchema.parse(revision);assert.ok(checkedRevision.scoreInputAudit);assert.ok(checkedRevision.ruleReport);
  assertKeywordScoreInputAuditBinding(checkedRevision.scoreInputAudit,checkedRevision.catalog.facts,checkedRevision.ruleReport);
  assert.equal(checkedRevision.scoreInputAudit.clusters[0].inputs.find(input=>input.field==='suggestedBid')!.value,null);
  assert.ok(revision.ruleReport,'Saved human revision exposes its frozen-basis W5 and PVS report');
  assert.equal(revision.ruleReport.factsId,facts.factsId);assert.equal(revision.ruleReport.classification.identity,revisionId);
  // Four retained source months establish calendar comparisons, but cannot establish
  // either two contiguous 3-month sums or two 6–12-month historical windows.
  assert.equal(revision.ruleReport.version,'market-keyword-rule-report/v3');
  assert.equal(revision.ruleReport.keywords[0].w5.searchVolume.value,0);
  assert.equal(revision.ruleReport.keywords[0].w5.recentGrowth.value,-1,'The known previous month still supports calendar MoM');
  assert.equal(revision.ruleReport.keywords[0].w5.yoyGrowth.value,null,'A single prior-year observation cannot establish equal historical windows');
  assert.equal(revision.ruleReport.keywords[0].w5.yoyGrowth.reason,'insufficient-history');
  assert.equal(revision.ruleReport.keywords[0].w5.yoyGrowth.formulaVersion,'equal-history-window-growth/v1');
  assert.equal(revision.ruleReport.keywords[0].w5.threeMonthGrowth.value,null,'A saved M-3 observation cannot replace the six complete months required for sum growth');
  assert.equal(revision.ruleReport.keywords[0].w5.threeMonthGrowth.reason,'insufficient-history');
  assert.equal(revision.ruleReport.keywords[0].w5.threeMonthGrowth.formulaVersion,'three-month-sum-growth/v1');
  assert.equal(revision.ruleReport.keywords[0].w5.lifecycle.status,'unavailable');
  assert.deepEqual(facts.members[0].trend.historyMonths!.map(point=>[point.month,point.searchVolume.value]),[['2025-08',10],['2026-05',15],['2026-07',20],['2026-08',0]],'Saved full-history observations remain available outside the research window');
  assert.deepEqual(revision.catalog.facts.members[0].trend.comparisonMonths,facts.members[0].trend.comparisonMonths,'Manual history preserves the original calendar comparison evidence');
  assert.equal(revision.ruleReport.clusters[0].score.pvs,null,'Missing source metrics cannot manufacture PVS');
  assert.equal(revision.ordinal, 1); assert.equal(revision.catalog.aggregation.pool.totalSearchVolume, 0);
  assert.deepEqual(revision.catalog.facts.semantics, facts.semantics);
  assert.equal(revision.catalog.aggregation.clusters[0].searchVolumeSharePercent, null);
  const ack = await http.inject(save); assert.equal(ack.statusCode, 200, ack.body); assert.deepEqual(ack.json().revision, revision);
  assert.deepEqual(await browser.saveKeywordRevision(initial.run.id,revisionBody,save.headers['idempotency-key']),revision);
  assert.deepEqual(await browser.readKeywordRevision(initial.run.id,revisionId),revision);
  const competing = await Promise.all(['校对A', '校对B'].map(note => http.inject({ ...save, payload: { ...revisionBody, expectedParentRevisionId: revisionId, note }, headers: { 'idempotency-key': randomUUID() } })));
  assert.deepEqual(competing.map(r => r.statusCode).sort(), [201, 409]);
  const secondRevisionId = competing.find(r => r.statusCode === 201)!.json().revision.catalog.revision.revisionId;
  assert.equal((await read()).run.history!.length, 2);
  const original = await http.inject({ method: 'GET', url: `${revisionPath}/${revisionId}` });
  assert.equal(original.statusCode, 200, original.body); assert.deepEqual(original.json().revision, revision);
  assert.equal(original.json().revision.scoreInputAudit.auditId,revision.scoreInputAudit.auditId,'History retains the same facts/report-bound audit');
  await assert.rejects(pg.pool.query('UPDATE market_keyword_revisions SET catalog_hash=$1 WHERE revision_id=$2', ['0'.repeat(64), revisionId]), /immutable/);
  const beforeCalls = { calls, modelCalls }, beforeCommands = (await pg.pool.query('SELECT count(*) FROM market_analysis_commands')).rows[0].count;
  assert.deepEqual((await read()).run.facts, facts);
  const unconfigured = new MarketModuleService({ context: new PostgresQueryContext(pg.pool), modelIdentity: () => null });
  assert.deepEqual((await unconfigured.findKeywords(actor, initial.run.id)).run.facts, facts);
  assert.deepEqual((await unconfigured.keywordRevision(actor,initial.run.id,revisionId)).revision.scoreInputAudit,revision.scoreInputAudit);
  assert.deepEqual((await browser.readKeywordRevision(initial.run.id,revisionId)).scoreInputAudit,revision.scoreInputAudit);
  assert.deepEqual({ calls, modelCalls }, beforeCalls); assert.equal((await pg.pool.query('SELECT count(*) FROM market_analysis_commands')).rows[0].count, beforeCommands);
  principal = { ...actor, organizationId: randomUUID() };
  assert.equal((await http.inject({ method: 'GET', url: path })).statusCode, 404);
  assert.equal((await http.inject({ method: 'GET', url: `${revisionPath}/${revisionId}` })).statusCode, 404); principal = actor;

  // Reject an altered successful model artifact even when its storage hash is recomputed.
  const auditId = facts.semantics.batches[0].agentRunId;
  const savedAudit = (await pg.pool.query('SELECT outcome_json,outcome_hash FROM market_agent_runs WHERE id=$1', [auditId])).rows[0];
  const altered = structuredClone(savedAudit.outcome_json); altered.output.keywords[0].keywordId = 'unselected-keyword';
  await assert.rejects(pg.pool.query('UPDATE market_agent_runs SET outcome_json=$2::jsonb,outcome_hash=$3 WHERE id=$1', [auditId, JSON.stringify(altered), digest(altered)]), /immutable/);
  // Fault injection in this disposable PG only, to exercise read validation
  // independently of the normal immutable-history database trigger.
  await pg.pool.query('ALTER TABLE market_agent_runs DISABLE TRIGGER market_agent_history');
  try {
    await pg.pool.query('UPDATE market_agent_runs SET outcome_json=$2::jsonb,outcome_hash=$3 WHERE id=$1', [auditId, JSON.stringify(altered), digest(altered)]);
    await assert.rejects(service.findKeywords(actor, initial.run.id));
  } finally {
    await pg.pool.query('UPDATE market_agent_runs SET outcome_json=$2::jsonb,outcome_hash=$3 WHERE id=$1', [auditId, JSON.stringify(savedAudit.outcome_json), savedAudit.outcome_hash]);
    await pg.pool.query('ALTER TABLE market_agent_runs ENABLE TRIGGER market_agent_history');
  }
  assert.deepEqual((await read()).run.facts, facts);

  const failed = first.run.steps.find(s => s.canRetry)!; assert.ok(failed); failSecond = false;
  await service.retry(actor, initial.run.id, { steps: [{ stepId: failed.id, failedAttemptId: failed.latestAttemptId! }] }, randomUUID());
  assert.equal((await read()).run.facts, null); await drain();
  const next = await read(); assert.equal(next.run.facts!.members.length, 2); assert.equal(next.run.facts!.pool.collectionCoverage, 'complete');
  assert.ok(next.run.facts!.members.every(m => m.trend.status === 'partial' && m.reference.searchVolume === 0), JSON.stringify(next.run.steps));
  assert.notEqual(next.run.facts!.factsId, facts.factsId);
  const stale = await http.inject({ ...save, payload: { ...revisionBody, expectedParentRevisionId: secondRevisionId }, headers: { 'idempotency-key': randomUUID() } });
  assert.equal(stale.statusCode, 409, stale.body);
  const historical = await http.inject({ method: 'GET', url: `${revisionPath}/${revisionId}` });
  assert.deepEqual(historical.json().revision, revision); // Source retry cannot rewrite an old human report.
  const fresh = await http.inject({ ...save, payload: { ...revisionBody, factsId: next.run.facts!.factsId, expectedParentRevisionId: secondRevisionId,
    assignments: next.run.facts!.members.map(m => ({ keywordId: m.keywordId, W1: ['lamp'], W2: [], W3: [], W4: [], clusterId: 'corner' })) },
    headers: { 'idempotency-key': randomUUID() } });
  assert.equal(fresh.statusCode, 201, fresh.body); assert.equal(fresh.json().revision.catalog.aggregation.pool.memberCount, 2);
  await service.cancel(actor, initial.run.id, {}, randomUUID());
  const cancelled = await read(); assert.equal(cancelled.run.status, 'cancelled'); assert.deepEqual(cancelled.run.facts, next.run.facts);
  assert.equal(cancelled.run.steps.some(s => s.canRetry), false);
  assert.deepEqual((await unconfigured.keywordRevision(actor, initial.run.id, revisionId)).revision, revision);
  assert.equal((await http.inject({ ...save, headers: { 'idempotency-key': randomUUID() } })).statusCode, 409);
  assert.equal((await http.inject(save)).statusCode, 200); // Acknowledgement replay is not a new write.
  assert.equal((await steps.findModuleRun({ actor, moduleRunId: initial.run.id }))!.steps.some(s => s.kind === 'report'), false);

  seedLegacyModels = false; missingHistory = true; const modelsBefore = modelCalls;
  const missing = await unconfigured.startKeywords(actor, study.study.id, { ...body, plannedPages: [{ seed: 'missing-history', page: 1 }] }, randomUUID());
  await drain();
  const missingFacts = (await unconfigured.findKeywords(actor, missing.run.id)).run.facts!;
  assert.equal(missingFacts.members[0].pageMetrics.monthlySearchVolume.value, 999);
  assert.equal(missingFacts.members[0].reference.searchVolume, null); // Never fall back to page volume.
  assert.equal(missingFacts.members[0].trend.status, 'empty'); assert.equal(missingFacts.semantics.status, 'unavailable');
  const empty = await unconfigured.startKeywords(actor, study.study.id, { ...body, plannedPages: [{ seed: 'empty', page: 1 }] }, randomUUID());
  await drain();
  const emptyFacts = (await unconfigured.findKeywords(actor, empty.run.id)).run.facts!;
  assert.deepEqual(emptyFacts.members, []); assert.deepEqual(emptyFacts.pool.emptyPages, [{ seed: 'empty', page: 1 }]);
  assert.equal(emptyFacts.pool.collectionCoverage, 'complete'); assert.equal(emptyFacts.pool.exhaustive, false);
  assert.equal(modelCalls, modelsBefore);
  // Both immutable protocols run in the same real runtime and disposable DB.
  // Retry uses the discovery identity, not the old four-task identity.
  seedLegacyModels = true;
  const discovered=await browser.startKeywordRun(study.study.id,{...body,plannedPages:[{seed:'lamp',page:1}],catalog:{...body.catalog,discoveryMode:'labels-and-clusters/v1'}},randomUUID());
  const discoveredView=await steps.findModuleRun({actor,moduleRunId:discovered.id});
  assert.equal(discoveredView!.run.versions.configuration,runtime.keywordDiscoveryConfigurationVersion);
  await drain();
  const discoveryFailed=await browser.readKeywordRun(discovered.id),failedModel=discoveryFailed.steps.find(s=>s.kind==='model-batch'&&s.canRetry);
  assert.ok(failedModel,JSON.stringify((await steps.findModuleRun({actor,moduleRunId:discovered.id}))!.attempts));
  failDiscovery=false;
  await service.retry(actor,discovered.id,{steps:[{stepId:failedModel.id,failedAttemptId:failedModel.latestAttemptId!}]},randomUUID());
  await drain();
  const discoveryFacts=(await browser.readKeywordRun(discovered.id)).facts!;
  assert.equal(discoveryFacts.semantics.status,'validated');
  assert.equal(discoveryFacts.semantics.batches[0].output.labelProposals![0].label,'灯');
  assert.equal(discoveryFacts.semantics.batches[0].output.keywords[0].W1.status,'supported');
  assert.equal(discoveryFacts.semantics.unknownDimensionCount,3);
  assert.deepEqual((await service.keywordRevision(actor,initial.run.id,revisionId)).revision,revision);
  const beforeRead={calls,modelCalls};await browser.readKeywordRun(discovered.id);
  assert.deepEqual({calls,modelCalls},beforeRead);
  const reconciliation=await readMarketKeywordReconciliationSource(context,actor,discovered.id);
  assert.ok(reconciliation);assert.equal(reconciliation.basis.initialBatches.length,1);
  assert.deepEqual(reconciliation.basis.initialBatches[0].output,discoveryFacts.semantics.batches[0].output);
  assert.equal(reconciliation.basis.snapshot.snapshotId,discoveryFacts.pool.semanticInputSnapshotId);
  assert.deepEqual({calls,modelCalls},beforeRead);
  assert.equal(await readMarketKeywordReconciliationSource(context,{...actor,organizationId:randomUUID()},discovered.id),null);
  const globalService=new MarketModuleService({context,modelIdentity:()=>null,
    keywordReconciliationModelIdentity:()=>({configurationVersion:runtime.keywordReconciliationConfigurationVersion,promptVersion:runtime.keywordReconciliationPromptVersion})});
  const global=await globalService.startKeywords(actor,study.study.id,{...body,analysisMode:'global-reconciliation/v1',catalog:{...body.catalog,discoveryMode:'labels-and-clusters/v1'}},randomUUID());
  await drain();
  const globalView=await steps.findModuleRun({actor,moduleRunId:global.run.id});
  assert.equal(globalView!.run.versions.configuration,runtime.keywordReconciliationConfigurationVersion);
  assert.ok(globalCalls>0,JSON.stringify(globalView!.attempts));
  const evaluated=globalView!.attempts.find(a=>(a.output as any)?.version==='keyword-reconciliation-evaluation/v1');
  assert.ok(evaluated,JSON.stringify(globalView!.attempts));assert.equal((evaluated.output as any).status,'partial');
  const failedGlobal=(await globalService.findKeywords(actor,global.run.id)).run;
  assert.equal(failedGlobal.facts!.semantics.batches.flatMap(b=>b.output.keywords).length,2,'Only the two initial discovery members appear in facts regardless of token-based batch packing');
  assert.equal(failedGlobal.reconciliation!.status,'partial');assert.ok(failedGlobal.reconciliation!.decisions.some(k=>k.W1.status==='unavailable'));
  const retrySteps=failedGlobal.steps.filter(s=>s.current&&s.canRetry);assert.ok(retrySteps.length);
  const savedGlobalFacts=failedGlobal.facts!.factsId,sourceCallsBeforeRetry=calls;failGlobal=false;
  await globalService.retry(actor,global.run.id,{steps:retrySteps.map(s=>({stepId:s.id,failedAttemptId:s.latestAttemptId!}))},randomUUID());await drain();
  const reconciled=(await globalService.findKeywords(actor,global.run.id)).run;
  assert.equal(calls,sourceCallsBeforeRetry,'Global retry reuses original source pages/trends');assert.equal(reconciled.facts!.factsId,savedGlobalFacts);
  assert.equal(reconciled.reconciliation!.decisions.length,2);assert.equal(reconciled.reconciliation!.catalog.length,1);
  assert.ok(reconciled.reconciliation!.decisions.every(k=>k.W1.status==='supported'&&k.W1.candidateIds[0]===reconciled.reconciliation!.catalog[0].candidateId));
  assert.notEqual(reconciled.reconciliation!.resultHash,failedGlobal.reconciliation!.resultHash);
  const countBeforeRead={calls,modelCalls};assert.deepEqual((await globalService.findKeywords(actor,global.run.id)).run.reconciliation,reconciled.reconciliation);assert.deepEqual({calls,modelCalls},countBeforeRead);
  assert.deepEqual((await service.keywordRevision(actor,initial.run.id,revisionId)).revision,revision,'Global flow preserves manual history');
  const globalParams={...body,analysisMode:'global-reconciliation/v1',catalog:{...body.catalog,discoveryMode:'labels-and-clusters/v1'}};
  await t.test('cancellation before reconciliation starts preserves facts and remains readable without network calls',async()=>{
    failDiscovery=true;
    const started=await globalService.startKeywords(actor,study.study.id,{...globalParams,catalog:{...globalParams.catalog,dictionaryVersion:'cancel-fixture/v1'},plannedPages:[{seed:'lamp',page:1}]},randomUUID());
    let pending=false;
    for(let i=0;i<50;i++){
      await runtime.tick();
      const view=(await steps.findModuleRun({actor,moduleRunId:started.run.id}))!;
      pending=view.steps.some(s=>s.kind==='reconcile'&&s.status==='queued'&&s.latestAttemptId===null);
      if(pending)break;
    }
    assert.ok(pending,'Must reach an unclaimed reconciliation step after the initial model failure');
    const before=(await globalService.findKeywords(actor,started.run.id)).run;
    const key=randomUUID(),counts={calls,modelCalls};
    await globalService.cancel(actor,started.run.id,{},key);
    const cancelled=(await globalService.findKeywords(actor,started.run.id)).run;
    assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.reconciliation!.status,'cancelled');
    assert.deepEqual(cancelled.facts!.pool,before.facts!.pool);assert.deepEqual(cancelled.facts!.semantics,before.facts!.semantics);
    assert.deepEqual(cancelled.facts!.members,before.facts!.members.map(m=>({...m,trend:{...m.trend,status:'cancelled'}})));
    assert.equal(cancelled.steps.some(s=>s.canRetry),false);
    assert.ok(cancelled.steps.some(s=>s.kind==='reconcile'&&s.current&&s.status==='cancelled'));
    await globalService.cancel(actor,started.run.id,{},key);
    assert.deepEqual((await globalService.findKeywords(actor,started.run.id)).run,cancelled);
    await assert.rejects(globalService.findKeywords({...actor,organizationId:randomUUID()},started.run.id));
    assert.deepEqual({calls,modelCalls},counts);failDiscovery=false;
  });
  const emptyGlobal=await globalService.startKeywords(actor,study.study.id,{...globalParams,plannedPages:[{seed:'empty',page:1}]},randomUUID());await drain();
  assert.equal((await globalService.findKeywords(actor,emptyGlobal.run.id)).run.reconciliation!.status,'empty');
  const failedPreparation=await globalService.startKeywords(actor,study.study.id,{...globalParams,plannedPages:[{seed:'lamp',page:1}]},randomUUID());
  const preparationFault=t.mock.method(MarketSemanticBatchPreparationService.prototype,'planBatches',async()=>{throw new TypeError('Synthetic preparation fault');});
  await drain();preparationFault.mock.restore();
  const stopped=(await globalService.findKeywords(actor,failedPreparation.run.id)).run;
  assert.equal(stopped.reconciliation!.status,'waiting-initial-models');assert.ok(stopped.steps.some(s=>s.kind==='prepare-model-batches'&&s.canRetry));
  const explicitService=new MarketModuleService({context,modelIdentity:()=>null,keywordExplicitModelIdentity:()=>({configurationVersion:runtime.keywordExplicitConfigurationVersion,promptVersion:runtime.keywordExplicitPromptVersion})});
  const explicit=await explicitService.startKeywords(actor,study.study.id,{...globalParams,analysisMode:'global-reconciliation/v2',catalog:{...globalParams.catalog,outputProtocol:'explicit-shape/v1'}},randomUUID());
  await drain();const explicitRead=(await explicitService.findKeywords(actor,explicit.run.id)).run;
  const explicitDiagnostic=await steps.findModuleRun({actor,moduleRunId:explicit.run.id});
  assert.equal(explicitRead.facts!.semantics.status,'validated',JSON.stringify(explicitDiagnostic!.attempts.map(a=>({status:a.status,error:a.error,output:a.output}))));assert.equal(explicitRead.reconciliation!.decisions.length,2);
  assert.ok(explicitRead.reconciliation!.decisions.every(k=>k.W1.status==='supported'));
  assert.ok(explicitRead.ruleReport);assert.equal(explicitRead.ruleReport.factsId,explicitRead.facts!.factsId);
  assert.equal(explicitRead.ruleReport.classification.kind,'global');
  assert.equal(explicitRead.ruleReport.keywords.length,explicitRead.facts!.members.length);
  const explicitView=await steps.findModuleRun({actor,moduleRunId:explicit.run.id});assert.equal(explicitView!.run.versions.configuration,runtime.keywordExplicitConfigurationVersion);
  assert.deepEqual((await globalService.findKeywords(actor,global.run.id)).run.reconciliation,reconciled.reconciliation,'Existing v1 results remain replayable after v2 execution');
  await t.test('secured app and actual same-origin proxy support all keyword routes including encoded revision history',async()=>{
    // Previous browser checks deliberately bypassed the proxy. Restore native
    // fetch here so this boundary test actually reaches the secured HTTP app.
    browserFetch.mock.restore();
    const token='K'.repeat(43),origin='http://keyword-proxy.test',proxyToken='synthetic-keyword-proxy-token';
    let securedPrincipal:{kind:'user';organizationId:string;userId:string;role:'member';email:string;sessionId:string}|null={kind:'user',...actor,role:'member',email:'keyword@example.test',sessionId:randomUUID()};
    const app=buildAgentApp({repository:{marketExecutionContext:context} as NonNullable<NonNullable<Parameters<typeof buildAgentApp>[0]>['repository']>,marketModuleService:service,userPresenceAccess:null,
      env:{AGENT_SERVICE_PROXY_TOKEN:proxyToken,AGENT_SERVICE_TRUSTED_ORIGINS:origin},authConfig:{mode:'authenticated',cookie:{name:'agent_session',secure:false,maxAgeSeconds:3600},sessionTtlMs:3600000,loginLimiter:{windowMs:60000,maxFailures:5,maxEntries:100}},
      authService:{authenticate:async(value:string|null)=>value===token?securedPrincipal:null} as AuthenticationService});
    t.after(()=>app.close());
    const address=await app.listen({host:'127.0.0.1',port:0}),agentClient=createAgentServiceClient({env:{AGENT_SERVICE_INTERNAL_URL:address,AGENT_SERVICE_PROXY_TOKEN:proxyToken}});
    async function proxy(method:string,routePath:string,payload?:unknown,key=randomUUID(),cookie=true,encodedParams=false){
      return proxyAgentRequest(new Request(`${origin}/api/agent${routePath}`,{method,headers:{'content-type':'application/json','idempotency-key':key,...(cookie?{cookie:`agent_session=${token}`}:{})},...(payload===undefined?{}:{body:JSON.stringify(payload)})}),
        {params:Promise.resolve({path:routePath.slice(1).split('/').map(part=>encodedParams?part:decodeURIComponent(part))})},agentClient);
    }
    const proxyBody={...body,catalog:{...body.catalog,dictionaryVersion:'synthetic-proxy/v1'}},createPath=`/v1/market-analysis/studies/${study.study.id}/keywords`,createKey=randomUUID(),beforeStart={calls,modelCalls};
    const started=await proxy('POST',createPath,proxyBody,createKey);assert.equal(started.status,201,await started.clone().text());
    const startedRun=MarketKeywordRunResponseSchema.parse(await started.json()).run,runPath=`/v1/market-analysis/runs/${startedRun.id}/keywords`;
    assert.equal(startedRun.facts,null);assert.deepEqual({calls,modelCalls},beforeStart,'Starting only persists work; requests never execute supplier or model calls inline');
    const startReplay=await proxy('POST',createPath,proxyBody,createKey);assert.equal(startReplay.status,200,await startReplay.clone().text());assert.equal((await startReplay.json()).run.id,startedRun.id);
    await drain();
    const beforeReads={calls,modelCalls},current=await proxy('GET',runPath);assert.equal(current.status,200,await current.clone().text());
    const run=MarketKeywordRunResponseSchema.parse(await current.json()).run;assert.ok(run.facts);assert.ok(run.scoreInputAudit);
    const manual={factsId:run.facts.factsId,expectedParentRevisionId:null,...classification,assignments:run.facts.members.map(m=>({keywordId:m.keywordId,W1:['lamp'],W2:[],W3:[],W4:[],clusterId:'corner'})),note:'经真实代理保存人工分类'};
    const revisionsPath=`${runPath}/revisions`,revisionKey=randomUUID(),written=await proxy('POST',revisionsPath,manual,revisionKey);assert.equal(written.status,201,await written.clone().text());
    const entry=MarketKeywordRevisionEntrySchema.parse((await written.json()).revision),id=entry.catalog.revision.revisionId,historyPath=`${revisionsPath}/${encodeURIComponent(id)}`;
    assert.ok(historyPath.includes('%3A'),'Historical IDs exercise URI-encoded colon characters');
    assert.equal((await proxy('POST',revisionsPath,manual,revisionKey)).status,200);
    for(const encodedParams of [false,true]){
      const history=await proxy('GET',historyPath,undefined,randomUUID(),true,encodedParams);assert.equal(history.status,200,await history.clone().text());
      assert.deepEqual(MarketKeywordRevisionEntrySchema.parse((await history.json()).revision),entry);
    }
    const countRows=async()=> (await pg.pool.query('SELECT (SELECT count(*) FROM market_analysis_module_runs) runs,(SELECT count(*) FROM market_keyword_revisions) revisions')).rows[0],beforeRejected=await countRows();
    for(const [method,routePath,payload] of [['POST',createPath,proxyBody],['GET',runPath,undefined],['POST',revisionsPath,manual],['GET',historyPath,undefined]] as const){
      const denied=await proxy(method,routePath,payload,randomUUID(),false);assert.equal(denied.status,401,await denied.clone().text());
    }
    assert.equal((await proxy('POST',createPath,{...proxyBody,authorId:randomUUID()})).status,400);
    assert.equal((await proxy('POST',revisionsPath,{...manual,authorId:randomUUID()})).status,400);
    securedPrincipal={...securedPrincipal!,organizationId:randomUUID()};
    assert.equal((await proxy('GET',runPath)).status,404);assert.equal((await proxy('GET',historyPath)).status,404);
    assert.deepEqual(await countRows(),beforeRejected);assert.deepEqual({calls,modelCalls},beforeReads,'Reads, revision writes and rejected requests do not recollect or call a model');
  });
});
