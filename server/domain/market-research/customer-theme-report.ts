import { z } from 'zod';
import type { MarketInputSnapshot } from '../../../shared/market-analysis-contracts';
import { MarketThemeReadinessCountsSchema, MarketThemeReportSchema } from '../../../shared/market-module-contracts';
import type { MarketModuleRunView, MarketStepDefinition } from '../../db/market-module-execution-repository';
import { MarketThemeFlowParamsSchema, MARKET_THEME_RULES_FLOW_VERSION, MARKET_THEME_RULES_FLOW_V2, MARKET_THEME_RULES_FLOW_V3 } from './customer-theme-flow';
import { MARKET_THEME_MAPPING_RULE_VERSION } from './customer-theme-mapping-rules';
import { MARKET_SOURCE_HANDLER_VERSION } from '../../../shared/market-source-contracts';
import { canonicalJsonSha256 as digest } from '../../runtime/model-request-accounting';
import { restoreMarketThemeEvaluation } from './customer-theme-evaluation-reader';
import { MARKET_THEME_EVALUATION_VERSION, MarketThemeEvaluationInputSchema } from './customer-theme-reconciliation-artifact';

export const MARKET_THEME_REPORT_VERSION = 'market-theme-report/v1';
export const MARKET_THEME_RECONCILED_REPORT_VERSION = 'market-theme-report/v2';
export const MARKET_THEME_RULE_REPORT_VERSION = 'market-theme-report/v3';
const readinessSchema = MarketThemeReadinessCountsSchema;
export function classifyMarketThemeReport(value: z.input<typeof readinessSchema>) {
  const p = readinessSchema.parse(value);
  if (p.selectedCount > p.requestedCount || p.selectedCount !== p.successfulCount + p.emptyCount + p.failedCount + p.missingCount ||
    p.expectedMemberCount !== p.validatedMemberCount + p.unavailableCount || p.validatedMemberCount !== p.mappedMemberCount + p.unknownCount ||
    (p.successfulCount === 0) !== (p.expectedMemberCount === 0)) throw new TypeError('Theme report coverage partitions differ');
  const reasons: string[] = [];
  if (p.selectedCount < p.requestedCount) reasons.push('selection-shortfall');
  if (!p.successfulCount) reasons.push('no-theme-data');
  if (p.emptyCount) reasons.push('empty-asins');
  if(p.quarantinedThemeCount)reasons.push('quarantined-themes');
  if (p.failedCount || p.missingCount) reasons.push('source-results-missing');
  if (p.unavailableCount) reasons.push('model-results-missing');
  if (p.unknownCount) reasons.push('unknown-themes');
  if (p.reconciliationRequired) reasons.push('reconciliation-required');
  return { status: !p.successfulCount ? 'no-data' as const : reasons.length ? 'partial' as const : 'complete' as const,
    dataReady: p.successfulCount > 0, semanticsReady: p.expectedMemberCount > 0 && !p.unavailableCount && !p.unknownCount && !p.reconciliationRequired,
    counts: p, reasons };
}
const inputId = z.string().regex(/^market-input:[a-f0-9]{64}$/);
export const MarketThemeReportStepInputSchema = z.discriminatedUnion('basis', [
  z.object({ task: z.literal('customer-theme-report'), basis: z.literal('rules'), rulesAttemptId: z.string().uuid(), inputSnapshotId: inputId }).strict(),
  z.object({ task: z.literal('customer-theme-report'), basis: z.literal('empty-selection'), selectionAttemptId: z.string().uuid(), inputSnapshotId: inputId }).strict(),
  z.object({ task: z.literal('customer-theme-report'), basis: z.literal('reconciliation-evaluation'), evaluationAttemptId: z.string().uuid(), inputSnapshotId: inputId }).strict(),
]);
const obj = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const same = (a: unknown, b: unknown) => { if (digest(a) !== digest(b)) throw new TypeError('Theme report lineage differs'); };
const asins = z.array(z.string().regex(/^[A-Z0-9]{10}$/)).max(20);

/** Validate the saved envelope against rebuilt evidence without rewriting history.
 * Pre-rules v1/v2 reports predate the two separate readiness fields. */
export function restoreMarketThemeReportEnvelope(rebuilt: ReturnType<typeof createMarketThemeReport>, stored: unknown) {
  const parsed = MarketThemeReportSchema.safeParse(stored);
  if (!parsed.success) return null;
  if (digest(rebuilt) === digest(stored)) return parsed.data;
  if (!['market-theme-flow/v1', 'market-theme-flow/v2'].includes(rebuilt.versions.planner) ||
      Object.hasOwn(parsed.data, 'ruleStatus') || Object.hasOwn(parsed.data, 'semanticStatus')) return null;
  const { ruleStatus: _rule, semanticStatus: _semantic, reportHash: _hash, ...original } = rebuilt;
  const legacy = { ...original, reportHash: digest(original) };
  return digest(legacy) === digest(stored) ? parsed.data : null;
}

