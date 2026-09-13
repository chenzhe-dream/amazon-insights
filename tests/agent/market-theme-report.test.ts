import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyMarketThemeReport } from '../../server/domain/market-research/customer-theme-report';

const complete = { requestedCount: 3, selectedCount: 3, successfulCount: 3, emptyCount: 0, failedCount: 0, missingCount: 0,
  expectedMemberCount: 9, validatedMemberCount: 9, mappedMemberCount: 9, unknownCount: 0, unavailableCount: 0, reconciliationRequired: false };
test('report readiness requires selected coverage and all mandatory semantic work, independently of execution success', () => {
  assert.equal(classifyMarketThemeReport(complete).status, 'complete');
  assert.deepEqual(classifyMarketThemeReport({ ...complete, requestedCount: 20 }).reasons, ['selection-shortfall']);
  assert.equal(classifyMarketThemeReport({ ...complete, successfulCount: 2, emptyCount: 1 }).status, 'partial');
  assert.deepEqual(classifyMarketThemeReport({ ...complete, mappedMemberCount: 8, unknownCount: 1 }).reasons, ['unknown-themes']);
  assert.deepEqual(classifyMarketThemeReport({ ...complete, validatedMemberCount: 8, mappedMemberCount: 8, unavailableCount: 1 }).reasons, ['model-results-missing']);
  assert.deepEqual(classifyMarketThemeReport({ ...complete, reconciliationRequired: true }).reasons, ['reconciliation-required']);
});
test('absence is no data, never a fabricated zero or completed analysis; inconsistent partitions are rejected', () => {
  const absent = { ...complete, successfulCount: 0, failedCount: 3, expectedMemberCount: 0, validatedMemberCount: 0, mappedMemberCount: 0 };
  assert.equal(classifyMarketThemeReport(absent).status, 'no-data');
  assert.deepEqual(classifyMarketThemeReport({ ...absent, selectedCount: 0, failedCount: 0 }).reasons, ['selection-shortfall', 'no-theme-data']);
  for (const bad of [{ ...complete, successfulCount: 4 }, { ...complete, unknownCount: 1 }, { ...complete, expectedMemberCount: 0 },
    { ...absent, expectedMemberCount: 1, unavailableCount: 1 }, { ...complete, selectedCount: 21 }, { ...complete, requestedCount: 2 }])
    assert.throws(() => classifyMarketThemeReport(bad));
});
