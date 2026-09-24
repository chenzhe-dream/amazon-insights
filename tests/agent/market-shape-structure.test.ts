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
const build = async (patch: (p: any) => void = () => { }, revise: Record<string, unknown> = {}, historyPatch: (p: any) => void = () => { }) => {
    const reference = await observation('2026-08', patch), history = await observation('2026-07', historyPatch);
    return buildMarketShapePriceCatalog({ reference, history: [history], sources: sources(reference, history), revision: revision(reference, revise), bands: [{ id: 'low', minInclusive: 0, maxExclusive: 10 }, { id: 'high', minInclusive: 10, maxExclusive: null }], dataCutoffAt: cutoff, version: 'market-shape-price-catalog/v2' });
};
test('brand by reference price band retains distinct denominators and calendar age at the research cutoff', async () => {
    const c = await build(p => { p.data[0].brand = ' Brand A '; p.data[1].brand = 'Brand A'; p.data[2].brand = null; p.data[0].shelfDate = '2026-08-31'; p.data[1].shelfDate = '2026-05-31'; p.data[2].shelfDate = '2025-08-15'; });
    assert.equal(c.version, 'market-shape-price-catalog/v2');
    const s = c.structure!;
    assert.equal(s.ruleVersion, 'market-shape-structure/v1');
    assert.equal(s.referenceMonth, '2026-08');
    assert.deepEqual(s.products.map(p => p.listing.ageMonths), [0, 3, 12]);
    assert.deepEqual(s.products.map(p => p.listing.bucketId), ['0-2', '3-5', '12-23']);
    const all = s.segments.find(s => s.kind === 'all')!, a = all.brands.find(g => g.brand === 'Brand A')!;
    assert.equal(a.stats.units, 220);
    assert.equal(a.stats.linkShare.value, 2 / 3);
    assert.equal(a.stats.salesShare.value, 1);
    const high = a.bands.find(b => b.bandId === 'high')!;
    assert.equal(high.stats.linkShare.value, 1 / 2);
    assert.equal(high.stats.salesShare.value, 1);
    assert.equal(high.stats.monthlyUnitsPerLink, 10);
    assert.equal(all.brands.find(b => b.brand === null)!.stats.units, 0);
    assert.equal(all.brands.find(b => b.brand === null)!.bands[0].stats.salesShare.value, 0);
    assert.deepEqual(s.products[0].brand.evidence.payloadPath, ['data', 0, 'brand']);
    assert.deepEqual(s.products[0].listing.evidence.payloadPath, ['data', 0, 'shelfDate']);
    assert.equal(s.products[0].brand.rawValue, ' Brand A ');
    assert.equal(s.segments.find(s => s.kind === 'shape' && s.labelId === null)!.ages.find(a => a.bucketId === '12-23')!.stats.salesShare.value, null);
});
test('invalid dates, future listings and missing prices retain unknown groups without invented zero sales', async () => {
    const c = await build(p => { p.data[0].shelfDate = '2026-02-30'; p.data[1].shelfDate = '2026-09-01'; p.data[2].shelfDate = null; p.data[0].price = null; });
    const s = c.structure!;
    assert.deepEqual(s.products.map(p => p.listing.issues), [['listing-date-invalid'], ['listed-after-reference-month'], ['listing-date-missing']]);
    assert.equal(s.products[0].listing.rawValue, '2026-02-30');
    assert.equal(s.products[0].priceBandId, null);
    assert.equal(s.products[0].comparableUnits, null);
    const all = s.segments.find(s => s.kind === 'all')!;
    assert.equal(all.ages.find(a => a.bucketId === null)!.stats.units, 20);
    const unknown = all.brands[0].bands.find(b => b.bandId === null)!;
    assert.equal(unknown.stats.units, null);
    assert.equal(unknown.stats.requestedLinks, 1);
    assert.equal(unknown.stats.salesShare.value, null);
    assert.equal(all.brands[0].stats.linkShare.value, 1);
});
test('member scope does not borrow another row echo and missing histories exclude the same member throughout', async () => {
    const c = await build(p => { delete p.marketplace; delete p.nodeIdPath; p.data[1].marketplace = 'US'; p.data[1].nodeIdPath = scope.nodeIdPath; }, {}, p => { p.data[1].totalUnits = null; });
    assert.ok(c.structure!.products[0].brand.issues.includes('scope-unconfirmed'));
    assert.equal(c.structure!.products[0].brand.rawValue, 'Fixture');
    assert.equal(c.structure!.products[0].brand.value, null);
    assert.equal(c.structure!.products[1].brand.value, 'Fixture');
    assert.equal(c.structure!.products[1].comparableUnits, null);
    assert.equal(c.structure!.segments[0].brands.find(b => b.brand === 'Fixture')!.stats.units, null);
});
test('manual exclusion and shape regrouping recompute structure from selected rows only and never merge brand aliases', async () => {
    const patch = (p: any) => { p.data[0].brand = 'Fixture'; p.data[1].brand = 'fixture'; };
    const first = await build(patch), before = digest(first);
    const changed = await build(patch, { selectedAsins: asins.slice(0, 2), assignments: [{ asin: asins[0], labelId: 'shelf' }, { asin: asins[1], labelId: 'shelf' }] });
    assert.equal(first.structure!.segments[0].brands.length, 2);
    assert.equal(changed.structure!.products.length, 2);
    const shelf = changed.structure!.segments.find(s => s.kind === 'shape' && s.labelId === 'shelf')!;
    assert.equal(shelf.brands[0].stats.linkShare.value, 1 / 2);
    assert.equal(shelf.brands.find(b => b.brand === 'Fixture')!.stats.salesShare.value, 200 / 220);
    assert.equal(digest(first), before);
});
test('legacy catalog stays deterministic for the current normalized source and rejects unsupported rule versions', async () => {
    const reference = await observation('2026-08'), history = await observation('2026-07');
    const input = { reference, history: [history], sources: sources(reference, history), revision: revision(reference), bands: [{ id: 'all', minInclusive: 0, maxExclusive: null }], dataCutoffAt: cutoff };
    const c = await buildMarketShapePriceCatalog(input);
    // The source fixture now records selectedSize and distinct provider-return
    // coverage, so its sourceRef and derived catalog identity changed together.
    assert.equal(digest(c), '1db475b0bea6be31fdd84e00486095f694d63d195dff17ad720fe79ec2725102');
    assert.equal(Object.hasOwn(c, 'structure'), false);
    await assert.rejects(buildMarketShapePriceCatalog({ ...input, version: 'made-up' as any }));
});
test('calendar age buckets use reference month across leap dates and all boundary months', async () => {
    const cases: [
        string,
        number | null,
        string | null
    ][] = [['2026-06-30', 2, '0-2'], ['2026-05-31', 3, '3-5'], ['2026-03-01', 5, '3-5'], ['2026-02-28', 6, '6-11'], ['2025-09-01', 11, '6-11'], ['2025-08-31', 12, '12-23'], ['2024-09-01', 23, '12-23'], ['2024-08-31', 24, '24+'], ['2024-02-29', 30, '24+'], ['2025-02-29', null, null]];
    for (let start = 0; start < cases.length; start += 3) {
        const batch = cases.slice(start, start + 3), c = await build(p => batch.forEach(([date], i) => p.data[i].shelfDate = date));
        batch.forEach(([, age, bucket], i) => { assert.equal(c.structure!.products[i].listing.ageMonths, age); assert.equal(c.structure!.products[i].listing.bucketId, bucket); });
    }
});
