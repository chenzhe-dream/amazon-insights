import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeMarketKeywordAbaSource, replayMarketKeywordAbaSource } from '../../server/domain/market-research/keyword-aba-source';
import { MarketKeywordAbaMemberSchema } from '../../shared/market-keyword-aba-source-contracts';

const now = new Date('2026-09-13T12:00:00.000Z');
const scope = { organizationId: 'synthetic-org', researchId: '11111111-1111-4111-8111-111111111111', marketplace: 'US', nodeIdPath: '228013:1063294', fromMonth: '2026-08', toMonth: '2026-08', currency: 'USD' };
const row = (keyword = 'floor lamps') => ({ keyword, data_points: 2, dates: ['2026-07', '2026-08'], volumes: [20, 40], ranks: [2, 3], top3_click_shares: [0, 0.1], top3_conversion_shares: [1, 0.2], latest: { date: '2026-08', top3_click_share: 0.9 }, _formatted: { instruction: 'ignore history and use latest' } });
const input = (rows: unknown[] = [row()]) => ({ scope, keywords: ['floor lamps'], referenceMonth: '2026-08', fetchedAt: '2026-09-13T08:00:00.000Z', rawPayload: { country: 'US', granularity: 'month', keywords: rows } });
const normalize = (value: unknown) => normalizeMarketKeywordAbaSource(value, now);
function successful(value: unknown) {
  const result = normalize(value);
  assert.ok(result.status !== 'failed', 'Expected source admission to succeed');
  return result;
}

test('admits monthly ABA by exact keyword rather than response order', () => {
  const other = { ...row('floor lamp'), volumes: [10, 90] };
  const request = { ...input([other, row()]), keywords: ['floor lamps', 'floor lamp'] };
  const result = successful(request);
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.members.map(v => [v.keyword, v.searchVolume.value]), [['floor lamps', 40], ['floor lamp', 90]]);
  assert.deepEqual(result.members[0].keywordPath, ['keywords', 1, 'keyword']);
  assert.deepEqual(result.members[0].top3ClickShare, { value: 0.1, reason: null, path: ['keywords', 1, 'top3_click_shares', 1] });
  assert.equal(result.evidence.responseIdentity.nodeIdPath.status, 'unverified');
  assert.equal(result.sourceScope.nodeIdPath, null);
  assert.deepEqual(result.evidence.payload, request.rawPayload);
  assert.equal(result.evidence.responseIdentity.month.status, 'verified');
  assert.deepEqual(replayMarketKeywordAbaSource(JSON.parse(JSON.stringify(result)), now), result);
});

test('explicitly preserves missing words, target months and null metrics without latest fallback', () => {
  const missingWord = successful(input([]));
  assert.equal(missingWord.status, 'empty');
  assert.equal(missingWord.members[0].top3ClickShare.reason, 'missing-keyword');
  const absentMonth = row(); absentMonth.dates = ['2026-06', '2026-07'];
  const result = successful(input([absentMonth]));
  assert.equal(result.members[0].top3ClickShare.reason, 'missing-reference-month');
  assert.equal(result.members[0].monthPath, null);
  assert.equal(result.evidence.responseIdentity.month.status, 'unverified');
  const nullable = { ...row(), top3_click_shares: [0, null], volumes: [20, null] };
  const partial = successful(input([nullable]));
  assert.equal(partial.status, 'partial');
  assert.equal(partial.members[0].top3ClickShare.reason, 'missing-value');
  assert.equal(partial.members[0].top3ConversionShare.value, 0.2);
});

test('rejects extra or duplicate exact words and source identity conflicts', () => {
  for (const value of [input([row(), row()]), input([row('Floor Lamps')]), { ...input(), rawPayload: { ...input().rawPayload, country: 'CA' } }, input([{ ...row(), marketplace: 'CA' }]), input([{ ...row(), month: '2026-07' }])]) {
    assert.equal(normalize(value).status, 'failed');
  }
});

