import { z } from 'zod';
import { MARKET_SOURCE_HANDLER_VERSION } from '../../../shared/market-source-contracts';
import type { CreateMarketModuleRunInput, MarketModuleRunView, MarketExecutionStep, MarketStepDefinition } from '../../db/market-module-execution-repository';
import { MarketThemePoolCatalogSchema } from './customer-theme-source-pool';
import { MARKET_THEME_MAPPING_RULE_VERSION } from './customer-theme-mapping-rules';
import { canonicalJsonSha256 as digest } from '../../runtime/model-request-accounting';
import { inspectMarketThemeReconciliationFlow } from './customer-theme-reconciliation-flow';

export const MARKET_THEME_FLOW_VERSION = 'market-theme-flow/v1';
// Old runs retain v1; new runs opt into the versioned reconciliation journal.
export const MARKET_THEME_RECONCILED_FLOW_VERSION = 'market-theme-flow/v2';
export const MARKET_THEME_RULES_FLOW_VERSION = 'market-theme-flow/rules-v1';
export const MarketThemeFlowParamsSchema = z.object({ flow: z.enum([MARKET_THEME_FLOW_VERSION,MARKET_THEME_RECONCILED_FLOW_VERSION,MARKET_THEME_RULES_FLOW_VERSION]), memberCount: z.number().int().min(1).max(20),
  poolSize: z.number().int().min(1).max(100), newProductMonths: z.union([z.literal(1), z.literal(3), z.literal(6), z.literal(12)]),
  catalog: MarketThemePoolCatalogSchema, topN: z.number().int().min(0).max(2000).optional() }).strict().refine(p => p.poolSize >= p.memberCount);
const obj = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const inputId = z.string().regex(/^market-input:[a-f0-9]{64}$/), sourceId = z.string().regex(/^market-source:[a-f0-9]{64}$/);
const asins = z.array(z.string().regex(/^[A-Z0-9]{10}$/)).max(20);
const success = (s: MarketExecutionStep) => s.status === 'succeeded' || s.status === 'empty';
const terminal = (s: MarketExecutionStep) => success(s) || s.status === 'failed';
const key = (phase: string, basis: unknown) => `theme-flow/${phase}:${digest(basis)}`;
type Request = Pick<CreateMarketModuleRunInput, 'scope' | 'moduleKind' | 'params' | 'versions'>;

function params(request: Request) {
  const p = MarketThemeFlowParamsSchema.parse(request.params);
  const rulesOnly = p.flow === MARKET_THEME_RULES_FLOW_VERSION;
  if (request.moduleKind !== 'customer-themes' || request.versions.source !== MARKET_SOURCE_HANDLER_VERSION || request.versions.planner !== p.flow ||
    request.versions.rule !== MARKET_THEME_MAPPING_RULE_VERSION || request.versions.mapping !== p.catalog.mappingVersion ||
    (rulesOnly ? request.versions.model !== null || request.versions.configuration !== null || request.versions.prompt !== null : request.versions.model !== 'market.semantic.text.v1' || !request.versions.configuration || !request.versions.prompt)) throw new TypeError('Theme flow versions differ');
  return p;
}
export function isMarketThemeFlow(request: { params: unknown }) { return [MARKET_THEME_FLOW_VERSION,MARKET_THEME_RECONCILED_FLOW_VERSION,MARKET_THEME_RULES_FLOW_VERSION].includes(String(obj(request.params).flow)); }
export function marketThemeFlowInitialSteps(request: Request): MarketStepDefinition[] {
  const p = params(request);
  return [{ stepKey: 'theme-flow/anchor', kind: 'collect-product-month', subject: { flow: p.flow }, input: { month: request.scope.toMonth,
    poolSize: p.poolSize, newProductMonths: p.newProductMonths }, inputRefs: [] }];
}

/** Called while the run is locked, after durable settlement. Plans one frontier
 * only; no polling, model calls or arbitrary workflow expressions. Immutable
 * attempt identities prevent an old source/model completion advancing a new pool. */
