import { z } from 'zod';
import type { MarketInputSnapshot, MarketJsonValue } from '../../shared/market-analysis-contracts';
import { MARKET_SOURCE_HANDLER_VERSION, type MarketSourceEvidence } from '../../shared/market-source-contracts';
import { PostgresQueryContext } from '../db/postgres/query-context';
import { PostgresMarketModuleExecutionStore } from '../db/postgres/market-module-execution-store';
import { PostgresMarketAnalysisSnapshotStore } from '../db/postgres/market-analysis-snapshot-store';
import { selectMarketThemeMembers, assembleMarketThemePool, MarketThemePoolCatalogSchema } from '../domain/market-research/customer-theme-source-pool';
import { customerThemeRuleBaselineFromRawPool } from '../domain/market-research/customer-theme-rule-baseline';
import { canonicalJsonSha256 as digest } from './model-request-accounting';
import type { MarketStepHandler, MarketStepWork } from './market-module-step-worker';
import type {MarketStepDefinition} from '../db/market-module-execution-repository';

const id = z.string().regex(/^market-input:[a-f0-9]{64}$/);
const obj=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
export const MarketThemePoolStepInputSchema = z.discriminatedUnion('phase', [
  z.object({ phase: z.literal('select-theme-members'), inputSnapshotId: id, count: z.number().int().min(1).max(20), catalog: MarketThemePoolCatalogSchema }).strict(),
  z.object({ phase: z.literal('assemble-theme-pool'), selectionInputSnapshotId: id, selectedAsins: z.array(z.string().regex(/^[A-Z0-9]{10}$/)).min(1).max(20),
    catalog: MarketThemePoolCatalogSchema, dataCutoffAt: z.string().datetime(), selectionRevision: z.string().min(1).max(160),
    observations: z.array(z.object({ inputSnapshotId: id, sourceRef: z.string().regex(/^market-source:[a-f0-9]{64}$/) }).strict()).max(20),
    failedAttemptIds: z.array(z.string().uuid()).max(20), imageAttemptIds: z.array(z.string().uuid()).max(20).optional() }).strict(),
]);
function invalid(): never { throw new z.ZodError([{ code: 'custom', path: [], message: 'Theme pool execution binding is unavailable' }]); }
const factory = (s: MarketInputSnapshot): MarketJsonValue => JSON.parse(JSON.stringify({ scope: s.scope, kind: s.kind, sourceVersion: s.sourceVersion,
  ruleVersion: s.ruleVersion, collectedAt: s.collectedAt, expectedRecordIds: s.expectedRecordIds, records: s.records }));

