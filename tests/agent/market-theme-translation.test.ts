import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { collectMarketProductPool } from '../../server/services/market-product-pool-collector';
import { collectMarketCustomerThemes } from '../../server/services/market-customer-themes-collector';
import { selectMarketThemeMembers } from '../../server/domain/market-research/customer-theme-source-pool';
import { calculateMarketThemeMappingRules } from '../../server/domain/market-research/customer-theme-mapping-rules';
import { createMarketInputSnapshot } from '../../server/domain/market-research/snapshot';
import { MarketInputRecordSchema } from '../../shared/market-analysis-contracts';
import { MARKET_SOURCE_HANDLER_VERSION } from '../../shared/market-source-contracts';
import { canonicalJsonSha256 as digest } from '../../server/runtime/model-request-accounting';
import { MarketThemeTranslationService } from '../../server/services/market-theme-translation';
import type { MarketExecutionActor } from '../../server/db/market-module-execution-repository';

const at = '2026-09-01T00:00:00.000Z';
const asin = 'B000000001';

async function fixture() {
  const scope = { organizationId: randomUUID(), researchId: randomUUID(), marketplace: 'US' as const, nodeIdPath: '12:34', fromMonth: '2026-07', toMonth: '2026-08', currency: 'USD' as const };
  const pool = await collectMarketProductPool({ scope, month: '2026-08', poolSize: 1, newProductMonths: 6, jobId: 'translation-test', connector: {
    id: 'sellerSprite', probe: async () => { throw Error('unused'); }, execute: async request => ({ data: { code: 'OK', data: [{ asin, title: 'Test product' }] }, source: { connectorId: 'sellerSprite', operation: request.operation, fetchedAt: at, attemptCount: 1 } }),
  } });
  assert.ok(pool.evidence);
  const productRef = `market-source:${digest(pool.evidence)}`;
  const products = createMarketInputSnapshot({ scope, kind: 'products', sourceVersion: MARKET_SOURCE_HANDLER_VERSION, ruleVersion: 'source-normalization/v1', collectedAt: at, expectedRecordIds: [asin], records: pool.products.map(product => ({ id: product.asin, scope, data: { collection: 'product-month', month: '2026-08', product, sourceRef: productRef } })) });
  const selection = selectMarketThemeMembers({ snapshot: products, sources: { [productRef]: pool.evidence }, count: 1 });
  const theme = await collectMarketCustomerThemes({ scope, asin, jobId: 'translation-test', connector: {
    id: 'sorftime', probe: async () => { throw Error('unused'); }, execute: async request => ({ data: { data: { details: [{ keyword: 'Brightness', content: 'Not bright for 2 hours', mention: 2, positive: 0, negative: 2, update_time: '2026-08-01' }] } }, source: { connectorId: 'sorftime', operation: request.operation, fetchedAt: at, attemptCount: 1 } }),
  } });
  assert.ok(theme.evidence);
  const themeRef = `market-source:${digest(theme.evidence)}`;
  const observation = createMarketInputSnapshot({ scope, kind: 'customer-themes', sourceVersion: MARKET_SOURCE_HANDLER_VERSION, ruleVersion: 'source-normalization/v1', collectedAt: at, expectedRecordIds: [asin], records: [{ id: asin, scope, data: { collection: 'customer-themes', result: theme.result, sourceRef: themeRef } }] });
  const rules = calculateMarketThemeMappingRules({
    poolInput: { selection: selection.snapshot, selectedAsins: [asin], catalog: { task: 'market-customer-theme-mapping', mappingVersion: 'mapping/v1', groupCatalog: [] }, dataCutoffAt: at, observations: [{ snapshot: observation, sourceRef: themeRef }], sources: { [productRef]: pool.evidence, [themeRef]: theme.evidence }, failures: [] },
    batches: [], originalRules: true,
  });
  const { aggregation: { groups: aggregateGroups, perAsin, mappings, ...aggregation }, groups: labels, decisions, ...summary } = rules;
  const chunks = (kind: string, items: unknown[], size: number) => Array.from({ length: Math.ceil(items.length / size) }, (_, index) => ({ id: `${kind}:${index}`, data: { kind, items: items.slice(index * size, (index + 1) * size) } }));
  const records = [{ id: 'summary', data: { ...summary, artifactLayout: 'theme-rules-chunks/v1', aggregation } }, ...perAsin.map(item => ({ id: `asin:${item.asin}`, data: item })), ...chunks('groups', aggregateGroups, 32), ...chunks('mappings', mappings, 128), ...chunks('labels', labels, 128), ...chunks('decisions', decisions, 128)].map(record => ({ ...record, scope, data: MarketInputRecordSchema.shape.data.parse(record.data) }));
  const snapshot = createMarketInputSnapshot({ scope, kind: 'customer-themes', sourceVersion: MARKET_SOURCE_HANDLER_VERSION, ruleVersion: `market-theme-mapping-rules/v1:${rules.resultHash}`, collectedAt: at, expectedRecordIds: records.map(record => record.id), records });
  const moduleRunId = randomUUID(), attemptId = randomUUID(), reportHash = 'a'.repeat(64);
  const entry = { attemptId, current: true, report: { reportVersion: 'market-theme-report/v3' as const, moduleRunId, scope, versions: { source: 'source/v1', rule: 'market-theme-flow/rules-v3', mapping: 'mapping/v1', planner: 'market-theme-flow/rules-v3', model: null, prompt: null, configuration: null }, basis: 'rules' as const, basisAttemptId: attemptId, inputSnapshotId: snapshot.snapshotId, resultHash: rules.resultHash, dataCutoffAt: at, categoryName: '测试类目', selectedAsins: [asin], selectionBasis: 'provider-row-order' as const, bsrTopVerified: false as const, metricKind: 'customers_say_topic_share' as const, reviewDeduplication: 'unavailable' as const, status: 'complete' as const, dataReady: true, semanticsReady: true, counts: { requestedCount: 1, selectedCount: 1, successfulCount: 1, emptyCount: 0, failedCount: 0, missingCount: 0, expectedMemberCount: 1, validatedMemberCount: 1, mappedMemberCount: 1, unknownCount: 0, unavailableCount: 0, reconciliationRequired: false }, reasons: [], reportHash, ruleStatus: 'complete' as const, semanticStatus: 'skipped' as const } };
  return { scope, moduleRunId, attemptId, entry, snapshot, actor: { organizationId: scope.organizationId, userId: randomUUID() } as MarketExecutionActor };
}

