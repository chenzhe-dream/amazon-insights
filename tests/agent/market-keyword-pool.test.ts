import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { assembleMarketKeywordPool } from '../../server/domain/market-research/keyword-source-pool';
import { createMarketInputSnapshot } from '../../server/domain/market-research/snapshot';
import { collectMarketKeywordPage } from '../../server/services/market-keyword-collector';
import { MARKET_SOURCE_HANDLER_VERSION } from '../../shared/market-source-contracts';
import { canonicalJsonSha256 as digest } from '../../server/runtime/model-request-accounting';
import type { MarketAnalysisScope } from '../../shared/market-analysis-contracts';
import type { MarketProjectionCatalog } from '../../server/domain/market-research/source-semantic-projection';
import { planMarketSemanticBatches } from '../../server/domain/market-research/semantic-batch-plan';

const scope: MarketAnalysisScope = { organizationId: randomUUID(), researchId: randomUUID(), marketplace: 'US', nodeIdPath: '12:34', fromMonth: '2026-07', toMonth: '2026-08', currency: 'USD' };
const at = '2026-09-01T00:00:00.000Z';
const catalog: Extract<MarketProjectionCatalog, { task: 'market-keyword-semantics' }> = { task: 'market-keyword-semantics', dictionaryVersion: 'dictionary/v1', categoryContext: 'Synthetic floor lamps', dimensionLabels: { W1: [], W2: [], W3: [], W4: [] }, clusterCatalog: [] };
async function page(page: number, keywords: { keyword: string; monthly_search_volume?: number }[], seed = 'lamp') {
  const result = await collectMarketKeywordPage({ scope, seed, page, jobId: 'synthetic', connector: { id: 'sorftime', probe: async () => { throw new Error('unused'); }, execute: async r => ({ data: { data: keywords }, source: { connectorId: 'sorftime', operation: r.operation, fetchedAt: at, attemptCount: 1 } }) } });
  assert.notEqual(result.status, 'failed'); if (result.status === 'failed') throw new Error('Invalid fixture');
  const ref = `market-source:${digest(result.evidence)}`;
  const snapshot = createMarketInputSnapshot({ scope, kind: 'keywords', sourceVersion: MARKET_SOURCE_HANDLER_VERSION, ruleVersion: 'source-normalization/v1', collectedAt: at,
    expectedRecordIds: result.members.map(m => m.id), records: result.members.map(member => ({ id: member.id, scope, data: { collection: 'keyword-page', member, sourceRef: ref } })) });
  return { snapshot, sourceRef: ref, source: result.evidence };
}
test('page order cannot alter deduplication, selected metrics, provenance or immutable pool identity', async () => {
  const first = await page(1, [{ keyword: 'shelf lamp', monthly_search_volume: 0 }, { keyword: 'reading lamp', monthly_search_volume: 20 }]);
  const second = await page(2, [{ keyword: 'shelf lamp', monthly_search_volume: 30 }, { keyword: 'corner lamp' }]);
  const input = { scope, catalog, dataCutoffAt: at, plannedPages: [{ seed: 'lamp', page: 1 }, { seed: 'lamp', page: 2 }], maxMembers: 20,
    pages: [first, second], sources: { [first.sourceRef]: first.source, [second.sourceRef]: second.source } };
  const a = assembleMarketKeywordPool(input), b = assembleMarketKeywordPool({ ...input, pages: [second, first], plannedPages: [...input.plannedPages].reverse() });
  assert.deepEqual(a, b); assert.equal(a.rawSnapshot.records.length, 3); assert.equal(a.manifest.duplicateMemberCount, 1);
  const record = a.rawSnapshot.records.find(r => (r.data as any).member.keyword === 'shelf lamp')!;
  assert.equal((record.data as any).member.monthlySearchVolume.value, 0);
  assert.equal((record.data as any).occurrences.length, 2); assert.deepEqual(a.manifest.conflictingMemberIds, [record.id]);
  const plan = await planMarketSemanticBatches({ task: catalog.task, moduleRunId: randomUUID(), snapshot: a.semanticSnapshot, sources: input.sources, selectionRevision: 'selection/v1', configurationVersion: 'model/v1', dataCutoffAt: at }, async () => true);
  assert.equal(plan.expectedMemberIds.length, 3); assert.equal(plan.batches.length, 1);
});
test('missing pages, observed empty pages and full pages retain different sampling states', async () => {
  const full = await page(1, Array.from({ length: 20 }, (_, i) => ({ keyword: `lamp ${i}` })));
  const empty = await page(2, []);
  const pool = assembleMarketKeywordPool({ scope, catalog, dataCutoffAt: at, maxMembers: 30, plannedPages: [1, 2, 3].map(page => ({ seed: 'lamp', page })), pages: [full, empty], sources: { [full.sourceRef]: full.source, [empty.sourceRef]: empty.source } });
  assert.equal(pool.manifest.exhaustive, false); assert.deepEqual(pool.manifest.missingPages, [{ seed: 'lamp', page: 3 }]);
  assert.deepEqual(pool.manifest.emptyPages, [{ seed: 'lamp', page: 2 }]); assert.deepEqual(pool.manifest.fullPages, [{ seed: 'lamp', page: 1 }]);
  assert.equal(pool.manifest.collectionCoverage, 'partial'); assert.equal(pool.manifest.sourceRefs.length, 2);
});
test('member limit is deterministic and omissions are explicit instead of counted as source failure', async () => {
  const p = await page(1, [{ keyword: 'z lamp' }, { keyword: 'a lamp' }, { keyword: 'm lamp' }]);
  const pool = assembleMarketKeywordPool({ scope, catalog, dataCutoffAt: at, maxMembers: 2, plannedPages: [{ seed: 'lamp', page: 1 }], pages: [p], sources: { [p.sourceRef]: p.source } });
  assert.deepEqual(pool.manifest.selectedKeywords, ['z lamp', 'a lamp']); assert.equal(pool.manifest.omittedMemberIds.length, 1);
  assert.equal(pool.rawSnapshot.coverage.status, 'complete'); assert.equal(pool.manifest.memberLimitReached, true);
});
test('empty pools remain versioned and retain planned gaps', () => {
  const input = { scope, catalog, dataCutoffAt: at, maxMembers: 20, plannedPages: [{ seed: 'lamp', page: 1 }], pages: [], sources: {} };
  const a = assembleMarketKeywordPool(input), b = assembleMarketKeywordPool({ ...input, plannedPages: [{ seed: 'lamp', page: 2 }] });
  assert.notEqual(a.rawSnapshot.snapshotId, b.rawSnapshot.snapshotId); assert.equal(a.manifest.collectionCoverage, 'none');
  assert.equal(a.semanticSnapshot.coverage.status, 'empty'); assert.equal(a.manifest.missingPages.length, 1);
});
test('unplanned pages, mismatched source receipt, duplicate queries and post-cutoff evidence reject', async () => {
  const p = await page(1, [{ keyword: 'lamp' }]), other = await page(2, []);
  const input = { scope, catalog, dataCutoffAt: at, maxMembers: 20, plannedPages: [{ seed: 'lamp', page: 1 }], pages: [p], sources: { [p.sourceRef]: p.source, [other.sourceRef]: other.source } };
  assert.throws(() => assembleMarketKeywordPool({ ...input, pages: [other] }));
  assert.throws(() => assembleMarketKeywordPool({ ...input, pages: [{ ...p, sourceRef: other.sourceRef }] }));
  assert.throws(() => assembleMarketKeywordPool({ ...input, pages: [p, p] }));
  assert.throws(() => assembleMarketKeywordPool({ ...input, plannedPages: [...input.plannedPages, ...input.plannedPages] }));
  assert.throws(() => assembleMarketKeywordPool({ ...input, dataCutoffAt: '2026-08-31T00:00:00.000Z' }));
});
test('changed normalized numbers cannot replace source observations even with a valid input hash', async () => {
  const p = await page(1, [{ keyword: 'lamp', monthly_search_volume: 0 }]);
  const records = JSON.parse(JSON.stringify(p.snapshot.records)); records[0].data.member.monthlySearchVolume.value = 999;
  const snapshot = createMarketInputSnapshot({ scope, kind: p.snapshot.kind, sourceVersion: p.snapshot.sourceVersion, ruleVersion: p.snapshot.ruleVersion,
    collectedAt: at, expectedRecordIds: p.snapshot.expectedRecordIds, records });
  assert.throws(() => assembleMarketKeywordPool({ scope, catalog, dataCutoffAt: at, maxMembers: 20, plannedPages: [{ seed: 'lamp', page: 1 }], pages: [{ ...p, snapshot }], sources: { [p.sourceRef]: p.source } }));
});
test('the full 100-page 2000-member contract preserves all members without implicit truncation', { timeout: 30000 }, async () => {
  const pages = [];
  for (let n = 1; n <= 100; n++) pages.push(await page(n, Array.from({ length: 20 }, (_, i) => ({ keyword: `lamp ${n}-${i}`, monthly_search_volume: i }))));
  const pool = assembleMarketKeywordPool({ scope, catalog, dataCutoffAt: at, maxMembers: 2000, plannedPages: pages.map((_, i) => ({ seed: 'lamp', page: i + 1 })),
    pages, sources: Object.fromEntries(pages.map(p => [p.sourceRef, p.source])) });
  assert.equal(pool.rawSnapshot.records.length, 2000); assert.equal(pool.semanticSnapshot.records.length, 2000);
  assert.equal(pool.manifest.omittedMemberIds.length, 0); assert.equal(pool.manifest.fullPages.length, 100); assert.equal(pool.manifest.exhaustive, false);
});
