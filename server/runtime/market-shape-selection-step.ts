import {replaySorftimeShapePoolPages} from '../services/market-shape-sorftime-reader';
import { z } from 'zod';
import { PostgresQueryContext } from '../db/postgres/query-context';
import { PostgresMarketModuleExecutionStore } from '../db/postgres/market-module-execution-store';
import { PostgresMarketAnalysisSnapshotStore } from '../db/postgres/market-analysis-snapshot-store';
import { MarketShapeFlowParamsSchema, MarketShapeSelectionSchema, inspectMarketShapeContinuation } from '../domain/market-research/shape-price-flow';
import { readMarketProductMonth } from '../domain/market-research/product-month-evidence';
import { canonicalJsonSha256 as digest } from './model-request-accounting';
import type { MarketStepHandler } from './market-module-step-worker';
const obj = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
function invalid(): never { throw new TypeError('Shape selection evidence differs from its source attempt'); }
export function createMarketShapeSelectionStep(context: PostgresQueryContext): MarketStepHandler {
    return async ({ claim, signal }) => {
        signal.throwIfAborted();
        const input = z.object({ phase: z.enum(['select-shape-members','select-sorftime-shape-members']), referenceAttemptId: z.string().uuid(),pageAttemptIds:z.array(z.string().uuid()).max(21).optional() }).strict().parse(claim.step.input);
        const actor = { organizationId: claim.organizationId, userId: claim.createdBy }, steps = new PostgresMarketModuleExecutionStore(context), snapshots = new PostgresMarketAnalysisSnapshotStore(context);
        const view = await steps.findModuleRun({ actor, moduleRunId: claim.moduleRunId }), step = view?.steps.find(s => s.id === claim.stepId);
        if (!view || !step || view.run.moduleKind !== 'shape-price' || view.run.status === 'cancelled' || view.run.createdBy !== claim.createdBy || view.run.scope.researchId !== claim.studyId || step.status !== 'running' || step.latestAttemptId !== claim.attemptId || step.inputHash !== claim.inputHash || digest(claim.step) !== claim.inputHash)
            invalid();
        const p = MarketShapeFlowParamsSchema.parse(view.run.params);
        if (!inspectMarketShapeContinuation(view, new Date().toISOString()).currentStepKeys.includes(step.stepKey))
            invalid();
        if(input.phase==='select-sorftime-shape-members'){
            const result=await replaySorftimeShapePoolPages({view,actor,snapshots,pageAttemptIds:input.pageAttemptIds??[]});
            if(input.referenceAttemptId!==result.pages[0].attempt.id||result.pages.some(page=>page.step.latestAttemptId!==page.attempt.id||!step.inputRefs.some(ref=>ref.kind==='step-output'&&ref.id===page.attempt.id)))invalid();
            signal.throwIfAborted();
            return {kind:'settlement',value:{outcome:{status:result.publicPool.products.length?'succeeded':'empty',output:{referenceAttemptId:input.referenceAttemptId,selectionInputSnapshotId:result.snapshot.snapshotId,sourceRef:result.pages[0].sourceRef,selectedAsins:result.publicPool.products.map(p=>p.asin),dataCutoffAt:result.snapshot.collectedAt,selectionBasis:'provider-row-order',bsrTopVerified:false}},inputs:[JSON.parse(JSON.stringify(result.factory))]}};
        }
        const a = view.attempts.find(a => a.id === input.referenceAttemptId), anchor = view.steps.find(s => s.id === a?.stepId);
        if (!a || !anchor || anchor.stepKey !== 'shape-flow/anchor' || anchor.latestAttemptId !== a.id || !['succeeded', 'empty'].includes(a.status) || !step.inputRefs.some(r => r.kind === 'step-output' && r.id === a.id))
            invalid();
        const out = obj(a.output), readScope = { actor, studyId: claim.studyId };
        const saved = await snapshots.findInput({ ...readScope, id: z.string().parse(out.inputSnapshotId) }), source = await snapshots.findSource({ ...readScope, id: z.string().parse(out.sourceRef) });
        if (!saved || !source)
            invalid();
        const checked = await readMarketProductMonth({ month: view.run.scope.toMonth, snapshot: saved.snapshot, sourceRef: source.id }, { [source.id]: source.evidence });
        if (digest(saved.snapshot.scope) !== digest(view.run.scope) || checked.products.length > p.poolSize)
            invalid();
        const selectedAsins = checked.products.map(p => p.asin);
        const output = MarketShapeSelectionSchema.parse({ referenceAttemptId: a.id, selectionInputSnapshotId: saved.snapshot.snapshotId, sourceRef: source.id, selectedAsins, dataCutoffAt: saved.snapshot.collectedAt, selectionBasis: 'provider-row-order', bsrTopVerified: false });
        signal.throwIfAborted();
        return { kind: 'settlement', value: { outcome: { status: selectedAsins.length ? 'succeeded' : 'empty', output } } };
    };
}
