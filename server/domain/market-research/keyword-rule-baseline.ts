import type { MarketAnalysisScope } from '../../../shared/market-analysis-contracts';
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
  coveredClusterCount: number;
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
  const missing = metrics.filter(metric => metric.value === null).map(metric => ({ key: metric.key, reason: metric.missingReason! }));
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
        value: `${input.coveredClusterCount}/${input.clusterCount}`,
        status: 'complete',
        sourceRecordIds: recordIds,
      }],
      missing,
    },
  });
}
