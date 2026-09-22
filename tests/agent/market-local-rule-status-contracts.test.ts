import assert from 'node:assert/strict';
import test from 'node:test';
import { MarketOverviewReportSchema } from '../../shared/market-overview-report-contracts';
import { MarketShapeRunResponseSchema } from '../../shared/market-shape-public-contracts';
import { MarketKeywordRunResponseSchema } from '../../shared/market-keyword-public-contracts';
import { MarketThemeReportSchema } from '../../shared/market-module-contracts';

const scope = { organizationId: '018f1f5c-60f0-4b7a-8000-000000000002', researchId: '60000000-0000-4000-8000-000000000002', marketplace: 'US', nodeIdPath: '12:34', fromMonth: '2026-08', toMonth: '2026-08', currency: 'USD' } as const;
const versions = { source: 'synthetic/v1', rule: 'synthetic/v1', mapping: 'synthetic/v1', planner: 'synthetic/v1', model: null, prompt: null, configuration: null } as const;

test('local rule reports expose independent rule and semantic status', () => {
  const report = MarketOverviewReportSchema.parse({
    reportVersion: 'market-overview-report/v1', moduleRunId: '60000000-0000-4000-8000-000000000001', scope,
    versions, task: 'overview-report', catalogAttemptId: '60000000-0000-4000-8000-000000000003', phase: 'numeric', windowAttemptId: null,
    preparationAttemptIds: [], modelAttemptIds: [], numericInputSnapshotId: `market-input:${'a'.repeat(64)}`, dataCutoffAt: '2026-09-12T07:00:00.000Z', sourceRefs: [], dataReady: true,
    analysisStatus: 'partial', windowStatus: 'complete', expectedWindowCount: 0, rejectedCount: 0, modelResults: [], failures: [], coverage: [], reasons: [], reportHash: 'b'.repeat(64),
    ruleStatus: 'complete', semanticStatus: 'skipped',
  });
  assert.equal(report.ruleStatus, 'complete');
  assert.equal(report.semanticStatus, 'skipped');

  assert.doesNotThrow(() => MarketShapeRunResponseSchema.parse({ run: {
    id: '60000000-0000-4000-8000-000000000001', scope, status: 'partial', params: { poolSize: 1, newProductMonths: 6, catalog: { task: 'market-product-shape-suggestion', taxonomyVersion: 'synthetic/v1', allowedLabels: [] } },
    steps: [], source: null, suggestions: { status: 'unavailable', items: [] }, latestRevision: null, history: [], ruleStatus: 'complete', semanticStatus: 'skipped',
  } }));

  assert.doesNotThrow(() => MarketKeywordRunResponseSchema.parse({ run: {
    id: '60000000-0000-4000-8000-000000000001', scope, status: 'partial', createdAt: '2026-09-12T07:00:00.000Z', params: { plannedPages: [{ seed: 'lamp', page: 1 }], maxMembers: 1, analysisMode: 'global-reconciliation/v2', catalog: { task: 'market-keyword-semantics', dictionaryVersion: 'synthetic/v1', categoryContext: 'synthetic', dimensionLabels: { W1: [], W2: [], W3: [], W4: [] }, clusterCatalog: [], discoveryMode: 'labels-and-clusters/v1', outputProtocol: 'explicit-shape/v1' } }, steps: [], facts: null, ruleStatus: 'complete', semanticStatus: 'skipped',
  } }));

  const theme = MarketThemeReportSchema.parse({
    reportVersion: 'market-theme-report/v1', moduleRunId: '60000000-0000-4000-8000-000000000001', scope, versions, basis: 'rules', basisAttemptId: '60000000-0000-4000-8000-000000000003', inputSnapshotId: `market-input:${'a'.repeat(64)}`, resultHash: null, dataCutoffAt: '2026-09-12T07:00:00.000Z', selectedAsins: [], selectionBasis: 'provider-row-order', bsrTopVerified: false, metricKind: 'customers_say_topic_share', reviewDeduplication: 'unavailable', status: 'no-data', dataReady: false, semanticsReady: false,
    counts: { requestedCount: 1, selectedCount: 0, successfulCount: 0, emptyCount: 0, failedCount: 0, missingCount: 0, expectedMemberCount: 0, validatedMemberCount: 0, mappedMemberCount: 0, unknownCount: 0, unavailableCount: 0, reconciliationRequired: false }, reasons: ['no-theme-data'], reportHash: 'b'.repeat(64), ruleStatus: 'unavailable', semanticStatus: 'skipped',
  });
  assert.equal(theme.semanticStatus, 'skipped');
});
