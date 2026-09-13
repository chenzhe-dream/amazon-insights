import { assertMarketProductQueryWindow, marketProductMonthSupported } from '../../shared/market-product-source-policy';
import assert from 'node:assert/strict';
import test from 'node:test';
import { collectMarketProductPool } from '../../server/services/market-product-pool-collector';
import { createMarketInputSnapshot } from '../../server/domain/market-research/snapshot';
import { canonicalJsonSha256 as digest } from '../../server/runtime/model-request-accounting';
import { createMarketShapeRevision, buildMarketShapePriceCatalog } from '../../server/domain/market-research/shape-price-catalog';
const scope = { organizationId: 'org-a', researchId: 'a9000000-0000-4000-8000-000000000001', marketplace: 'US' as const, nodeIdPath: '1:2:3', fromMonth: '2026-07', toMonth: '2026-08', currency: 'USD' as const };
const cutoff = '2026-09-12T00:00:00.000Z', asins = ['B000000001', 'B000000002', 'B000000003'];
const labels = [{ labelId: 'desk', label: '台灯', definition: '人工确认的桌面灯' }, { labelId: 'shelf', label: '层架灯', definition: '人工确认的层架灯' }];
const rows = () => asins.map((asin, i) => ({ asin, title: 'Synthetic lamp', brand: 'Fixture', price: i ? 15 : 5, totalUnits: i === 0 ? 100 : i === 1 ? 10 : 0, totalRevenue: 0, ranking: i + 1, rating: 4, ratings: 20, sellerName: 'Fixture', sellerType: 'FBA', shelfDate: '2025-01-10' }));
async function observation(month: string, patch: (p: any) => void = () => { }, selectedAsins?: string[]) {
    const payload: any = { code: 'OK', marketplace: 'US', nodeIdPath: scope.nodeIdPath, month, currency: 'USD', data: rows() };
    patch(payload);
    const result = await collectMarketProductPool({ scope, month, poolSize: selectedAsins?.length ?? 100, newProductMonths: 6, ...(selectedAsins ? { selectedAsins } : {}), jobId: 'synthetic', connector: { id: 'sellerSprite', probe: async () => { throw Error('unused'); }, execute: async () => ({ data: payload, source: { connectorId: 'sellerSprite', operation: 'market_product_concentration', fetchedAt: cutoff, attemptCount: 1 } }) }, now: () => new Date(cutoff) });
    assert.ok(result.evidence);
    const source = result.evidence, sourceRef = 'market-source:' + digest(source);
    const snapshot = createMarketInputSnapshot({ scope, kind: 'products', sourceVersion: 'market-source-handlers/v1', ruleVersion: 'source-normalization/v1', collectedAt: cutoff, expectedRecordIds: selectedAsins ?? result.products.map(p => p.asin), records: result.products.map(product => ({ id: product.asin, scope, data: { collection: 'product-month', month, product, sourceRef } })) });
    return { month, snapshot, sourceRef, source };
}
const revision = (reference: Awaited<ReturnType<typeof observation>>, patch: Record<string, unknown> = {}) => createMarketShapeRevision({ scope, basisSnapshotId: reference.snapshot.snapshotId, selectedAsins: asins, taxonomyVersion: 'synthetic/v1', labels, assignments: [{ asin: asins[0], labelId: 'desk' }, { asin: asins[1], labelId: 'desk' }], authorId: 'synthetic-author', createdAt: cutoff, parentRevisionId: null, ...patch });
const sources = (...observations: Awaited<ReturnType<typeof observation>>[]) => Object.fromEntries(observations.map(o => [o.sourceRef, o.source]));
const clearEcho = (p: any) => { delete p.marketplace; delete p.nodeIdPath; delete p.month; delete p.currency; };
const build = async (patch: (p: any) => void = clearEcho) => {
    const reference = await observation('2026-08', patch), history = await observation('2026-07', patch), rawHash = digest(reference.source);
    const result = await buildMarketShapePriceCatalog({ reference, history: [history], sources: sources(reference, history), revision: revision(reference), bands: [{ id: 'all', minInclusive: 0, maxExclusive: null }], dataCutoffAt: cutoff, version: 'market-shape-price-catalog/v3' });
    assert.equal(digest(reference.source), rawHash);
    return { result, reference, history };
};
test('documented request scope and US currency admit real-shaped rows without rewriting response proofs', async () => {
    const { result: c, reference } = await build();
    assert.equal(c.analysis.totals.totalUnits, 220);
    assert.equal(c.analysis.scope.eligibleAsins.length, 3);
    assert.equal(c.sourcePolicy!.version, 'sellersprite-product-source-policy/v1');
    assert.equal(c.products[0].referencePrice.currency, 'USD');
    assert.deepEqual(c.products[0].referencePrice.provenance, { scopeBasis: 'request-bound', currencyBasis: 'provider-contract' });
    assert.deepEqual(c.products[0].observations[0].provenance, { scopeBasis: 'request-bound', periodBasis: 'request-bound' });
    assert.equal(reference.source.responseIdentity.marketplace.status, 'unverified');
    assert.equal(reference.source.responseIdentity.month.status, 'unverified');
    assert.equal(reference.source.units.price.status, 'unknown');
    assert.equal(c.structure!.ruleVersion, 'market-shape-structure/v2');
    assert.equal(c.structure!.products[0].brand.value, 'Fixture');
    assert.equal(c.structure!.products[0].brand.scopeBasis, 'request-bound');
    assert.equal(c.structure!.products[0].listing.ageMonths, 19);
});
test('a member echo only changes that members provenance; missing raw values and zero keep their meanings', async () => {
    const { result: c } = await build(p => { clearEcho(p); Object.assign(p.data[0], { marketplace: 'US', nodeIdPath: scope.nodeIdPath, currency: 'USD' }); delete p.data[0].month; p.data[0].price = 0; p.data[0].totalUnits = 0; p.data[1].price = null; p.data[2].totalUnits = null; });
    assert.deepEqual(c.products[0].referencePrice.provenance, { scopeBasis: 'response-verified', currencyBasis: 'response-echo' });
    assert.equal(c.products[1].referencePrice.provenance!.scopeBasis, 'request-bound');
    assert.equal(c.products[0].referencePrice.value, 0);
    assert.equal(c.analysis.totals.totalUnits, 0);
    assert.equal(c.products[1].referencePrice.value, null);
    assert.ok(c.products[1].referencePrice.issues.includes('price-missing'));
    assert.equal(c.products[2].observations[0].units, null);
});
test('conflicting currency, marketplace or query month cannot enter the request-bound path', async () => {
    for (const patch of [(p: any) => p.currency = 'EUR', (p: any) => p.marketplace = 'UK', (p: any) => p.month = '2026-06', (p: any) => p.data[1].currency = 'EUR'])
        await assert.rejects(build(patch));
});
test('previous v2 structure catalog remains byte-identical after new admission policy', async () => {
    const reference = await observation('2026-08'), history = await observation('2026-07');
    const c = await buildMarketShapePriceCatalog({ reference, history: [history], sources: sources(reference, history), revision: revision(reference), bands: [{ id: 'all', minInclusive: 0, maxExclusive: null }], dataCutoffAt: cutoff, version: 'market-shape-price-catalog/v2' });
    assert.equal(digest(c), 'b10f1c167a19ff918e2d42935230a1eab3c4b86ec2ee2800498bff3a550cb01f');
});
test('source month support is evaluated at collection time and new queries are limited to 24 complete months', () => {
    const at = new Date('2026-09-13T00:00:00Z');
    assert.equal(marketProductMonthSupported('2024-09', at), true);
    assert.equal(marketProductMonthSupported('2024-08', at), false);
    assert.equal(marketProductMonthSupported('2026-08', at), true);
    assert.equal(marketProductMonthSupported('2026-09', at), false);
    assert.doesNotThrow(() => assertMarketProductQueryWindow({ fromMonth: '2024-09', toMonth: '2026-08' }, at));
    assert.throws(() => assertMarketProductQueryWindow({ fromMonth: '2024-08', toMonth: '2026-08' }, at), /24/);
    assert.throws(() => assertMarketProductQueryWindow({ fromMonth: '2026-08', toMonth: '2026-09' }, at), /24/);
    assert.equal(marketProductMonthSupported('2024-09', new Date('2026-10-01T00:00:00Z')), false);
    // The historical receipt still binds its original September collection cutoff.
    assert.equal(marketProductMonthSupported('2024-09', at), true);
});
