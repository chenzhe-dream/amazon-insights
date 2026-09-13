import { MarketInputRecordSchema } from '../../shared/market-analysis-contracts';
import { MARKET_SOURCE_HANDLER_VERSION } from '../../shared/market-source-contracts';
import { PostgresQueryContext } from '../db/postgres/query-context';
import { calculateMarketThemeMappingRules, MARKET_THEME_MAPPING_RULE_VERSION } from '../domain/market-research/customer-theme-mapping-rules';
import { createMarketInputSnapshot } from '../domain/market-research/snapshot';
import type { MarketStepHandler } from './market-module-step-worker';
import { loadMarketThemeRuleInputs } from './market-theme-rule-inputs';
export { MarketThemeRulesStepInputSchema } from './market-theme-rule-inputs';
const json = (v: unknown) => MarketInputRecordSchema.shape.data.parse(v);

export function createMarketThemeRulesStep(context: PostgresQueryContext): MarketStepHandler {
  return async ({ claim, signal }) => {
    const {input,view,poolInput,pool,receipt,original,batches,auditRefs}=await loadMarketThemeRuleInputs(context,claim,signal);
    const result = calculateMarketThemeMappingRules({ poolInput, batches, topN: input.topN }); signal.throwIfAborted();
    const { aggregation: { groups: rows, perAsin, mappings, ...aggregation }, groups: labels, decisions, batches: results, ...summary } = result;
    const chunks = (name: string, values: readonly unknown[], size: number) => Array.from({ length: Math.ceil(values.length / size) }, (_, i) => ({
      id: `${name}:${i}`, scope: view.run.scope, data: json({ kind: name, items: values.slice(i * size, (i + 1) * size) }) }));
    // Keep both the T1 2,000-record ceiling and its per-record JSON node bound.
    // Large pools cannot become 2,001 records or one duplicated giant summary.
    const recordsForSnapshot = [{ id: 'summary', scope: view.run.scope, data: json({ ...summary, artifactLayout: 'theme-rules-chunks/v1', aggregation, selection: receipt.selection,
      batches: results.map(({ output: _output, ...b }) => b), auditRefs: auditRefs.sort((a, b) => a.agentRunId.localeCompare(b.agentRunId)) }) },
      ...perAsin.map(a => ({ id: `asin:${a.asin}`, scope: view.run.scope, data: json(a) })), ...chunks('groups', rows, 32),
      ...chunks('decisions', decisions, 128), ...chunks('mappings', mappings, 128), ...chunks('labels', labels, 128)];
    const saved = { scope: view.run.scope, kind: 'customer-themes' as const, sourceVersion: MARKET_SOURCE_HANDLER_VERSION,
      ruleVersion: `${MARKET_THEME_MAPPING_RULE_VERSION}:${result.resultHash}`, collectedAt: original.dataCutoffAt,
      expectedRecordIds: recordsForSnapshot.map(r => r.id), records: recordsForSnapshot };
    const snapshot = createMarketInputSnapshot(saved);
    return { kind: 'settlement', value: { inputs: [json(saved)], outcome: { status: result.aggregation.dataReady ? 'succeeded' : 'empty',
      output: { inputSnapshotId: snapshot.snapshotId, resultHash: result.resultHash, ruleVersion: MARKET_THEME_MAPPING_RULE_VERSION,
        rawInputSnapshotId: pool.rawSnapshot.snapshotId, semanticInputSnapshotId: pool.semanticSnapshot.snapshotId,
        coverage: result.aggregation.coverage, semantics: result.semantics, totals: result.aggregation.totals } } } };
  };
}
