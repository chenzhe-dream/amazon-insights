import { MarketThemeSelectionStore } from '../../server/db/postgres/market-theme-selection-store';
import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { loadVocPositioningRuntimeConfig } from '../../server/config';
import { runPostgresMigrations } from '../../server/db/postgres/migrations';
import { createMarketModelRuntime } from '../../server/runtime/market-model-runtime';
import { SkillRegistry } from '../../server/skills/registry';
import { MARKET_SOURCE_HANDLER_VERSION } from '../../shared/market-source-contracts';
import type { MarketJsonValue } from '../../shared/market-analysis-contracts';
import type { MarketStepKind, MarketStepInputRef, MarketModuleKind, MarketStepDefinition, MarketStepClaim } from '../../server/db/market-module-execution-repository';
import { ConnectorError, type RemoteMcpConnector } from '../../server/connectors/connector-contract';
import type { OpenAIProviderOptions } from '../../server/runtime/openai-provider';
import { createMarketSemanticFixture } from './helpers/market-semantic-fixture';
import { startPostgresTestContainer } from './helpers/postgres-test-container';
import { marketThemeFlowInitialSteps, MARKET_THEME_FLOW_VERSION, MARKET_THEME_RECONCILED_FLOW_VERSION } from '../../server/domain/market-research/customer-theme-flow';
import { createMarketThemeRulesStep } from '../../server/runtime/market-theme-rules-step';
import { createMarketThemeReportStep } from '../../server/runtime/market-theme-report-step';
import { MarketThemeReportService } from '../../server/services/market-theme-report-service';
import { MarketModuleService } from '../../server/services/market-module-service';
import { registerMarketModuleRoutes } from '../../server/routes/market-modules';
import { MarketThemeRunResponseSchema } from '../../shared/market-module-contracts';
import { MarketSemanticBatchPreparationService } from '../../server/runtime/market-semantic-batch-preparation';
import { createMarketThemeReconciliationStep } from '../../server/runtime/market-theme-reconciliation-step';
import { readMarketThemeReconciliationRound, readMarketThemeReconciliationPlan } from '../../server/runtime/market-theme-reconciliation-round';
import { createMarketThemeReconciliationEvaluationStep } from '../../server/runtime/market-theme-reconciliation-evaluation-step';
import { loadMarketThemeEvaluationHistory } from '../../server/db/postgres/market-theme-evaluation-history';

const base = loadVocPositioningRuntimeConfig({ OPENAI_API_KEY: 'synthetic-key', AGENT_VOC_MODEL: 'synthetic-model',
  AGENT_VOC_ESTIMATED_INPUT_TOKENS: '10000', AGENT_VOC_MAX_OUTPUT_TOKENS: '4000', AGENT_VOC_TIMEOUT_MS: '90000',
  AGENT_VOC_INPUT_USD_PER_MILLION_TOKENS: '1', AGENT_VOC_OUTPUT_USD_PER_MILLION_TOKENS: '2', AGENT_VOC_CALL_MAX_TOKENS: '100000',
  AGENT_VOC_CALL_MAX_COST_MICROS: '1000000', AGENT_VOC_RUN_MAX_TOKENS: '100000', AGENT_VOC_RUN_MAX_COST_MICROS: '1000000',
  AGENT_VOC_DAILY_MAX_TOKENS: '100000', AGENT_VOC_DAILY_MAX_COST_MICROS: '1000000', AGENT_VOC_WORKER_OWNER_ID: 'synthetic-worker' });
