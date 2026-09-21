import { z } from 'zod';
import { MarketShapeRevisionBodySchema, MarketShapePriceBandsSchema, type MarketShapeRevision } from '../../../shared/market-shape-price-contracts';
import type { MarketSourceEvidence } from '../../../shared/market-source-contracts';
import { readMarketProductMonth, type MarketProductMonthObservation } from './product-month-evidence';
import { analyzeShapePriceBands, type ShapePriceProduct } from './shape-price';
import { canonicalJsonSha256 as digest } from '../../runtime/model-request-accounting';
import {MarketShapeCatalogVersionSchema,MARKET_SHAPE_STRUCTURE_CATALOG_VERSION,type MarketShapeStructure} from '../../../shared/market-shape-structure-contracts';
import {buildMarketShapeStructure} from './shape-structure';
import {marketProductSourceAdmission} from './product-source-admission';
import {marketProductSourcePolicy,MARKET_SHAPE_REQUEST_BOUND_CATALOG_VERSION} from '../../../shared/market-product-source-policy';
export const MARKET_SHAPE_PRICE_CATALOG_VERSION = 'market-shape-price-catalog/v1';
function freeze<T>(value: T): T { if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
} return value; }
/** Authenticated services must supply authorId and validate parent lineage. This
 * builder records a manual decision; it never upgrades model suggestions. */
