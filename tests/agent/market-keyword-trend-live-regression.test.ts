import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { collectMarketKeywordTrend } from '../../server/services/market-keyword-collector';
import type { ConnectorResult, RemoteMcpConnector } from '../../server/connectors/connector-contract';
import { readMarketKeywordTrendEvidence } from '../../server/domain/market-research/keyword-trend-evidence';
import { createMarketInputSnapshot } from '../../server/domain/market-research/snapshot';
import { canonicalJsonSha256 as digest } from '../../server/runtime/model-request-accounting';
import { MARKET_SOURCE_HANDLER_VERSION } from '../../shared/market-source-contracts';
const fixture = JSON.parse(readFileSync(new URL('../fixtures/market-keyword-trend-gel-pend-20260917.json', import.meta.url), 'utf8'));
const now = new Date('2026-09-17T02:00:00.000Z');
const scope = { organizationId: 'trend-regression', researchId: '11111111-1111-4111-8111-111111111111', marketplace: 'US' as const, nodeIdPath: '1069828', fromMonth: '2026-08', toMonth: '2026-08', currency: 'USD' as const };
async function replay(response = structuredClone(fixture.result)) {
  let calls = 0;
  const connector: RemoteMcpConnector = { id: 'sorftime', async execute() { calls++; return response as ConnectorResult; }, async probe() { throw Error('no external call'); } };
  const result = await collectMarketKeywordTrend({ connector, scope, jobId: 'replay', keyword: response.data.data.keyword }, now);
  assert.equal(calls, 1);
  return result;
}
test('recorded gel pend trend retains real search volumes despite missing bids', async () => {
  const result = await replay();
  assert.equal(result.status, 'partial');
  assert.equal(result.months[0].searchVolume.value, 260);
  assert.equal(result.months[0].yoyGrowth.value, 260 / 114 - 1);
  assert.equal(result.months[0].recentGrowth.reason, 'zero-baseline');
  assert.deepEqual(result.months[0].recommendedBid, { value: null, reason: 'missing' });
  assert.equal(result.cpcCurrency, null);
  assert.ok(result.issues.some(issue => issue.code === 'duplicate-month'));
  assert.ok(result.issues.some(issue => issue.code === 'missing' && issue.path[1] === 'recommended_bid_trend'));
  assert.deepEqual(result.evidence.payload, fixture.result.data);
});
test('missing sentinel and conflicting bid remain unknown independently of source order', async () => {
  for (const values of [['-1', '0'], ['0', '-1.00'], ['1.25', '2.25', '1.25'], ['2.25', '1.25', '1.25']]) {
    const response = structuredClone(fixture.result);
    response.data.data.recommended_bid_trend = values.map(value => `2026-08 CPC recommended bid ${value}`);
    const result = await replay(response);
    assert.equal(result.status, 'partial');
    assert.equal(result.months[0].recommendedBid.value, null);
    assert.equal(result.months[0].searchVolume.value, 260);
    assert.ok(result.issues.some(issue => issue.code === 'conflicting-month'));
  }
});
test('unsupported negatives remain malformed', async () => {
  for (const token of ['-2', '-1.01', '-0', '-1e0']) {
    const response = structuredClone(fixture.result);
    response.data.data.recommended_bid_trend = [`2026-08 CPC recommended bid ${token}`];
    const result = await replay(response);
    assert.equal(result.status, 'failed', token);
  }
});
test('conflicting baseline stays unknown while current volume and independent rank survive', async () => {
  const response = structuredClone(fixture.result);
  response.data.data.search_volume_trend.push('2025-08 search volume 200', '2025-08 search volume 114');
  response.data.data.recommended_bid_trend = [];
  const result = await replay(response);
  assert.equal(result.status, 'partial');
  assert.equal(result.months[0].searchVolume.value, 260);
  assert.notEqual(result.months[0].searchRank.value, null);
  assert.equal(result.months[0].yoyGrowth.reason, 'missing-baseline');
  assert.equal(result.series.searchVolume.find(point => point.month === '2025-08')?.measurement.value, null);
});

for (const [keyword, current, baseline] of [['gel oens', 6553, 4061], ['gel pena', 404, 587]] as const) {
  test(`recorded ${keyword} response retains its independent volume and exact raw source`, async () => {
    const recorded = JSON.parse(readFileSync(new URL(`../fixtures/market-keyword-trend-${keyword.replace(' ', '-')}-20260917.json`, import.meta.url), 'utf8'));
    const result = await replay(recorded.result);
    assert.equal(result.status, 'partial');
    assert.equal(result.months[0].searchVolume.value, current);
    assert.equal(result.months[0].yoyGrowth.value, current / baseline - 1);
    assert.equal(result.months[0].recommendedBid.value, null);
    assert.deepEqual(result.evidence.payload, recorded.result.data);
  });
}

test('new partial recorded source persists and replays with intact evidence validation', async () => {
  const result = await replay();
  if (result.status === 'failed') return assert.fail();
  const { evidence: source, issues, ...trend } = result;
  void issues;
  const sourceRef = `market-source:${digest(source)}`;
  const snapshot = createMarketInputSnapshot({ scope, kind: 'keywords', sourceVersion: MARKET_SOURCE_HANDLER_VERSION,
    ruleVersion: 'source-normalization/v1', collectedAt: source.fetchedAt, expectedRecordIds: [result.memberId],
    records: [{ id: result.memberId, scope, data: { collection: 'keyword-trend', trend, sourceRef } }] }, now);
  const actual = await readMarketKeywordTrendEvidence({ scope, keyword: result.keyword, source, sourceRef, snapshot });
  assert.deepEqual(actual, result);
});
