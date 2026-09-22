import {marketProductSourcePolicy,MARKET_SHAPE_REQUEST_BOUND_CATALOG_VERSION} from '../../shared/market-product-source-policy';
import { z } from 'zod';
import { MarketShapeRunResponseSchema, MarketShapeRevisionPublicSchema } from '../../shared/market-shape-public-contracts';
import { MarketSemanticRecordSchema, type MarketShapeSuggestionOutput } from '../../shared/market-semantic-contracts';
import type { MarketSourceEvidence } from '../../shared/market-source-contracts';
import { MarketExecutionConflictError, type MarketExecutionActor } from '../db/market-module-execution-repository';
import { PostgresQueryContext } from '../db/postgres/query-context';
import { PostgresMarketModuleExecutionStore } from '../db/postgres/market-module-execution-store';
import { PostgresMarketAnalysisSnapshotStore } from '../db/postgres/market-analysis-snapshot-store';
import { PostgresMarketShapePriceRevisionStore } from '../db/postgres/market-shape-price-revision-store';
import { PostgresMarketAgentRunStore } from '../db/postgres/market-agent-run-store';
import { isMarketShapeFlow, inspectMarketShapeContinuation, MarketShapeFlowParamsSchema } from '../domain/market-research/shape-price-flow';
import { readMarketProductMonth } from '../domain/market-research/product-month-evidence';
import { validateMarketShapeSuggestions } from '../domain/market-research/semantic-validation';
import {buildMarketShapePeriodProjection} from '../domain/market-research/shape-period-projection';
import {projectMarketShapeSourceMetadata} from '../domain/market-research/shape-source-metadata';
import {MarketRuleBaselineSchema} from '../../shared/market-rule-baseline-contracts';
const obj = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
function invalid(): never { throw new MarketExecutionConflictError(); }
type Saved = NonNullable<Awaited<ReturnType<PostgresMarketShapePriceRevisionStore['find']>>>;
export function marketShapePublicRevision(saved: Saved) {
    const c = saved.catalog, r = c.revision;
    // Preserve the configured bands even when there are no eligible sales.
    const bands = c.analysis.shapes[0].bands.map(b => b.band);
    const report = MarketShapeRevisionPublicSchema.parse({ revisionId: r.revisionId, parentRevisionId: r.parentRevisionId, ordinal: saved.ordinal, createdAt: r.createdAt, catalogId: c.catalogId, scope: c.scope, selectedAsins: r.selectedAsins, taxonomyVersion: r.taxonomyVersion, labels: r.labels, assignments: r.assignments, note: r.note, bands, totalUnits: c.analysis.totals.totalUnits, eligibleAsins: c.analysis.scope.eligibleAsins, coverage: c.analysis.coverage.status,
        groups: c.analysis.shapes.map(s => ({ labelId: s.shape, units: s.totals.totalUnits, links: s.totals.eligibleLinkCount, monthlyUnitsPerLink: s.totals.monthlyUnitsPerLink, bands: s.bands.map(b => ({ id: b.band.id, units: b.metrics.totalUnits, links: b.metrics.eligibleLinkCount, share: b.salesShareWithinShape.value, denominatorUnits: b.salesShareWithinShape.denominator })) })),
        comparisonBasis: c.comparisonBasis, priceBasis: c.priceBasis, historicalPriceStatus: c.historicalPriceStatus, products: c.products.map(p => ({ asin: p.asin, shape: p.shape, price: p.referencePrice.value, rawPrice: p.referencePrice.rawValue, priceIssues: p.referencePrice.issues,...(p.referencePrice.provenance?{provenance:p.referencePrice.provenance}:{}), observations: p.observations.map(o => ({ month: o.month, units: o.units, rawUnits: o.rawUnits, issues: o.issues,...(o.provenance?{provenance:o.provenance}:{}) })) })), monthly: c.monthly.map(m => ({ month: m.month, totalUnits: m.analysis.totals.totalUnits, eligibleAsins: m.analysis.scope.eligibleAsins })), semanticStatus: 'not-integrated', ...(c.structure?{structure:c.structure}:{}),...(c.sourcePolicy?{sourcePolicy:c.sourcePolicy}:{}) });
    return MarketShapeRevisionPublicSchema.parse({...report,periodProjection:buildMarketShapePeriodProjection(report)});
}
export async function readMarketShapeRun(context: PostgresQueryContext, actor: MarketExecutionActor, id: string) {
    const steps = new PostgresMarketModuleExecutionStore(context), snapshots = new PostgresMarketAnalysisSnapshotStore(context), revisions = new PostgresMarketShapePriceRevisionStore(context), audits = new PostgresMarketAgentRunStore(context);
    const view = await steps.findModuleRun({ actor, moduleRunId: id });
    if (!view || !isMarketShapeFlow(view.run))
        return null;
    const params = MarketShapeFlowParamsSchema.parse(view.run.params), { flow: _flow, ...publicParams } = params;
    // Cancelled runs retain their frozen inputs and accepted suggestions for viewing.
    const current = new Set(inspectMarketShapeContinuation(view.run.status === 'cancelled' ? { ...view, run: { ...view.run, status: 'partial' } } : view, new Date().toISOString()).currentStepKeys);
    const rulesOnly = params.flow === 'market-shape-price-flow/rules-v1';
    const projection = view.steps.find(s => s.kind === 'prepare-members' && obj(s.input).catalog && obj(obj(s.input).catalog).task === 'market-product-shape-suggestion');
    const projectionAttempt = projection?.latestAttemptId ? view.attempts.find(a => a.id === projection.latestAttemptId && ['succeeded','empty'].includes(a.status)) : undefined;
    const ruleBaseline = projectionAttempt && Object.hasOwn(obj(projectionAttempt.output), 'ruleBaseline') ? MarketRuleBaselineSchema.parse(obj(projectionAttempt.output).ruleBaseline) : undefined;
    const readScope = { actor, studyId: view.run.scope.researchId, moduleRunId: id };
    const anchor = view.steps.find(s => s.stepKey === 'shape-flow/anchor'), a = view.attempts.find(a => a.id === anchor?.latestAttemptId);
    let source: null | {
        referenceAttemptId: string;
        historyAttemptIds: string[];
        referenceSnapshotId: string;
        fetchedAt: string;
        selectionBasis: 'provider-row-order';
        bsrTopVerified: false;
        products: Array<{
            asin: string;
            title: string | null;
            brand: string | null;
            price: number | null;
            units: number | null;
        }>;
    } = null;
    if (a && ['succeeded', 'empty'].includes(a.status)) {
        const out = obj(a.output), saved = await snapshots.findInput({ ...readScope, id: z.string().parse(out.inputSnapshotId) }), raw = await snapshots.findSource({ ...readScope, id: z.string().parse(out.sourceRef) });
        if (!saved || !raw)
            invalid();
        const checked = await readMarketProductMonth({ month: view.run.scope.toMonth, snapshot: saved.snapshot, sourceRef: raw.id }, { [raw.id]: raw.evidence });
        source = { referenceAttemptId: a.id, historyAttemptIds: view.steps.filter(s => current.has(s.stepKey) && s.kind === 'collect-product-month' && s.id !== anchor!.id && ['succeeded', 'empty'].includes(s.status)).map(s => s.latestAttemptId!), referenceSnapshotId: saved.snapshot.snapshotId, fetchedAt: raw.evidence.fetchedAt, selectionBasis: 'provider-row-order', bsrTopVerified: false, products: checked.products.map(p => ({ asin: p.asin, title: p.title, brand: p.brand, price: p.price, units: p.units, metadata: projectMarketShapeSourceMetadata(checked,p.asin,view.run.versions.rule===MARKET_SHAPE_REQUEST_BOUND_CATALOG_VERSION) })) };
    }
    const items: MarketShapeSuggestionOutput['products'] = [];
    const modelSteps = view.steps.filter(s => current.has(s.stepKey) && s.kind === 'model-batch');
    for (const step of modelSteps.filter(s => s.status === 'succeeded')) {
        const attempt = view.attempts.find(a => a.id === step.latestAttemptId);
        if (!attempt)
            invalid();
        const out = obj(attempt.output), input = obj(step.input);
        const audit = await audits.findAgentRun({ ...readScope, agentRunId: z.string().parse(out.agentRunId) }), binding = await audits.findSnapshotBinding({ ...readScope, bindingId: z.string().parse(input.bindingId) });
        if (!audit || !binding || audit.task !== 'market-product-shape-suggestion' || audit.attemptId !== attempt.id || audit.stepId !== step.id || audit.bindingId !== binding.id || out.bindingId !== binding.id || out.executionFingerprint !== audit.executionFingerprint || input.inputDigest !== binding.inputDigest || audit.outcome?.terminalStatus !== 'succeeded' || audit.outcome.validationStatus !== 'passed' || !audit.outcome.output)
            invalid();
        const saved = await snapshots.findInput({ ...readScope, id: binding.inputSnapshotId });
        if (!saved)
            invalid();
        const sources: Record<string, MarketSourceEvidence> = {};
        for (const ref of binding.sourceRefs) {
            const raw = await snapshots.findSource({ ...readScope, id: ref });
            if (!raw)
                invalid();
            sources[ref] = raw.evidence;
        }
        const output = validateMarketShapeSuggestions(binding.inputProjection, audit.outcome.output, { scope: view.run.scope, inputSnapshot: saved.snapshot, sourceEvidenceByRef: sources, selectionRevision: binding.selectionRevision, batchKey: binding.batchKey, inputDigest: binding.inputDigest, expectedIds: binding.memberRefs, sourceCatalog: Object.fromEntries(saved.snapshot.records.map(r => [r.id, MarketSemanticRecordSchema.parse(obj(r.data).semantic)])) });
        items.push(...output.products);
    }
    if (new Set(items.map(i => i.productId)).size !== items.length || items.some(i => !source?.products.some(p => p.asin === i.productId)))
        invalid();
    const pending = view.steps.some(s => current.has(s.stepKey) && ['queued', 'running'].includes(s.status) && ['prepare-members', 'prepare-model-batches', 'model-batch'].includes(s.kind));
    const suggestionStatus = !view.run.versions.model ? 'unavailable' : !source ? 'not-ready' : pending ? 'running' : source.products.length > 0 && items.length === source.products.length ? 'complete' : 'partial';
    const latest = await revisions.find({ actor, moduleRunId: id });
    const history = (await context.query<{
        revision_id: string;
        ordinal: number;
        stored_at: Date;
    }>('SELECT revision_id,ordinal,stored_at FROM market_shape_price_revisions WHERE organization_id=$1 AND run_id=$2 ORDER BY ordinal DESC LIMIT 100', [actor.organizationId, id])).rows.map(r => ({ revisionId: r.revision_id, ordinal: r.ordinal, createdAt: new Date(r.stored_at).toISOString() }));
    return MarketShapeRunResponseSchema.parse({ run: { id, scope: view.run.scope, status: view.run.status, params: publicParams,...(view.run.versions.rule===MARKET_SHAPE_REQUEST_BOUND_CATALOG_VERSION?{sourcePolicy:marketProductSourcePolicy(view.run.scope.marketplace)}:{}), ...(rulesOnly?{ruleStatus:ruleBaseline?.status??(source?'partial':'unavailable'),semanticStatus:'skipped' as const,...(ruleBaseline?{ruleBaseline}: {})}:{}), source, suggestions: { status: suggestionStatus, items }, latestRevision: latest ? marketShapePublicRevision(latest) : null, history,
            steps: view.steps.map(s => { const a = view.attempts.find(a => a.id === s.latestAttemptId); return { id: s.id, kind: s.kind, status: s.status, latestAttemptId: s.latestAttemptId, attemptCount: s.attemptCount,nextAttemptAt:s.nextAttemptAt??null, current: current.has(s.stepKey), canRetry: current.has(s.stepKey) && s.status === 'failed' && view.run.status !== 'cancelled', asin: null, month: s.kind === 'collect-product-month' ? obj(s.input).month : null, errorCode: ['failed', 'interrupted'].includes(a?.status ?? '') ? obj(a?.error).code ?? 'internal' : null }; }) } });
}
