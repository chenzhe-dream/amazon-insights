import type { MarketAnalysisScope } from '../../../shared/market-analysis-contracts';
import { MarketSemanticRecordSchema } from '../../../shared/market-semantic-contracts';
import { normalizeMarketRuleBaseline, type MarketRuleBaseline, type MarketRuleEvidenceRef } from '../../../shared/market-rule-baseline-contracts';

export interface OverviewRuleBaselineCatalog {
  readonly version: string;
  readonly semanticSnapshot: { readonly records: readonly { readonly data: unknown }[] } | null;
  readonly numericSnapshot: { readonly scope: MarketAnalysisScope };
}

/** Map a saved overview catalog into a rule baseline. Semantic synthesis is not part of this result. */
export function buildOverviewRuleBaseline(catalog: OverviewRuleBaselineCatalog): MarketRuleBaseline {
  const scope = catalog.numericSnapshot.scope;
  if (!catalog.semanticSnapshot) {
    return normalizeMarketRuleBaseline({
      module: 'overview',
      ruleVersion: catalog.version,
      scope,
      status: 'unavailable',
      metrics: [],
      facts: [],
      missing: [{ key: 'overview-catalog', reason: 'saved overview catalog has no deterministic facts' }],
      evidenceRefs: [],
    });
  }
  const semantic = MarketSemanticRecordSchema.parse((catalog.semanticSnapshot.records[0]?.data as { semantic?: unknown } | undefined)?.semantic);
  if (semantic.task !== 'market-overview-explanation') throw new Error('Expected overview catalog');
  const evidence = (id: string): MarketRuleEvidenceRef => ({ id, scope });
  const known = semantic.metrics.map(metric => ({
    key: metric.metricId,
    value: metric.value,
    unit: metric.unit.unit,
    denominator: null,
    status: 'complete' as const,
    missingReason: null,
    evidenceRefs: metric.sourceRefs.map(evidence),
  }));
  const knownKeys = new Set(known.map(metric => metric.key));
  const missingByKey = new Map<string, string>();
  for (const gap of semantic.gaps) {
    const key = gap.metricId ?? gap.gapId;
    if (!knownKeys.has(key) && !missingByKey.has(key)) missingByKey.set(key, gap.reason);
  }
  const missing = [...missingByKey].map(([key, reason]) => ({ key, reason }));
  const metrics = [
    ...known,
    ...missing.map(item => ({
      key: item.key,
      value: null,
      unit: 'count',
      denominator: null,
      status: 'unavailable' as const,
      missingReason: item.reason,
      evidenceRefs: [],
    })),
  ];
  const status = known.length && missing.length ? 'partial' as const : known.length ? 'complete' as const : 'unavailable' as const;
  return normalizeMarketRuleBaseline({
    module: 'overview',
    ruleVersion: catalog.version,
    scope,
    status,
    metrics,
    facts: [],
    missing,
    evidenceRefs: [...new Set(semantic.metrics.flatMap(metric => [...metric.sourceRefs]))].map(evidence),
  });
}