test('translation reads are free, failed text is retried alone, and ready text is reused', async () => {
  const f = await fixture();
  const root = mkdtempSync(join(process.env.TEMP ?? '.', 'market-theme-translation-'));
  try {
    let calls = 0, failContent = true;
    const service = new MarketThemeTranslationService({
      root, modelIdentity: 'test-model/v1',
      resolveReport: { resolveReport: async () => ({ entry: f.entry, snapshot: f.snapshot, view: {}, priorEvaluations: [] }) } as never,
      readSelection: async () => ({ samples: [{ asin, customerSay: { value: 'Customers find brightness low for 2 hours' } }] }),
      translate: async source => { calls += 1; if (source.item.field === 'member-content' && failContent) { failContent = false; throw new Error('provider timeout'); } return source.item.original.includes('2') ? '中文摘要 2 小时' : '中文翻译'; },
    });
    const initial = await service.read(f.actor, f.moduleRunId, f.attemptId, { reportHash: f.entry.report.reportHash });
    assert.ok(initial); assert.equal(calls, 0); assert.ok(initial.items.every(item => item.state === 'missing'));
    const started = await service.start(f.actor, f.moduleRunId, f.attemptId, { reportHash: f.entry.report.reportHash });
    assert.ok(started); await service.drain();
    const afterFailure = await service.read(f.actor, f.moduleRunId, f.attemptId, { reportHash: f.entry.report.reportHash });
    assert.ok(afterFailure); const failed = afterFailure.items.filter(item => item.state === 'failed'); const ready = afterFailure.items.filter(item => item.state === 'ready');
    assert.equal(failed.length, 1); assert.ok(ready.length >= 1); const callsAfterFirstRun = calls;
    const retried = await service.start(f.actor, f.moduleRunId, f.attemptId, { reportHash: f.entry.report.reportHash, itemIds: failed.map(item => item.itemId) });
    assert.ok(retried); await service.drain();
    const final = await service.read(f.actor, f.moduleRunId, f.attemptId, { reportHash: f.entry.report.reportHash });
    assert.ok(final); assert.equal(final.items.filter(item => item.state === 'failed').length, 0); assert.equal(calls, callsAfterFirstRun + 1); assert.equal(final.items.filter(item => item.state === 'ready').length, afterFailure.items.filter(item => item.state === 'ready').length + 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
