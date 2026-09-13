import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { selectMarketThemeMembers, assembleMarketThemePool } from '../../server/domain/market-research/customer-theme-source-pool';
import { collectMarketProductPool } from '../../server/services/market-product-pool-collector';
import { collectMarketCustomerThemes } from '../../server/services/market-customer-themes-collector';
import { createMarketInputSnapshot } from '../../server/domain/market-research/snapshot';
import { MARKET_SOURCE_HANDLER_VERSION } from '../../shared/market-source-contracts';
import { canonicalJsonSha256 as digest } from '../../server/runtime/model-request-accounting';
import type { MarketAnalysisScope } from '../../shared/market-analysis-contracts';
import { planMarketSemanticBatches } from '../../server/domain/market-research/semantic-batch-plan';

const scope: MarketAnalysisScope = { organizationId: randomUUID(), researchId: randomUUID(), marketplace: 'US', nodeIdPath: '12:34', fromMonth: '2026-07', toMonth: '2026-08', currency: 'USD' };
const at = '2026-09-01T00:00:00.000Z', asin = (i: number) => `B${String(i).padStart(9, '0')}`;
const catalog = { task: 'market-customer-theme-mapping' as const, mappingVersion: 'mapping/v1', groupCatalog: [] };
async function products(count = 22) {
  const result = await collectMarketProductPool({ scope, month: '2026-08', poolSize: 100, newProductMonths: 6, jobId: 'synthetic',
    connector: { id: 'sellerSprite', probe: async () => { throw new Error('unused'); }, execute: async r => ({ data: { code: 'OK', data: Array.from({ length: count }, (_, i) => ({ asin: asin(count - i), title: null, ranking: i + 300 })) }, source: { connectorId: 'sellerSprite', operation: r.operation, fetchedAt: at, attemptCount: 1 } }) } });
  assert.ok(result.evidence); const ref = `market-source:${digest(result.evidence)}`;
  const snapshot = createMarketInputSnapshot({ scope, kind: 'products', sourceVersion: MARKET_SOURCE_HANDLER_VERSION, ruleVersion: 'source-normalization/v1', collectedAt: at,
    expectedRecordIds: result.products.map(p => p.asin), records: result.products.map(product => ({ id: product.asin, scope, data: { collection: 'product-month', month: '2026-08', sourceRef: ref, product } })) });
  return { snapshot, sources: { [ref]: result.evidence } };
}
async function theme(id: string, empty = false, mention = 2) {
  const result = await collectMarketCustomerThemes({ scope, asin: id, jobId: 'synthetic', connector: { id: 'sorftime', probe: async () => { throw new Error('unused'); },
    execute: async r => ({ data: { data: { details: empty ? [] : [{ keyword: 'Assembly', content: 'Easy assembly', mention, positive: mention, negative: 0, update_time: '2026-08-01' }] } }, source: { connectorId: 'sorftime', operation: r.operation, fetchedAt: at, attemptCount: 1 } }) } });
  assert.ok(result.evidence); const sourceRef = `market-source:${digest(result.evidence)}`;
  const snapshot = createMarketInputSnapshot({ scope, kind: 'customer-themes', sourceVersion: MARKET_SOURCE_HANDLER_VERSION, ruleVersion: 'source-normalization/v1', collectedAt: at,
    expectedRecordIds: [id], records: [{ id, scope, data: { sourceRef, collection: 'customer-themes', result: result.result } }] });
  return { snapshot, sourceRef, source: result.evidence };
}
test('fixed first 20 follow original source order, not ASIN sort or an invented BSR claim', async () => {
  const f = await products(), selected = selectMarketThemeMembers({ ...f, count: 20 });
  assert.equal(selected.manifest.selectedAsins.length, 20); assert.equal(selected.manifest.selectedAsins[0], asin(22));
  assert.equal(selected.manifest.selectedAsins.at(-1), asin(3)); assert.equal(selected.manifest.bsrTopVerified, false);
  assert.equal(selected.manifest.selectionBasis, 'provider-row-order'); assert.equal(selected.snapshot.records.length, 20);
  assert.equal(selected.manifest.omittedAsins.length, 2);
});
test('17/20 keeps empty, failed and missing separate; repeated payloads never become unique review counts', async () => {
  const selected = selectMarketThemeMembers({ ...await products(20), count: 20 }), ids = selected.manifest.selectedAsins;
  const observations = []; for (const id of ids.slice(0, 17)) observations.push(await theme(id)); observations.push(await theme(ids[17], true));
  const sources = Object.fromEntries(observations.map(p => [p.sourceRef, p.source]));
  const input = { selection: selected.snapshot, selectedAsins: ids, catalog, dataCutoffAt: at, observations, sources, failures: [{ asin: ids[18], attemptId: randomUUID(), code: 'timeout' }] };
  const a = assembleMarketThemePool(input), b = assembleMarketThemePool({ ...input, observations: [...observations].reverse() });
  assert.deepEqual(a, b); assert.equal(a.aggregation.coverage.selectedAsinCount, 20); assert.equal(a.aggregation.coverage.successfulAsinCount, 17);
  assert.equal(a.aggregation.coverage.emptyAsinCount, 1); assert.equal(a.aggregation.coverage.failedAsinCount, 1); assert.equal(a.aggregation.coverage.missingAsinCount, 1);
  assert.equal(a.aggregation.totals!.mention, 34); assert.equal(a.semanticSnapshot.records.length, 17);
  assert.equal(a.manifest.reviewDeduplication, 'unavailable'); assert.equal(a.manifest.sharedPayloadGroups[0].asins.length, 17);
  assert.ok(a.aggregation.groups.every(g => g.topicShare.denominator === 34 && g.topicShare.metricKind === 'customers_say_topic_share'));
  const plan = await planMarketSemanticBatches({ task: catalog.task, moduleRunId: randomUUID(), snapshot: a.semanticSnapshot, sources, selectionRevision: 'selection/v1', configurationVersion: 'configuration/v1', dataCutoffAt: at }, async () => true);
  assert.equal(plan.expectedMemberIds.length, 17); assert.equal(plan.batches.length, 2);
});
test('zero mentions stay known zero; empty or absent observations do not produce zero totals', async () => {
  const selected = selectMarketThemeMembers({ ...await products(1), count: 20 }), ids = selected.manifest.selectedAsins;
  const zero = await theme(ids[0], false, 0), empty = await theme(ids[0], true);
  const options = { selection: selected.snapshot, selectedAsins: ids, catalog, dataCutoffAt: at, failures: [] };
  assert.equal(assembleMarketThemePool({ ...options, observations: [zero], sources: { [zero.sourceRef]: zero.source } }).aggregation.totals!.mention, 0);
  assert.equal(assembleMarketThemePool({ ...options, observations: [empty], sources: { [empty.sourceRef]: empty.source } }).aggregation.totals, null);
  assert.equal(assembleMarketThemePool({ ...options, observations: [], sources: {} }).aggregation.totals, null);
});
test('duplicate responses, foreign ASINs, forged counts and contradictory failure receipts reject', async () => {
  const selected = selectMarketThemeMembers({ ...await products(1), count: 20 }), observation = await theme(asin(1)), foreign = await theme(asin(2));
  const input = { selection: selected.snapshot, selectedAsins: selected.manifest.selectedAsins, catalog, dataCutoffAt: at, observations: [observation], sources: { [observation.sourceRef]: observation.source, [foreign.sourceRef]: foreign.source }, failures: [] };
  assert.throws(() => assembleMarketThemePool({ ...input, observations: [observation, observation] }));
  assert.throws(() => assembleMarketThemePool({ ...input, observations: [foreign] }));
  assert.throws(() => assembleMarketThemePool({ ...input, failures: [{ asin: asin(1), attemptId: randomUUID(), code: 'timeout' }] }));
  const rows = JSON.parse(JSON.stringify(observation.snapshot.records)); rows[0].data.result.themes[0].mention = 999;
  const snapshot = createMarketInputSnapshot({ scope, kind: 'customer-themes', sourceVersion: MARKET_SOURCE_HANDLER_VERSION, ruleVersion: 'source-normalization/v1', collectedAt: at, expectedRecordIds: [asin(1)], records: rows });
  assert.throws(() => assembleMarketThemePool({ ...input, observations: [{ ...observation, snapshot }] }));
});
test('complete 20-ASIN observation retains every member; caller cannot reorder the fixed pool', async () => {
  const selection = selectMarketThemeMembers({ ...await products(20), count: 20 });
  const observations = []; for (const id of selection.manifest.selectedAsins) observations.push(await theme(id));
  const input = { selection: selection.snapshot, selectedAsins: selection.manifest.selectedAsins, catalog, dataCutoffAt: at, observations,
    sources: Object.fromEntries(observations.map(o => [o.sourceRef, o.source])), failures: [] };
  const pool = assembleMarketThemePool(input);
  assert.equal(pool.aggregation.coverage.status, 'complete'); assert.equal(pool.aggregation.coverage.successfulAsinCount, 20);
  assert.equal(pool.aggregation.totals!.mention, 40); assert.equal(pool.semanticSnapshot.records.length, 20);
  assert.throws(() => assembleMarketThemePool({ ...input, selectedAsins: [...input.selectedAsins].reverse() }));
});
test('an empty anchor pool creates no fabricated ASIN or verified ranking', async () => {
  const selection = selectMarketThemeMembers({ ...await products(0), count: 20 });
  assert.deepEqual(selection.snapshot.records, []); assert.deepEqual(selection.manifest.selectedAsins, []);
  assert.equal(selection.manifest.requestedCountMet, false); assert.equal(selection.manifest.bsrTopVerified, false);
});