/** A bounded report envelope references the immutable rule rows instead of copying
 * counts or model output into a second, independently mutable representation. */
export function createMarketThemeReport(view: MarketModuleRunView, definition: MarketStepDefinition, snapshot: MarketInputSnapshot, priorEvaluations:readonly MarketInputSnapshot[]=[]) {
  const input = MarketThemeReportStepInputSchema.parse(definition.input), params = MarketThemeFlowParamsSchema.parse(view.run.params);
  if (view.run.moduleKind !== 'customer-themes' || definition.kind !== 'report' || snapshot.sourceVersion !== MARKET_SOURCE_HANDLER_VERSION ||
    view.run.versions.rule !== MARKET_THEME_MAPPING_RULE_VERSION) throw new TypeError('Unsupported theme report');
  same(snapshot.scope, view.run.scope); same(snapshot.snapshotId, input.inputSnapshotId);
  const basisAttemptId = input.basis === 'rules' ? input.rulesAttemptId : input.basis==='reconciliation-evaluation'?input.evaluationAttemptId:input.selectionAttemptId;
  for (const ref of [{ kind: 'input', id: input.inputSnapshotId }, { kind: 'step-output', id: basisAttemptId }])
    if (!definition.inputRefs.some(r => r.kind === ref.kind && r.id === ref.id)) throw new TypeError('Undeclared report input');
  const attempt = view.attempts.find(a => a.id === basisAttemptId), step = view.steps.find(s => s.latestAttemptId === basisAttemptId);
  if (!attempt || !step || attempt.stepId !== step.id || attempt.status !== step.status || !['succeeded', 'empty'].includes(attempt.status)) throw new TypeError('Unaccepted report basis');
  const output = obj(attempt.output);
  let selectedAsins: string[], readiness: ReturnType<typeof classifyMarketThemeReport>;
  let resultHash: string | null = null;
  let categoryName:string|null=null;
  if (input.basis === 'empty-selection') {
    if (step.kind !== 'prepare-members' || obj(step.input).phase !== 'select-theme-members' || attempt.status !== 'empty' || snapshot.kind !== 'products') throw new TypeError('Invalid empty selection report');
    same(output.selectionInputSnapshotId, snapshot.snapshotId); same(output.selectedAsins, []); same(snapshot.records, []); same(snapshot.expectedRecordIds, []);
    same(output.requestedCount, params.memberCount); selectedAsins = [];categoryName=typeof output.categoryName==='string'?output.categoryName:null;
    readiness = classifyMarketThemeReport({ requestedCount: params.memberCount, selectedCount: 0, successfulCount: 0, emptyCount: 0,
      failedCount: 0, missingCount: 0, expectedMemberCount: 0, validatedMemberCount: 0, mappedMemberCount: 0, unknownCount: 0, unavailableCount: 0, reconciliationRequired: false });
  } else if(input.basis==='reconciliation-evaluation') {
    if(step.kind!=='reconcile'||attempt.status!=='succeeded'||params.flow!=='market-theme-flow/v2')throw new TypeError('Invalid reconciliation report');
    const evaluated=MarketThemeEvaluationInputSchema.parse(step.input),restored=restoreMarketThemeEvaluation(snapshot,priorEvaluations);
    same(restored.summary.input,evaluated);
    resultHash=restored.result.resultHash;
    same(output,{version:MARKET_THEME_EVALUATION_VERSION,inputSnapshotId:snapshot.snapshotId,evaluationHash:snapshot.contentHash,
      completedRound:restored.summary.completedRound,initialRulesAttemptId:evaluated.initialRulesAttemptId,frontierHash:evaluated.frontierHash,
      status:restored.summary.status,planHash:restored.summary.afterPlanHash,resultHash});
    const {aggregation,decisions}=restored,coverage=aggregation.coverage;
    selectedAsins=asins.parse(aggregation.scope.selectedAsins);
    const unknownCount=decisions.filter(d=>d.status==='unknown').length,unavailableCount=decisions.filter(d=>d.status==='unavailable').length;
    readiness=classifyMarketThemeReport({requestedCount:params.memberCount,selectedCount:selectedAsins.length,
      successfulCount:coverage.successfulAsinCount,emptyCount:coverage.emptyAsinCount,failedCount:coverage.failedAsinCount,missingCount:coverage.missingAsinCount,
      expectedMemberCount:decisions.length,validatedMemberCount:decisions.length-unavailableCount,mappedMemberCount:decisions.filter(d=>d.status==='mapped').length,
      unknownCount,unavailableCount,reconciliationRequired:false});
    same(aggregation.dataReady,readiness.dataReady);same(aggregation.totals===null,!readiness.dataReady);
  } else {
    if (step.kind !== 'rules' || obj(step.input).task !== 'customer-theme-rules' || snapshot.kind !== 'customer-themes') throw new TypeError('Invalid rule report');
    same(output.inputSnapshotId, snapshot.snapshotId);
    const summary = obj(snapshot.records.find(r => r.id === 'summary')?.data), aggregation = obj(summary.aggregation), coverage = obj(aggregation.coverage), semantics = obj(summary.semantics);
    resultHash = z.string().regex(/^[a-f0-9]{64}$/).parse(summary.resultHash);
    same(snapshot.ruleVersion, `${MARKET_THEME_MAPPING_RULE_VERSION}:${resultHash}`);
    same(summary.artifactLayout, 'theme-rules-chunks/v1'); same(summary.mappingVersion, view.run.versions.mapping);
    same(summary.ruleVersion, MARKET_THEME_MAPPING_RULE_VERSION); same(summary.resultHash, output.resultHash);
    same(summary.dataCutoffAt, snapshot.collectedAt); same(summary.rawInputSnapshotId, output.rawInputSnapshotId); same(summary.semanticInputSnapshotId, output.semanticInputSnapshotId);
    same(coverage, output.coverage); same(semantics, output.semantics); same(aggregation.totals, output.totals);
    same(obj(summary.selection).requestedCount, params.memberCount);categoryName=typeof obj(summary.selection).categoryName==='string'?String(obj(summary.selection).categoryName):null;
    selectedAsins = asins.parse(obj(aggregation.scope).selectedAsins);
    if (new Set(selectedAsins).size !== selectedAsins.length) throw new TypeError('Duplicate report selection');
    same(coverage.selectedAsinCount, selectedAsins.length);
    readiness = classifyMarketThemeReport(readinessSchema.parse({ requestedCount: params.memberCount, selectedCount: selectedAsins.length,
      ...(coverage.quarantinedThemeCount?{quarantinedThemeCount:coverage.quarantinedThemeCount}:{}),
      successfulCount: coverage.successfulAsinCount, emptyCount: coverage.emptyAsinCount, failedCount: coverage.failedAsinCount, missingCount: coverage.missingAsinCount,
      expectedMemberCount: semantics.expectedMemberCount, validatedMemberCount: semantics.validatedMemberCount, mappedMemberCount: semantics.mappedMemberCount,
      unknownCount: z.array(z.string()).parse(semantics.unknownMemberIds).length, unavailableCount: z.array(z.string()).parse(semantics.unavailableMemberIds).length,
      reconciliationRequired: semantics.reconciliationRequired }));
    same(aggregation.dataReady, readiness.dataReady); same(aggregation.totals === null, !readiness.dataReady);
    same(attempt.status, readiness.dataReady ? 'succeeded' : 'empty');
  }
  const rulesV2 = params.flow === MARKET_THEME_RULES_FLOW_V2 || params.flow === MARKET_THEME_RULES_FLOW_V3;
  const semanticSkipped = rulesV2 || params.flow === MARKET_THEME_RULES_FLOW_VERSION;
  const reasons = rulesV2 ? readiness.reasons.filter(reason => !['model-results-missing', 'unknown-themes', 'reconciliation-required'].includes(reason)) : readiness.reasons;
  const status = rulesV2 ? !readiness.dataReady ? 'no-data' as const : reasons.length ? 'partial' as const : 'complete' as const : readiness.status;
  const report = { reportVersion: input.basis==='reconciliation-evaluation'?MARKET_THEME_RECONCILED_REPORT_VERSION:rulesV2?MARKET_THEME_RULE_REPORT_VERSION:MARKET_THEME_REPORT_VERSION, moduleRunId: view.run.id, scope: view.run.scope, versions: view.run.versions,
    basis: input.basis, basisAttemptId, inputSnapshotId: snapshot.snapshotId, resultHash, dataCutoffAt: snapshot.collectedAt,
    selectedAsins, ...(params.flow===MARKET_THEME_RULES_FLOW_V3?{categoryName}:{}),selectionBasis: 'provider-row-order', bsrTopVerified: false, metricKind: 'customers_say_topic_share',
    reviewDeduplication: 'unavailable', ...readiness, reasons, status,
    ruleStatus: rulesV2 ? status === 'no-data' ? 'unavailable' as const : status : readiness.dataReady ? 'complete' as const : readiness.status === 'partial' ? 'partial' as const : 'unavailable' as const,
    semanticStatus: semanticSkipped ? 'skipped' as const : readiness.semanticsReady ? 'complete' as const : readiness.counts.expectedMemberCount ? 'partial' as const : 'unavailable' as const };
  return { ...report, reportHash: digest(report) };
}
