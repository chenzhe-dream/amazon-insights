import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { aggregateCustomerThemes } from '../../server/domain/market-research/customer-themes';
import { createMarketInputSnapshot } from '../../server/domain/market-research/snapshot';
import { readMarketThemeDetailPage } from '../../server/domain/market-research/customer-theme-details';
import { MarketInputRecordSchema } from '../../shared/market-analysis-contracts';

function fixture(topN?: number) {
  const scope = { organizationId: randomUUID(), researchId: randomUUID(), marketplace: 'US' as const, nodeIdPath: '12:34', fromMonth: '2026-07', toMonth: '2026-08', currency: 'USD' as const };
  const at = '2026-09-01T00:00:00.000Z', asin = 'B000000001';
  const aggregation = aggregateCustomerThemes({ selectedAsins: [asin, 'B000000002'], results: [{ asin, status: 'success',
    source: { sourceRecordId: 'source-1', fetchedAt: at, sourceUpdatedAt: null }, themes: [
      { sourceThemeId: 'a', keyword: 'Assembly', content: 'Easy assembly', mention: 9, positive: 9, negative: 0 },
      { sourceThemeId: 'b', keyword: 'Brightness', content: '光'.repeat(12000), mention: 1, positive: 0, negative: 1 },
      { sourceThemeId: 'c', keyword: 'Size', content: '', mention: 0, positive: 0, negative: 0 },
    ] }, { asin: 'B000000002', status: 'failed', source: null, reason: 'timeout' }], mappings: [{ sourceThemeId: 'a', groupId: 'assembly' }], topN });
  const { groups, perAsin, mappings, ...summary } = aggregation;
  const records = [{ id: 'summary', data: { artifactLayout: 'theme-rules-chunks/v1', aggregation: summary, resultHash: 'f'.repeat(64),
    semantics: { expectedMemberCount: 3, validatedMemberCount: 2, mappedMemberCount: 1, unknownMemberIds: ['b'], unavailableMemberIds: ['c'] } } },
    ...perAsin.map(a => ({ id: `asin:${a.asin}`, data: a })),
    ...(groups.length ? [{ id: 'groups:0', data: { kind: 'groups', items: groups } }] : []),
    { id: 'mappings:0', data: { kind: 'mappings', items: mappings } },
    { id: 'labels:0', data: { kind: 'labels', items: [{ groupId: 'assembly', labelZh: '组装', definition: '组装体验', origin: 'catalog', batchId: null, proposalId: null }] } },
    { id: 'decisions:0', data: { kind: 'decisions', items: [
      { sourceThemeId: 'a', status: 'mapped', groupId: 'assembly', reason: null, batchId: 'batch-1' },
      { sourceThemeId: 'b', status: 'unknown', groupId: null, reason: 'insufficient-evidence', batchId: 'batch-1' },
      { sourceThemeId: 'c', status: 'unavailable', groupId: null, reason: 'model-result-unavailable', batchId: null },
    ] } }].map(r => ({ ...r, scope, data: MarketInputRecordSchema.shape.data.parse(r.data) }));
  const factory = { scope, kind: 'customer-themes' as const, sourceVersion: 'market-source-handlers/v1', ruleVersion: `market-theme-mapping-rules/v1:${'f'.repeat(64)}`,
    collectedAt: at, records, expectedRecordIds: records.map(r => r.id) };
  return { factory, snapshot: createMarketInputSnapshot(factory) };
}
test('paged group rows preserve full denominators, mapping labels, zero and failed ASINs', () => {
  const { snapshot } = fixture();
  const first = readMarketThemeDetailPage(snapshot, { section: 'groups', offset: 0, limit: 1 });
  assert.equal(first.totalItems, 3); assert.equal(first.nextOffset, 1); assert.equal(first.totals!.mention, 10);
  assert.equal(first.items[0].kind, 'group'); assert.equal((first.items[0] as any).labelZh, '组装');
  assert.equal((first.items[0] as any).topicShare.valuePct, 90);
  const second = readMarketThemeDetailPage(snapshot, { section: 'groups', offset: 1, limit: 1 });
  assert.equal((second.items[0] as any).sourceLabel.text, 'Brightness');
  assert.equal((second.items[0] as any).topicShare.denominator, 10); assert.equal((second.items[0] as any).topicShare.valuePct, 10);
  const zero = readMarketThemeDetailPage(snapshot, { section: 'members', offset: 2, limit: 1 });
  assert.equal((zero.items[0] as any).mention, 0); assert.equal((zero.items[0] as any).decision.status, 'unavailable');
  const asins = readMarketThemeDetailPage(snapshot, { section: 'asins' });
  assert.equal((asins.items[1] as any).status, 'failed'); assert.equal((asins.items[1] as any).totals, null);
});
test('topN is a display limit only, evidence remains available and clipping is explicit', () => {
  const { snapshot } = fixture(0);
  const groups = readMarketThemeDetailPage(snapshot, { section: 'groups' }); assert.equal(groups.items.length, 0); assert.equal(groups.display.omittedGroupCount, 3);
  const members = readMarketThemeDetailPage(snapshot, { section: 'members' }); assert.equal(members.totalItems, 3);
  const content = (members.items[1] as any).content; assert.equal(content.truncated, true); assert.equal(content.totalLength, 12000); assert.equal(content.text.length, 2000);
  assert.equal(members.totals!.mention, 10); assert.equal(members.nextOffset, null);
  assert.throws(() => readMarketThemeDetailPage(snapshot, { section: 'members', groupIndex: 0 }));
});
test('missing chunk indices, invented counts, labels and member decisions are rejected even with a newly valid content hash', () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>['factory']) => { f.records.find(r => r.id === 'groups:0')!.id = 'groups:1'; },
    (f: ReturnType<typeof fixture>['factory']) => { (f.records.find(r => r.id === 'groups:0')!.data as any).items[0].totals.mention = 999; },
    (f: ReturnType<typeof fixture>['factory']) => { (f.records.find(r => r.id === 'decisions:0')!.data as any).items[1].sourceThemeId = 'invented'; },
    (f: ReturnType<typeof fixture>['factory']) => { (f.records.find(r => r.id === 'labels:0')!.data as any).items[0].groupId = 'invented'; },
    (f: ReturnType<typeof fixture>['factory']) => { (f.records.find(r => r.id === 'summary')!.data as any).semantics.unknownMemberIds = []; },
  ]) {
    const f = fixture().factory; mutate(f); f.expectedRecordIds = f.records.map(r => r.id);
    assert.throws(() => readMarketThemeDetailPage(createMarketInputSnapshot(f), { section: 'groups' }));
  }
});
test('an empty selection report returns an empty page and null totals', () => {
  const f = fixture().factory;
  const snapshot = createMarketInputSnapshot({ ...f, kind: 'products', records: [], expectedRecordIds: [] });
  const page = readMarketThemeDetailPage(snapshot, {}, true);
  assert.equal(page.totals, null); assert.deepEqual(page.items, []); assert.equal(page.nextOffset, null);
});
test('multiple complete chunks and byte-bounded evidence pages retain every member exactly once', () => {
  const f = fixture().factory, asin = 'B000000001', ids = Array.from({ length: 40 }, (_, i) => `theme-${String(i).padStart(2, '0')}`);
  const result = aggregateCustomerThemes({ selectedAsins: [asin], mappings: [], results: [{ asin, status: 'success',
    source: { sourceRecordId: 'large-evidence', fetchedAt: f.collectedAt, sourceUpdatedAt: null },
    themes: ids.map(sourceThemeId => ({ sourceThemeId, keyword: '装'.repeat(2100), content: '亮'.repeat(3000), mention: 1, positive: 1, negative: 0 })) }] });
  const { groups, perAsin, mappings: _mappings, ...aggregation } = result;
  const chunks = (name: string, items: unknown[], size: number) => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => ({ id: `${name}:${i}`, data: { kind: name, items: items.slice(i * size, (i + 1) * size) } }));
  const records = [{ id: 'summary', data: { artifactLayout: 'theme-rules-chunks/v1', resultHash: 'f'.repeat(64), aggregation,
    semantics: { expectedMemberCount: 40, validatedMemberCount: 40, mappedMemberCount: 0, unknownMemberIds: ids, unavailableMemberIds: [] } } },
    { id: `asin:${asin}`, data: perAsin[0] }, ...chunks('groups', groups, 32), ...chunks('decisions', ids.map(sourceThemeId => ({ sourceThemeId,
      status: 'unknown', groupId: null, reason: 'insufficient-evidence', batchId: 'batch-1' })), 128)].map(r => ({ ...r, scope: f.scope, data: MarketInputRecordSchema.shape.data.parse(r.data) }));
  const snapshot = createMarketInputSnapshot({ ...f, records, expectedRecordIds: records.map(r => r.id) });
  const seen: string[] = []; let offset: number | null = 0;
  while (offset !== null) {
    const page = readMarketThemeDetailPage(snapshot, { section: 'members', offset, limit: 50 });
    assert.ok(page.items.length < 40); assert.ok(Buffer.byteLength(JSON.stringify(page.items), 'utf8') < 202000);
    seen.push(...page.items.map(r => (r as any).sourceThemeId)); offset = page.nextOffset;
    assert.equal(page.totals!.mention, 40);
  }
  assert.deepEqual(seen, ids); assert.equal(readMarketThemeDetailPage(snapshot, { section: 'groups', offset: 32 }).items.length, 8);
});
