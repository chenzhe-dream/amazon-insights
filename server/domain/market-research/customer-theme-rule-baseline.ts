import type { MarketAnalysisScope, MarketInputSnapshot } from '../../../shared/market-analysis-contracts';
import { aggregateCustomerThemes, type AggregateCustomerThemesInput, type CustomerThemesAsinInput } from './customer-themes';
import { buildMarketRuleBaseline, type MarketRuleBaselineSourceSnapshot } from './market-rule-baseline';

/** Rebuild counts from the frozen pool after a selection revision. This does not recollect or call a model. */
export function buildCustomerThemeRuleBaseline(input: {
  scope: MarketAnalysisScope;
  sourceSnapshot: MarketRuleBaselineSourceSnapshot;
  sourcePool: AggregateCustomerThemesInput;
  excludedAsins: readonly string[];
}) {
  const excluded = new Set(input.excludedAsins);
  const selectedAsins = input.sourcePool.selectedAsins.filter(asin => !excluded.has(asin));
  const selected = new Set(selectedAsins);
  const aggregation = aggregateCustomerThemes({
    ...input.sourcePool,
    selectedAsins,
    results: input.sourcePool.results.filter(result => selected.has(result.asin)),
  });
  const recordIds = input.sourceSnapshot.records.map(record => record.id);
  const totals = aggregation.totals;
  const ready = aggregation.dataReady;
  const count = (key: string, value: number) => ({
    key,
    value: ready ? value : null,
    unit: 'count',
    denominator: aggregation.coverage.successfulAsinCount,
    status: ready ? 'complete' as const : 'unavailable' as const,
    missingReason: ready ? null : 'no successful Customers Say themes in the selected sample',
    evidenceRecordIds: ready ? recordIds : [],
  });
  return buildMarketRuleBaseline({
    module: 'customer-themes',
    scope: input.scope,
    sourceSnapshot: input.sourceSnapshot,
    projection: {
      ruleVersion: 'customers-say-topic-share/v1',
      status: ready ? 'partial' : 'unavailable',
      metrics: [
        count('mention', totals?.mention ?? 0),
        count('positive', totals?.positive ?? 0),
        count('negative', totals?.negative ?? 0),
        {
          key: 'uniqueReviews',
          value: null,
          unit: 'count',
          denominator: null,
          status: 'unavailable',
          missingReason: 'Customers Say observations are not deduplicated reviews',
          evidenceRecordIds: [],
        },
      ],
      facts: [{
        id: 'sentiment-overlap',
        label: '正负是否互斥',
        value: ready ? aggregation.sentimentOverlap : null,
        status: ready ? 'complete' : 'unavailable',
        sourceRecordIds: ready ? recordIds : [],
      }],
      missing: [
        ...(ready ? [] : [{ key: 'mention', reason: 'no successful Customers Say themes in the selected sample' }]),
        { key: 'uniqueReviews', reason: 'Customers Say observations are not deduplicated reviews' },
      ],
    },
  });
}

const recordObject = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Recount the frozen sample pool. Exclusion uses this pool and does not recollect. */
export function customerThemeRuleBaselineFromRawPool(input: {
  scope: MarketAnalysisScope;
  snapshot: MarketInputSnapshot;
  selectedAsins: readonly string[];
  excludedAsins?: readonly string[];
}) {
  const results = input.snapshot.records.map(record => recordObject(record.data).result as CustomerThemesAsinInput);
  return buildCustomerThemeRuleBaseline({
    scope: input.scope,
    sourceSnapshot: {
      snapshotId: input.snapshot.snapshotId,
      sourceVersion: input.snapshot.sourceVersion,
      records: input.snapshot.records.map(record => ({ id: record.id, scope: record.scope })),
    },
    sourcePool: { selectedAsins: input.selectedAsins, results, mappings: [] },
    excludedAsins: input.excludedAsins ?? [],
  });
}