export function createMarketThemePoolStep(context: PostgresQueryContext): MarketStepHandler {
  const steps = new PostgresMarketModuleExecutionStore(context), snapshots = new PostgresMarketAnalysisSnapshotStore(context);
  return async ({ claim, signal }): Promise<MarketStepWork> => {
    signal.throwIfAborted(); const input = MarketThemePoolStepInputSchema.parse(claim.step.input);
    const actor = { organizationId: claim.organizationId, userId: claim.createdBy }, view = await steps.findModuleRun({ actor, moduleRunId: claim.moduleRunId });
    const step = view?.steps.find(s => s.id === claim.stepId);
    if (!view || !step || claim.step.kind !== 'prepare-members' || step.status !== 'running' || step.latestAttemptId !== claim.attemptId ||
      digest(claim.step) !== claim.inputHash || step.inputHash !== claim.inputHash || view.run.createdBy !== claim.createdBy || view.run.scope.researchId !== claim.studyId ||
      view.run.moduleKind !== 'customer-themes' || view.run.status === 'cancelled' || view.run.versions.source !== MARKET_SOURCE_HANDLER_VERSION ||
      view.run.versions.mapping !== input.catalog.mappingVersion || !((view.run.versions.model === null && view.run.versions.configuration === null && view.run.versions.prompt === null) ||
        (view.run.versions.model === 'market.semantic.text.v1' && !!view.run.versions.configuration && !!view.run.versions.prompt))) invalid();
    async function bound(snapshotId: string) {
      signal.throwIfAborted(); if (!claim.step.inputRefs.some(r => r.kind === 'input' && r.id === snapshotId)) invalid();
      const saved = await snapshots.findInput({ actor, studyId: claim.studyId, id: snapshotId });
      if (!saved || digest(saved.snapshot.scope) !== digest(view!.run.scope)) invalid(); return saved.snapshot;
    }
    const sources: Record<string, MarketSourceEvidence> = {};
    async function source(ref: unknown) {
      if (typeof ref !== 'string') invalid(); if (Object.hasOwn(sources, ref)) return;
      signal.throwIfAborted(); const saved = await snapshots.findSource({ actor, studyId: claim.studyId, id: ref }); if (!saved) invalid(); sources[ref] = saved.evidence;
    }
    if (input.phase === 'select-theme-members') {
      const snapshot = await bound(input.inputSnapshotId); for (const r of snapshot.records) await source((r.data as { sourceRef?: unknown })?.sourceRef);
      const selected = selectMarketThemeMembers({ snapshot, count: input.count, sources }); signal.throwIfAborted();
      return { kind: 'settlement', value: { outcome: { status: selected.manifest.selectedAsins.length ? 'succeeded' : 'empty', output: { ...selected.manifest, catalog: input.catalog } },
        inputs: [factory(selected.snapshot)], children: selected.manifest.selectedAsins.map<MarketStepDefinition>(asin => ({
          stepKey: `theme-source/${digest({ selection: selected.snapshot.snapshotId, asin })}`, kind: 'collect-customer-themes', subject: { asin },
          input: { asin, selectionInputSnapshotId: selected.snapshot.snapshotId }, inputRefs: [{ kind: 'input', id: selected.snapshot.snapshotId }],
        })).concat(view.run.versions.planner==='market-theme-flow/rules-v3' ? selected.snapshot.records.filter(r=>!obj(obj(r.data).product).imageUrl).map<MarketStepDefinition>(r=>({
          stepKey:`theme-image/${digest({selection:selected.snapshot.snapshotId,asin:r.id})}`,kind:'collect-product-image',subject:{asin:r.id},
          input:{asin:r.id,selectionInputSnapshotId:selected.snapshot.snapshotId},inputRefs:[{kind:'input',id:selected.snapshot.snapshotId}],
        })) : []) } };
    }
    const selection = await bound(input.selectionInputSnapshotId);
    const selectedReceipt = view.attempts.find(a => a.status === 'succeeded' && claim.step.inputRefs.some(r => r.kind === 'step-output' && r.id === a.id) &&
      view.steps.some(s => s.id === a.stepId && s.latestAttemptId === a.id && s.status === 'succeeded' && s.kind === 'prepare-members' && (s.input as { phase?: unknown })?.phase === 'select-theme-members') &&
      (a.output as { selectionInputSnapshotId?: string })?.selectionInputSnapshotId === selection.snapshotId &&
      digest((a.output as { selectedAsins?: unknown }).selectedAsins) === digest(input.selectedAsins));
    if (!selectedReceipt || digest((selectedReceipt.output as { catalog?: unknown }).catalog) !== digest(input.catalog)) invalid();
    const selectionSummary = z.object({ sourceInputSnapshotId: id, requestedCount: z.number().int().min(1).max(20), observedProductCount: z.number().int().nonnegative(),
      requestedCountMet: z.boolean(), selectionBasis: z.literal('provider-row-order'), bsrTopVerified: z.literal(false), anchorMonth: z.string().nullable(),categoryName:z.string().max(500).nullable().optional() }).parse(selectedReceipt.output);
    if(input.imageAttemptIds){
      if(view.run.versions.planner!=='market-theme-flow/rules-v3'||new Set(input.imageAttemptIds).size!==input.imageAttemptIds.length)invalid();
      for(const id of input.imageAttemptIds){
        const a=view.attempts.find(a=>a.id===id),s=view.steps.find(s=>s.latestAttemptId===id);
        if(!a||!s||s.kind!=='collect-product-image'||!['succeeded','empty','failed'].includes(s.status)||!['succeeded','empty','failed','interrupted'].includes(a.status)||!claim.step.inputRefs.some(r=>r.kind==='step-output'&&r.id===id)||obj(s.input).selectionInputSnapshotId!==selection.snapshotId||!input.selectedAsins.includes(z.string().parse(obj(s.input).asin)))invalid();
      }
    }
    const observations = [];
    for (const observation of input.observations) {
      const snapshot = await bound(observation.inputSnapshotId);
      if (!claim.step.inputRefs.some(r => r.kind === 'source' && r.id === observation.sourceRef)) invalid();
      await source(observation.sourceRef); observations.push({ snapshot, sourceRef: observation.sourceRef });
    }
    if (new Set(input.failedAttemptIds).size !== input.failedAttemptIds.length) invalid();
    const failures = input.failedAttemptIds.map(attemptId => {
      const attempt = view.attempts.find(a => a.id === attemptId), failedStep = view.steps.find(s => s.latestAttemptId === attemptId);
      if (!attempt || !['failed', 'interrupted'].includes(attempt.status) || !failedStep || failedStep.kind !== 'collect-customer-themes' || failedStep.status !== 'failed' ||
        (failedStep.input as { selectionInputSnapshotId?: string }).selectionInputSnapshotId !== input.selectionInputSnapshotId) invalid();
      return { asin: z.string().parse((failedStep.input as { asin?: unknown }).asin), attemptId, code: z.string().parse((attempt.error as { code?: unknown })?.code) };
    });
    const pool = assembleMarketThemePool({ selection, selectedAsins: input.selectedAsins, catalog: input.catalog, dataCutoffAt: input.dataCutoffAt, observations, sources, failures }); signal.throwIfAborted();
    const { rawSnapshot, semanticSnapshot, aggregation, manifest } = pool;
    return { kind: 'settlement', value: { outcome: { status: aggregation.dataReady ? 'succeeded' : 'empty', output: { ...manifest, selection: {...selectionSummary,...(input.imageAttemptIds?{imageAttemptIds:input.imageAttemptIds}:{})}, totals: aggregation.totals,
      perAsin: aggregation.perAsin.map(({ asin, status, reason, totals }) => ({ asin, status, reason, totals })),
      ruleBaseline: customerThemeRuleBaselineFromRawPool({ scope: view.run.scope, snapshot: rawSnapshot, selectedAsins: input.selectedAsins }) } },
      inputs: [factory(rawSnapshot), factory(semanticSnapshot)], children: semanticSnapshot.records.length && view.run.versions.model === 'market.semantic.text.v1' ? [{
        stepKey: `theme-model/${manifest.basisHash}`, kind: 'prepare-model-batches', subject: { task: input.catalog.task },
        input: { task: input.catalog.task, inputSnapshotId: semanticSnapshot.snapshotId, selectionRevision: input.selectionRevision, dataCutoffAt: input.dataCutoffAt },
        inputRefs: [{ kind: 'input', id: semanticSnapshot.snapshotId }],
      }] : [] } };
  };
}