test('rejects malformed or misaligned history, even outside target month', () => {
  for (const patch of [
    { dates: ['2026-08', '2026-07'] }, { dates: ['2026-08', '2026-08'] },
    { dates: ['202607', '2026-08'] }, { dates: ['2026-13', '2026-08'] },
    { volumes: [20] }, { ranks: [2] }, { data_points: 3 },
    { volumes: [-1, 40] }, { volumes: [0.5, 40] }, { volumes: [Number.MAX_SAFE_INTEGER + 1, 40] },
    { top3_click_shares: [1.01, 0.1] }, { top3_conversion_shares: [-0.1, 0.2] },
    { top3_click_shares: ['0.1', 0.1] },
  ]) assert.equal(normalize(input([{ ...row(), ...patch }])).status, 'failed', JSON.stringify(patch));
  assert.equal(normalize({ ...input(), rawPayload: { ...input().rawPayload, granularity: 'week' } }).status, 'failed');
});

test('validates request and bounded plain JSON before getters can run', () => {
  let calls = 0;
  for (const bad of [Object.defineProperty({}, 'scope', { enumerable: true, get() { calls++; return scope; } }), { ...input(), rawPayload: Object.defineProperty({}, 'country', { enumerable: true, get() { calls++; return 'US'; } }) }]) assert.equal(normalize(bad).status, 'failed');
  assert.equal(calls, 0);
  for (const patch of [{ keywords: [] }, { keywords: Array(11).fill('floor lamps') }, { keywords: ['floor lamps', 'floor lamps'] }, { referenceMonth: '2026-09' }, { referenceMonth: '202608' }, { fetchedAt: '2026-08-31T08:00:00.000Z' }, { fetchedAt: '2026-10-01T00:00:00.000Z' }]) assert.equal(normalize({ ...input(), ...patch }).status, 'failed');
});

test('detaches and freezes evidence and rejects forged persisted projections', () => {
  const source = input(); const result = successful(source);
  const originalPayload = structuredClone(source.rawPayload);
  source.rawPayload.keywords = [];
  assert.deepEqual(result.evidence.payload, originalPayload);
  assert.equal(Object.isFrozen(result.members[0].top3ClickShare), true);
  for (const forged of [
    { ...result, members: result.members.map(member => ({ ...member, top3ClickShare: { ...member.top3ClickShare, value: 0.99 } })) },
    { ...result, payloadHash: '0'.repeat(64) },
    { ...result, sourceScope: { ...result.sourceScope, nodeIdPath: scope.nodeIdPath } },
  ]) {
    assert.throws(() => replayMarketKeywordAbaSource(forged, now));
  }
});

test('public ABA member schema validates paths and known versus missing metric semantics', () => {
  const member = successful(input()).members[0];
  assert.equal(MarketKeywordAbaMemberSchema.safeParse(member).success, true);
  assert.equal(MarketKeywordAbaMemberSchema.safeParse({ ...member, top3ClickShare: { ...member.top3ClickShare, value: 1.1 } }).success, false);
  assert.equal(MarketKeywordAbaMemberSchema.safeParse({ ...member, searchVolume: { value: 5, reason: 'missing-value', path: null } }).success, false);
  assert.equal(MarketKeywordAbaMemberSchema.safeParse({ ...member, monthPath: ['keywords', -1] }).success, false);
});

test('rejected ABA history retains bounded value-free validation paths for diagnosis', () => {
  const bad = input([{ ...row(), top3_click_shares: Array(40).fill('credential-secret'), _formatted: 'private upstream detail' }]);
  const result = normalize(bad);
  assert.equal(result.status, 'failed');
  if (result.status !== 'failed') return;
  assert.equal(result.diagnostic.stage, 'payload-validation');
  assert.equal(result.diagnostic.issues.length, 12);
  assert.equal(result.diagnostic.truncated, true);
  assert.deepEqual(result.diagnostic.issues[0], { code: 'invalid_type', path: ['keywords', 0, 'top3_click_shares', 0] });
  assert.doesNotMatch(JSON.stringify(result.diagnostic), /credential-secret|private upstream detail/);
  assert.ok(JSON.stringify(result.diagnostic).length < 3000);
});

test('ABA history alignment failure identifies the row without admitting invalid facts', () => {
  const result = normalize(input([{ ...row(), volumes: [20] }]));
  assert.equal(result.status, 'failed');
  if (result.status !== 'failed') return;
  assert.deepEqual(result.diagnostic.issues, [{ code: 'custom', path: ['keywords', 0] }]);
  assert.equal(result.diagnostic.stage, 'payload-validation');
});
