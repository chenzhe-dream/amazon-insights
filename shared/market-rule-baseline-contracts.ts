import { z } from 'zod';
import { MarketAnalysisScopeSchema, type MarketAnalysisScope } from './market-analysis-contracts';

export const MARKET_RULE_BASELINE_MODULES = ['overview', 'shape-price', 'keywords', 'customer-themes'] as const;
export const MarketRuleBaselineStatusSchema = z.enum(['complete', 'partial', 'unavailable']);
export type MarketRuleBaselineStatus = z.infer<typeof MarketRuleBaselineStatusSchema>;

export const MarketRuleEvidenceRefSchema = z.object({
  id: z.string().trim().min(1).max(240),
  scope: MarketAnalysisScopeSchema,
}).strict();
export type MarketRuleEvidenceRef = z.infer<typeof MarketRuleEvidenceRefSchema>;

export const MarketRuleMetricSchema = z.object({
  key: z.string().trim().min(1).max(120),
  value: z.number().finite().nullable(),
  unit: z.string().trim().min(1).max(40),
  denominator: z.number().finite().nullable(),
  status: MarketRuleBaselineStatusSchema,
  missingReason: z.string().trim().min(1).max(400).nullable(),
  evidenceRefs: z.array(MarketRuleEvidenceRefSchema).max(200),
}).strict();
export type MarketRuleMetric = z.infer<typeof MarketRuleMetricSchema>;

export const MarketRuleFactSchema = z.object({
  id: z.string().trim().min(1).max(160),
  label: z.string().trim().min(1).max(240),
  value: z.union([z.number().finite(), z.string().trim().min(1).max(500), z.null()]),
  status: MarketRuleBaselineStatusSchema,
  sourceRefs: z.array(MarketRuleEvidenceRefSchema).max(200),
}).strict();
export type MarketRuleFact = z.infer<typeof MarketRuleFactSchema>;

export const MarketRuleMissingSchema = z.object({
  key: z.string().trim().min(1).max(120),
  reason: z.string().trim().min(1).max(400),
}).strict();

export const MarketRuleBaselineSchema = z.object({
  module: z.enum(MARKET_RULE_BASELINE_MODULES),
  ruleVersion: z.string().trim().min(1).max(160),
  scope: MarketAnalysisScopeSchema,
  status: MarketRuleBaselineStatusSchema,
  metrics: z.array(MarketRuleMetricSchema).max(500),
  facts: z.array(MarketRuleFactSchema).max(500),
  missing: z.array(MarketRuleMissingSchema).max(500),
  evidenceRefs: z.array(MarketRuleEvidenceRefSchema).max(500),
}).strict();
export type MarketRuleBaseline = z.infer<typeof MarketRuleBaselineSchema>;

function sameScope(left: MarketAnalysisScope, right: MarketAnalysisScope): boolean {
  return left.organizationId === right.organizationId
    && left.researchId === right.researchId
    && left.marketplace === right.marketplace
    && left.nodeIdPath === right.nodeIdPath
    && left.fromMonth === right.fromMonth
    && left.toMonth === right.toMonth
    && left.currency === right.currency;
}

function assertInScope(scope: MarketAnalysisScope, refs: readonly MarketRuleEvidenceRef[], label: string): void {
  for (const ref of refs) {
    if (!sameScope(scope, ref.scope)) throw new Error(`${label} cites evidence outside the frozen scope`);
  }
}

function derivedStatus(baseline: MarketRuleBaseline): MarketRuleBaselineStatus {
  const known = baseline.metrics.some(metric => metric.value !== null) || baseline.facts.some(fact => fact.value !== null);
  const missing = baseline.metrics.some(metric => metric.value === null) || baseline.facts.some(fact => fact.value === null) || baseline.missing.length > 0;
  if (known && missing) return 'partial';
  if (missing) return 'unavailable';
  return 'complete';
}

/** Accept a rule baseline only when known values carry in-scope evidence and gaps stay null. */
export function normalizeMarketRuleBaseline(input: unknown): MarketRuleBaseline {
  const parsed = MarketRuleBaselineSchema.parse(input);
  const missingKeys = new Set(parsed.missing.map(item => item.key));
  for (const metric of parsed.metrics) {
    assertInScope(parsed.scope, metric.evidenceRefs, metric.key);
    if (metric.value === null) {
      if (!metric.missingReason) throw new Error(`${metric.key} is missing without a reason`);
      if (metric.status !== 'unavailable') throw new Error(`${metric.key} missing status must be unavailable`);
      if (metric.evidenceRefs.length > 0) throw new Error(`${metric.key} missing value cannot carry evidence`);
      continue;
    }
    if (metric.missingReason || missingKeys.has(metric.key)) throw new Error(`${metric.key} known value cannot be recorded as missing`);
    if (metric.evidenceRefs.length === 0) throw new Error(`${metric.key} known value requires evidence`);
    if (metric.status === 'unavailable') throw new Error(`${metric.key} known value cannot be unavailable`);
  }
  for (const fact of parsed.facts) {
    assertInScope(parsed.scope, fact.sourceRefs, fact.id);
    if (fact.value === null) {
      if (fact.status !== 'unavailable' || fact.sourceRefs.length > 0) throw new Error(`${fact.id} missing fact requires an unavailable status and no sources`);
      continue;
    }
    if (fact.sourceRefs.length === 0 || fact.status === 'unavailable') throw new Error(`${fact.id} known fact requires in-scope sources`);
  }
  assertInScope(parsed.scope, parsed.evidenceRefs, 'baseline');
  const status = derivedStatus(parsed);
  if (parsed.status !== status) throw new Error(`baseline status ${parsed.status} does not match ${status}`);
  return {
    ...parsed,
    scope: { ...parsed.scope },
    metrics: parsed.metrics.map(metric => ({
      ...metric,
      evidenceRefs: metric.evidenceRefs.map(ref => ({ ...ref, scope: { ...ref.scope } })),
    })),
    facts: parsed.facts.map(fact => ({
      ...fact,
      sourceRefs: fact.sourceRefs.map(ref => ({ ...ref, scope: { ...ref.scope } })),
    })),
    missing: parsed.missing.map(item => ({ ...item })),
    evidenceRefs: parsed.evidenceRefs.map(ref => ({ ...ref, scope: { ...ref.scope } })),
  };
}
