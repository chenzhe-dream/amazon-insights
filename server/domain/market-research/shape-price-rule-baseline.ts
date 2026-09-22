import type { MarketAnalysisScope, MarketInputSnapshot } from '../../../shared/market-analysis-contracts';
import type { MarketSourceEvidence } from '../../../shared/market-source-contracts';
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

const recordObject = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Project the frozen product-month snapshot this step already holds. Unconfirmed price units stay ineligible. */
export function shapeRuleBaselineFromProductSnapshot(input: {
  snapshot: MarketInputSnapshot;
  sources: Readonly<Record<string, MarketSourceEvidence>>;
  revisionId?: string | null;
}) {
  const products = new Map<string, { asin: string; shape: null; price: number | null; brand: string | null; monthlySales: { month: string; units: number | null }[] }>();
  const months = new Set<string>();
  for (const record of input.snapshot.records) {
    const data = recordObject(record.data);
    if (data.collection !== 'product-month' || typeof data.month !== 'string') throw new TypeError('Shape baseline requires a product-month record');
    const product = recordObject(data.product);
    const asin = typeof product.asin === 'string' ? product.asin : record.id;
    const sourceRef = typeof data.sourceRef === 'string' ? data.sourceRef : '';
    const priceKnown = input.sources[sourceRef]?.units.price?.status === 'known';
    const price = priceKnown && typeof product.price === 'number' ? product.price : null;
    const units = typeof product.units === 'number' ? product.units : null;
    const brand = typeof product.brand === 'string' ? product.brand : null;
    months.add(data.month);
    const current = products.get(asin);
    if (current) current.monthlySales.push({ month: data.month, units });
    else products.set(asin, { asin, shape: null, price, brand, monthlySales: [{ month: data.month, units }] });
  }
  return buildShapePriceRuleBaseline({
    scope: input.snapshot.scope,
    sourceSnapshot: {
      snapshotId: input.snapshot.snapshotId,
      sourceVersion: input.snapshot.sourceVersion,
      records: input.snapshot.records.map(record => ({ id: record.id, scope: record.scope })),
    },
    revisionId: input.revisionId ?? null,
    analysisInput: {
      months: months.size ? [...months].sort() : [input.snapshot.scope.toMonth],
      bands: [{ id: 'all-prices', minInclusive: 0, maxExclusive: null }],
      products: [...products.values()],
    },
  });
}
