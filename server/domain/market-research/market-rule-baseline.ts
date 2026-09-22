import type { MarketAnalysisScope } from '../../../shared/market-analysis-contracts';
import {
  normalizeMarketRuleBaseline,
  type MarketRuleBaseline,
  type MarketRuleBaselineStatus,
  type MarketRuleFact,
} from '../../../shared/market-rule-baseline-contracts';

export interface MarketRuleBaselineSourceSnapshot {
  readonly snapshotId: string;
  readonly sourceVersion: string;
  readonly records: readonly { readonly id: string; readonly scope: MarketAnalysisScope }[];
}

export interface MarketRuleBaselineProjectionMetric {
  readonly key: string;
  readonly value: number | null;
  readonly unit: string;
  readonly denominator: number | null;
  readonly status: MarketRuleBaselineStatus;
  readonly missingReason: string | null;
  readonly evidenceRecordIds: readonly string[];
}

export interface MarketRuleBaselineProjectionFact {
  readonly id: string;
  readonly label: string;
  readonly value: MarketRuleFact['value'];
  readonly status: MarketRuleBaselineStatus;
  readonly sourceRecordIds: readonly string[];
}

export interface MarketRuleBaselineAssemblyInput {
  readonly module: MarketRuleBaseline['module'];
  readonly scope: MarketAnalysisScope;
  readonly sourceSnapshot: MarketRuleBaselineSourceSnapshot;
  readonly projection: {
    readonly ruleVersion: string;
    readonly status: MarketRuleBaselineStatus;
    readonly metrics: readonly MarketRuleBaselineProjectionMetric[];
    readonly facts: readonly MarketRuleBaselineProjectionFact[];
    readonly missing: readonly { readonly key: string; readonly reason: string }[];
  };
}

function evidenceFor(snapshot: MarketRuleBaselineSourceSnapshot, scope: MarketAnalysisScope, recordId: string) {
  const record = snapshot.records.find(item => item.id === recordId);
  if (!record || record.scope.organizationId !== scope.organizationId || record.scope.researchId !== scope.researchId
    || record.scope.marketplace !== scope.marketplace || record.scope.nodeIdPath !== scope.nodeIdPath
    || record.scope.fromMonth !== scope.fromMonth || record.scope.toMonth !== scope.toMonth
    || record.scope.currency !== scope.currency) {
    throw new Error(`${recordId} is outside the frozen source snapshot`);
  }
  return { id: `${snapshot.snapshotId}:${record.id}`, scope: record.scope };
}

/** Build one rule baseline from a frozen snapshot and an existing deterministic projection. */
export function buildMarketRuleBaseline(input: MarketRuleBaselineAssemblyInput): MarketRuleBaseline {
  const cited = [
    ...input.projection.metrics.flatMap(metric => metric.evidenceRecordIds),
    ...input.projection.facts.flatMap(fact => fact.sourceRecordIds),
  ];
  return normalizeMarketRuleBaseline({
    module: input.module,
    ruleVersion: input.projection.ruleVersion,
    scope: input.scope,
    status: input.projection.status,
    metrics: input.projection.metrics.map(metric => ({
      key: metric.key,
      value: metric.value,
      unit: metric.unit,
      denominator: metric.denominator,
      status: metric.status,
      missingReason: metric.missingReason,
      evidenceRefs: metric.evidenceRecordIds.map(recordId => evidenceFor(input.sourceSnapshot, input.scope, recordId)),
    })),
    facts: input.projection.facts.map(fact => ({
      id: fact.id,
      label: fact.label,
      value: fact.value,
      status: fact.status,
      sourceRefs: fact.sourceRecordIds.map(recordId => evidenceFor(input.sourceSnapshot, input.scope, recordId)),
    })),
    missing: input.projection.missing.map(item => ({ key: item.key, reason: item.reason })),
    evidenceRefs: [...new Set(cited)].map(recordId => evidenceFor(input.sourceSnapshot, input.scope, recordId)),
  });
}
