import type {MarketInputSnapshot} from '../../../shared/market-analysis-contracts';
import type {MarketOverviewAnalysis} from '../../../shared/market-overview-analysis-contracts';
import type {MarketOverviewSynthesisBasis, MarketOverviewSynthesisLeaf} from '../../../shared/market-overview-synthesis-contracts';
import {MarketSemanticRecordSchema, MarketOverviewRequestRecordSchema} from '../../../shared/market-semantic-contracts';
import {canonicalJsonSha256 as digest} from '../../runtime/model-request-accounting';
import {validateOverviewAnalysis, validateOverviewAnalysisBrief} from './overview-analysis-validation';
import {restoreMarketOverviewSemanticWindow} from './overview-semantic-windows';
import {MarketOverviewWindowPlanSchema, type MarketOverviewWindowPlan} from './overview-window-plan';
import {createMarketInputSnapshot} from './snapshot';

export type MarketOverviewSynthesisBasisInput = {
  catalog: MarketInputSnapshot;
  plan: MarketOverviewWindowPlan;
  windows: Array<{inputSnapshotId: string; attemptId: string; agentRunId: string; analysis: MarketOverviewAnalysis}>;
};

const fail = (reason: string): never => {throw new TypeError(`Invalid overview synthesis basis: ${reason}`);};
function unique(ids: readonly string[], name: string): Set<string> {
  if (ids.some(id => typeof id !== 'string' || !id.trim()) || new Set(ids).size !== ids.length) fail(`empty or duplicate ${name}`);
  return new Set(ids);
}
function semanticValue(snapshot: MarketInputSnapshot): unknown {
  const data = snapshot.records[0]?.data;
  if (!data || typeof data !== 'object' || Array.isArray(data) || !('semantic' in data)) return fail('missing semantic record');
  return data.semantic;
}
function freezeDeep<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freezeDeep);
    Object.freeze(value);
  }
  return value;
}
function requireExactCoverage(actual: readonly string[], expected: readonly string[], name: string): void {
  const supplied = unique(actual, name);
  if (supplied.size !== expected.length || expected.some(id => !supplied.has(id))) fail(`incomplete or foreign ${name}`);
}

/** Pure reconstruction only. The service caller must authorize the catalog,
 * manifest and successful persisted attempts/audits before supplying them here. */
