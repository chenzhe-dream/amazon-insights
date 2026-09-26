import {inspectSorftimeShapeContinuation} from './shape-sorftime-flow';
import { z } from 'zod';
import {SHAPE_CATEGORY_METRICS} from '../../../shared/market-shape-category-contracts';
import { MarketShapeStartRequestSchema } from '../../../shared/market-shape-price-contracts';
export { MarketShapeStartRequestSchema } from '../../../shared/market-shape-price-contracts';
import { MarketAnalysisScopeSchema } from '../../../shared/market-analysis-contracts';
import type { CreateMarketModuleRunInput, MarketModuleRunView, MarketExecutionStep, MarketStepDefinition } from '../../db/market-module-execution-repository';
import { canonicalJsonSha256 as digest } from '../../runtime/model-request-accounting';
import {MarketShapeCatalogVersionSchema} from '../../../shared/market-shape-structure-contracts';
export const MARKET_SHAPE_FLOW_VERSION = 'market-shape-price-flow/v1';
export const MARKET_SHAPE_RULES_FLOW_VERSION = 'market-shape-price-flow/rules-v1';
export const MARKET_SHAPE_HISTORY_FLOW_VERSION = 'market-shape-price-flow/rules-v2';
export const MARKET_SHAPE_REFERENCE_RULE_VERSION='market-shape-reference-rules/v1';
export const MARKET_SHAPE_SORFTIME_FLOW_VERSION = 'market-shape-price-flow/rules-v4';
export const MARKET_SHAPE_CATEGORY_FLOW_VERSION = 'market-shape-price-flow/rules-v3';
export const isMarketShapeRulesFlow = (flow:unknown) => [MARKET_SHAPE_RULES_FLOW_VERSION, MARKET_SHAPE_HISTORY_FLOW_VERSION, MARKET_SHAPE_CATEGORY_FLOW_VERSION, MARKET_SHAPE_SORFTIME_FLOW_VERSION].includes(String(flow));
export const MarketShapeFlowParamsSchema = MarketShapeStartRequestSchema.extend({ flow: z.enum([MARKET_SHAPE_FLOW_VERSION, MARKET_SHAPE_RULES_FLOW_VERSION, MARKET_SHAPE_HISTORY_FLOW_VERSION, MARKET_SHAPE_CATEGORY_FLOW_VERSION, MARKET_SHAPE_SORFTIME_FLOW_VERSION]) });
export const MarketShapeSelectionSchema = z.object({ referenceAttemptId: z.string().uuid(), selectionInputSnapshotId: z.string().regex(/^market-input:[a-f0-9]{64}$/),
    sourceRef: z.string().regex(/^market-source:[a-f0-9]{64}$/), selectedAsins: z.array(z.string().regex(/^[A-Z0-9]{10}$/)).max(100), dataCutoffAt: z.string().datetime(),
    selectionBasis: z.literal('provider-row-order'), bsrTopVerified: z.literal(false) }).strict();
