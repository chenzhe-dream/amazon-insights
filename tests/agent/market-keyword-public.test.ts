import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { loadVocPositioningRuntimeConfig } from '../../server/config';
import { runPostgresMigrations } from '../../server/db/postgres/migrations';
import { PostgresQueryContext } from '../../server/db/postgres/query-context';
import { PostgresMarketModuleExecutionStore } from '../../server/db/postgres/market-module-execution-store';
import { MarketModuleService } from '../../server/services/market-module-service';
import {readMarketKeywordReconciliationSource} from '../../server/services/market-keyword-reconciliation-source';
import {MarketSemanticBatchPreparationService} from '../../server/runtime/market-semantic-batch-preparation';
import { registerMarketModuleRoutes } from '../../server/routes/market-modules';
import { createMarketModelRuntime } from '../../server/runtime/market-model-runtime';
import { MarketKeywordRunResponseSchema } from '../../shared/market-keyword-public-contracts';
import { ConnectorError, type RemoteMcpConnector } from '../../server/connectors/connector-contract';
import type { OpenAIProviderOptions } from '../../server/runtime/openai-provider';
import { canonicalJsonSha256 as digest } from '../../server/runtime/model-request-accounting';
import { startPostgresTestContainer } from './helpers/postgres-test-container';

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
    const data = r.operation === 'keyword_extends' ? { data: r.input.keyword === 'empty' ? [] : [{ keyword: `synthetic lamp ${r.input.page}`, monthly_search_volume: 999, recommended_cpc_bid: '1.25' }] }
      : { data: { keyword: r.input.keyword, search_volume_trend: missingHistory ? [] : ['2025-08 search volume 10', '2026-05 search volume 15', '2026-07 search volume 20', '2026-08 search volume 0'],
        search_rank_trend: [], recommended_bid_trend: ['2026-08 CPC recommended bid 2.5'] } };
    return { data, source: { connectorId: 'sorftime', operation: r.operation, fetchedAt: new Date().toISOString(), attemptCount: 1 } };
  } };
  const base = loadVocPositioningRuntimeConfig({ OPENAI_API_KEY: 'synthetic-key', AGENT_VOC_MODEL: 'synthetic-model',
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
  const http = Fastify(); t.after(() => http.close()); http.decorateRequest('authPrincipal', null);
  let principal = actor;
  http.addHook('preHandler', async req => { req.authPrincipal = { kind: 'user', ...principal, role: 'member', email: 'native@example.test', sessionId: randomUUID() }; });
  registerMarketModuleRoutes(http, service);
  const browser=await import('../../app/lib/market-keyword-browser');
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{
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
  assert.ok(revision.ruleReport,'Saved human revision exposes its frozen-basis W5 and PVS report');
  assert.equal(revision.ruleReport.factsId,facts.factsId);assert.equal(revision.ruleReport.classification.identity,revisionId);
  assert.equal(revision.ruleReport.keywords[0].w5.yoyGrowth.value,-1,'A saved full-history baseline outside the research window must remain usable');
  assert.equal(revision.ruleReport.keywords[0].w5.threeMonthGrowth.value,-1,'M-3 baseline is projected from the saved full series, without refetching');
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
  await assert.rejects(pg.pool.query('UPDATE market_keyword_revisions SET catalog_hash=$1 WHERE revision_id=$2', ['0'.repeat(64), revisionId]), /immutable/);
  const beforeCalls = { calls, modelCalls }, beforeCommands = (await pg.pool.query('SELECT count(*) FROM market_analysis_commands')).rows[0].count;
  assert.deepEqual((await read()).run.facts, facts);
  const unconfigured = new MarketModuleService({ context: new PostgresQueryContext(pg.pool), modelIdentity: () => null });
  assert.deepEqual((await unconfigured.findKeywords(actor, initial.run.id)).run.facts, facts);
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

  missingHistory = true; const modelsBefore = modelCalls;
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
  assert.equal(failedGlobal.facts!.semantics.batches.length,2,'Global batches must not become initial discovery facts');
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
});
