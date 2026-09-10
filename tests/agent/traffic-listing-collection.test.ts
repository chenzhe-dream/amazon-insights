import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeListingDetails, collectTrafficListing } from '../../server/services/traffic-listing-collection';

const asin = 'B01E6CX34C';
const overview = { total: 100, overview: { nf: { score: 60, ratio: .6 }, ad: { score: 40, ratio: .4 } }, ad: { sp: { name: 'SP', score: 40, ratio: 1 } }, recommend: { similar: { name: '相似商品', score: 10, ratio: 1 } }, data_notice: '2026-09-10' };
const structure = { chars: { dims: [{ val: asin, features: ['Black'], img: '', sumScore: 100, ratio: 1 }], nfs: [{ score: 60 }], sps: [{ score: 40 }], recs: [{ score: 0 }], sbs: [{ score: 0 }], sbvs: [{ score: 0 }] } };

test('normalizer retains summary and all three detail groups from the same responses', () => {
  const result = normalizeListingDetails(overview, structure);
  assert.equal(result.totalScore, 100);
  assert.equal(result.adChannels[0].label, 'SP(常规)');
  assert.equal(result.recommendationSources[0].label, '相似商品');
  assert.equal(result.children[0].asin, asin);
  assert.equal(result.children[0].organic, 60);
});
test('unknown positive advertising channels are preserved using their provider label', () => {
  const result = normalizeListingDetails({ ...overview, ad: { alpha: { name: 'Alpha', score: 40, ratio: 1 } } }, structure);
  assert.equal(result.adChannels[0]?.label, 'Alpha');
});
test('missing detail arrays and invalid child identifiers fail closed rather than become zero', () => {
  assert.throws(() => normalizeListingDetails({ ...overview, recommend: undefined }, structure));
  assert.throws(() => normalizeListingDetails(overview, { chars: { ...structure.chars, sps: [] } }));
  assert.throws(() => normalizeListingDetails(overview, { chars: { ...structure.chars, dims: [{ ...structure.chars.dims[0], val: 'not-an-asin' }] } }));
});
test('returned empty detail is distinct from missing data and all-natural is supported', () => {
  const result = normalizeListingDetails({ ...overview, total: 60, overview: { nf: { score: 60, ratio: 1 } }, ad: {}, recommend: {} }, { chars: { dims: [], nfs: [], sps: [], recs: [], sbs: [], sbvs: [] } });
  assert.deepEqual(result.adChannels, []);
  assert.deepEqual(result.children, []);
  assert.equal(result.naturalAd[1].score, 0);
});
test('listing recovery uses two calls per ASIN and binds full-response checksums', async () => {
  const calls: string[] = [];
  const result = await collectTrafficListing({ connector: { id: 'sif', probe: async () => { throw new Error('not used'); }, execute: async request => {
    calls.push(request.operation);
    assert.equal(request.input.asin, asin);
    return { data: request.operation.endsWith('overview') ? overview : structure, source: { connectorId: 'sif', operation: request.operation, fetchedAt: '2026-09-10T01:00:00.000Z', attemptCount: 1 } };
  } }, organizationId: '10000000-0000-4000-8000-000000000001', runId: '10000000-0000-4000-8000-000000000002', asins: [asin], marketplace: 'US', id: '10000000-0000-4000-8000-000000000003' });
  assert.deepEqual(calls, ['ops_get_listing_traffic_overview', 'ops_get_listing_traffic_structure']);
  assert.equal(result.collection.records[asin].children.length, 1);
  assert.equal(result.requests.length, 2);
  assert.match(result.requests[0].checksum, /^[a-f0-9]{64}$/);
});
test('a provider that ignores abort cannot return a late collection', async () => {
  const signal = AbortSignal.timeout(10);
  const start = Date.now();
  await assert.rejects(collectTrafficListing({ connector: { id: 'sif', probe: async () => { throw new Error('not used'); }, execute: async () => new Promise(() => {}) }, organizationId: '10000000-0000-4000-8000-000000000001', runId: '10000000-0000-4000-8000-000000000002', asins: [asin], marketplace: 'US', id: '10000000-0000-4000-8000-000000000003', signal }), /timeout|abort/i);
  assert.ok(Date.now() - start < 1000);
});
