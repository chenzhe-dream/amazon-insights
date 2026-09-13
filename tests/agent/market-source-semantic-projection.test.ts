import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { createMarketSourceEvidence } from '../../server/domain/market-research/source-evidence';
import { createMarketInputSnapshot } from '../../server/domain/market-research/snapshot';
import { projectMarketSourceSnapshot } from '../../server/domain/market-research/source-semantic-projection';
import { planMarketSemanticBatches } from '../../server/domain/market-research/semantic-batch-plan';
import { MARKET_SOURCE_HANDLER_VERSION } from '../../shared/market-source-contracts';
import { canonicalJsonSha256 as digest } from '../../server/runtime/model-request-accounting';
import type { MarketAnalysisScope, MarketJsonValue } from '../../shared/market-analysis-contracts';

const scope: MarketAnalysisScope = { organizationId: randomUUID(), researchId: randomUUID(), marketplace: 'US', nodeIdPath: '12:34', fromMonth: '2026-07', toMonth: '2026-08', currency: 'USD' };
const at = '2026-09-01T00:00:00.000Z', asin = 'B000000001';
const shape = { task: 'market-product-shape-suggestion' as const, taxonomyVersion: 'shape/v1', allowedLabels: [] };
const keyword = { task: 'market-keyword-semantics' as const, dictionaryVersion: 'words/v1', categoryContext: 'Synthetic floor lamps', dimensionLabels: { W1: [], W2: [], W3: [], W4: [] }, clusterCatalog: [] };
const theme = { task: 'market-customer-theme-mapping' as const, mappingVersion: 'themes/v1', selectedAsins: [asin], groupCatalog: [] };
function fixture(kind: 'products' | 'keywords' | 'customer-themes', payload: MarketJsonValue, records: (sourceRef: string, payloadHash: string) => { id: string; data: MarketJsonValue }[], expected?: string[]) {
  const source = createMarketSourceEvidence({ scope, provider: kind === 'products' ? 'sellerSprite' : 'sorftime',
    operation: kind === 'products' ? 'market_product_concentration' : kind === 'keywords' ? 'keyword_extends' : 'product_customers_say',
    requestIdentity: { marketplace: 'US', ...(kind === 'products' ? { month: '2026-08', nodeIdPath: scope.nodeIdPath } : kind === 'keywords' ? { keyword: 'lamp', page: 1 } : { asin }) },
    payload, fetchedAt: at, responseIdentityPaths: {}, observationPeriod: { kind: 'unknown', reason: 'Synthetic source' }, units: {}, coverage: { receivedCount: 1, expectedCount: null, truncation: { status: 'unknown', reason: 'Synthetic source' } } });
  const ref = `market-source:${digest(source)}`, rows = records(ref, source.payloadHash);
  const input = { scope, kind, sourceVersion: MARKET_SOURCE_HANDLER_VERSION, ruleVersion: 'source-normalization/v1', collectedAt: at, expectedRecordIds: expected ?? rows.map(r => r.id), records: rows.map(r => ({ ...r, scope })) };
  return { input, snapshot: createMarketInputSnapshot(input), sources: { [ref]: source }, ref };
}
function product(title: string | null = '  Shelf lamp  ') {
  return fixture('products', { code: 'OK', data: [{ asin, title }] }, ref => [{ id: asin, data: { sourceRef: ref, collection: 'product-month', month: '2026-08', product: { asin, sourceIndex: 0, title: title?.trim() || null, price: null, units: 0 } } }], [asin, 'B000000002']);
}
test('product projection binds exact raw text, keeps missing members and does not invent parameters', async () => {
  const f = product(), p = projectMarketSourceSnapshot({ ...f, catalog: shape });
  const data = p.snapshot.records[0].data as any;
  assert.equal(data.semantic.product.title.value.text, '  Shelf lamp  ');
  assert.deepEqual(data.semantic.product.parameters, { state: 'missing', reason: 'not-collected' });
  assert.deepEqual(p.snapshot.coverage.missingRecordIds, ['B000000002']);
  assert.deepEqual(data.sourceFields[0].path, ['data', 0, 'title']);
  assert.equal(data.sourceInputSnapshotId, f.snapshot.snapshotId);
  assert.equal((f.snapshot.records[0].data as any).product.units, 0);
  const plan = await planMarketSemanticBatches({ task: shape.task, moduleRunId: randomUUID(), snapshot: p.snapshot, sources: f.sources, selectionRevision: 'selection/v1', configurationVersion: 'configuration/v1', dataCutoffAt: at }, async () => true);
  assert.equal(plan.batches.length, 1); assert.deepEqual(plan.missingMemberIds, ['B000000002']);
});
test('missing title remains missing; oversized source is rejected without truncation', () => {
  assert.equal((projectMarketSourceSnapshot({ ...product(null), catalog: shape }).snapshot.records[0].data as any).semantic.product.title.state, 'missing');
  assert.throws(() => projectMarketSourceSnapshot({ ...product('x'.repeat(4001)), catalog: shape }));
});
test('normalized keyword identity uses original spelling as model evidence', async () => {
  const raw = '  Shelf LAMP  ', normalized = 'Shelf LAMP';
  const id = `kw_${createHash('sha256').update(JSON.stringify([scope.organizationId, scope.researchId, 'US', scope.nodeIdPath, normalized])).digest('hex')}`;
  const f = fixture('keywords', { data: [{ keyword: raw }] }, ref => [{ id, data: { sourceRef: ref, collection: 'keyword-page', member: { id, keyword: normalized, rawKeyword: raw } } }]);
  const p = projectMarketSourceSnapshot({ ...f, catalog: keyword });
  assert.equal((p.snapshot.records[0].data as any).semantic.keyword.text.text, raw);
  const plan = await planMarketSemanticBatches({ task: keyword.task, moduleRunId: randomUUID(), snapshot: p.snapshot, sources: f.sources, selectionRevision: 'selection/v1', configurationVersion: 'configuration/v1', dataCutoffAt: at }, async () => true);
  assert.equal(plan.batches[0].input.sourceRefs[0], f.ref);
});
test('Customers Say expansion preserves native theme identities and count provenance', async () => {
  const row = { keyword: 'Assembly', content: '', mention: 0, positive: 0, negative: 0, update_time: '2026-08-01' };
  const f = fixture('customer-themes', { data: { details: [row] } }, (ref, hash) => [{ id: asin, data: { sourceRef: ref, collection: 'customer-themes', result: { asin, status: 'success', source: { sourceRecordId: `customers-say:${hash}:${asin}` }, themes: [{ ...row, sourceThemeId: `customers-say:${hash}:${asin}:0`, sourceUpdatedAt: row.update_time }] } } }]);
  const p = projectMarketSourceSnapshot({ ...f, catalog: theme });
  const data = p.snapshot.records[0].data as any;
  assert.equal(data.semantic.theme.content.state, 'missing'); assert.equal(data.counts.mention, 0);
  assert.equal(p.manifest.emptyAsins.length, 0); assert.equal(p.manifest.sourceKind, 'customers-say');
  const plan = await planMarketSemanticBatches({ task: theme.task, moduleRunId: randomUUID(), snapshot: p.snapshot, sources: f.sources, selectionRevision: 'selection/v1', configurationVersion: 'configuration/v1', dataCutoffAt: at }, async () => true);
  assert.equal(plan.batches.length, 1);
});
test('tampered normalized title, source hash, wrong source scope and undeclared source reject', () => {
  const f = product();
  const altered = structuredClone(f.input); (altered.records[0].data as any).product.title = 'Invented title';
  assert.throws(() => projectMarketSourceSnapshot({ ...f, snapshot: createMarketInputSnapshot(altered), catalog: shape }));
  assert.throws(() => projectMarketSourceSnapshot({ ...f, sources: {}, catalog: shape }));
  const bad = { [f.ref]: { ...f.sources[f.ref], payloadHash: '0'.repeat(64) } };
  assert.throws(() => projectMarketSourceSnapshot({ ...f, sources: bad, catalog: shape }));
  const moved = structuredClone(f.input); moved.scope = { ...scope, researchId: randomUUID() }; moved.records.forEach(r => { r.scope = moved.scope; });
  assert.throws(() => projectMarketSourceSnapshot({ ...f, snapshot: createMarketInputSnapshot(moved), catalog: shape }));
});
test('projection catalog and source versions are bound even when the pool is empty', () => {
  const f = fixture('products', { code: 'OK', data: [] }, () => []);
  const first = projectMarketSourceSnapshot({ ...f, catalog: shape });
  const second = projectMarketSourceSnapshot({ ...f, catalog: { ...shape, taxonomyVersion: 'shape/v2' } });
  assert.notEqual(first.snapshot.snapshotId, second.snapshot.snapshotId);
  assert.throws(() => projectMarketSourceSnapshot({ ...f, snapshot: createMarketInputSnapshot({ ...f.input, sourceVersion: 'obsolete' }), catalog: shape }));
});
test('empty Customers Say remains an explicit empty ASIN and other selected ASINs remain unrepresented', () => {
  const payloads: MarketJsonValue[] = [{ data: { details: [] } }, { content: [{ type: 'text', text: '  No relevant data.  ' }] }];
  for (const payload of payloads) {
    const f = fixture('customer-themes', payload, (ref, hash) => [{ id: asin, data: { sourceRef: ref, collection: 'customer-themes', result: { asin, status: 'empty', source: { sourceRecordId: `customers-say:${hash}:${asin}` } } } }]);
    const p = projectMarketSourceSnapshot({ ...f, catalog: { ...theme, selectedAsins: [asin, 'B000000002'] } });
    assert.deepEqual(p.snapshot.records, []); assert.equal(p.snapshot.coverage.status, 'empty');
    assert.deepEqual(p.manifest.emptyAsins, [asin]); assert.deepEqual(p.manifest.unrepresentedSelectedAsins, ['B000000002']);
  }
});
test('source ASIN normalization matches the collector without changing title evidence', () => {
  const f = fixture('products', { code: 'OK', data: [{ asin: ' b000000001 ', title: 'Shelf lamp' }] }, ref => [{ id: asin, data: { sourceRef: ref, collection: 'product-month', month: '2026-08', product: { asin, sourceIndex: 0, title: 'Shelf lamp' } } }]);
  assert.equal((projectMarketSourceSnapshot({ ...f, catalog: shape }).snapshot.records[0].data as any).semantic.product.asin, asin);
});