type Request = Pick<CreateMarketModuleRunInput, 'scope' | 'moduleKind' | 'params' | 'versions'>;
const obj = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const success = (s: MarketExecutionStep) => s.status === 'succeeded' || s.status === 'empty';
const key = (phase: string, basis: unknown) => `shape-flow/${phase}:${digest(basis)}`;
export const isMarketShapeFlow = (run: {
    params: unknown;
}) => [MARKET_SHAPE_FLOW_VERSION, MARKET_SHAPE_RULES_FLOW_VERSION, MARKET_SHAPE_HISTORY_FLOW_VERSION, MARKET_SHAPE_CATEGORY_FLOW_VERSION, MARKET_SHAPE_SORFTIME_FLOW_VERSION].includes(String(obj(run.params).flow));
function params(r: Request) {
    const p = MarketShapeFlowParamsSchema.parse(r.params);
    MarketAnalysisScopeSchema.parse(r.scope);
    if (r.moduleKind !== 'shape-price' || r.versions.source !== 'market-source-handlers/v1' || !(p.flow===MARKET_SHAPE_SORFTIME_FLOW_VERSION?r.versions.rule===MARKET_SHAPE_REFERENCE_RULE_VERSION:MarketShapeCatalogVersionSchema.safeParse(r.versions.rule).success) || r.versions.mapping !== p.catalog.taxonomyVersion || r.versions.planner !== p.flow ||
        !(r.versions.model === null && r.versions.configuration === null && r.versions.prompt === null || r.versions.model === 'market.semantic.text.v1' && r.versions.configuration && r.versions.prompt))
        throw new TypeError('Shape flow versions differ');
    if(p.flow!==MARKET_SHAPE_SORFTIME_FLOW_VERSION&&p.poolSize>100)throw new TypeError('Legacy shape pool limit exceeded');
    if (new Set(p.catalog.allowedLabels.map(l => l.labelId)).size !== p.catalog.allowedLabels.length)
        throw new TypeError('Duplicate shape labels');
    return p;
}
export function marketShapeFlowInitialSteps(r: Request): MarketStepDefinition[] {
    const p = params(r);
    if(p.flow===MARKET_SHAPE_SORFTIME_FLOW_VERSION)return [{stepKey:'shape-flow/anchor',kind:'collect-shape-pool',subject:{flow:p.flow},input:{poolSize:p.poolSize},inputRefs:[]}];
    return [{ stepKey: 'shape-flow/anchor', kind: 'collect-product-month', subject: { flow: p.flow }, input: { month: r.scope.toMonth, poolSize: p.poolSize, newProductMonths: p.newProductMonths }, inputRefs: [] }];
}
/** A source/model frontier only. Human revisions are separate explicit commands;
 * this planner never creates a manual assignment or declares the full A2 ready. */
