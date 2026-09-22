import { z } from 'zod';
import type { MarketSourceEvidence } from '../../shared/market-source-contracts';
import { MARKET_SOURCE_HANDLER_VERSION } from '../../shared/market-source-contracts';
import type { MarketJsonValue } from '../../shared/market-analysis-contracts';
import { PostgresQueryContext } from '../db/postgres/query-context';
import { PostgresMarketModuleExecutionStore } from '../db/postgres/market-module-execution-store';
import { PostgresMarketAnalysisSnapshotStore } from '../db/postgres/market-analysis-snapshot-store';
import { MarketProjectionCatalogSchema, projectMarketSourceSnapshot } from '../domain/market-research/source-semantic-projection';
import { shapeRuleBaselineFromProductSnapshot } from '../domain/market-research/shape-price-rule-baseline';
import { canonicalJsonSha256 as digest } from './model-request-accounting';
import type { MarketStepHandler } from './market-module-step-worker';
import { createMarketThemePoolStep } from './market-theme-pool-step';

const snapshotId = z.string().regex(/^market-input:[a-f0-9]{64}$/);
export const MarketSourceProjectionStepInputSchema = z.object({
  inputSnapshotId: snapshotId, catalog: MarketProjectionCatalogSchema,
  selectionInputSnapshotId: snapshotId.optional(), selectionRevision: z.string().min(1).max(160), dataCutoffAt: z.string().datetime(),
}).strict();
function invalid(): never { throw new z.ZodError([{ code: 'custom', path: [], message: 'Source projection binding is unavailable' }]); }

/** Produces only immutable input plus the next preparation step. The generic
 * worker settles these together under the original claim's fence. */
export function createMarketSourceProjectionStep(context: PostgresQueryContext): MarketStepHandler {
  const steps = new PostgresMarketModuleExecutionStore(context), snapshots = new PostgresMarketAnalysisSnapshotStore(context);
  const themePool = createMarketThemePoolStep(context);
  return async ({ claim, signal }) => {
    if (typeof (claim.step.input as { phase?: unknown })?.phase === 'string') return themePool({ claim, signal });
    signal.throwIfAborted(); const input = MarketSourceProjectionStepInputSchema.parse(claim.step.input);
    const actor = { organizationId: claim.organizationId, userId: claim.createdBy };
    const view = await steps.findModuleRun({ actor, moduleRunId: claim.moduleRunId }), step = view?.steps.find(s => s.id === claim.stepId);
    const catalog = input.catalog;
    const mapping = catalog.task === 'market-product-shape-suggestion' ? catalog.taxonomyVersion : catalog.task === 'market-keyword-semantics' ? catalog.dictionaryVersion : catalog.mappingVersion;
    const moduleKind = catalog.task === 'market-product-shape-suggestion' ? 'shape-price' : catalog.task === 'market-keyword-semantics' ? 'keywords' : 'customer-themes';
    if (claim.step.kind !== 'prepare-members' || !view || !step || step.status !== 'running' || step.latestAttemptId !== claim.attemptId ||
      step.inputHash !== claim.inputHash || digest(claim.step) !== claim.inputHash || view.run.createdBy !== claim.createdBy ||
      view.run.scope.researchId !== claim.studyId || view.run.moduleKind !== moduleKind || view.run.status === 'cancelled' ||
      view.run.versions.source !== MARKET_SOURCE_HANDLER_VERSION || view.run.versions.mapping !== mapping ||
      !((view.run.versions.model === null && view.run.versions.configuration === null && view.run.versions.prompt === null) ||
        (view.run.versions.model === 'market.semantic.text.v1' && !!view.run.versions.configuration && !!view.run.versions.prompt))) invalid();
    async function bound(id: string) {
      signal.throwIfAborted();
      if (!claim.step.inputRefs.some(r => r.kind === 'input' && r.id === id)) invalid();
      const saved = await snapshots.findInput({ actor, studyId: claim.studyId, id });
      if (!saved || digest(saved.snapshot.scope) !== digest(view!.run.scope) || Date.parse(saved.snapshot.collectedAt) > Date.parse(input.dataCutoffAt)) invalid();
      return saved.snapshot;
    }
    if (Date.parse(input.dataCutoffAt) > Date.now()) invalid();
    const snapshot = await bound(input.inputSnapshotId);
    if (catalog.task === 'market-customer-theme-mapping') {
      if (!input.selectionInputSnapshotId) invalid(); const selection = await bound(input.selectionInputSnapshotId);
      if (selection.kind !== 'products' || selection.sourceVersion !== MARKET_SOURCE_HANDLER_VERSION || new Set(catalog.selectedAsins).size !== catalog.selectedAsins.length ||
        catalog.selectedAsins.some(id => !selection.records.some(r => {
          const data = r.data as { collection?: unknown; product?: { asin?: unknown } };
          return r.id === id && data?.collection === 'product-month' && data.product?.asin === id;
        }))) invalid();
    } else if (input.selectionInputSnapshotId) invalid();
    const sources: Record<string, MarketSourceEvidence> = {};
    for (const record of snapshot.records) {
      signal.throwIfAborted(); const ref = (record.data as { sourceRef?: unknown })?.sourceRef;
      if (typeof ref !== 'string') invalid();
      if (Object.hasOwn(sources, ref)) continue;
      const saved = await snapshots.findSource({ actor, studyId: claim.studyId, id: ref });
      if (!saved) invalid(); sources[ref] = saved.evidence;
    }
    const result = projectMarketSourceSnapshot({ snapshot, sources, catalog }); signal.throwIfAborted();
    const ruleBaseline = catalog.task === 'market-product-shape-suggestion' ? shapeRuleBaselineFromProductSnapshot({ snapshot, sources }) : null;
    const projected = result.snapshot;
    const factory = { scope: projected.scope, kind: projected.kind, sourceVersion: projected.sourceVersion, ruleVersion: projected.ruleVersion,
      collectedAt: projected.collectedAt, expectedRecordIds: projected.expectedRecordIds, records: projected.records };
    const hasModel = view.run.versions.model === 'market.semantic.text.v1' && !!view.run.versions.configuration && !!view.run.versions.prompt;
    return { kind: 'settlement', value: { outcome: { status: projected.records.length ? 'succeeded' : 'empty', output: ruleBaseline ? { ...result.manifest, ruleBaseline } : result.manifest },
      inputs: [JSON.parse(JSON.stringify(factory)) as MarketJsonValue], children: projected.records.length && hasModel ? [{
        stepKey: `prepare-model/${digest({ projection: projected.snapshotId, selectionRevision: input.selectionRevision, dataCutoffAt: input.dataCutoffAt })}`,
        kind: 'prepare-model-batches', subject: { task: catalog.task },
        input: { task: catalog.task, inputSnapshotId: projected.snapshotId, selectionRevision: input.selectionRevision, dataCutoffAt: input.dataCutoffAt },
        inputRefs: [{ kind: 'input', id: projected.snapshotId }],
      }] : [] } };
  };
}
