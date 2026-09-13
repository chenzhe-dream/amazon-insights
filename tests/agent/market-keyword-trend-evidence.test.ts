/* eslint-disable @typescript-eslint/no-explicit-any -- corruption tests intentionally mutate persisted JSON beyond its declared types */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readMarketKeywordTrendEvidence } from '../../server/domain/market-research/keyword-trend-evidence';
import { collectMarketKeywordTrend } from '../../server/services/market-keyword-collector';
import { createMarketInputSnapshot } from '../../server/domain/market-research/snapshot';
import { canonicalJsonSha256 as digest } from '../../server/runtime/model-request-accounting';
import { MARKET_SOURCE_HANDLER_VERSION } from '../../shared/market-source-contracts';

const scope = { organizationId: 'synthetic-org', researchId: '11111111-1111-4111-8111-111111111111', marketplace: 'US' as const, nodeIdPath: '228013:1063294', fromMonth: '2026-07', toMonth: '2026-08', currency: 'USD' as const };
const keyword = 'synthetic reading lamp';
const fetchedAt = '2026-09-12T06:00:00.000Z';
async function fixture() {
  const result = await collectMarketKeywordTrend({ scope, keyword, jobId: 'synthetic-job', connector: {
    id: 'sorftime', probe: async () => { throw Error('no probe'); }, execute: async () => ({
      source: { connectorId: 'sorftime', operation: 'keyword_trend', fetchedAt, attemptCount: 1 },
      data: { site: 'US', data: { keyword, search_volume_trend: ['2025-08 search volume 100', '2026-07 search volume 0', '2026-08 search volume 150', '2026-09 search volume 999'], search_rank_trend: ['2026-08 search rank 0'], recommended_bid_trend: ['2026-08 CPC recommended bid 0'] } },
    }),
  } }, new Date(fetchedAt));
  assert.notEqual(result.status, 'failed');
  if (result.status === 'failed') throw Error('fixture failed');
  const { evidence: source, issues, ...trend } = result;
  void issues;
  const sourceRef = `market-source:${digest(source)}`;
  const proposal = { scope, kind: 'keywords', sourceVersion: MARKET_SOURCE_HANDLER_VERSION, ruleVersion: 'source-normalization/v1', collectedAt: fetchedAt, expectedRecordIds: [result.memberId], records: [{ id: result.memberId, scope, data: { collection: 'keyword-trend', trend, sourceRef } }] };
  return JSON.parse(JSON.stringify({ scope, keyword, source, sourceRef, snapshot: createMarketInputSnapshot(proposal), proposal, result }));
}

test('saved trend replay preserves zeros, unknown currency and calendar growth semantics', async () => {
  const f = await fixture();
  const actual = await readMarketKeywordTrendEvidence(f);
  assert.deepEqual(actual, f.result);
  assert.equal(actual.months[0].searchVolume.value, 0);
  assert.equal(actual.months[1].searchRank.value, 0);
  assert.equal(actual.months[1].recommendedBid.value, 0);
  assert.equal(actual.cpcCurrency, null);
  assert.equal(actual.months[1].yoyGrowth.value, 0.5);
  assert.equal(actual.months[1].yoyGrowth.baselineMonth, '2025-08');
  assert.equal(actual.months[1].recentGrowth.reason, 'zero-baseline');
  assert.equal(actual.series.searchVolume.at(-1)?.measurement.reason, 'incomplete-month');
  assert.deepEqual(actual.evidence.units.yoyGrowth, { status: 'known', unit: 'ratio', rawUnit: 'fractional change' });
});

test('rejects altered cached numbers, currency, history and metadata even after snapshot rehash', async () => {
  const mutations = [
    (p: any) => { p.records[0].data.trend.months[1].searchVolume.value = 900; },
    (p: any) => { p.records[0].data.trend.cpcCurrency = 'USD'; },
    (p: any) => { p.records[0].data.trend.series.searchVolume[0].measurement.value = 50; },
    (p: any) => { p.records[0].data.trend.months[1].yoyGrowth.value = 50; },
    (p: any) => { p.records[0].data.trend.observedCompleteMonths = ['2026-08']; },
    (p: any) => { p.collectedAt = '2026-09-12T07:00:00.000Z'; },
    (p: any) => { p.sourceVersion = 'unsupported'; },
    (p: any) => { p.ruleVersion = 'unsupported'; },
    (p: any) => { p.records[0].data.sourceRef = 'market-source:' + '0'.repeat(64); },
    (p: any) => { p.records = []; },
    (p: any) => { p.expectedRecordIds.push('extra'); },
    (p: any) => { p.records[0].id = 'other'; p.expectedRecordIds = ['other']; },
  ];
  for (const mutate of mutations) {
    const f = await fixture(); mutate(f.proposal); f.snapshot = createMarketInputSnapshot(f.proposal);
    await assert.rejects(readMarketKeywordTrendEvidence(f));
  }
});

test('rejects scope, reference, immutable snapshot and source identity mutations', async () => {
  for (const mutate of [
    (f: any) => { f.scope = { ...f.scope, researchId: '22222222-2222-4222-8222-222222222222' }; },
    (f: any) => { f.keyword = 'another keyword'; },
    (f: any) => { f.sourceRef = 'market-source:' + '0'.repeat(64); },
    (f: any) => { f.snapshot.coverage.availableCount = 0; },
    (f: any) => { f.source.provider = 'sellerSprite'; },
    (f: any) => { f.source.operation = 'keyword_extends'; },
    (f: any) => { f.source.requestIdentity.keyword = 'another keyword'; },
    (f: any) => { f.source.responseIdentity.keyword.status = 'unverified'; },
    (f: any) => { f.source.units.recommendedBid = { status: 'known', unit: 'currency', rawUnit: 'USD', currency: 'USD' }; },
    (f: any) => { f.source.payload.data.search_volume_trend[0] = '2025-08 search volume 50'; },
  ]) {
    const f = await fixture(); mutate(f);
    // Rehash source and bind snapshot to it: raw-derived identity/data must still be checked.
    if (f.sourceRef === `market-source:${digest(f.result.evidence)}`) {
      f.sourceRef = `market-source:${digest(f.source)}`;
      f.proposal.records[0].data.sourceRef = f.sourceRef;
      if (f.snapshot.coverage.availableCount !== 0) f.snapshot = createMarketInputSnapshot(f.proposal);
    }
    await assert.rejects(readMarketKeywordTrendEvidence(f));
  }
});