test('collected source projection feeds the native model queue in isolated PostgreSQL', { timeout: 120000 }, async t => {
  const pg = await startPostgresTestContainer(); t.after(() => pg.close()); await runPostgresMigrations(pg.pool);
  const manifest = (await (await SkillRegistry.open('skills-src')).load('market-classify-keyword-demand', '1.0.0')).manifest;
  const f = await createMarketSemanticFixture(pg.pool, { manifest }); await f.stores.steps.cancelModuleRun({ actor: f.actor, moduleRunId: f.subject.moduleRunId, idempotencyKey: randomUUID() });
  const asin = 'B000000001'; let sourceCalls = 0, modelCalls = 0;
  let themePoolMode = false;
  let fullFlowMode = false;
  let emptyAnchor = false;
  let mappedThemeOutput = false;
  let forceNewThemeProposal = false;
  let multiRoundThemeMode = false;
  let failOneReconciliationBatch=false,failedReconciliationDigest:string|null=null;
  const bodies: any[] = [];
  const connector = (id: 'sellerSprite' | 'sorftime'): RemoteMcpConnector => ({ id, probe: async () => { throw new Error('unused'); }, execute: async r => {
    sourceCalls++;
    if (themePoolMode && r.operation === 'product_customers_say' && r.input.asin === 'B000000003') throw new ConnectorError('sorftime', 'upstream-permanent', false);
    if (fullFlowMode && r.operation === 'product_customers_say' && ['B000000019', 'B000000020'].includes(String(r.input.asin))) throw new ConnectorError('sorftime', 'upstream-permanent', false);
    const data = r.operation === 'market_product_concentration' ? { code: 'OK', data: emptyAnchor ? [] : fullFlowMode ? Array.from({ length: 20 }, (_, i) => ({ asin: `B${String(i + 1).padStart(9, '0')}`, title: 'Synthetic top pool lamp', totalUnits: 0 })) : themePoolMode ? [1, 2, 3].map(n => ({ asin: `B00000000${n}`, title: 'Synthetic pool lamp', totalUnits: 0 })) : [{ asin, title: '  Synthetic shelf lamp  ', totalUnits: 0 }] }
      : r.operation === 'keyword_extends' ? { data: [{ keyword: '  synthetic shelf lamp  ' }, ...(r.input.page === 2 ? [{ keyword: 'synthetic corner lamp' }] : [])] }
      : r.operation === 'keyword_trend' ? { data: { keyword: r.input.keyword, search_volume_trend: ['2026-08 search volume 20'], search_rank_trend: [], recommended_bid_trend: [] } }
      : { data: { details: (themePoolMode && r.input.asin === 'B000000002') || (fullFlowMode && r.input.asin === 'B000000018') ? [] : Array.from({length:multiRoundThemeMode?13:1},(_,i)=>({ keyword:multiRoundThemeMode?`Assembly ${i}`:'Assembly', content: 'Easy assembly', mention: 2, positive: 2, negative: 0, update_time: '2026-08-01' })) } };
    return { data, source: { connectorId: id, operation: r.operation, fetchedAt: new Date().toISOString(), attemptCount: 1 } };
  } });
  const client = { responses: { create: async (body: { input: string }) => {
    modelCalls++; const input = JSON.parse(body.input); bodies.push(input);
    const unknown = { status: 'unknown', reason: 'insufficient-evidence', evidence: [] };
    const result = { schemaVersion: '1.0.0', task: input.task, batchId: input.batchId, inputDigest: input.inputDigest,
      ...(input.products ? { products: input.products.map((p: any) => ({ productId: p.productId, decision: unknown })) }
      : input.keywords ? { keywords: input.keywords.map((k: any) => ({ keywordId: k.keywordId, W1: unknown, W2: unknown, W3: unknown, W4: unknown, cluster: unknown })), proposals: [], synonymRelations: [] }
      : mappedThemeOutput && input.groupCatalog.length && !forceNewThemeProposal && !(multiRoundThemeMode&&input.mappingMode!=='catalog-only') ? { themes: input.themes.map((v:any)=>({sourceThemeId:v.sourceThemeId,decision:{status:'mapped',target:{kind:'existing',groupId:(multiRoundThemeMode?input.groupCatalog.at(-1):input.groupCatalog[0]).groupId},labelZh:'组装体验',explanationZh:'主题原文描述组装体验。',evidence:[{refId:v.keyword.value.refId,start:0,end:v.keyword.value.text.length,quote:v.keyword.value.text}]}})),proposals:[] }
      : mappedThemeOutput ? { themes: input.themes.map((v:any)=>({sourceThemeId:v.sourceThemeId,decision:{status:'mapped',target:{kind:'proposed',proposalId:'assembly'},labelZh:'组装体验',explanationZh:'主题原文描述组装体验。',evidence:[{refId:v.keyword.value.refId,start:0,end:v.keyword.value.text.length,quote:v.keyword.value.text}]}})),
        proposals:[{proposalId:'assembly',labelZh:'组装体验',definition:'产品的组装体验',evidence:[{refId:input.themes[0].keyword.value.refId,start:0,end:input.themes[0].keyword.value.text.length,quote:input.themes[0].keyword.value.text}]}] }
      : { themes: input.themes.map((v: any) => ({ sourceThemeId: v.sourceThemeId, decision: unknown })), proposals: [] }) };
    if(failOneReconciliationBatch&&input.mappingMode==='catalog-only'){
      failedReconciliationDigest??=input.inputDigest;
      if(input.inputDigest===failedReconciliationDigest)result.schemaVersion='synthetic-invalid';
    }
    return { id: 'synthetic-response', status: 'completed', usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
      output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(result) }] }] };
  } } } as unknown as OpenAIProviderOptions['client'];
  const runtime = await createMarketModelRuntime(f.context, base, { client, connectors: { sellerSprite: connector('sellerSprite'), sorftime: connector('sorftime') } }); t.after(() => runtime.stop());
  async function create(kind: MarketStepKind, moduleKind: MarketModuleKind, input: MarketJsonValue, refs: MarketStepInputRef[] = [], mapping = 'mapping/v1') {
    return (await f.stores.steps.createModuleRun({ actor: f.actor, scope: f.scope, moduleKind, params: {},
      versions: { source: MARKET_SOURCE_HANDLER_VERSION, rule: 'rules/v1', mapping, planner: 'planner/v1', model: 'market.semantic.text.v1', prompt: 'prompt/v1', configuration: runtime.configurationVersion },
      collectionRevision: randomUUID(), idempotencyKey: randomUUID(), initialSteps: [{ stepKey: 'one', kind, subject: {}, input, inputRefs: refs }] })).run;
  }
  const view = (id: string) => f.stores.steps.findModuleRun({ actor: f.actor, moduleRunId: id });
  let productInputId = '';
  const cases = [
    { module: 'shape-price' as const, collect: 'collect-product-month' as const, catalog: { task: 'market-product-shape-suggestion', taxonomyVersion: 'mapping/v1', allowedLabels: [] } },
    { module: 'keywords' as const, collect: 'collect-keyword-page' as const, catalog: { task: 'market-keyword-semantics', dictionaryVersion: 'mapping/v1', categoryContext: 'Synthetic floor lamps', dimensionLabels: { W1: [], W2: [], W3: [], W4: [] }, clusterCatalog: [] } },
    { module: 'customer-themes' as const, collect: 'collect-customer-themes' as const, catalog: { task: 'market-customer-theme-mapping', mappingVersion: 'mapping/v1', selectedAsins: [asin], groupCatalog: [] } },
  ];
  for (const entry of cases) await t.test(`${entry.module}: source text reaches persisted audited analysis through automatic queue steps`, async () => {
    const collectionInput = entry.module === 'shape-price' ? { month: '2026-08', poolSize: 100, newProductMonths: 6 }
      : entry.module === 'keywords' ? { seed: 'lamp', page: 1 } : { asin, selectionInputSnapshotId: productInputId };
    const collecting = await create(entry.collect, entry.module, JSON.parse(JSON.stringify(collectionInput)), entry.module === 'customer-themes' ? [{ kind: 'input', id: productInputId }] : []);
    assert.equal(await runtime.tick(), true); const collected = (await view(collecting.id))!;
    assert.equal(collected.steps[0].status, 'succeeded');
    const inputSnapshotId = (collected.attempts[0].output as { inputSnapshotId: string }).inputSnapshotId;
    if (entry.module === 'shape-price') productInputId = inputSnapshotId;
    const refs: MarketStepInputRef[] = [{ kind: 'input', id: inputSnapshotId }];
    if (entry.module === 'customer-themes') refs.push({ kind: 'input', id: productInputId });
    const run = await create('prepare-members', entry.module, JSON.parse(JSON.stringify({ catalog: entry.catalog, inputSnapshotId,
      selectionRevision: 'selection/v1', dataCutoffAt: new Date().toISOString(), ...(entry.module === 'customer-themes' ? { selectionInputSnapshotId: productInputId } : {}) })), refs);
    const before = modelCalls;
    assert.equal(await runtime.tick(), true); assert.equal(modelCalls, before);
    let saved = (await view(run.id))!; assert.equal(saved.steps.find(s => s.kind === 'prepare-members')!.status, 'succeeded');
    assert.equal(saved.steps.find(s => s.kind === 'prepare-model-batches')!.status, 'queued');
    assert.equal(await runtime.tick(), true); assert.equal(modelCalls, before);
    assert.equal(await runtime.tick(), true);
    assert.equal(modelCalls, before + 1);
    saved = (await view(run.id))!; assert.equal(saved.steps.length, 3); assert.ok(saved.steps.every(s => s.status === 'succeeded'));
    assert.notEqual(saved.run.status, 'succeeded'); // Report reconciliation is still required.
    const audits = await f.stores.audit.listAgentRuns({ actor: f.actor, studyId: f.scope.researchId, moduleRunId: run.id });
    assert.equal(audits.length, 1); assert.equal(audits[0].validationStatus, 'passed');
    if (entry.module === 'shape-price') assert.equal(bodies.at(-1).products[0].title.value.text, '  Synthetic shelf lamp  ');
    if (entry.module === 'keywords') assert.equal(bodies.at(-1).keywords[0].text.text, '  synthetic shelf lamp  ');
    if (entry.module === 'customer-themes') assert.equal(bodies.at(-1).themes[0].content.value.text, 'Easy assembly');
  });
  await t.test('snapshot and child enqueue roll back together on database rejection', async () => {
    const run = await create('prepare-members', 'shape-price', { inputSnapshotId: productInputId,
      catalog: { task: 'market-product-shape-suggestion', taxonomyVersion: 'rollback/v1', allowedLabels: [] }, selectionRevision: 'selection/v1', dataCutoffAt: new Date().toISOString() }, [{ kind: 'input', id: productInputId }], 'rollback/v1');
    const before = (await pg.pool.query('SELECT count(*) FROM market_analysis_inputs')).rows[0].count;
    await pg.pool.query(`CREATE FUNCTION reject_projection_child() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.run_id='${run.id}' THEN RAISE EXCEPTION 'synthetic failure'; END IF; RETURN NEW; END; $$`);
    await pg.pool.query('CREATE TRIGGER reject_projection_child BEFORE INSERT ON market_analysis_steps FOR EACH ROW EXECUTE FUNCTION reject_projection_child()');
    try { await runtime.tick(); } finally { await pg.pool.query('DROP TRIGGER reject_projection_child ON market_analysis_steps'); await pg.pool.query('DROP FUNCTION reject_projection_child()'); }
    const saved = (await view(run.id))!; assert.equal(saved.steps.length, 1); assert.equal(saved.steps[0].status, 'failed');
    assert.equal((await pg.pool.query('SELECT count(*) FROM market_analysis_inputs')).rows[0].count, before);
  });
  await t.test('undeclared snapshot or taxonomy lineage mismatch cannot publish analysis input', async () => {
    for (const refs of [[], [{ kind: 'input' as const, id: productInputId }]]) {
      const run = await create('prepare-members', 'shape-price', { inputSnapshotId: productInputId,
        catalog: { task: 'market-product-shape-suggestion', taxonomyVersion: refs.length ? 'wrong/v1' : 'mapping/v1', allowedLabels: [] }, selectionRevision: 'selection/v1', dataCutoffAt: new Date().toISOString() }, refs);
      await runtime.tick(); const saved = (await view(run.id))!; assert.equal(saved.steps[0].status, 'failed'); assert.equal(saved.steps.length, 1);
    }
    assert.equal(sourceCalls, 3); assert.equal(modelCalls, 3);
  });
  await t.test('two pages create one fixed pool, two trend tasks and bounded deduplicated model batches', async () => {
    const pages: { inputSnapshotId: string; sourceRef: string }[] = [], refs: MarketStepInputRef[] = [];
    for (const page of [1, 2]) {
      const run = await create('collect-keyword-page', 'keywords', { seed: 'lamp', page }); await runtime.tick();
      const output = (await view(run.id))!.attempts[0].output as { inputSnapshotId: string; sourceRef: string };
      pages.push({ inputSnapshotId: output.inputSnapshotId, sourceRef: output.sourceRef });
      refs.push({ kind: 'input', id: output.inputSnapshotId }, { kind: 'source', id: output.sourceRef });
    }
    const run = await create('prepare-keyword-pool', 'keywords', { phase: 'assemble', pages, plannedPages: [{ seed: 'lamp', page: 1 }, { seed: 'lamp', page: 2 }], maxMembers: 20,
      catalog: JSON.parse(JSON.stringify(cases[1].catalog)), selectionRevision: 'selection/v1', dataCutoffAt: new Date().toISOString() }, refs);
    const previousCalls = sourceCalls, previousModels = modelCalls;
    await runtime.tick(); let saved = (await view(run.id))!;
    assert.equal(saved.steps.length, 3); assert.equal(sourceCalls, previousCalls); assert.equal(modelCalls, previousModels);
    const manifest = saved.attempts.find(a => a.status === 'succeeded')!.output as { rawInputSnapshotId: string; basisHash: string; duplicateMemberCount: number; selectedMemberIds: string[] };
    assert.equal(manifest.duplicateMemberCount, 1); assert.equal(manifest.selectedMemberIds.length, 2);
    for (let i = 0; i < 8 && saved.steps.some(s => s.status === 'queued' || s.status === 'running'); i++) { await runtime.tick(); saved = (await view(run.id))!; }
    const batches = saved.steps.filter(s => s.kind === 'model-batch').length;
    assert.ok(batches >= 1 && batches <= 2); assert.equal(saved.steps.length, 5 + batches); assert.ok(saved.steps.every(s => s.status === 'succeeded'));
    assert.equal(sourceCalls, previousCalls + 2); assert.equal(modelCalls, previousModels + batches);
    const modeledIds = bodies.slice(previousModels).flatMap(b => b.keywords.map((k: { keywordId: string }) => k.keywordId));
    assert.equal(modeledIds.length, 2); assert.equal(new Set(modeledIds).size, 2);
    assert.notEqual(saved.run.status, 'succeeded');
    const restarted = await createMarketModelRuntime(f.context, base, { client, connectors: { sellerSprite: connector('sellerSprite'), sorftime: connector('sorftime') } });
    try { assert.equal(await restarted.tick(), false); assert.equal(sourceCalls, previousCalls + 2); assert.equal(modelCalls, previousModels + batches); }
    finally { await restarted.stop(); }
    const forged = await create('prepare-keyword-pool', 'keywords', { phase: 'dispatch-trends', inputSnapshotId: manifest.rawInputSnapshotId, basisHash: manifest.basisHash }, [{ kind: 'input', id: manifest.rawInputSnapshotId }]);
    await runtime.tick(); assert.equal((await view(forged.id))!.steps[0].status, 'failed');
    const rollback = await create('prepare-keyword-pool', 'keywords', { phase: 'assemble', pages, plannedPages: [{ seed: 'lamp', page: 1 }, { seed: 'lamp', page: 2 }], maxMembers: 20,
      catalog: { ...JSON.parse(JSON.stringify(cases[1].catalog)), dictionaryVersion: 'pool-rollback/v1' }, selectionRevision: 'selection/v1', dataCutoffAt: new Date().toISOString() }, refs, 'pool-rollback/v1');
    const beforeInputs = (await pg.pool.query('SELECT count(*) FROM market_analysis_inputs')).rows[0].count;
    await pg.pool.query(`CREATE FUNCTION reject_pool_children() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.run_id='${rollback.id}' THEN RAISE EXCEPTION 'synthetic rollback'; END IF; RETURN NEW; END; $$`);
    await pg.pool.query('CREATE TRIGGER reject_pool_children BEFORE INSERT ON market_analysis_steps FOR EACH ROW EXECUTE FUNCTION reject_pool_children()');
    try { await runtime.tick(); } finally { await pg.pool.query('DROP TRIGGER reject_pool_children ON market_analysis_steps'); await pg.pool.query('DROP FUNCTION reject_pool_children()'); }
    const rolledBack = (await view(rollback.id))!; assert.equal(rolledBack.steps.length, 1); assert.equal(rolledBack.steps[0].status, 'failed');
    assert.equal((await pg.pool.query('SELECT count(*) FROM market_analysis_inputs')).rows[0].count, beforeInputs);
    assert.equal(sourceCalls, previousCalls + 2); assert.equal(modelCalls, previousModels + batches);
  });
  await t.test('fixed theme selection collects each ASIN once and preserves empty/failed members through pooled model preparation', async () => {
    themePoolMode = true;
    mappedThemeOutput = true;
    const anchor = await create('collect-product-month', 'shape-price', { month: '2026-08', poolSize: 100, newProductMonths: 6 }); await runtime.tick();
    const sourceInputSnapshotId = ((await view(anchor.id))!.attempts[0].output as { inputSnapshotId: string }).inputSnapshotId;
    const catalog = { task: 'market-customer-theme-mapping', mappingVersion: 'mapping/v1', groupCatalog: [] };
    const run = (await f.stores.steps.createModuleRun({ actor: f.actor, scope: f.scope, moduleKind: 'customer-themes', params: {},
      versions: { source: MARKET_SOURCE_HANDLER_VERSION, rule: 'market-theme-mapping-rules/v1', mapping: 'mapping/v1', planner: 'planner/v1', model: 'market.semantic.text.v1', prompt: 'prompt/v1', configuration: runtime.configurationVersion },
      collectionRevision: randomUUID(), idempotencyKey: randomUUID(), initialSteps: [
        { stepKey: 'select', kind: 'prepare-members', subject: {}, input: { phase: 'select-theme-members', inputSnapshotId: sourceInputSnapshotId, count: 20, catalog }, inputRefs: [{ kind: 'input', id: sourceInputSnapshotId }] },
        // The test supplies the not-yet-implemented frontier's explicit assembly handoff.
        { stepKey: 'planner-fixture', kind: 'reconcile', subject: {}, input: {}, inputRefs: [] },
        { stepKey: 'planner-later-fixture', kind: 'reconcile', subject: {}, input: {}, inputRefs: [] },
        { stepKey: 'planner-rules-fixture', kind: 'reconcile', subject: {}, input: {}, inputRefs: [] },
        { stepKey: 'planner-reconciliation-fixture', kind: 'reconcile', subject: {}, input: {}, inputRefs: [] },
      ] })).run;
    const beforeSources = sourceCalls, beforeModels = modelCalls;
    await runtime.tick(); let saved = (await view(run.id))!;
    const receipt = saved.attempts.find(a => a.status === 'succeeded')!;
    const selection = receipt.output as { selectionInputSnapshotId: string; selectedAsins: string[]; bsrTopVerified: boolean };
    assert.equal(selection.selectedAsins.length, 3); assert.equal(selection.bsrTopVerified, false);
    assert.equal(saved.steps.filter(s => s.kind === 'collect-customer-themes').length, 3);
    for (let i = 0; i < 3; i++) await runtime.tick(); saved = (await view(run.id))!;
    assert.equal(sourceCalls, beforeSources + 3); assert.equal(modelCalls, beforeModels);
    const observations = saved.attempts.filter(a => a.id !== receipt.id && (a.status === 'succeeded' || a.status === 'empty')).map(a => {
      const output = a.output as { inputSnapshotId: string; sourceRef: string }; return { inputSnapshotId: output.inputSnapshotId, sourceRef: output.sourceRef };
    });
    const failures = saved.attempts.filter(a => a.status === 'failed').map(a => a.id); assert.equal(failures.length, 1);
    const bridge = await f.stores.steps.claimStep({ moduleRunId: run.id, kinds: ['reconcile'], leaseOwnerId: randomUUID(), leaseMs: 120000 }); assert.ok(bridge);
    const refs: MarketStepInputRef[] = [{ kind: 'input', id: selection.selectionInputSnapshotId }, { kind: 'step-output', id: receipt.id },
      ...observations.flatMap(o => [{ kind: 'input' as const, id: o.inputSnapshotId }, { kind: 'source' as const, id: o.sourceRef }])];
    await f.stores.steps.settleAndEnqueue({ claim: bridge, outcome: { status: 'succeeded', output: { syntheticPlannerHandoff: true } }, children: [{
      stepKey: 'assemble', kind: 'prepare-members', subject: {}, input: { phase: 'assemble-theme-pool', selectionInputSnapshotId: selection.selectionInputSnapshotId,
        selectedAsins: selection.selectedAsins, catalog, observations, failedAttemptIds: failures, selectionRevision: 'selection/v1', dataCutoffAt: new Date().toISOString() }, inputRefs: refs,
    }] });
    await runtime.tick(); saved = (await view(run.id))!;
    const poolStep = saved.steps.find(s => s.stepKey === 'assemble')!; assert.equal(poolStep.status, 'succeeded');
    const pool = saved.attempts.find(a => a.id === poolStep.latestAttemptId)!.output as any;
    assert.equal(pool.coverage.selectedAsinCount, 3); assert.equal(pool.coverage.successfulAsinCount, 1); assert.equal(pool.coverage.emptyAsinCount, 1); assert.equal(pool.coverage.failedAsinCount, 1);
    assert.equal(pool.totals.mention, 2); assert.equal(pool.reviewDeduplication, 'unavailable');
    assert.equal(pool.ruleBaseline.module, 'customer-themes');
    assert.equal(pool.ruleBaseline.metrics.find((metric: { key: string; value: number | null }) => metric.key === 'mention')?.value, 2);
    assert.equal(pool.ruleBaseline.metrics.find((metric: { key: string; missingReason: string | null }) => metric.key === 'uniqueReviews')?.missingReason, 'Customers Say observations are not deduplicated reviews');
    assert.equal(pool.ruleBaseline.facts[0].value, 'not_assumed_disjoint');
    assert.equal(pool.selection.requestedCount, 20); assert.equal(pool.selection.observedProductCount, 3); assert.equal(pool.selection.requestedCountMet, false);
    await runtime.tick(); await runtime.tick(); saved = (await view(run.id))!;
    assert.equal(saved.steps.find(s => s.kind === 'model-batch')!.status, 'succeeded');
    assert.equal(modelCalls, beforeModels + 1); assert.equal(sourceCalls, beforeSources + 3);
    assert.deepEqual(bodies.at(-1).selectedAsins, selection.selectedAsins); assert.equal(bodies.at(-1).themes.length, 1);
    assert.notEqual(saved.run.status, 'succeeded');
    const later = await f.stores.steps.claimStep({ moduleRunId: run.id, kinds: ['reconcile'], leaseOwnerId: randomUUID(), leaseMs: 120000 }); assert.ok(later);
    const nextInput = { phase: 'assemble-theme-pool', selectionInputSnapshotId: selection.selectionInputSnapshotId, selectedAsins: selection.selectedAsins,
      catalog, observations, failedAttemptIds: failures, selectionRevision: 'selection/v1', dataCutoffAt: new Date().toISOString() };
    await f.stores.steps.settleAndEnqueue({ claim: later, outcome: { status: 'succeeded', output: { syntheticPlannerHandoff: true } }, children: [
      { stepKey: 'rollback-theme-pool', kind: 'prepare-members', subject: {}, input: nextInput, inputRefs: refs },
      { stepKey: 'invalid-failure-receipt', kind: 'prepare-members', subject: {}, input: { ...nextInput, failedAttemptIds: [receipt.id] }, inputRefs: refs },
    ] });
    const inputCount = (await pg.pool.query('SELECT count(*) FROM market_analysis_inputs')).rows[0].count;
    await pg.pool.query(`CREATE FUNCTION reject_theme_model_child() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.run_id='${run.id}' AND NEW.kind='prepare-model-batches' THEN RAISE EXCEPTION 'synthetic rollback'; END IF; RETURN NEW; END; $$`);
    await pg.pool.query('CREATE TRIGGER reject_theme_model_child BEFORE INSERT ON market_analysis_steps FOR EACH ROW EXECUTE FUNCTION reject_theme_model_child()');
    try { await runtime.tick(); await runtime.tick(); }
    finally { await pg.pool.query('DROP TRIGGER reject_theme_model_child ON market_analysis_steps'); await pg.pool.query('DROP FUNCTION reject_theme_model_child()'); }
    const rejected = (await view(run.id))!;
    assert.equal(rejected.steps.find(s => s.stepKey === 'rollback-theme-pool')!.status, 'failed');
    assert.equal(rejected.steps.find(s => s.stepKey === 'invalid-failure-receipt')!.status, 'failed');
    assert.equal((await pg.pool.query('SELECT count(*) FROM market_analysis_inputs')).rows[0].count, inputCount);
    assert.equal(modelCalls, beforeModels + 1); assert.equal(sourceCalls, beforeSources + 3);
    const rulesBridge = await f.stores.steps.claimStep({ moduleRunId: run.id, kinds: ['reconcile'], leaseOwnerId: randomUUID(), leaseMs: 120000 }); assert.ok(rulesBridge);
    const modelAttemptId = rejected.steps.find(s => s.kind === 'model-batch')!.latestAttemptId!;
    const ruleRefs: MarketStepInputRef[] = [{ kind: 'step-output', id: poolStep.latestAttemptId! }, { kind: 'step-output', id: modelAttemptId }];
    await f.stores.steps.settleAndEnqueue({ claim: rulesBridge, outcome: { status: 'succeeded', output: { syntheticPlannerHandoff: true } }, children: [
      { stepKey: 'theme-rules', kind: 'rules', subject: {}, input: { task: 'customer-theme-rules', poolAttemptId: poolStep.latestAttemptId!, modelAttemptIds: [modelAttemptId] }, inputRefs: ruleRefs },
      { stepKey: 'omit-accepted-model', kind: 'rules', subject: {}, input: { task: 'customer-theme-rules', poolAttemptId: poolStep.latestAttemptId!, modelAttemptIds: [] }, inputRefs: ruleRefs },
      { stepKey: 'source-as-model', kind: 'rules', subject: {}, input: { task: 'customer-theme-rules', poolAttemptId: poolStep.latestAttemptId!, modelAttemptIds: [receipt.id] }, inputRefs: [...ruleRefs, { kind: 'step-output', id: receipt.id }] },
      { stepKey: 'rollback-rules', kind: 'rules', subject: {}, input: { task: 'customer-theme-rules', poolAttemptId: poolStep.latestAttemptId!, modelAttemptIds: [modelAttemptId], topN: 0 }, inputRefs: ruleRefs },
    ] });
    for (let i = 0; i < 3; i++) await runtime.tick();
    const ruled = (await view(run.id))!, rulesStep = ruled.steps.find(s => s.stepKey === 'theme-rules')!;
    assert.equal(rulesStep.status, 'succeeded', JSON.stringify(ruled.attempts.find(a => a.id === rulesStep.latestAttemptId)?.error));
    const computed = ruled.attempts.find(a => a.id === rulesStep.latestAttemptId)!.output as any;
    assert.equal(computed.totals.mention, 2); assert.equal(computed.coverage.successfulAsinCount, 1);
    assert.equal(computed.coverage.emptyAsinCount, 1); assert.equal(computed.coverage.failedAsinCount, 1);
    const stored = await f.stores.snapshots.findInput({ actor: f.actor, studyId: f.scope.researchId, id: computed.inputSnapshotId }); assert.ok(stored);
    const summary = stored.snapshot.records.find(r => r.id === 'summary')!.data as any;
    assert.equal(summary.selection.requestedCount, 20); assert.equal(summary.auditRefs.length, 1);
    assert.equal(summary.semantics.validatedMemberCount, 1); assert.equal(summary.resultHash, computed.resultHash);
    assert.equal(ruled.steps.find(s => s.stepKey === 'omit-accepted-model')!.status, 'failed');
    assert.equal(ruled.steps.find(s => s.stepKey === 'source-as-model')!.status, 'failed');
    assert.equal(modelCalls, beforeModels + 1); assert.equal(sourceCalls, beforeSources + 3); assert.notEqual(ruled.run.status, 'succeeded');
    assert.equal(summary.artifactLayout, 'theme-rules-chunks/v1');
    const groups = stored.snapshot.records.filter(r => r.id.startsWith('groups:')).flatMap(r => (r.data as any).items);
    assert.equal(groups.length, 1); assert.equal(groups[0].topicShare.denominator, 2);
    const rollbackId = ruled.steps.find(s => s.stepKey === 'rollback-rules')!.id;
    const beforeRuleRollback = (await pg.pool.query('SELECT count(*) FROM market_analysis_inputs')).rows[0].count;
    await pg.pool.query(`CREATE FUNCTION reject_rule_settlement() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.step_id='${rollbackId}' AND NEW.status='succeeded' THEN RAISE EXCEPTION 'synthetic rule rollback'; END IF; RETURN NEW; END; $$`);
    await pg.pool.query('CREATE TRIGGER reject_rule_settlement BEFORE UPDATE ON market_analysis_step_attempts FOR EACH ROW EXECUTE FUNCTION reject_rule_settlement()');
    try { await runtime.tick(); } finally { await pg.pool.query('DROP TRIGGER reject_rule_settlement ON market_analysis_step_attempts'); await pg.pool.query('DROP FUNCTION reject_rule_settlement()'); }
    assert.equal((await view(run.id))!.steps.find(s => s.id === rollbackId)!.status, 'failed');
    assert.equal((await pg.pool.query('SELECT count(*) FROM market_analysis_inputs')).rows[0].count, beforeRuleRollback);
    // Explicit bridge only until the complete reconciliation flow is wired.
    const handoff=await f.stores.steps.claimStep({moduleRunId:run.id,kinds:['reconcile'],leaseOwnerId:randomUUID(),leaseMs:120000});assert.ok(handoff);
    await f.stores.steps.settleAndEnqueue({claim:handoff,outcome:{status:'succeeded',output:{}},children:[{
      stepKey:'reconcile-page',kind:'reconcile',subject:{},input:{task:'customer-theme-reconciliation-page',initialRulesAttemptId:rulesStep.latestAttemptId!,offset:0},
      inputRefs:[{kind:'step-output',id:rulesStep.latestAttemptId!}],
    },{
      stepKey:'bad-reconcile-seed',kind:'reconcile',subject:{},input:{task:'customer-theme-reconciliation-page',initialRulesAttemptId:poolStep.latestAttemptId!,offset:0},
      inputRefs:[{kind:'step-output',id:poolStep.latestAttemptId!}],
    },{
      stepKey:'undeclared-reconcile-seed',kind:'reconcile',subject:{},input:{task:'customer-theme-reconciliation-page',initialRulesAttemptId:rulesStep.latestAttemptId!,offset:0},inputRefs:[],
    },{
      stepKey:'evaluation-planner-fixture',kind:'reconcile',subject:{},input:{},inputRefs:[],
    }]});
    const claim=await f.stores.steps.claimStep({moduleRunId:run.id,kinds:['reconcile'],leaseOwnerId:randomUUID(),leaseMs:120000});assert.ok(claim);
    const beforeReconcileSources=sourceCalls,beforeReconcileModels=modelCalls;
    await assert.rejects(createMarketThemeReconciliationStep(f.context)({claim:{...claim,organizationId:randomUUID()},signal:new AbortController().signal}));
    const work=await createMarketThemeReconciliationStep(f.context)({claim,signal:new AbortController().signal});
    assert.equal(work.kind,'settlement');if(work.kind!=='settlement'||work.value.outcome.status==='failed')throw new Error('reconcile fixture');
    const page=work.value.outcome.output as any;
    assert.equal(page.totalWindows,1);assert.equal(page.offset,0);assert.equal(page.nextOffset,null);assert.equal(page.windows.length,1);
    assert.equal(work.value.inputs!.length,1);assert.equal(work.value.children!.length,1);assert.equal(work.value.children![0].kind,'prepare-model-batches');
    const beforeReconcileInputs=(await pg.pool.query('SELECT count(*) FROM market_analysis_inputs')).rows[0].count;
    await pg.pool.query(`CREATE FUNCTION reject_reconciliation_child() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.run_id='${run.id}' AND NEW.kind='prepare-model-batches' THEN RAISE EXCEPTION 'synthetic reconciliation rollback'; END IF; RETURN NEW; END; $$`);
    await pg.pool.query('CREATE TRIGGER reject_reconciliation_child BEFORE INSERT ON market_analysis_steps FOR EACH ROW EXECUTE FUNCTION reject_reconciliation_child()');
    try{await assert.rejects(f.stores.steps.settleAndEnqueue({claim,...work.value}));}
    finally{await pg.pool.query('DROP TRIGGER reject_reconciliation_child ON market_analysis_steps');await pg.pool.query('DROP FUNCTION reject_reconciliation_child()');}
    assert.equal((await pg.pool.query('SELECT count(*) FROM market_analysis_inputs')).rows[0].count,beforeReconcileInputs);
    assert.equal((await view(run.id))!.attempts.find(a=>a.id===claim.attemptId)!.status,'running');
    assert.equal((await f.stores.steps.settleAndEnqueue({claim:{...claim,leaseGeneration:claim.leaseGeneration+1},...work.value})).status,'lease-lost');
    assert.equal((await pg.pool.query('SELECT count(*) FROM market_analysis_inputs')).rows[0].count,beforeReconcileInputs);
    assert.equal((await f.stores.steps.settleAndEnqueue({claim,...work.value})).status,'committed');
    assert.equal((await f.stores.steps.settleAndEnqueue({claim,...work.value})).status,'already-committed');
    const persisted=await f.stores.snapshots.findInput({actor:f.actor,studyId:f.scope.researchId,id:page.windows[0].inputSnapshotId});assert.ok(persisted);
    assert.equal(persisted.snapshot.records.length,1);assert.equal(sourceCalls,beforeReconcileSources);assert.equal(modelCalls,beforeReconcileModels);
    const roundRequest={actor:f.actor,moduleRunId:run.id,initialRulesAttemptId:rulesStep.latestAttemptId!,lastPageAttemptId:claim.attemptId};
    const waiting=await readMarketThemeReconciliationRound(f.context,roundRequest,new AbortController().signal);
    assert.equal(waiting.status,'waiting');assert.equal(waiting.result,null);
    // The persisted child goes through the existing meter, binding and audited model worker.
    forceNewThemeProposal=true;
    await runtime.tick();await runtime.tick();assert.equal(modelCalls,beforeReconcileModels+2);assert.equal(sourceCalls,beforeReconcileSources);
    const failedModel=(await view(run.id))!.steps.find(s=>s.kind==='model-batch'&&s.inputRefs.some(r=>r.id===persisted.snapshot.snapshotId))!;
    assert.equal(failedModel.status,'failed');
    const partial=await readMarketThemeReconciliationRound(f.context,roundRequest,new AbortController().signal);
    assert.equal(partial.status,'settled');assert.equal(partial.result!.status,'partial');assert.equal(partial.result!.result!.aggregation.totals!.mention,2);
    assert.equal(partial.result!.result!.unavailableMemberIds.length,1);assert.equal(partial.auditRefs.length,0);
    forceNewThemeProposal=false;
    await f.stores.steps.retryFailedSteps({actor:f.actor,moduleRunId:run.id,steps:[{stepId:failedModel.id,failedAttemptId:failedModel.latestAttemptId!}],idempotencyKey:randomUUID()});
    assert.equal((await readMarketThemeReconciliationRound(f.context,roundRequest,new AbortController().signal)).status,'waiting');
    await runtime.tick();assert.equal(modelCalls,beforeReconcileModels+3);assert.equal(sourceCalls,beforeReconcileSources);
    const reconciledAudits=await f.stores.audit.listAgentRuns({actor:f.actor,studyId:f.scope.researchId,moduleRunId:run.id});
    assert.equal(reconciledAudits.length,3);assert.equal(reconciledAudits.filter(a=>a.validationStatus==='passed').length,2);
    assert.equal(reconciledAudits.filter(a=>a.validationStatus==='failed').length,1);
    assert.equal(bodies.at(-1).contentSnapshotId,persisted.snapshot.snapshotId);assert.equal(bodies.at(-1).groupCatalog.length,1);
    assert.equal(bodies.at(-1).mappingMode,'catalog-only');
    assert.deepEqual(bodies.at(-1).selectedAsins,selection.selectedAsins);
    const complete=await readMarketThemeReconciliationRound(f.context,roundRequest,new AbortController().signal);
    assert.equal(complete.status,'settled');assert.equal(complete.result!.status,'ready');
    assert.equal(complete.result!.result!.aggregation.totals!.mention,2);assert.equal(complete.result!.result!.aggregation.coverage.failedAsinCount,1);
    assert.equal(complete.auditRefs.length,1);assert.equal(complete.receipt!.batches.length,1);
    await assert.rejects(readMarketThemeReconciliationRound(f.context,{...roundRequest,actor:{...f.actor,organizationId:randomUUID()}},new AbortController().signal));
    await assert.rejects(readMarketThemeReconciliationRound(f.context,{...roundRequest,lastPageAttemptId:rulesStep.latestAttemptId!},new AbortController().signal));
    for(let i=0;i<2;i++){
      const invalid=await f.stores.steps.claimStep({moduleRunId:run.id,kinds:['reconcile'],leaseOwnerId:randomUUID(),leaseMs:120000});assert.ok(invalid);
      await assert.rejects(createMarketThemeReconciliationStep(f.context)({claim:invalid,signal:new AbortController().signal}));
      await f.stores.steps.settleAndEnqueue({claim:invalid,outcome:{status:'failed',error:{code:'invalid-data',retryable:false}}});
    }
    const evaluationBridge=await f.stores.steps.claimStep({moduleRunId:run.id,kinds:['reconcile'],leaseOwnerId:randomUUID(),leaseMs:120000});assert.ok(evaluationBridge);
    await f.stores.steps.settleAndEnqueue({claim:evaluationBridge,outcome:{status:'succeeded',output:{syntheticHandoff:true}},children:[{
      stepKey:'evaluate-reconciliation',kind:'reconcile',subject:{},input:{task:'customer-theme-reconciliation-evaluate',initialRulesAttemptId:rulesStep.latestAttemptId!,lastPageAttemptId:claim.attemptId,frontierHash:complete.frontierHash},
      inputRefs:[{kind:'step-output',id:rulesStep.latestAttemptId!},{kind:'step-output',id:claim.attemptId}],
    },{
      stepKey:'evaluate-obsolete-frontier',kind:'reconcile',subject:{},input:{task:'customer-theme-reconciliation-evaluate',initialRulesAttemptId:rulesStep.latestAttemptId!,lastPageAttemptId:claim.attemptId,frontierHash:partial.frontierHash},
      inputRefs:[{kind:'step-output',id:rulesStep.latestAttemptId!},{kind:'step-output',id:claim.attemptId}],
    }]});
    let evaluationClaim:MarketStepClaim|null=null;
    for(let i=0;i<2;i++){
      const candidate=await f.stores.steps.claimStep({moduleRunId:run.id,kinds:['reconcile'],leaseOwnerId:randomUUID(),leaseMs:120000});assert.ok(candidate);
      if(candidate.step.stepKey==='evaluate-reconciliation'){evaluationClaim=candidate;continue;}
      assert.equal(candidate.step.stepKey,'evaluate-obsolete-frontier');
      const stale=await createMarketThemeReconciliationEvaluationStep(f.context)({claim:candidate,signal:new AbortController().signal});
      if(stale.kind!=='atomic')throw new Error('Evaluation work');
      const count=(await pg.pool.query('SELECT count(*) FROM market_analysis_inputs')).rows[0].count;
      await assert.rejects(stale.commit(),/settled matching frontier/);
      assert.equal((await pg.pool.query('SELECT count(*) FROM market_analysis_inputs')).rows[0].count,count);
      await f.stores.steps.settleAndEnqueue({claim:candidate,outcome:{status:'failed',error:{code:'invalid-data',retryable:false}}});
    }
    assert.ok(evaluationClaim);
    const evaluation=await createMarketThemeReconciliationEvaluationStep(f.context)({claim:evaluationClaim,signal:new AbortController().signal});
    assert.equal(evaluation.kind,'atomic');if(evaluation.kind!=='atomic')throw new Error('evaluation fixture');
    const beforeEvaluationInputs=(await pg.pool.query('SELECT count(*) FROM market_analysis_inputs')).rows[0].count;
    await pg.pool.query(`CREATE FUNCTION reject_evaluation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${evaluationClaim.attemptId}' AND NEW.status='succeeded' THEN RAISE EXCEPTION 'synthetic evaluation rollback'; END IF; RETURN NEW; END; $$`);
    await pg.pool.query('CREATE TRIGGER reject_evaluation BEFORE UPDATE ON market_analysis_step_attempts FOR EACH ROW EXECUTE FUNCTION reject_evaluation()');
    try{await assert.rejects(evaluation.commit());}finally{await pg.pool.query('DROP TRIGGER reject_evaluation ON market_analysis_step_attempts');await pg.pool.query('DROP FUNCTION reject_evaluation()');}
    assert.equal((await pg.pool.query('SELECT count(*) FROM market_analysis_inputs')).rows[0].count,beforeEvaluationInputs);
    assert.equal((await view(run.id))!.attempts.find(a=>a.id===evaluationClaim.attemptId)!.status,'running');
    await evaluation.commit();assert.equal((await evaluation.commit() as any).status,'already-committed');
    const evaluated=(await view(run.id))!.attempts.find(a=>a.id===evaluationClaim.attemptId)!.output as any;
    assert.equal(evaluated.status,'ready');assert.equal(evaluated.resultHash,complete.result!.result!.resultHash);
    const evaluationSnapshot=await f.stores.snapshots.findInput({actor:f.actor,studyId:f.scope.researchId,id:evaluated.inputSnapshotId});assert.ok(evaluationSnapshot);
    assert.equal((evaluationSnapshot.snapshot.records.find(r=>r.id==='summary')!.data as any).frontierHash,complete.frontierHash);
    const restored=await readMarketThemeReconciliationPlan(f.context,{actor:f.actor,moduleRunId:run.id,initialRulesAttemptId:rulesStep.latestAttemptId!,priorEvaluationAttemptIds:[evaluationClaim.attemptId]},new AbortController().signal);
    assert.equal(restored.status,'ready');assert.equal(restored.result!.resultHash,complete.result!.result!.resultHash);
    await assert.rejects(readMarketThemeReconciliationPlan(f.context,{actor:f.actor,moduleRunId:run.id,initialRulesAttemptId:rulesStep.latestAttemptId!,priorEvaluationAttemptIds:[evaluationClaim.attemptId,evaluationClaim.attemptId]},new AbortController().signal));
    assert.equal(modelCalls,beforeReconcileModels+3);assert.equal(sourceCalls,beforeReconcileSources);
    mappedThemeOutput=false;
    assert.equal(modelCalls, beforeModels + 4); assert.equal(sourceCalls, beforeSources + 3);
  });
  await t.test('versioned flow automatically advances two native reconciliation rounds across a runtime restart',async sub=>{
    themePoolMode=false;fullFlowMode=false;emptyAnchor=false;mappedThemeOutput=true;multiRoundThemeMode=true;
    sub.after(()=>{multiRoundThemeMode=false;mappedThemeOutput=false;});
    let active=await createMarketModelRuntime(f.context,base,{client,connectors:{sellerSprite:connector('sellerSprite'),sorftime:connector('sorftime')}});sub.after(()=>active.stop());
    const catalog={task:'market-customer-theme-mapping',mappingVersion:'mapping/v1',groupCatalog:Array.from({length:8},(_,i)=>({groupId:`known-${i}`,labelZh:`组装${i}`,definition:`组装体验目录项${i}`}))};
    const runRequest={actor:f.actor,scope:f.scope,moduleKind:'customer-themes' as const,
      params:{flow:MARKET_THEME_RECONCILED_FLOW_VERSION,memberCount:1,poolSize:20,newProductMonths:6,catalog},
      versions:{source:MARKET_SOURCE_HANDLER_VERSION,rule:'market-theme-mapping-rules/v1',mapping:'mapping/v1',planner:MARKET_THEME_RECONCILED_FLOW_VERSION,model:'market.semantic.text.v1',prompt:'prompt/v1',configuration:active.configurationVersion},
      collectionRevision:randomUUID(),idempotencyKey:randomUUID()};
    const run=(await f.stores.steps.createModuleRun({...runRequest,initialSteps:marketThemeFlowInitialSteps(runRequest)})).run;
    const beforeSources=sourceCalls,beforeModels=modelCalls;
    let firstEvaluation:string|null=null;
    for(let i=0;i<80;i++){
      assert.equal(await active.tick(),true,'Flow stopped before its first evaluation');
      const saved=(await view(run.id))!;
      const first=saved.steps.find(s=>s.kind==='reconcile'&&(s.input as any).task==='customer-theme-reconciliation-evaluate'&&s.status==='succeeded');
      if(first){firstEvaluation=first.latestAttemptId;break;}
    }
    assert.ok(firstEvaluation);await active.stop();
    active=await createMarketModelRuntime(f.context,base,{client,connectors:{sellerSprite:connector('sellerSprite'),sorftime:connector('sorftime')}});
    let idle=false;for(let i=0;i<80;i++)if(!await active.tick()){idle=true;break;}assert.equal(idle,true);
    const current=(await view(run.id))!,seed=current.steps.find(s=>s.kind==='rules')!;
    const evaluations=current.steps.filter(s=>s.kind==='reconcile'&&(s.input as any).task==='customer-theme-reconciliation-evaluate');
    assert.equal(evaluations.length,2);assert.ok(evaluations.every(s=>s.status==='succeeded'));
    const prior=evaluations.sort((a,b)=>(a.input as any).priorEvaluationAttemptIds.length-(b.input as any).priorEvaluationAttemptIds.length).map(s=>s.latestAttemptId!);
    assert.equal(prior[0],firstEvaluation);
    const restored=await readMarketThemeReconciliationPlan(f.context,{actor:f.actor,moduleRunId:run.id,initialRulesAttemptId:seed.latestAttemptId!,priorEvaluationAttemptIds:prior},new AbortController().signal);
    assert.equal(restored.status,'ready');assert.equal(restored.result!.aggregation.totals!.mention,26);assert.equal(restored.result!.decisions.length,13);
    assert.equal(restored.result!.aggregation.groups.length,1);assert.equal(sourceCalls,beforeSources+2);
    const savedModels=(await view(run.id))!.steps.filter(s=>s.kind==='model-batch');assert.ok(savedModels.length>=8);
    assert.ok(savedModels.every(s=>s.status==='succeeded'&&s.attemptCount===1));assert.equal(modelCalls,beforeModels+savedModels.length);
    const finalView=(await view(run.id))!,report=finalView.steps.find(s=>s.kind==='report')!;
    assert.equal(report.status,'succeeded');assert.equal((report.input as any).basis,'reconciliation-evaluation');
    assert.equal(finalView.run.status,'succeeded','A current complete report must complete its module run');
    assert.equal((report.input as any).evaluationAttemptId,prior.at(-1));assert.equal(finalView.run.latestReportAttemptId,report.latestAttemptId);
    assert.equal(finalView.steps.some(s=>(s.input as any).task==='synthetic-bridge'),false);
    assert.equal(restored.result!.groups[0].origin,'batch-proposal');
    const reports=new MarketThemeReportService(f.context),saved=await reports.read({actor:f.actor,moduleRunId:run.id});
    const entry=saved!.currentReport!;assert.ok(entry);assert.equal(entry.report.reportVersion,'market-theme-report/v2');
    assert.equal(entry.report.status,'complete');assert.equal(entry.report.counts.mappedMemberCount,13);assert.equal(entry.report.counts.reconciliationRequired,false);
    const detail=await reports.readDetails({actor:f.actor,moduleRunId:run.id,attemptId:entry.attemptId,query:{section:'groups'}});
    assert.equal(detail!.page.totals!.mention,26);assert.equal(detail!.page.totalItems,1);
    const group=detail!.page.items[0];if(group.kind!=='group')throw new Error('Expected group');assert.equal(group.labelOrigin,'batch-proposal');
    const memberId=restored.result!.decisions[0].sourceThemeId;
    const evidence=await reports.readEvidence({actor:f.actor,moduleRunId:run.id,attemptId:entry.attemptId,query:{sourceThemeId:memberId}});
    assert.equal(evidence!.evidence.analysis!.status,'mapped');assert.equal(evidence!.evidence.analysis!.explanationZh,'主题原文描述组装体验。');
    assert.equal(evidence!.evidence.analysis!.evidence[0].quote,evidence!.evidence.keyword);
    assert.equal(evidence!.evidence.analysis!.outputDigest,restored.result!.decisions[0].outputDigest);
    await assert.rejects(reports.readEvidence({actor:f.actor,moduleRunId:run.id,attemptId:entry.attemptId,query:{sourceThemeId:'outside-report'}}));
    assert.equal(await reports.readDetails({actor:{...f.actor,organizationId:randomUUID()},moduleRunId:run.id,attemptId:entry.attemptId,query:{section:'groups'}}),null);
    assert.equal(sourceCalls,beforeSources+2);assert.equal(modelCalls,beforeModels+savedModels.length);
    const selectionStore=new MarketThemeSelectionStore(f.context),selectionIdentity={actor:f.actor,moduleRunId:run.id,attemptId:entry.attemptId};
    const baseSelection=await selectionStore.read(selectionIdentity);assert.ok(baseSelection);assert.equal(baseSelection.baseline.totals!.mention,26);
    const selectionCommand={...selectionIdentity,idempotencyKey:randomUUID(),request:{baseReportHash:entry.report.reportHash,expectedParentRevisionId:null,excludedAsins:entry.report.selectedAsins}};
    const excludedSelection=await selectionStore.save(selectionCommand);assert.equal(excludedSelection.view.revision!.result.status,'no-data');
    const restoredSelection=await selectionStore.save({...selectionCommand,idempotencyKey:randomUUID(),request:{...selectionCommand.request,expectedParentRevisionId:excludedSelection.view.latestRevisionId,excludedAsins:[]}});
    assert.deepEqual(restoredSelection.view.revision!.result,baseSelection.baseline);assert.equal(sourceCalls,beforeSources+2);assert.equal(modelCalls,beforeModels+savedModels.length);
    assert.equal((await reports.read({actor:f.actor,moduleRunId:run.id}))!.currentReport!.report.reportHash,entry.report.reportHash);
    // A final report must validate its saved prior-round receipt too, even when
    // its own snapshot and final receipt remain unchanged.
    const priorOutput=finalView.attempts.find(a=>a.id===prior[0])!.output;
    await assert.rejects(pg.pool.query('UPDATE market_analysis_step_attempts SET output_json=$2 WHERE id=$1',
      [prior[0],JSON.stringify({...priorOutput as object,evaluationHash:'f'.repeat(64)})]),/Finished market attempts are immutable/);
    const forgedView=structuredClone(finalView);
    forgedView.attempts.find(a=>a.id===prior[0])!.output={...priorOutput as object,evaluationHash:'f'.repeat(64)};
    const finalEvaluationSnapshot=await f.stores.snapshots.findInput({actor:f.actor,studyId:f.scope.researchId,id:entry.report.inputSnapshotId});assert.ok(finalEvaluationSnapshot);
    await assert.rejects(loadMarketThemeEvaluationHistory(f.context,f.actor,forgedView,prior.at(-1)!,finalEvaluationSnapshot.snapshot));
    // A historical read after cancellation retains the accepted result and exact
    // model audit; cancellation only removes its current execution frontier.
    await f.stores.steps.cancelModuleRun({actor:f.actor,moduleRunId:run.id,idempotencyKey:randomUUID()});
    const historical=await reports.readEvidence({actor:f.actor,moduleRunId:run.id,attemptId:entry.attemptId,query:{sourceThemeId:memberId}});
    assert.equal(historical!.report.current,false);assert.equal(historical!.report.report.reportHash,entry.report.reportHash);assert.deepEqual(historical!.evidence,evidence!.evidence);
    assert.equal((await selectionStore.save(selectionCommand)).created,false);assert.equal((await selectionStore.read({...selectionIdentity,revisionId:excludedSelection.view.latestRevisionId!}))!.revision!.result.status,'no-data');
    await assert.rejects(selectionStore.save({...selectionCommand,idempotencyKey:randomUUID(),request:{...selectionCommand.request,expectedParentRevisionId:restoredSelection.view.latestRevisionId}}));
  });
  await t.test('v2 failed reconciliation retry preserves successful batches and the complete old report evidence',async sub=>{
    themePoolMode=false;fullFlowMode=false;emptyAnchor=false;mappedThemeOutput=true;multiRoundThemeMode=true;failOneReconciliationBatch=true;failedReconciliationDigest=null;
    sub.after(()=>{multiRoundThemeMode=false;mappedThemeOutput=false;failOneReconciliationBatch=false;failedReconciliationDigest=null;});
    const active=await createMarketModelRuntime(f.context,base,{client,connectors:{sellerSprite:connector('sellerSprite'),sorftime:connector('sorftime')}});sub.after(()=>active.stop());
    const request={actor:f.actor,scope:f.scope,moduleKind:'customer-themes' as const,
      params:{flow:MARKET_THEME_RECONCILED_FLOW_VERSION,memberCount:1,poolSize:20,newProductMonths:6,catalog:{task:'market-customer-theme-mapping',mappingVersion:'mapping/v1',groupCatalog:Array.from({length:8},(_,i)=>({groupId:`known-${i}`,labelZh:`组装${i}`,definition:`组装体验目录项${i}`}))}},
      versions:{source:MARKET_SOURCE_HANDLER_VERSION,rule:'market-theme-mapping-rules/v1',mapping:'mapping/v1',planner:MARKET_THEME_RECONCILED_FLOW_VERSION,model:'market.semantic.text.v1',prompt:'prompt/v1',configuration:active.configurationVersion},
      collectionRevision:randomUUID(),idempotencyKey:randomUUID()};
    const run=(await f.stores.steps.createModuleRun({...request,initialSteps:marketThemeFlowInitialSteps(request)})).run;
    const drainActive=async()=>{for(let i=0;i<120;i++)if(!await active.tick())return;throw new Error('v2 retry flow did not stop');};
    await drainActive();
    const reports=new MarketThemeReportService(f.context),before=(await view(run.id))!,first=(await reports.read({actor:f.actor,moduleRunId:run.id}))!.currentReport!;
    assert.ok(first);assert.equal(first.report.reportVersion,'market-theme-report/v2');assert.equal(first.report.status,'partial');assert.equal(before.run.status,'partial');
    const failed=before.steps.filter(s=>s.kind==='model-batch'&&s.status==='failed');assert.equal(failed.length,1);
    const members=await reports.readDetails({actor:f.actor,moduleRunId:run.id,attemptId:first.attemptId,query:{section:'members'}});
    const unavailable=members!.page.items.find(i=>i.kind==='member'&&i.decision.status==='unavailable');assert.ok(unavailable&&unavailable.kind==='member');
    const original=await reports.readEvidence({actor:f.actor,moduleRunId:run.id,attemptId:first.attemptId,query:{sourceThemeId:unavailable.sourceThemeId}});
    assert.equal(original!.evidence.analysis,null);
    const priorSelectionStore=new MarketThemeSelectionStore(f.context),priorSelectionIdentity={actor:f.actor,moduleRunId:run.id,attemptId:first.attemptId};
    const priorSelection=await priorSelectionStore.save({...priorSelectionIdentity,idempotencyKey:randomUUID(),request:{baseReportHash:first.report.reportHash,expectedParentRevisionId:null,excludedAsins:[]}});
    const priorSelectionJson=JSON.stringify(priorSelection.view);
    const sourceCount=sourceCalls,succeeded=before.steps.filter(s=>s.kind==='model-batch'&&s.status==='succeeded');
    failOneReconciliationBatch=false;
    await f.stores.steps.retryFailedSteps({actor:f.actor,moduleRunId:run.id,steps:[{stepId:failed[0].id,failedAttemptId:failed[0].latestAttemptId!}],idempotencyKey:randomUUID()});
    const queued=(await reports.read({actor:f.actor,moduleRunId:run.id}))!;assert.equal(queued.executionStatus,'queued');assert.equal(queued.currentReport,null);assert.equal(queued.latestSavedReport!.report.reportHash,first.report.reportHash);
    await drainActive();const after=(await view(run.id))!,latest=(await reports.read({actor:f.actor,moduleRunId:run.id}))!;
    assert.equal(after.run.status,'succeeded');assert.equal(latest.currentReport!.report.status,'complete');assert.notEqual(latest.currentReport!.attemptId,first.attemptId);
    assert.equal(latest.currentReport!.report.counts.expectedMemberCount,13);assert.equal(sourceCalls,sourceCount);
    assert.equal(after.steps.find(s=>s.id===failed[0].id)!.attemptCount,2);
    for(const s of succeeded)assert.equal(after.steps.find(n=>n.id===s.id)!.latestAttemptId,s.latestAttemptId);
    const old=await reports.readEvidence({actor:f.actor,moduleRunId:run.id,attemptId:first.attemptId,query:{sourceThemeId:unavailable.sourceThemeId}});
    assert.equal(old!.report.current,false);assert.deepEqual(old!.evidence,original!.evidence);
    const recovered=await reports.readEvidence({actor:f.actor,moduleRunId:run.id,attemptId:latest.currentReport!.attemptId,query:{sourceThemeId:unavailable.sourceThemeId}});
    assert.equal(recovered!.evidence.analysis!.status,'mapped');
    const modelsAfterRetry=modelCalls;assert.equal(JSON.stringify(await priorSelectionStore.read(priorSelectionIdentity)),priorSelectionJson);assert.equal(modelCalls,modelsAfterRetry);assert.equal(sourceCalls,sourceCount);
  });
  await t.test('durable theme flow resumes after restart and retries only the failed ASIN without a synthetic planner bridge', async () => {
    themePoolMode = true;
    mappedThemeOutput = false;
    forceNewThemeProposal = false;
    const request = { actor: f.actor, scope: f.scope, moduleKind: 'customer-themes' as const,
      params: { flow: MARKET_THEME_FLOW_VERSION, memberCount: 3, poolSize: 20, newProductMonths: 6,
        catalog: { task: 'market-customer-theme-mapping', mappingVersion: 'mapping/v1', groupCatalog: [] } },
      versions: { source: MARKET_SOURCE_HANDLER_VERSION, rule: 'market-theme-mapping-rules/v1', mapping: 'mapping/v1', planner: MARKET_THEME_FLOW_VERSION,
        model: 'market.semantic.text.v1', prompt: 'prompt/v1', configuration: runtime.configurationVersion }, collectionRevision: randomUUID(), idempotencyKey: randomUUID() };
    const run = (await f.stores.steps.createModuleRun({ ...request, initialSteps: marketThemeFlowInitialSteps(request) })).run;
    const startingSources = sourceCalls, startingModels = modelCalls;
    await runtime.tick();
    assert.equal((await view(run.id))!.steps.filter(s => s.kind === 'prepare-members').length, 1);
    await runtime.stop();
    const restarted = await createMarketModelRuntime(f.context, base, { client, connectors: { sellerSprite: connector('sellerSprite'), sorftime: connector('sorftime') } });
    t.after(() => restarted.stop());
    async function drain() { for (let i = 0; i < 30; i++) if (!await restarted.tick()) return; assert.fail('Flow did not reach an idle frontier'); }
    await drain();
    const done = (await view(run.id))!; assert.equal(done.steps.some(s => s.kind === 'reconcile'), false);
    const rule = done.steps.find(s => s.kind === 'rules')!; assert.ok(rule); assert.equal(rule.status, 'succeeded', JSON.stringify(done.attempts));
    const output = done.attempts.find(a => a.id === rule.latestAttemptId)!.output as any;
    assert.equal(output.coverage.successfulAsinCount, 1); assert.equal(output.coverage.emptyAsinCount, 1); assert.equal(output.coverage.failedAsinCount, 1);
    assert.equal(output.semantics.validatedMemberCount, 1); assert.equal(sourceCalls, startingSources + 4); assert.equal(modelCalls, startingModels + 1);
    const published = done.steps.find(s => s.kind === 'report')!; assert.ok(published);
    assert.equal(published.status, 'succeeded', JSON.stringify(done.attempts));
    const firstReport = done.attempts.find(a => a.id === published.latestAttemptId)!.output as any;
    assert.equal(firstReport.status, 'partial'); assert.equal(firstReport.basisAttemptId, rule.latestAttemptId);
    assert.equal((await pg.pool.query('SELECT latest_report_attempt_id FROM market_analysis_module_runs WHERE id=$1', [run.id])).rows[0].latest_report_attempt_id, published.latestAttemptId);
    const reports = new MarketThemeReportService(f.context), reportRequest = { actor: f.actor, moduleRunId: run.id };
    assert.equal((await reports.read(reportRequest))!.currentReport!.report.reportHash, firstReport.reportHash);
    assert.equal(await reports.read({ ...reportRequest, actor: { ...f.actor, organizationId: randomUUID() } }), null);
    const failed = done.steps.find(s => s.kind === 'collect-customer-themes' && s.status === 'failed')!; assert.ok(failed);
    themePoolMode = false;
    await f.stores.steps.retryFailedSteps({ actor: f.actor, moduleRunId: run.id, steps: [{ stepId: failed.id, failedAttemptId: failed.latestAttemptId! }], idempotencyKey: randomUUID() });
    const duringRetry = (await reports.read(reportRequest))!;
    assert.equal(duringRetry.currentReport, null); assert.equal(duringRetry.latestSavedReport!.current, false);
    assert.equal(duringRetry.latestSavedReport!.report.reportHash, firstReport.reportHash);
    await drain(); const recovered = (await view(run.id))!, rules = recovered.steps.filter(s => s.kind === 'rules');
    assert.equal(rules.length, 2); assert.ok(rules.every(s => s.status === 'succeeded'));
    const newer = recovered.attempts.find(a => a.id === rules.find(s => s.id !== rule.id)!.latestAttemptId)!.output as any;
    assert.equal(newer.coverage.successfulAsinCount, 2); assert.equal(newer.coverage.emptyAsinCount, 1); assert.equal(newer.coverage.failedAsinCount, 0);
    assert.notEqual(newer.inputSnapshotId, output.inputSnapshotId);
    assert.equal(recovered.steps.filter(s => s.kind === 'report' && s.status === 'succeeded').length, 2);
    assert.deepEqual(recovered.attempts.find(a => a.id === published.latestAttemptId)!.output, firstReport);
    const afterRetry = (await reports.read(reportRequest))!;
    assert.equal(afterRetry.history.length, 2); assert.equal(afterRetry.currentReport!.report.counts.successfulCount, 2);
    assert.ok(await f.stores.snapshots.findInput({ actor: f.actor, studyId: f.scope.researchId, id: output.inputSnapshotId }));
    assert.equal(sourceCalls, startingSources + 5); assert.equal(modelCalls, startingModels + 2);
    assert.equal(recovered.steps.find(s => s.id === failed.id)!.attemptCount, 2);
    assert.ok(recovered.steps.filter(s => s.kind === 'collect-customer-themes' && s.id !== failed.id).every(s => s.attemptCount === 1));
    assert.equal(await restarted.tick(), false); assert.notEqual(recovered.run.status, 'succeeded');

    // Freeze an old rule computation, then advance a failed source before commit.
    themePoolMode = true;
    const second = (await f.stores.steps.createModuleRun({ ...request, collectionRevision: randomUUID(), idempotencyKey: randomUUID(), initialSteps: marketThemeFlowInitialSteps(request) })).run;
    for (let i = 0; i < 20 && !(await view(second.id))!.steps.some(s => s.kind === 'rules'); i++) await restarted.tick();
    const oldClaim = await f.stores.steps.claimStep({ moduleRunId: second.id, kinds: ['rules'], leaseOwnerId: randomUUID(), leaseMs: 120000 }); assert.ok(oldClaim);
    const oldWork = await createMarketThemeRulesStep(f.context)({ claim: oldClaim, signal: new AbortController().signal }); assert.equal(oldWork.kind, 'settlement');
    const secondView = (await view(second.id))!, secondFailed = secondView.steps.find(s => s.kind === 'collect-customer-themes' && s.status === 'failed')!;
    themePoolMode = false;
    await f.stores.steps.retryFailedSteps({ actor: f.actor, moduleRunId: second.id, steps: [{ stepId: secondFailed.id, failedAttemptId: secondFailed.latestAttemptId! }], idempotencyKey: randomUUID() });
    await restarted.tick();
    if (oldWork.kind !== 'settlement') throw new Error('fixture work');
    const superseded = await f.stores.steps.settleAndEnqueue({ claim: oldClaim, ...oldWork.value });
    assert.deepEqual(superseded.inputIds, []); assert.deepEqual(superseded.childStepIds, []);
    assert.equal((await f.stores.steps.settleAndEnqueue({ claim: oldClaim, ...oldWork.value })).status, 'already-committed');
    const stale = (await view(second.id))!.attempts.find(a => a.id === oldClaim.attemptId)!;
    assert.equal(stale.status, 'empty'); assert.equal((stale.output as any).superseded, true);
    await drain(); assert.equal((await view(second.id))!.steps.filter(s => s.kind === 'rules' && s.status === 'succeeded').length, 1);

    // Automatic child insertion and the accepted source share one transaction.
    const third = (await f.stores.steps.createModuleRun({ ...request, collectionRevision: randomUUID(), idempotencyKey: randomUUID(), initialSteps: marketThemeFlowInitialSteps(request) })).run;
    const before = (await pg.pool.query('SELECT count(*) FROM market_analysis_inputs')).rows[0].count;
    const beforeEvidence = (await pg.pool.query('SELECT count(*) FROM market_analysis_sources')).rows[0].count;
    await pg.pool.query(`CREATE FUNCTION reject_automatic_selection() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.run_id='${third.id}' AND NEW.kind='prepare-members' THEN RAISE EXCEPTION 'synthetic automatic rollback'; END IF; RETURN NEW; END; $$`);
    await pg.pool.query('CREATE TRIGGER reject_automatic_selection BEFORE INSERT ON market_analysis_steps FOR EACH ROW EXECUTE FUNCTION reject_automatic_selection()');
    try { await restarted.tick(); } finally { await pg.pool.query('DROP TRIGGER reject_automatic_selection ON market_analysis_steps'); await pg.pool.query('DROP FUNCTION reject_automatic_selection()'); }
    const rolled = (await view(third.id))!; assert.equal(rolled.steps.length, 1); assert.equal(rolled.steps[0].status, 'failed');
    assert.equal((await pg.pool.query('SELECT count(*) FROM market_analysis_inputs')).rows[0].count, before);
    assert.equal((await pg.pool.query('SELECT count(*) FROM market_analysis_sources')).rows[0].count, beforeEvidence);

    // Exhausted crashed source claims must also advance the durable failure barrier.
    const expiredRequest = { ...request, params: { ...request.params, memberCount: 1 }, collectionRevision: randomUUID(), idempotencyKey: randomUUID() };
    const fourth = (await f.stores.steps.createModuleRun({ ...expiredRequest, initialSteps: marketThemeFlowInitialSteps(expiredRequest) })).run;
    await restarted.tick(); await restarted.tick();
    const beforeExpiredModels = modelCalls, beforeExpiredSources = sourceCalls;
    for (let i = 0; i < 3; i++) {
      const abandoned = await f.stores.steps.claimStep({ moduleRunId: fourth.id, kinds: ['collect-customer-themes'], leaseOwnerId: randomUUID(), leaseMs: 30000 }); assert.ok(abandoned);
      await pg.pool.query("UPDATE market_analysis_steps SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [abandoned.stepId]);
      assert.equal(await f.stores.steps.claimStep({ moduleRunId: fourth.id, kinds: ['collect-customer-themes'], leaseOwnerId: randomUUID(), leaseMs: 30000 }), null);
      await pg.pool.query("UPDATE market_analysis_steps SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE run_id=$1 AND status='queued'", [fourth.id]);
    }
    await drain(); const expired = (await view(fourth.id))!;
    const expiredSource = expired.steps.find(s => s.kind === 'collect-customer-themes')!; assert.equal(expiredSource.status, 'failed');
    assert.equal(expired.attempts.find(a => a.id === expiredSource.latestAttemptId)!.status, 'interrupted');
    const emptyRule = expired.steps.find(s => s.kind === 'rules')!; assert.equal(emptyRule.status, 'empty', JSON.stringify(expired.attempts));
    const unavailable = expired.attempts.find(a => a.id === emptyRule.latestAttemptId)!.output as any;
    assert.equal(unavailable.coverage.failedAsinCount, 1); assert.equal(unavailable.totals, null); assert.equal(unavailable.semantics.status, 'no-input');
    assert.equal(modelCalls, beforeExpiredModels); assert.equal(sourceCalls, beforeExpiredSources);

    // A preparation computed before retry cannot persist stale binding records.
    themePoolMode = true;
    const fifth = (await f.stores.steps.createModuleRun({ ...request, collectionRevision: randomUUID(), idempotencyKey: randomUUID(), initialSteps: marketThemeFlowInitialSteps(request) })).run;
    for (let i = 0; i < 20 && !(await view(fifth.id))!.steps.some(s => s.kind === 'prepare-model-batches'); i++) await restarted.tick();
    const preparing = await f.stores.steps.claimStep({ moduleRunId: fifth.id, kinds: ['prepare-model-batches'], leaseOwnerId: randomUUID(), leaseMs: 120000 }); assert.ok(preparing);
    const preparation = new MarketSemanticBatchPreparationService(f.context, await SkillRegistry.open('skills-src'));
    const cap = { maxTokens: 100000, maxCostMicros: 1000000 };
    const prepared = await preparation.planBatches(preparing, { task: 'market-customer-theme-mapping', configurationVersion: runtime.configurationVersion,
      model: { ...base.model, estimatedInputTokens: 12000, maxOutputTokens: 4000, timeoutMs: 60000 }, providerName: base.providerName, transport: base.transport,
      limits: { call: cap, run: cap, organizationUtcDay: cap }, openAI: { client } });
    const failedBeforePrepare = (await view(fifth.id))!.steps.find(s => s.kind === 'collect-customer-themes' && s.status === 'failed')!;
    themePoolMode = false;
    await f.stores.steps.retryFailedSteps({ actor: f.actor, moduleRunId: fifth.id, steps: [{ stepId: failedBeforePrepare.id, failedAttemptId: failedBeforePrepare.latestAttemptId! }], idempotencyKey: randomUUID() });
    await restarted.tick(); await prepared.commit();
    assert.equal((await pg.pool.query('SELECT count(*) FROM market_analysis_semantic_snapshot_bindings WHERE module_run_id=$1', [fifth.id])).rows[0].count, '0');
    assert.equal((await view(fifth.id))!.steps.find(s => s.id === preparing.stepId)!.status, 'empty');
    const modelsBeforeNewBasis = modelCalls; await drain(); assert.equal(modelCalls, modelsBeforeNewBasis + 1);

    // A queued old model is skipped before making a paid request.
    themePoolMode = true;
    const sixth = (await f.stores.steps.createModuleRun({ ...request, collectionRevision: randomUUID(), idempotencyKey: randomUUID(), initialSteps: marketThemeFlowInitialSteps(request) })).run;
    for (let i = 0; i < 20 && !(await view(sixth.id))!.steps.some(s => s.kind === 'model-batch'); i++) await restarted.tick();
    const beforeOldModel = (await view(sixth.id))!, oldModel = beforeOldModel.steps.find(s => s.kind === 'model-batch')!;
    const oldFailed = beforeOldModel.steps.find(s => s.kind === 'collect-customer-themes' && s.status === 'failed')!;
    themePoolMode = false;
    await f.stores.steps.retryFailedSteps({ actor: f.actor, moduleRunId: sixth.id, steps: [{ stepId: oldFailed.id, failedAttemptId: oldFailed.latestAttemptId! }], idempotencyKey: randomUUID() });
    const beforePaid = modelCalls; await drain();
    assert.equal((await view(sixth.id))!.steps.find(s => s.id === oldModel.id)!.status, 'empty');
    assert.equal(modelCalls, beforePaid + 1);

    fullFlowMode = true;
    const fullRequest = { ...request, params: { ...request.params, memberCount: 20, poolSize: 100 }, collectionRevision: randomUUID(), idempotencyKey: randomUUID() };
    const full = (await f.stores.steps.createModuleRun({ ...fullRequest, initialSteps: marketThemeFlowInitialSteps(fullRequest) })).run;
    const fullSourceStart = sourceCalls, fullModelStart = modelCalls;
    for (let i = 0; i < 50; i++) if (!await restarted.tick()) break;
    const twenty = (await view(full.id))!, fullRule = twenty.steps.find(s => s.kind === 'rules')!;
    assert.ok(fullRule); assert.equal(fullRule.status, 'succeeded', JSON.stringify(twenty.attempts));
    const fullResult = twenty.attempts.find(a => a.id === fullRule.latestAttemptId)!.output as any;
    assert.equal(fullResult.coverage.selectedAsinCount, 20); assert.equal(fullResult.coverage.successfulAsinCount, 17);
    assert.equal(fullResult.coverage.emptyAsinCount, 1); assert.equal(fullResult.coverage.failedAsinCount, 2); assert.equal(fullResult.totals.mention, 34);
    assert.equal(fullResult.semantics.validatedMemberCount, 17); assert.equal(sourceCalls, fullSourceStart + 21);
    const batchSteps = twenty.steps.filter(s => s.kind === 'model-batch'); assert.ok(batchSteps.length >= 2);
    assert.equal(modelCalls, fullModelStart + batchSteps.length); assert.ok(batchSteps.every(s => s.status === 'succeeded'));
    assert.equal(await restarted.tick(), false); fullFlowMode = false;

    // Empty anchor has an honest saved no-data report and no invented ASIN/model.
    emptyAnchor = true;
    const noAnchorRequest = { ...request, collectionRevision: randomUUID(), idempotencyKey: randomUUID() };
    const noAnchor = (await f.stores.steps.createModuleRun({ ...noAnchorRequest, initialSteps: marketThemeFlowInitialSteps(noAnchorRequest) })).run;
    const beforeEmptySources = sourceCalls, beforeEmptyModels = modelCalls; await drain();
    const noData = (await reports.read({ actor: f.actor, moduleRunId: noAnchor.id }))!;
    assert.equal(noData.currentReport!.report.status, 'no-data'); assert.deepEqual(noData.currentReport!.report.selectedAsins, []);
    assert.equal(sourceCalls, beforeEmptySources + 1); assert.equal(modelCalls, beforeEmptyModels); emptyAnchor = false;

    // Reject forged envelopes, and roll back the pointer with its report attempt.
    themePoolMode = true;
    const reportRequest2 = { ...request, collectionRevision: randomUUID(), idempotencyKey: randomUUID() };
    const pendingReport = (await f.stores.steps.createModuleRun({ ...reportRequest2, initialSteps: marketThemeFlowInitialSteps(reportRequest2) })).run;
    for (let i = 0; i < 25 && !(await view(pendingReport.id))!.steps.some(s => s.kind === 'report'); i++) await restarted.tick();
    const reportClaim = await f.stores.steps.claimStep({ moduleRunId: pendingReport.id, kinds: ['report'], leaseOwnerId: randomUUID(), leaseMs: 120000 }); assert.ok(reportClaim);
    const reportWork = await createMarketThemeReportStep(f.context)({ claim: reportClaim, signal: new AbortController().signal });
    if (reportWork.kind !== 'settlement' || reportWork.value.outcome.status === 'failed') throw new Error('report fixture');
    await assert.rejects(f.stores.steps.settleAndEnqueue({ claim: reportClaim, outcome: { status: 'succeeded', output: { ...(reportWork.value.outcome.output as object), status: 'complete' } } }));
    await pg.pool.query(`CREATE FUNCTION reject_report_pointer() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${pendingReport.id}' AND NEW.latest_report_attempt_id IS NOT NULL THEN RAISE EXCEPTION 'synthetic report rollback'; END IF; RETURN NEW; END; $$`);
    await pg.pool.query('CREATE TRIGGER reject_report_pointer BEFORE UPDATE ON market_analysis_module_runs FOR EACH ROW EXECUTE FUNCTION reject_report_pointer()');
    try { await assert.rejects(f.stores.steps.settleAndEnqueue({ claim: reportClaim, ...reportWork.value })); }
    finally { await pg.pool.query('DROP TRIGGER reject_report_pointer ON market_analysis_module_runs'); await pg.pool.query('DROP FUNCTION reject_report_pointer()'); }
    const rolledReport = (await view(pendingReport.id))!; assert.equal(rolledReport.run.latestReportAttemptId, null);
    assert.equal(rolledReport.attempts.find(a => a.id === reportClaim.attemptId)!.status, 'running');

    // Retry the failed source while an old report is computed but not committed.
    const reportFailedSource = rolledReport.steps.find(s => s.kind === 'collect-customer-themes' && s.status === 'failed')!;
    themePoolMode = false;
    await f.stores.steps.retryFailedSteps({ actor: f.actor, moduleRunId: pendingReport.id, steps: [{ stepId: reportFailedSource.id, failedAttemptId: reportFailedSource.latestAttemptId! }], idempotencyKey: randomUUID() });
    const fencedReport = await f.stores.steps.settleAndEnqueue({ claim: reportClaim, ...reportWork.value }); assert.equal(fencedReport.status, 'committed');
    assert.equal((await view(pendingReport.id))!.run.latestReportAttemptId, null);
    assert.equal((await f.stores.steps.settleAndEnqueue({ claim: reportClaim, ...reportWork.value })).status, 'already-committed');
    await drain();
    const freshReport = (await reports.read({ actor: f.actor, moduleRunId: pendingReport.id }))!;
    assert.equal(freshReport.history.length, 1); assert.equal(freshReport.currentReport!.report.counts.successfulCount, 2);
    const readSources = sourceCalls, readModels = modelCalls;
    await reports.read({ actor: f.actor, moduleRunId: pendingReport.id });
    assert.equal(sourceCalls, readSources); assert.equal(modelCalls, readModels);

    // The public application service creates the same real native workflow;
    // neither the HTTP handler nor refreshing its saved report executes models.
    const http = Fastify(); t.after(() => http.close()); http.decorateRequest('authPrincipal', null);
    http.addHook('preHandler', async req => { req.authPrincipal = { kind: 'user', ...f.actor, role: 'member', email: 'native@example.test', sessionId: randomUUID() }; });
    registerMarketModuleRoutes(http, new MarketModuleService({ context: f.context,
      modelIdentity: () => ({ configurationVersion: restarted.configurationVersion, promptVersion: restarted.promptVersion }) }));
    themePoolMode = true;
    const httpSourceStart = sourceCalls, httpModelStart = modelCalls;
    const started = await http.inject({ method: 'POST', url: `/v1/market-analysis/studies/${f.scope.researchId}/customer-themes`,
      headers: { 'idempotency-key': randomUUID() }, payload: { memberCount: 3, poolSize: 20, newProductMonths: 6 } });
    assert.equal(started.statusCode, 201, started.body); assert.equal(sourceCalls, httpSourceStart); assert.equal(modelCalls, httpModelStart);
    const httpId = started.json().run.id, httpUrl = `/v1/market-analysis/runs/${httpId}`; await drain();
    const publicResult = await http.inject({ method: 'GET', url: httpUrl }); assert.equal(publicResult.statusCode, 200, publicResult.body);
    const publicRun = MarketThemeRunResponseSchema.parse(publicResult.json()).run;
    assert.equal(publicRun.currentReport!.report.status, 'partial'); assert.equal(publicRun.currentReport!.report.ruleStatus, 'complete'); assert.equal(publicRun.currentReport!.report.semanticStatus, 'skipped'); assert.equal(publicRun.currentReport!.report.counts.unknownCount, 0);
    assert.equal(sourceCalls, httpSourceStart + 4); assert.equal(modelCalls, httpModelStart);
    const retryable = publicRun.steps.find(s => s.canRetry)!; assert.equal(retryable.asin, 'B000000003');
    themePoolMode = false; const commandKey = randomUUID();
    const retryHttp = () => http.inject({ method: 'POST', url: `${httpUrl}/retry`, headers: { 'idempotency-key': commandKey },
      payload: { steps: [{ stepId: retryable.id, failedAttemptId: retryable.latestAttemptId }] } });
    assert.equal((await retryHttp()).statusCode, 200); assert.equal((await retryHttp()).statusCode, 200);
    assert.equal((await http.inject({ method: 'GET', url: httpUrl })).json().run.currentReport, null); await drain();
    const latest = MarketThemeRunResponseSchema.parse((await http.inject({ method: 'GET', url: httpUrl })).json()).run;
    assert.equal(latest.history.length, 2); assert.equal(latest.currentReport!.report.counts.successfulCount, 2); assert.equal(latest.currentReport!.report.ruleStatus, 'complete'); assert.equal(latest.currentReport!.report.semanticStatus, 'skipped'); assert.equal(modelCalls, httpModelStart);
    assert.equal(sourceCalls, httpSourceStart + 5); assert.equal(modelCalls, httpModelStart);
    const detailUrl = (attemptId: string) => `${httpUrl}/reports/${attemptId}/details`;
    const firstDetails = await http.inject({ method: 'GET', url: `${detailUrl(publicRun.currentReport!.attemptId)}?section=groups&limit=1` });
    assert.equal(firstDetails.statusCode, 200, firstDetails.body); assert.equal(firstDetails.json().report.current, false);
    assert.equal(firstDetails.json().page.totals.mention, 2); assert.equal(firstDetails.json().page.items[0].topicShare.denominator, 2);
    const latestDetails = await http.inject({ method: 'GET', url: `${detailUrl(latest.currentReport!.attemptId)}?section=groups&limit=1` });
    assert.equal(latestDetails.statusCode, 200, latestDetails.body); assert.equal(latestDetails.json().page.nextOffset, 1);
    assert.equal(latestDetails.json().page.items[0].topicShare.denominator, 4); assert.equal(latestDetails.json().page.items[0].topicShare.valuePct, 50);
    const page2 = await http.inject({ method: 'GET', url: `${detailUrl(latest.currentReport!.attemptId)}?section=groups&offset=1&limit=1` });
    assert.equal(page2.statusCode, 200); assert.equal(page2.json().page.items[0].topicShare.denominator, 4);
    const evidence = await http.inject({ method: 'GET', url: `${detailUrl(latest.currentReport!.attemptId)}?section=members&groupIndex=0` });
    assert.equal(evidence.statusCode, 200, evidence.body); assert.equal(evidence.json().page.items[0].keyword.text, 'Assembly');
    assert.equal(evidence.json().page.items[0].decision.status, 'unavailable'); assert.equal(evidence.json().page.items[0].content.truncated, false);
    const memberId=evidence.json().page.items[0].sourceThemeId;
    const fullUrl=(attemptId:string,sourceThemeId=memberId)=>`${httpUrl}/reports/${attemptId}/evidence?${new URLSearchParams({sourceThemeId})}`;
    const fullEvidence=await http.inject({method:'GET',url:fullUrl(latest.currentReport!.attemptId)});
    assert.equal(fullEvidence.statusCode,200,fullEvidence.body);assert.equal(fullEvidence.json().evidence.keyword,'Assembly');
    assert.equal(fullEvidence.json().evidence.analysis, null);
    const oldMembers=await http.inject({method:'GET',url:`${detailUrl(publicRun.currentReport!.attemptId)}?section=members`});
    const historical=await http.inject({method:'GET',url:fullUrl(publicRun.currentReport!.attemptId,oldMembers.json().page.items[0].sourceThemeId)});
    assert.equal(historical.statusCode,200,historical.body);assert.equal(historical.json().report.current,false);
    assert.equal(historical.json().evidence.analysis, null);
    assert.equal((await http.inject({method:'GET',url:fullUrl(latest.currentReport!.attemptId,'outside')})).statusCode,404);
    assert.equal((await http.inject({method:'GET',url:fullUrl(publicRun.steps[0].latestAttemptId!)})).statusCode,404);
    assert.equal(await reports.readEvidence({actor:{...f.actor,organizationId:randomUUID()},moduleRunId:httpId,attemptId:latest.currentReport!.attemptId,query:{sourceThemeId:memberId}}),null);
    assert.equal((await http.inject({ method: 'GET', url: `${detailUrl(latest.currentReport!.attemptId)}?section=groups&offset=999` })).statusCode, 400);
    assert.equal((await http.inject({ method: 'GET', url: detailUrl(publicRun.steps[0].latestAttemptId!) })).statusCode, 404);
    assert.equal((await http.inject({ method: 'GET', url: `${httpUrl}/reports/${firstReport.basisAttemptId}/details` })).statusCode, 404);
    assert.equal(await reports.readDetails({ actor: { ...f.actor, organizationId: randomUUID() }, moduleRunId: httpId, attemptId: latest.currentReport!.attemptId, query: {} }), null);
    assert.equal(sourceCalls, httpSourceStart + 5); assert.equal(modelCalls, httpModelStart);
  });
});
