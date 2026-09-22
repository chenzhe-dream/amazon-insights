import type { MarketAnalysisScope } from '../../../shared/market-analysis-contracts';
import { buildMarketRuleBaseline, type MarketRuleBaselineSourceSnapshot } from './market-rule-baseline';
import { analyzeShapePriceBands, type ShapePriceAnalysisInput } from './shape-price';

export function buildShapePriceRuleBaseline(input: {
  scope: MarketAnalysisScope;
  sourceSnapshot: MarketRuleBaselineSourceSnapshot;
  analysisInput: ShapePriceAnalysisInput;
  revisionId: string | null;
}) {
  const analysis = analyzeShapePriceBands(input.analysisInput);
  const recordIds = input.sourceSnapshot.records.map(record => record.id);
  const units = analysis.totals.totalUnits;
  const known = units !== null;
  return buildMarketRuleBaseline({
    module: 'shape-price',
    scope: input.scope,
    sourceSnapshot: input.sourceSnapshot,
    projection: {
      ruleVersion: input.revisionId ? `shape-price-bands/v1+revision:${input.revisionId}` : 'shape-price-bands/v1',
      status: known ? 'partial' : 'unavailable',
      metrics: [
        {
          key: 'totalUnits',
          value: units,
          unit: 'count',
          denominator: analysis.totals.linkMonthCount,
          status: known ? 'complete' : 'unavailable',
          missingReason: known ? null : 'no eligible products with price and sales',
          evidenceRecordIds: known ? recordIds : [],
        },
        {
          key: 'imageShape',
          value: null,
          unit: 'label',
          denominator: null,
          status: 'unavailable',
          missingReason: 'image evidence is not a formal shape input',
          evidenceRecordIds: [],
        },
        {
          key: 'margin',
          value: null,
          unit: 'ratio',
          denominator: null,
          status: 'unavailable',
          missingReason: 'cost inputs are not collected',
          evidenceRecordIds: [],
        },
        {
          key: 'returnRate',
          value: null,
          unit: 'ratio',
          denominator: null,
          status: 'unavailable',
          missingReason: 'return rate is not collected',
          evidenceRecordIds: [],
        },
      ],
      facts: input.revisionId ? [{
        id: 'shape-revision',
        label: '人工形态修订',
        value: input.revisionId,
        status: 'complete' as const,
        sourceRecordIds: recordIds,
      }] : [],
      missing: [
        { key: 'imageShape', reason: 'image evidence is not a formal shape input' },
        { key: 'margin', reason: 'cost inputs are not collected' },
        { key: 'returnRate', reason: 'return rate is not collected' },
        ...(known ? [] : [{ key: 'totalUnits', reason: 'no eligible products with price and sales' }]),
      ],
    },
  });
}