export function buildMarketOverviewSynthesisBasis(input: MarketOverviewSynthesisBasisInput): MarketOverviewSynthesisBasis {
  const {catalog} = input;
  if (catalog.kind !== 'overview' || !['market-overview-source-catalog/v5', 'market-overview-source-catalog/v6'].includes(catalog.ruleVersion) || catalog.records.length !== 1) fail('expected complete overview catalog');
  const {scope, kind, sourceVersion, ruleVersion, collectedAt, expectedRecordIds, records} = catalog;
  const rebuilt = createMarketInputSnapshot({scope, kind, sourceVersion, ruleVersion, collectedAt, expectedRecordIds, records});
  if (digest(catalog) !== digest(rebuilt) || rebuilt.coverage.status !== 'complete') fail('catalog hash or coverage differs');
  const semantic = MarketSemanticRecordSchema.parse(semanticValue(catalog));
  if (semantic.task !== 'market-overview-explanation') return fail('expected overview semantics');
  const brief = validateOverviewAnalysisBrief(semantic);
  if (!brief) return fail('missing complete analysis brief');
  const metricIds = unique(semantic.metrics.map(metric => metric.metricId), 'metrics');
  for (const metric of semantic.metrics) {
    if ([metric.numeratorRef, metric.denominatorRef].some(id => id !== null && !metricIds.has(id))) fail('missing metric dependency');
  }
  for (const fact of semantic.facts) {
    unique(fact.metricRefs, 'fact metric references');
    if (fact.metricRefs.some(id => !metricIds.has(id))) fail('missing fact metric');
  }

  const plan = MarketOverviewWindowPlanSchema.parse(input.plan);
  if (plan.basisSnapshotId !== catalog.snapshotId || plan.dataCutoffAt !== catalog.collectedAt) fail('plan basis or cutoff differs');
  if (!plan.windows.length || plan.rejected.length) fail('incomplete window plan');
  unique(plan.windows.map(window => window.inputSnapshotId), 'planned window inputs');
  requireExactCoverage(plan.windows.flatMap(window => window.primaryFactIds), semantic.facts.map(fact => fact.factId), 'primary facts');
  requireExactCoverage(plan.windows.flatMap(window => window.gapIds), semantic.gaps.map(gap => gap.gapId), 'primary gaps');
  requireExactCoverage(input.windows.map(window => window.inputSnapshotId), plan.windows.map(window => window.inputSnapshotId), 'analysis window inputs');
  unique(input.windows.map(window => window.attemptId), 'analysis attempts');
  unique(input.windows.map(window => window.agentRunId), 'analysis audit runs');
  const byInput = new Map(input.windows.map(window => [window.inputSnapshotId, window]));
  const leaves: MarketOverviewSynthesisLeaf[] = [];

  // Manifest order is authoritative; caller retrieval order has no effect.
  for (const planned of plan.windows) {
    const restored = restoreMarketOverviewSemanticWindow(catalog, [
      ...planned.primaryFactIds.map(id => ({kind: 'fact' as const, id})),
      ...planned.gapIds.map(id => ({kind: 'gap' as const, id})),
    ]);
    if (restored.snapshot.snapshotId !== planned.inputSnapshotId) fail('restored window hash differs');
    const local = MarketOverviewRequestRecordSchema.parse(semanticValue(restored.snapshot));
    const localBrief = validateOverviewAnalysisBrief(local);
    if (!localBrief) return fail('missing window analysis brief');
    const supplied = byInput.get(planned.inputSnapshotId)!;
    const analysis = validateOverviewAnalysis(local, supplied.analysis);
    if (!analysis) return fail('missing window analysis');
    const sections = new Map(analysis.dimensions.map(section => [section.dimensionId, section]));
    for (const dimension of localBrief.dimensions) {
      leaves.push({
        leafId: `market-overview-synthesis-leaf:${digest({inputSnapshotId: planned.inputSnapshotId, dimensionId: dimension.id})}`,
        inputSnapshotId: planned.inputSnapshotId,
        attemptId: supplied.attemptId,
        agentRunId: supplied.agentRunId,
        dimensionId: dimension.id,
        primaryFactIds: dimension.factIds.filter(id => planned.primaryFactIds.includes(id)),
        primaryGapIds: dimension.gapIds.filter(id => planned.gapIds.includes(id)),
        coveredFactIds: dimension.factIds,
        coveredGapIds: dimension.gapIds,
        section: sections.get(dimension.id)!,
      });
    }
  }
  unique(leaves.map(leaf => leaf.leafId), 'synthesis leaves');
  const value = {
    version: 'market-overview-synthesis-basis/v1' as const,
    scope: catalog.scope,
    catalogSnapshotId: catalog.snapshotId,
    catalogContentHash: catalog.contentHash,
    planContentHash: digest(plan),
    numericInputSnapshotId: plan.numericInputSnapshotId,
    dataCutoffAt: plan.dataCutoffAt,
    selectionRevision: plan.selectionRevision,
    configurationVersion: plan.configurationVersion,
    scopeStatement: brief.scopeStatement,
    dimensions: brief.dimensions,
    facts: semantic.facts,
    gaps: semantic.gaps,
    metrics: semantic.metrics,
    factLabels: brief.factLabels,
    leaves,
  };
  const contentHash = digest(value);
  return freezeDeep(structuredClone({...value, contentHash, basisId: `market-overview-synthesis-basis:${contentHash}`}));
}
