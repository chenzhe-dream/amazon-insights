import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { OpenAIProviderOptions } from '../../server/runtime/openai-provider';
import type { RemoteMcpConnector } from '../../server/connectors/connector-contract';
import { loadVocPositioningRuntimeConfig } from '../../server/config';
import { runPostgresMigrations } from '../../server/db/postgres/migrations';
import { PostgresQueryContext } from '../../server/db/postgres/query-context';
import { PostgresMarketModuleExecutionStore } from '../../server/db/postgres/market-module-execution-store';
import { MarketThemeSelectionStore } from '../../server/db/postgres/market-theme-selection-store';
import { MarketModuleService } from '../../server/services/market-module-service';
import { createMarketModelRuntime } from '../../server/runtime/market-model-runtime';
import { startPostgresTestContainer } from './helpers/postgres-test-container';

const NOW = new Date('2026-09-16T08:00:00.000Z');

test('four market modules compose persisted rules-only flows in isolated PostgreSQL', { timeout: 240_000 }, async t => {
  const pg = await startPostgresTestContainer();
  t.after(() => pg.close());
  await runPostgresMigrations(pg.pool);

  const actor = { organizationId: randomUUID(), userId: randomUUID() };
  await pg.pool.query(
    "INSERT INTO users(id,organization_id,email,display_name,role,status,created_at,updated_at) VALUES($1,$2,$3,'Four module fixture','member','active',clock_timestamp(),clock_timestamp())",
    [actor.userId, actor.organizationId, `${actor.userId}@example.test`],
  );

  const context = new PostgresQueryContext(pg.pool);
  const service = new MarketModuleService({ context, modelIdentity: () => null, now: () => NOW });
  const study = await service.createStudy(actor, {
    marketplace: 'US', currency: 'USD', nodeIdPath: '12:34', fromMonth: '2026-07', toMonth: '2026-08',
  }, randomUUID());

  const overview = await service.startOverview(actor, study.study.id, { headTopN: 10, newProductMonths: 6 }, randomUUID());
  const shapes = await service.startShapes(actor, study.study.id, {
    poolSize: 3, newProductMonths: 6,
    catalog: { task: 'market-product-shape-suggestion', taxonomyVersion: 'fixture/v1', allowedLabels: [] },
  }, randomUUID());
  const keywords = await service.startKeywords(actor, study.study.id, {
    plannedPages: [{ seed: 'shelf lamp', page: 1 }], maxMembers: 10,
    catalog: { task: 'market-keyword-semantics', dictionaryVersion: 'fixture/v1', categoryContext: 'shelf lamps', dimensionLabels: { W1: [], W2: [], W3: [], W4: [] }, clusterCatalog: [] },
  }, randomUUID());
  const themes = await service.startThemes(actor, study.study.id, { memberCount: 1, poolSize: 1, newProductMonths: 6 }, randomUUID());

  const store = new PostgresMarketModuleExecutionStore(context);
  const started = [overview.run.id, shapes.run.id, keywords.run.id, themes.run.id];
  const expected = new Map([
    [overview.run.id, 'market-overview-flow/rules-v4'],
    [shapes.run.id, 'market-shape-price-flow/rules-v4'],
    [keywords.run.id, 'market-keyword-flow/rules-v1'],
    [themes.run.id, 'market-theme-flow/rules-v3'],
  ]);
  for (const id of started) {
    const view = await store.findModuleRun({ actor, moduleRunId: id });
    assert.ok(view);
    assert.equal((view.run.params as { flow: string }).flow, expected.get(id));
    assert.equal(view.run.versions.model, null);
    assert.equal(view.run.versions.prompt, null);
    assert.equal(view.run.versions.configuration, null);
    assert.ok(view.steps.length > 0);
  }

  let sourceCalls = 0;
  let modelCalls = 0;
  const connector: RemoteMcpConnector = {
    id: 'sellerSprite',
    probe: async () => { throw new Error('probe is not used by the fixture'); },
    execute: async request => {
      sourceCalls++;
      const input = ((request.input as Record<string, unknown>).request ?? request.input) as Record<string, unknown>;
      const month = String(input.month ?? '2026-08');
      const data = request.operation === 'category_products' ? [{asin:'B000000001',title:'Synthetic shelf lamp',sub_category:[['Floor Lamps','34',1]],main_image:['https://m.media-amazon.com/images/I/lamp-1.jpg']}] : request.operation === 'category_report' ? {category_stats_report:{node_id:'34',top100_monthly_sales_volume:'200'},top100_products:[{asin:'B000000001',title:'Synthetic shelf lamp',category_rank:'Category: Floor Lamps, Rank: 1',main_image:'https://m.media-amazon.com/images/I/lamp-1.jpg'}]} : request.operation === 'product_detail' ? {asin:String(input.asin),main_image:['https://m.media-amazon.com/images/I/lamp-1.jpg']} : request.operation === 'category_trend' ? ['2026-06=10','2026-07=0','2026-08=20'] : request.operation === 'product_trend' ? ['2026-06=10','2026-07=0','2026-08=20'] : request.operation === 'market_product_concentration'
        ? Array.from({length:100},(_,index)=>({asin:`B${String(index+1).padStart(9,'0')}`,title:'Synthetic shelf lamp',totalUnits:20+index,totalRevenue:400+index,price:20,ranking:index+1}))
        : request.operation === 'market_research'
          ? { items: [{ marketplace: 'US', currency: 'USD', nodeIdPath: '12:34', month, topProducts: 1, products: 1, totalUnits: 20, totalRevenue: 400 }] }
          : request.operation === 'market_research_statistics'
            ? { marketplace: 'US', currency: 'USD', nodeIdPath: '12:34', month, topProducts: 1, products: 1, totalUnits: 20, totalRevenue: 400 }
            : request.operation === 'keyword_extends'
              ? [{ keyword: 'shelf lamp' }, { keyword: 'corner shelf lamp' }]
              : request.operation === 'keyword_trend'
                ? { keyword: String(input.keyword ?? 'shelf lamp'), search_volume_trend: ['2026-08 search volume 20'], search_rank_trend: [], recommended_bid_trend: [] }
                : { details: [{ keyword: 'easy assembly', content: 'Easy assembly', mention: 2, positive: 2, negative: 0, update_time: '2026-08-01' }] };
      const connectorId = request.operation.startsWith('category_') || request.operation === 'product_detail' || request.operation === 'product_trend' || request.operation === 'keyword_extends' || request.operation === 'keyword_trend' || request.operation === 'product_customers_say' ? 'sorftime' : 'sellerSprite';
      return { data: { code: 'OK', marketplace: 'US', currency: 'USD', nodeIdPath: '12:34', month, data }, source: { connectorId, operation: request.operation, fetchedAt: NOW.toISOString(), attemptCount: 1 } };
    },
  };
  const base = loadVocPositioningRuntimeConfig({
    OPENAI_API_KEY: 'synthetic-key', AGENT_VOC_MODEL: 'gpt-5.6', AGENT_VOC_ESTIMATED_INPUT_TOKENS: '12000',
    AGENT_VOC_MAX_OUTPUT_TOKENS: '4000', AGENT_VOC_TIMEOUT_MS: '60000', AGENT_VOC_INPUT_USD_PER_MILLION_TOKENS: '1',
    AGENT_VOC_OUTPUT_USD_PER_MILLION_TOKENS: '2', AGENT_VOC_CALL_MAX_TOKENS: '1000000', AGENT_VOC_CALL_MAX_COST_MICROS: '10000000',
    AGENT_VOC_RUN_MAX_TOKENS: '1000000', AGENT_VOC_RUN_MAX_COST_MICROS: '10000000', AGENT_VOC_DAILY_MAX_TOKENS: '1000000',
    AGENT_VOC_DAILY_MAX_COST_MICROS: '10000000', AGENT_VOC_WORKER_OWNER_ID: 'synthetic-four-module-worker',
  });
  const client = { responses: { create: async () => { modelCalls++; throw new Error('rules-only flow must not call the model'); } } } as unknown as OpenAIProviderOptions['client'];
  const runtime = await createMarketModelRuntime(context, base, { client, connectors: { sellerSprite: connector, sorftime: { ...connector, id: 'sorftime' } } });
  t.after(() => runtime.stop());

  let progressed = true;
  for (let tick = 0; tick < 240 && progressed; tick++) progressed = await runtime.tick();

  assert.ok(sourceCalls > 0);
  assert.equal(modelCalls, 0);
  for (const id of started) {
    const view = await store.findModuleRun({ actor, moduleRunId: id });
    assert.ok(view);
    assert.equal(view.steps.some(step => ['queued', 'running'].includes(step.status)), false, JSON.stringify({ steps: view.steps.map(step => ({ kind: step.kind, status: step.status })), attempts: view.attempts.map(attempt => ({ status: attempt.status, error: attempt.error })) }));
    assert.equal(view.steps.some(step => step.kind === 'model-batch' || step.kind === 'prepare-model-batches'), false);
    // Sorftime shape v4 saves its complete selected input; its reader derives the rules from that frozen pool.
    if(id===shapes.run.id){
      const selected=view.steps.find(step=>step.kind==='prepare-members'&&step.status==='succeeded');assert.ok(selected);
      const attempt=view.attempts.find(attempt=>attempt.id===selected.latestAttemptId);assert.ok(attempt?.output&&typeof attempt.output==='object'&&'selectionInputSnapshotId' in attempt.output);
      assert.equal(view.steps.some(step=>step.status==='failed'),false);
    }else assert.ok(view.attempts.some(attempt => attempt.status === 'succeeded' && attempt.output && typeof attempt.output === 'object' && 'ruleBaseline' in attempt.output), `${id} did not persist a rule baseline`);
  }
  const overviewReport=await service.findOverview(actor,overview.run.id);
  assert.ok(overviewReport.run.currentReport);
  const overviewDetails=await service.overviewDetails(actor,overview.run.id,overviewReport.run.currentReport.attemptId);
  assert.equal(overviewDetails.numbers.distributions?.filter(row=>row.operation==='market_product_concentration').length,2);
  const latestProducts=overviewDetails.numbers.distributions?.find(row=>row.operation==='market_product_concentration'&&row.month==='2026-08');
  assert.equal(latestProducts?.distribution?.rows.length,100);
  assert.equal(overviewDetails.numbers.distributions?.find(row=>row.operation==='market_product_concentration'&&row.month==='2026-07')?.status,'not-collected');
  assert.ok(Buffer.byteLength(JSON.stringify(overviewDetails))<8*1_048_576);
  const themeRun = await service.findRun(actor, themes.run.id);
  assert.equal(themeRun.run.status, 'succeeded');
  assert.ok(themeRun.run.currentReport, 'the rules-only theme run publishes a current report');
  assert.equal(themeRun.run.currentReport.report.reportVersion, 'market-theme-report/v3');
  assert.equal(themeRun.run.currentReport.report.semanticStatus, 'skipped');
  assert.equal(themeRun.run.currentReport.report.ruleStatus, 'complete');
  assert.equal(themeRun.run.currentReport.report.status, 'complete');
  assert.equal(themeRun.run.currentReport.report.reasons.includes('model-results-missing'), false);
  const themeDetails = await service.details(actor, themes.run.id, themeRun.run.currentReport.attemptId, { section: 'groups', offset: 0, limit: 20 });
  assert.ok(themeDetails.page.items.some(item => item.kind === 'group' && item.labelZh === '安装便捷' && item.labelOrigin === 'local-rule'));
  const selectionStore = new MarketThemeSelectionStore(context);
  const identity = { actor, moduleRunId: themes.run.id, attemptId: themeRun.run.currentReport.attemptId };
  const selection = await selectionStore.read(identity);
  assert.ok(selection);
  assert.equal(selection.baseline.status, 'complete');
  const callsBeforeRevision = sourceCalls;
  const revision = await selectionStore.save({ ...identity, request: { baseReportHash: themeRun.run.currentReport.report.reportHash, expectedParentRevisionId: null, excludedAsins: [selection.baseline.selectedAsins[0]] }, idempotencyKey: randomUUID() });
  assert.equal(revision.view.revision?.result.status, 'no-data');
  assert.equal(sourceCalls, callsBeforeRevision);
  assert.equal(modelCalls, 0);
});
