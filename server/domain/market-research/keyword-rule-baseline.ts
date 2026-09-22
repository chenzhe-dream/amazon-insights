import type { MarketAnalysisScope, MarketInputSnapshot } from '../../../shared/market-analysis-contracts';
import { KEYWORD_THREE_MONTH_FORMULA_VERSION } from '../../../shared/market-keyword-rule-report-contracts';
import { buildMarketRuleBaseline, type MarketRuleBaselineSourceSnapshot } from './market-rule-baseline';

export interface KeywordRuleBaselineKeyword {
  readonly keywordId: string;
  readonly searchVolume: number | null;
  readonly searchVolumeReason: string | null;
  readonly threeMonthGrowth: number | null;
  readonly threeMonthReason: string | null;
}

/** Project an existing keyword rule report. Recommended bid is never stored as CPC. */
export function buildKeywordRuleBaseline(input: {
  scope: MarketAnalysisScope;
  sourceSnapshot: MarketRuleBaselineSourceSnapshot;
  keywords: readonly KeywordRuleBaselineKeyword[];
  clusterCount: number;
  coveredClusterCount: number | null;
  revisionId: string | null;
}) {
  const recordIds = input.sourceSnapshot.records.map(record => record.id);
  const volumeKnown = input.keywords.some(keyword => keyword.searchVolume !== null);
  const metrics = [
    ...input.keywords.flatMap(keyword => [
      {
        key: `${keyword.keywordId}:searchVolume`,
        value: keyword.searchVolume,
        unit: 'count',
        denominator: null,
        status: keyword.searchVolume === null ? 'unavailable' as const : 'complete' as const,
        missingReason: keyword.searchVolume === null ? keyword.searchVolumeReason ?? 'missing-completed-month-volume' : null,
        evidenceRecordIds: keyword.searchVolume === null ? [] : recordIds,
      },
      {
        key: `${keyword.keywordId}:threeMonthGrowth`,
        value: keyword.threeMonthGrowth,
        unit: 'fraction',
        denominator: null,
        status: keyword.threeMonthGrowth === null ? 'unavailable' as const : 'complete' as const,
        missingReason: keyword.threeMonthGrowth === null ? keyword.threeMonthReason ?? 'missing-baseline' : null,
        evidenceRecordIds: keyword.threeMonthGrowth === null ? [] : recordIds,
      },
    ]),
    {
      key: 'cpc',
      value: null,
      unit: 'USD',
      denominator: null,
      status: 'unavailable' as const,
      missingReason: 'source-provides-recommended-bid-only',
      evidenceRecordIds: [],
    },
    {
      key: 'seasonality',
      value: null,
      unit: 'label',
      denominator: null,
      status: 'unavailable' as const,
      missingReason: 'verified-seasonality-rule-evidence-unavailable',
      evidenceRecordIds: [],
    },
  ];
  const missing = [
    ...metrics.filter(metric => metric.value === null).map(metric => ({ key: metric.key, reason: metric.missingReason! })),
    ...(input.coveredClusterCount === null ? [{ key: 'cluster-coverage', reason: 'keyword clustering has not run' }] : []),
  ];
  return buildMarketRuleBaseline({
    module: 'keywords',
    scope: input.scope,
    sourceSnapshot: input.sourceSnapshot,
    projection: {
      ruleVersion: input.revisionId ? `${KEYWORD_THREE_MONTH_FORMULA_VERSION}+revision:${input.revisionId}` : KEYWORD_THREE_MONTH_FORMULA_VERSION,
      status: volumeKnown ? 'partial' : 'unavailable',
      metrics,
      facts: [{
        id: 'cluster-coverage',
        label: '已覆盖簇',
        value: input.coveredClusterCount === null ? null : `${input.coveredClusterCount}/${input.clusterCount}`,
        status: input.coveredClusterCount === null ? 'unavailable' as const : 'complete' as const,
        sourceRecordIds: input.coveredClusterCount === null ? [] : recordIds,
      }],
      missing,
    },
  });
}

const recordObject = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Page-pool volumes only. Trend comparisons are not on this step, so calendar growth stays missing. */
export function keywordRuleBaselineFromPool(input: {
  scope: MarketAnalysisScope;
  snapshot: MarketInputSnapshot;
  clusterCount: number;
  revisionId?: string | null;
}) {
  const keywords = input.snapshot.records.map(record => {
    const member = recordObject(recordObject(record.data).member);
    const volume = recordObject(member.monthlySearchVolume);
    const searchVolume = typeof volume.value === 'number' ? volume.value : null;
    return {
      keywordId: record.id,
      searchVolume,
      searchVolumeReason: searchVolume === null ? (typeof volume.reason === 'string' ? volume.reason : 'missing-completed-month-volume') : null,
      threeMonthGrowth: null,
      threeMonthReason: 'missing-baseline',
    };
  });
  return buildKeywordRuleBaseline({
    scope: input.scope,
    sourceSnapshot: {
      snapshotId: input.snapshot.snapshotId,
      sourceVersion: input.snapshot.sourceVersion,
      records: input.snapshot.records.map(record => ({ id: record.id, scope: record.scope })),
    },
    keywords,
    clusterCount: input.clusterCount,
    coveredClusterCount: null,
    revisionId: input.revisionId ?? null,
  });
}