export function inspectMarketShapeContinuation(view: MarketModuleRunView, now: string): {
    children: MarketStepDefinition[];
    currentStepKeys: string[];
} {
    const children: MarketStepDefinition[] = [], currentStepKeys: string[] = [], result = () => ({ children, currentStepKeys });
    if (!isMarketShapeFlow(view.run) || view.run.status === 'cancelled')
        return result();
    const p = params(view.run);
    if(p.flow===MARKET_SHAPE_SORFTIME_FLOW_VERSION)return inspectSorftimeShapeContinuation(view);
    z.string().datetime().parse(now);
    function find(d: MarketStepDefinition) {
        currentStepKeys.push(d.stepKey);
        const found = view.steps.filter(s => s.stepKey === d.stepKey);
        if (found.length > 1 || found[0] && found[0].inputHash !== digest(d))
            throw new TypeError('Shape frontier definition differs');
        return found[0];
    }
    function attempt(s: MarketExecutionStep) {
        const a = view.attempts.find(a => a.id === s.latestAttemptId && a.stepId === s.id);
        if (!a || a.status !== s.status && !(s.status === 'failed' && a.status === 'interrupted'))
            throw new TypeError('Shape source attempt differs');
        return a;
    }
    const anchor = find(marketShapeFlowInitialSteps(view.run)[0]);
    if (!anchor)
        throw new TypeError('Shape anchor missing');
    if (!success(anchor))
        return result();
    const a = attempt(anchor), selectionDefinition: MarketStepDefinition = { stepKey: key('select', a.id), kind: 'prepare-members', subject: { flow: p.flow }, input: { phase: 'select-shape-members', referenceAttemptId: a.id }, inputRefs: [{ kind: 'step-output', id: a.id }] };
    const selectionStep = find(selectionDefinition);
    if (!selectionStep) {
        children.push(selectionDefinition);
        return result();
    }
    if (!success(selectionStep))
        return result();
    const selection = MarketShapeSelectionSchema.parse(attempt(selectionStep).output);
    if (selection.referenceAttemptId !== a.id || selection.selectionInputSnapshotId !== obj(a.output).inputSnapshotId || selection.sourceRef !== obj(a.output).sourceRef || new Set(selection.selectedAsins).size !== selection.selectedAsins.length)
        throw new TypeError('Shape selection differs from anchor');
    if (p.flow === MARKET_SHAPE_CATEGORY_FLOW_VERSION) for (const metric of SHAPE_CATEGORY_METRICS) {
        const d: MarketStepDefinition={stepKey:key('category',{reference:a.id,metric}),kind:'collect-shape-category',subject:{flow:p.flow,metric},input:{metric,selectionInputSnapshotId:selection.selectionInputSnapshotId},inputRefs:[{kind:'input',id:selection.selectionInputSnapshotId}]};
        if (!find(d)) children.push(d);
    }
    if (!selection.selectedAsins.length)
        return result();
    for (let month = view.run.scope.fromMonth; month < view.run.scope.toMonth;) {
        const d: MarketStepDefinition = { stepKey: key('history', { reference: a.id, month }), kind: 'collect-product-month', subject: { flow: p.flow }, input: { month, poolSize: selection.selectedAsins.length, newProductMonths: p.newProductMonths, selectedAsins: selection.selectedAsins, selectionInputSnapshotId: selection.selectionInputSnapshotId }, inputRefs: [{ kind: 'input', id: selection.selectionInputSnapshotId }] };
        if (!find(d))
            children.push(d);
        const [y, m] = month.split('-').map(Number);
        month = `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}`;
    }
    if ([MARKET_SHAPE_HISTORY_FLOW_VERSION,MARKET_SHAPE_CATEGORY_FLOW_VERSION, MARKET_SHAPE_SORFTIME_FLOW_VERSION].includes(p.flow)) for (const asin of selection.selectedAsins) {
        const d: MarketStepDefinition = { stepKey: key('product-history', { reference: a.id, asin }), kind: 'collect-product-history', subject: { flow: p.flow, asin }, input: { asin, selectionInputSnapshotId: selection.selectionInputSnapshotId }, inputRefs: [{ kind: 'input', id: selection.selectionInputSnapshotId }] };
        if (!find(d)) children.push(d);
    }
    const selectionRevision = `shape-selection:${digest(selection.selectionInputSnapshotId)}`;
    const projectionDefinition: MarketStepDefinition = { stepKey: key('project', a.id), kind: 'prepare-members', subject: { flow: p.flow }, input: { inputSnapshotId: selection.selectionInputSnapshotId, catalog: p.catalog, selectionRevision, dataCutoffAt: selection.dataCutoffAt }, inputRefs: [{ kind: 'input', id: selection.selectionInputSnapshotId }, { kind: 'step-output', id: a.id }] };
    const projection = find(projectionDefinition);
    if (!projection) {
        children.push(projectionDefinition);
        return result();
    }
    if (!success(projection))
        return result();
    const projected = attempt(projection), snapshotId = z.string().regex(/^market-input:[a-f0-9]{64}$/).parse(obj(projected.output).inputSnapshotId);
    if (obj(projected.output).sourceInputSnapshotId !== selection.selectionInputSnapshotId || obj(projected.output).catalogHash !== digest(p.catalog))
        throw new TypeError('Shape projection differs');
    if (isMarketShapeRulesFlow(p.flow))
        return result();
    const preparationDefinition: MarketStepDefinition = { stepKey: `prepare-model/${digest({ projection: snapshotId, selectionRevision, dataCutoffAt: selection.dataCutoffAt })}`, kind: 'prepare-model-batches', subject: { task: p.catalog.task }, input: { task: p.catalog.task, inputSnapshotId: snapshotId, selectionRevision, dataCutoffAt: selection.dataCutoffAt }, inputRefs: [{ kind: 'input', id: snapshotId }] };
    const preparation = find(preparationDefinition);
    if (!preparation)
        throw new TypeError('Shape model preparation missing');
    if (!success(preparation))
        return result();
    const manifest = z.array(z.object({ bindingId: z.string().uuid(), inputDigest: z.string().regex(/^[a-f0-9]{64}$/) })).max(2000).parse(obj(attempt(preparation).output).batches);
    if (new Set(manifest.map(b => b.bindingId)).size !== manifest.length)
        throw new TypeError('Duplicate shape model binding');
    for (const b of manifest) {
        const matches = view.steps.filter(s => s.kind === 'model-batch' && obj(s.input).bindingId === b.bindingId && obj(s.input).inputDigest === b.inputDigest);
        if (matches.length !== 1)
            throw new TypeError('Shape model step missing or ambiguous');
        currentStepKeys.push(matches[0].stepKey);
    }
    return result();
}