export function createMarketShapeRevision(input: unknown): MarketShapeRevision {
    const parsed = MarketShapeRevisionBodySchema.parse(input);
    if (Date.parse(parsed.createdAt) > Date.now())
        throw new TypeError('Shape revision time is in the future');
    const body = { ...parsed, selectedAsins: [...parsed.selectedAsins].sort(), assignments: [...parsed.assignments].sort((a, b) => a.asin.localeCompare(b.asin)) };
    return freeze({ ...body, revisionId: 'market-shape-revision:' + digest(body) });
}
export async function buildMarketShapePriceCatalog(options: {
    reference: MarketProductMonthObservation;
    history: readonly MarketProductMonthObservation[];
    sources: Readonly<Record<string, MarketSourceEvidence>>;
    revision: MarketShapeRevision;
    bands: unknown;
    dataCutoffAt: string;
    version?:z.infer<typeof MarketShapeCatalogVersionSchema>;
}) {
    const version=MarketShapeCatalogVersionSchema.parse(options.version??MARKET_SHAPE_PRICE_CATALOG_VERSION);
    const { revisionId, ...body } = options.revision, revision = createMarketShapeRevision(body);
    if (revisionId !== revision.revisionId)
        throw new TypeError('Shape revision digest differs');
    const requestBound=version===MARKET_SHAPE_REQUEST_BOUND_CATALOG_VERSION;
    const cutoff = z.string().datetime().parse(options.dataCutoffAt);
    if (Date.parse(cutoff) > Date.now())
        throw new TypeError('Shape data cutoff is in the future');
    const reference = await readMarketProductMonth(options.reference, options.sources), scope = reference.observation.snapshot.scope;
    if (digest(scope) !== digest(revision.scope) || revision.basisSnapshotId !== reference.observation.snapshot.snapshotId || reference.observation.month !== scope.toMonth)
        throw new TypeError('Shape selection basis differs');
    const pool = new Set(reference.products.map(p => p.asin));
    if (revision.selectedAsins.some(id => !pool.has(id)))
        throw new TypeError('Selected product is outside the reference pool');
    const observations = new Map([[reference.observation.month, reference]]);
    for (const o of options.history) {
        if (observations.has(o.month))
            throw new TypeError('Duplicate product month');
        const checked = await readMarketProductMonth(o, options.sources);
        if (digest(checked.observation.snapshot.scope) !== digest(scope) || checked.observation.snapshot.expectedRecordIds.some(id => !pool.has(id)))
            throw new TypeError('Historical product pool differs from reference scope');
        observations.set(o.month, checked);
    }
    for (const checked of observations.values())
        if (Date.parse(checked.source.fetchedAt) > Date.parse(cutoff))
            throw new TypeError('Product source is newer than data cutoff');
    const months: string[] = [];
    for (let month = scope.fromMonth; month <= scope.toMonth;) {
        months.push(month);
        const [y, m] = month.split('-').map(Number);
        month = `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}`;
    }
    const assignments = new Map(revision.assignments.map(a => [a.asin, a.labelId]));
    const products = revision.selectedAsins.map(asin => {
        const p = reference.products.find(p => p.asin === asin)!;
        const proof=requestBound?marketProductSourceAdmission(reference,asin):null;
        const priceIssues = [...(!requestBound&&!p.scopeConfirmed ? ['scope-unconfirmed'] : []), ...(!requestBound&&!p.currencyConfirmed ? ['currency-unconfirmed'] : []), ...(p.price === null ? ['price-missing'] : [])];
        return { asin, title: p.title, brand: p.brand, shape: assignments.get(asin) ?? null, classificationBasis: assignments.has(asin) ? 'manual' as const : 'unclassified' as const,
            referencePrice: { basis: 'reference-observation' as const, rawValue: p.price, value: priceIssues.length ? null : p.price, currency: requestBound||p.currencyConfirmed ? scope.currency : null, sourceRef: options.reference.sourceRef, inputSnapshotId: options.reference.snapshot.snapshotId, fetchedAt: reference.source.fetchedAt, issues: priceIssues,...(proof?{provenance:{scopeBasis:proof.scopeBasis,currencyBasis:proof.currencyBasis}}:{}) },
            observations: months.map(month => { const o = observations.get(month), p = o?.products.find(p => p.asin === asin); const proof=requestBound&&o&&p?marketProductSourceAdmission(o,asin):null; const issues = !o ? ['not-collected'] : !p ? ['member-missing'] : [...(!requestBound&&!p.scopeConfirmed ? ['scope-unconfirmed'] : []), ...(!requestBound&&!p.periodConfirmed ? ['period-unconfirmed'] : []), ...(proof?.periodBasis==='unsupported-month'?['period-outside-provider-history']:[]), ...(p.units === null ? ['units-missing'] : [])]; return { month, rawUnits: p?.units ?? null, units: issues.length ? null : p!.units, issues, sourceRef: o?.observation.sourceRef ?? null, inputSnapshotId: o?.observation.snapshot.snapshotId ?? null, fetchedAt: o?.source.fetchedAt ?? null,...(proof?{provenance:{scopeBasis:proof.scopeBasis,periodBasis:proof.periodBasis}}:{}) }; }) };
    });
    const bands = MarketShapePriceBandsSchema.parse(options.bands), ruleProducts: ShapePriceProduct[] = products.map(p => ({ asin: p.asin, shape: p.shape, price: p.referencePrice.value, brand: p.brand, monthlySales: p.observations.map(o => ({ month: o.month, units: o.units })) }));
    const analysis = analyzeShapePriceBands({ months, bands, products: ruleProducts }), eligible = new Set(analysis.scope.eligibleAsins);
    const monthly = months.map(month => ({ month, analysis: analyzeShapePriceBands({ months: [month], bands, products: ruleProducts.filter(p => eligible.has(p.asin)).map(p => ({ ...p, monthlySales: p.monthlySales.filter(m => m.month === month) })) }) }));
    const extra:{structure?:MarketShapeStructure}=version!==MARKET_SHAPE_PRICE_CATALOG_VERSION?{structure:buildMarketShapeStructure({reference,products,analysis,bands,requestBound})}:{};
    const value = { version, scope, dataCutoffAt: cutoff, revision, referenceSnapshotId: options.reference.snapshot.snapshotId,
        inputSnapshotIds: [...observations.values()].sort((a, b) => a.observation.month.localeCompare(b.observation.month)).map(o => o.observation.snapshot.snapshotId), priceBasis: 'reference-observation' as const, historicalPriceStatus: 'not-collected' as const,
        comparisonBasis: 'complete-common-members' as const, products, analysis, monthly,...extra,...(requestBound?{sourcePolicy:marketProductSourcePolicy(scope.marketplace)}:{}) };
    return freeze({ ...value, catalogId: 'market-shape-price:' + digest(value) });
}
