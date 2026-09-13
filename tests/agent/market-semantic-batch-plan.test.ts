import assert from 'node:assert/strict';
import test from 'node:test';
import { createMarketInputSnapshot } from '../../server/domain/market-research/snapshot';
import { createMarketSourceEvidence } from '../../server/domain/market-research/source-evidence';
import { canonicalJsonSha256 as digest } from '../../server/runtime/model-request-accounting';
import { planMarketSemanticBatches } from '../../server/domain/market-research/semantic-batch-plan';
import { validateMarketSemanticInput } from '../../server/domain/market-research/semantic-validation';
import type { MarketSemanticRecord, MarketSemanticTaskName } from '../../shared/market-semantic-contracts';

const scope = { organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', researchId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  marketplace: 'US' as const, nodeIdPath: '1:2', fromMonth: '2020-01', toMonth: '2020-02', currency: 'USD' as const };
const cutoff = '2020-03-01T00:00:00.000Z';
const source = createMarketSourceEvidence({ scope, provider: 'sorftime', operation: 'synthetic', requestIdentity: {}, responseIdentityPaths: {},
  payload: { synthetic: true }, fetchedAt: cutoff, observationPeriod: { kind: 'unknown', reason: 'synthetic' }, units: {},
  coverage: { receivedCount: 1, expectedCount: 1, truncation: { status: 'unknown', reason: 'synthetic' } } });
const sourceRef = `market-source:${digest(source)}`;
function fixture(task: Exclude<MarketSemanticTaskName,'market-shape-structure-explanation'|'market-shape-synthesis'|'market-overview-synthesis'>, count: number, missing = false) {
  const ids = Array.from({ length: count }, (_, i) => task === 'market-product-shape-suggestion' ? `B${String(i).padStart(9, '0')}` : `record-${String(i).padStart(3, '0')}`);
  const records = ids.map(id => {
    let semantic: MarketSemanticRecord;
    if (task === 'market-product-shape-suggestion') semantic = { task, taxonomyVersion: 'taxonomy/v1', allowedLabels: [], product: {
      productId: id, asin: id, title: { state: 'known', value: { refId: `title-${id}`, sourceRef, recordId: id, field: 'title', text: 'shelf lamp' } },
      parameters: { state: 'missing', reason: 'field-absent' } } };
    else if (task === 'market-keyword-semantics') semantic = { task, dictionaryVersion: 'dictionary/v1', categoryContext: 'synthetic lamp',
      dimensionLabels: { W1: [], W2: [], W3: [], W4: [] }, clusterCatalog: [],
      keyword: { keywordId: id, text: { refId: `keyword-${id}`, sourceRef, recordId: id, field: 'keyword', text: 'shelf lamp' } } };
    else if (task === 'market-customer-theme-mapping') semantic = { task, mappingVersion: 'mapping/v1', selectedAsins: ['B000000001'], groupCatalog: [],
      theme: { sourceThemeId: id, asin: 'B000000001', keyword: { state: 'known', value: { refId: `keyword-${id}`, sourceRef, recordId: id, field: 'keyword', text: 'shelf' } },
        content: { state: 'missing', reason: 'field-absent' } } };
    else semantic = { task, metrics: [{ metricId: 'metric', state: 'known', value: 10, unit: { status: 'known', unit: 'count', rawUnit: 'count' },
      period: { kind: 'calendar-months', fromMonth: scope.fromMonth, toMonth: scope.toMonth }, sourceRefs: [sourceRef], formulaVersion: 'synthetic/v1',
      numeratorRef: null, denominatorRef: null, coverage: { status: 'complete', expectedCount: 1, availableCount: 1 } }],
      gaps: [], facts: [{ factId: 'fact', kind: 'value', metricRefs: ['metric'], sourceRefs: [sourceRef], statementTemplateId: 'synthetic' }], interpretationOptions: [], validationOptions: [] };
    return { id, scope, data: { semantic } };
  });
  const kind = task === 'market-product-shape-suggestion' ? 'products' : task === 'market-keyword-semantics' ? 'keywords' : task === 'market-customer-theme-mapping' ? 'customer-themes' : 'overview';
  const snapshot = createMarketInputSnapshot({ scope, kind, sourceVersion: 'source/v1', ruleVersion: 'rule/v1', collectedAt: cutoff,
    expectedRecordIds: [...ids, ...(missing ? [kind === 'products' ? 'B999999999' : 'missing-record'] : [])], records });
  return { task, moduleRunId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', snapshot, sources: { [sourceRef]: source }, selectionRevision: 'selection/v1', configurationVersion: 'config/v1', dataCutoffAt: cutoff };
}

test('batch preparation keeps complete membership, deterministic identity and registered member caps for all tasks', async () => {
  for (const [task, count, cap] of [
    ['market-overview-explanation', 1, 1], ['market-product-shape-suggestion', 23, 10],
    ['market-keyword-semantics', 43, 20], ['market-customer-theme-mapping', 27, 12],
  ] as const) {
    const input = fixture(task, count, true);
    const plan = await planMarketSemanticBatches(input, async () => true);
    assert.equal(plan.batches.length, Math.ceil(count / cap));
    assert.deepEqual(plan.batches.flatMap(b => b.memberRefs), input.snapshot.records.map(r => r.id));
    assert.equal(plan.missingMemberIds.length, 1); assert.equal(plan.rejectedMembers.length, 0);
    for (const batch of plan.batches) {
      assert.ok(batch.memberRefs.length <= cap);
      validateMarketSemanticInput(batch.input, batch.validationBinding);
    }
    assert.deepEqual(await planMarketSemanticBatches(input, async () => true), plan);
    const changed = await planMarketSemanticBatches({ ...input, configurationVersion: 'config/v2' }, async () => true);
    assert.notEqual(changed.batches[0].input.batchId, plan.batches[0].input.batchId);
    assert.notEqual(changed.basisHash, plan.basisHash);
  }
});
test('input size splits at exact accepted boundary and oversized members remain explicit gaps', async () => {
  const input = fixture('market-keyword-semantics', 7);
  const result = await planMarketSemanticBatches(input, async batch => batch.task === 'market-keyword-semantics' && batch.keywords.length <= 2);
  assert.deepEqual(result.batches.map(b => b.memberRefs.length), [2, 2, 2, 1]);
  const rejected = await planMarketSemanticBatches(input, async () => false);
  assert.equal(rejected.batches.length, 0);
  assert.deepEqual(rejected.rejectedMembers, input.snapshot.records.map(r => ({ memberId: r.id, reason: 'request-too-large' })));
  assert.equal(rejected.missingMemberIds.length, 0);
});
test('missing evidence and changed snapshots reject before calling the admission meter', async () => {
  let calls = 0; const meter = async () => { calls++; return true; };
  const input = fixture('market-keyword-semantics', 2);
  await assert.rejects(() => planMarketSemanticBatches({ ...input, sources: {} }, meter));
  assert.equal(calls, 0);
  await assert.rejects(() => planMarketSemanticBatches({ ...input, snapshot: { ...input.snapshot, collectedAt: '2020-03-02T00:00:00.000Z' } }, meter));
  assert.equal(calls, 0);
});
test('admission infrastructure errors are not misreported as oversized source records', async () => {
  await assert.rejects(() => planMarketSemanticBatches(fixture('market-keyword-semantics', 2), async () => { throw new Error('synthetic meter unavailable'); }), /meter unavailable/);
});
test('empty snapshots produce no fake batches and preserve all expected missing members', async () => {
  const input = fixture('market-keyword-semantics', 0, true); let calls = 0;
  const plan = await planMarketSemanticBatches(input, async () => { calls++; return true; });
  assert.deepEqual(plan.batches, []); assert.deepEqual(plan.missingMemberIds, ['missing-record']); assert.equal(calls, 0);
});
test('batch identity is isolated per module run and metadata cannot change during sizing', async () => {
  const input = fixture('market-keyword-semantics', 3), initial = await planMarketSemanticBatches(input, async () => true);
  const otherRun = await planMarketSemanticBatches({ ...input, moduleRunId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' }, async () => true);
  assert.notEqual(otherRun.batches[0].bindingId, initial.batches[0].bindingId);
  const mutation = await planMarketSemanticBatches(input, async () => { input.selectionRevision = 'mutated'; input.configurationVersion = 'mutated'; return true; });
  assert.deepEqual(mutation, initial);
});
test('cancellation while sizing does not return a partial success plan', async () => {
  const controller = new AbortController();
  await assert.rejects(() => planMarketSemanticBatches(fixture('market-keyword-semantics', 3), async () => { controller.abort(); return true; }, controller.signal));
});
test('overview preserves explicit unknown periods for source values but rejects trend claims before sizing', async () => {
  const input = fixture('market-overview-explanation', 1);
  const record = JSON.parse(JSON.stringify(input.snapshot.records[0]));
  record.data.semantic.metrics[0].period = { kind: 'unknown', reason: 'synthetic unknown period' };
  const original = input.snapshot;
  input.snapshot = createMarketInputSnapshot({ scope: original.scope, kind: original.kind, sourceVersion: original.sourceVersion, ruleVersion: original.ruleVersion,
    collectedAt: original.collectedAt, expectedRecordIds: original.expectedRecordIds, records: [record] });
  let calls = 0;
  const planned=await planMarketSemanticBatches(input,async()=>{calls++;return true;});assert.equal(planned.batches.length,1);
  assert.equal((planned.batches[0].input as any).metrics[0].period.kind,'unknown');
  record.data.semantic.facts[0].kind='trend';
  input.snapshot=createMarketInputSnapshot({scope:original.scope,kind:original.kind,sourceVersion:original.sourceVersion,ruleVersion:original.ruleVersion,collectedAt:original.collectedAt,expectedRecordIds:original.expectedRecordIds,records:[record]});calls=0;
  await assert.rejects(() => planMarketSemanticBatches(input, async () => { calls++; return true; }), /invalid_period/);
  assert.equal(calls, 0);
});