export function inspectMarketThemeContinuation(view: MarketModuleRunView, now: string): { children: MarketStepDefinition[]; currentStepKeys: string[] } {
  const current = new Set<string>(), result = (children: MarketStepDefinition[] = []) => ({ children, currentStepKeys: [...current] });
  if (!isMarketThemeFlow(view.run) || view.run.status === 'cancelled') return result();
  const p = params(view.run); z.string().datetime().parse(now);
  const one = (found: MarketExecutionStep[]) => { if (found.length !== 1) throw new TypeError('Theme flow frontier is missing or ambiguous'); return found[0]; };
  const attempt = (s: MarketExecutionStep) => {
    const a = view.attempts.find(a => a.id === s.latestAttemptId && a.stepId === s.id);
    if (!a || (a.status !== s.status && !(s.status === 'failed' && a.status === 'interrupted'))) throw new TypeError('Theme flow terminal attempt differs');
    return a.status === 'interrupted' ? { ...a, status: 'failed' as const } : a;
  };
  const findKey = (stepKey: string) => view.steps.find(s => s.stepKey === stepKey);
  const anchor = one(view.steps.filter(s => s.stepKey === 'theme-flow/anchor'));
  current.add(anchor.stepKey); if (!success(anchor)) return result();
  const anchorAttempt = attempt(anchor), selectedKey = key('select', anchorAttempt.id), selectedStep = findKey(selectedKey);
  current.add(selectedKey);
  if (!selectedStep) return result([{ stepKey: selectedKey, kind: 'prepare-members', subject: { flow: p.flow, anchorAttemptId: anchorAttempt.id },
    input: { phase: 'select-theme-members', inputSnapshotId: inputId.parse(obj(anchorAttempt.output).inputSnapshotId), count: p.memberCount, catalog: p.catalog },
    inputRefs: [{ kind: 'step-output', id: anchorAttempt.id }, { kind: 'input', id: inputId.parse(obj(anchorAttempt.output).inputSnapshotId) }] }]);
  if (!success(selectedStep)) return result();
  const selectedAttempt = attempt(selectedStep), selected = obj(selectedAttempt.output);
  const selectionInputSnapshotId = inputId.parse(selected.selectionInputSnapshotId), selectedAsins = asins.parse(selected.selectedAsins);
  if (new Set(selectedAsins).size !== selectedAsins.length) throw new TypeError('Duplicate theme selection');
  const report = (basis: 'rules' | 'empty-selection', a: ReturnType<typeof attempt>, snapshotId: string) => {
    const reportKey = key('report', { basis, attemptId: a.id }); current.add(reportKey);
    return result(findKey(reportKey) ? [] : [{ stepKey: reportKey, kind: 'report', subject: { flow: p.flow }, input: {
      task: 'customer-theme-report', basis, ...(basis === 'rules' ? { rulesAttemptId: a.id } : { selectionAttemptId: a.id }), inputSnapshotId: snapshotId,
    }, inputRefs: [{ kind: 'step-output', id: a.id }, { kind: 'input', id: snapshotId }] }]);
  };
  if (!selectedAsins.length) return report('empty-selection', selectedAttempt, selectionInputSnapshotId);
  const sources = selectedAsins.map(asin => one(view.steps.filter(s => s.kind === 'collect-customer-themes' && obj(s.input).asin === asin && obj(s.input).selectionInputSnapshotId === selectionInputSnapshotId)));
  sources.forEach(s => current.add(s.stepKey)); if (sources.some(s => !terminal(s))) return result();
  const sourceAttempts = sources.map(attempt), sourceBasis = { selectionAttemptId: selectedAttempt.id, sourceAttempts: sourceAttempts.map(a => ({ id: a.id, status: a.status })) };
  const poolKey = key('pool', sourceBasis), poolStep = findKey(poolKey);
  current.add(poolKey);
  if (!poolStep) {
    const observations = sourceAttempts.filter(a => a.status !== 'failed').map(a => ({ inputSnapshotId: inputId.parse(obj(a.output).inputSnapshotId), sourceRef: sourceId.parse(obj(a.output).sourceRef) }));
    return result([{ stepKey: poolKey, kind: 'prepare-members', subject: { flow: p.flow, frontierHash: digest(sourceBasis) }, input: {
      phase: 'assemble-theme-pool', selectionInputSnapshotId, selectedAsins, catalog: p.catalog, dataCutoffAt: now,
      selectionRevision: `theme-selection:${digest(selectionInputSnapshotId)}`, observations, failedAttemptIds: sourceAttempts.filter(a => a.status === 'failed').map(a => a.id),
    }, inputRefs: [{ kind: 'input', id: selectionInputSnapshotId }, { kind: 'step-output', id: selectedAttempt.id },
      ...observations.flatMap(o => [{ kind: 'input' as const, id: o.inputSnapshotId }, { kind: 'source' as const, id: o.sourceRef }])] }]);
  }
  if (!success(poolStep)) return result();
  const poolAttempt = attempt(poolStep), pool = obj(poolAttempt.output), semanticInputSnapshotId = inputId.parse(pool.semanticInputSnapshotId);
  let preparationAttemptId: string | null = null, preparationReceiptId: string | null = null;
  let modelSteps: MarketExecutionStep[] = [];
  if (pool.semanticStatus !== 'no-input' && p.flow !== MARKET_THEME_RULES_FLOW_VERSION) {
    const preparation = one(view.steps.filter(s => s.kind === 'prepare-model-batches' && obj(s.input).inputSnapshotId === semanticInputSnapshotId));
    current.add(preparation.stepKey); if (!terminal(preparation)) return result();
    const prepared = attempt(preparation); preparationAttemptId = prepared.id;
    if (success(preparation)) {
      preparationReceiptId = prepared.id;
      const manifest = z.array(z.object({ bindingId: z.string().uuid(), inputDigest: z.string().regex(/^[a-f0-9]{64}$/) })).max(2000).parse(obj(prepared.output).batches);
      if (new Set(manifest.map(b => b.bindingId)).size !== manifest.length) throw new TypeError('Duplicate theme model binding');
      modelSteps = manifest.map(b => one(view.steps.filter(s => s.kind === 'model-batch' && obj(s.input).bindingId === b.bindingId && obj(s.input).inputDigest === b.inputDigest)));
      modelSteps.forEach(s => current.add(s.stepKey)); if (modelSteps.some(s => !terminal(s))) return result();
    }
  }
  const modelAttempts = modelSteps.map(attempt), modelBasis = { poolAttemptId: poolAttempt.id, preparationAttemptId,
    modelAttempts: modelAttempts.map(a => ({ id: a.id, status: a.status })).sort((a, b) => a.id.localeCompare(b.id)) };
  const rulesKey = key('rules', modelBasis); current.add(rulesKey); const rulesStep = findKey(rulesKey);
  if (rulesStep) {
    if (!success(rulesStep)) return result();
    const ruled = attempt(rulesStep),semantics=obj(obj(ruled.output).semantics);
    if(p.flow===MARKET_THEME_RECONCILED_FLOW_VERSION&&semantics.reconciliationRequired===true&&z.array(z.string()).parse(semantics.unavailableMemberIds).length===0)
      return inspectMarketThemeReconciliationFlow(view,ruled.id,current);
    return report('rules', ruled, inputId.parse(obj(ruled.output).inputSnapshotId));
  }
  return result([{ stepKey: rulesKey, kind: 'rules', subject: { flow: p.flow, frontierHash: digest(modelBasis) }, input: {
    task: 'customer-theme-rules', poolAttemptId: poolAttempt.id, modelAttemptIds: modelAttempts.filter(a => a.status === 'succeeded').map(a => a.id).sort(),
    ...(preparationReceiptId ? { preparationAttemptId: preparationReceiptId } : {}), ...(p.topN !== undefined ? { topN: p.topN } : {}),
  }, inputRefs: [{ kind: 'step-output', id: poolAttempt.id }, ...(preparationReceiptId ? [{ kind: 'step-output' as const, id: preparationReceiptId }] : [])] }]);
}
export const planMarketThemeContinuation = (view: MarketModuleRunView, now: string) => inspectMarketThemeContinuation(view, now).children;
