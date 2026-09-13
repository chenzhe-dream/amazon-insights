import {marketProductSourceAdmission} from './product-source-admission';
import { z } from 'zod';
import { MARKET_LISTING_AGE_BANDS, MarketShapeStructureSchema, type MarketShapeStructure } from '../../../shared/market-shape-structure-contracts';
import type { readMarketProductMonth } from './product-month-evidence';
import type { ShapePriceAnalysisResult, ShapePriceBand } from './shape-price';
type Reference = Awaited<ReturnType<typeof readMarketProductMonth>>;
type Row = MarketShapeStructure['products'][number];
const monthIndex = (month: string) => Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1;
const record = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const ratio = (numerator: number | null, denominator: number | null) => ({ numerator, denominator, value: numerator === null || denominator === null || denominator === 0 ? null : numerator / denominator });
function sum(rows: readonly Row[]): number | null {
    const values = rows.map(r => r.comparableUnits).filter((v): v is number => v !== null);
    if (!values.length)
        return null;
    const total = values.reduce((a, b) => a + b, 0);
    if (!Number.isFinite(total))
        throw new RangeError('Shape structure sales overflow');
    return total;
}
function stats(rows: readonly Row[], denominator: readonly Row[], monthCount: number) {
    const units = sum(rows), comparableLinks = rows.filter(r => r.comparableUnits !== null).length;
    return { requestedLinks: rows.length, comparableLinks, units, monthlyUnitsPerLink: units === null || comparableLinks === 0 ? null : units / (comparableLinks * monthCount),
        linkShare: ratio(rows.length, denominator.length), salesShare: ratio(units, sum(denominator)) };
}
/** Metadata from the reference snapshot only; no brand alias inference, current
 * clock, model decisions, network calls or monthly-cohort substitutions. */
export function buildMarketShapeStructure(options: {
    reference: Reference;
    requestBound?:boolean;
    products: readonly {
        asin: string;
        shape: string | null;
        referencePrice: {
            value: number | null;
        };
        observations: readonly {
            month: string;
            units: number | null;
        }[];
    }[];
    analysis: ShapePriceAnalysisResult;
    bands: readonly ShapePriceBand[];
}): MarketShapeStructure {
    const { reference, analysis, bands } = options, eligible = new Set(analysis.scope.eligibleAsins), month = reference.observation.month;
    const rawRows = record(reference.source.payload).data as unknown[];
    const products: Row[] = options.products.map(p => {
        const source = reference.products.find(r => r.asin === p.asin);
        if (!source)
            throw new TypeError('Structure member is outside the frozen reference');
        const raw = record(rawRows[source.sourceIndex]), brandIssues: Row['brand']['issues'] = [], listingIssues: Row['listing']['issues'] = [];
        const proof=options.requestBound?marketProductSourceAdmission(reference,p.asin):null;
        if (!proof&&!source.scopeConfirmed) {
            brandIssues.push('scope-unconfirmed');
            listingIssues.push('scope-unconfirmed');
        }
        if (source.brand === null)
            brandIssues.push('brand-missing');
        const rawDate = typeof raw.shelfDate === 'string' ? raw.shelfDate : null;
        // Date.parse normalizes impossible days in some runtimes. Round-trip before
        // admitting a date, including leap-day and end-of-month boundaries.
        const date = z.string().date().safeParse(rawDate);
        const validDate = date.success && Number.isFinite(Date.parse(date.data)) && new Date(date.data).toISOString().slice(0, 10) === date.data ? date.data : null;
        if (raw.shelfDate === null || raw.shelfDate === undefined || raw.shelfDate === '')
            listingIssues.push('listing-date-missing');
        else if (!validDate)
            listingIssues.push('listing-date-invalid');
        else if (validDate.slice(0, 7) > month)
            listingIssues.push('listed-after-reference-month');
        const listingDate = listingIssues.length ? null : validDate, age = listingDate === null ? null : monthIndex(month) - monthIndex(listingDate);
        const evidence = (field: 'brand' | 'shelfDate') => ({ sourceRef: reference.observation.sourceRef, inputSnapshotId: reference.observation.snapshot.snapshotId, payloadPath: ['data', source.sourceIndex, field] as [
                'data',
                number,
                'brand' | 'shelfDate'
            ] });
        const values = p.observations.map(o => o.units), comparableUnits = eligible.has(p.asin) ? values.reduce<number>((a, b) => { if (b === null)
            throw new TypeError('Comparable member has an unknown month'); return a + b; }, 0) : null;
        return { asin: p.asin, shape: p.shape, priceBandId: p.referencePrice.value === null ? null : bands.find(b => p.referencePrice.value! >= b.minInclusive && (b.maxExclusive === null || p.referencePrice.value! < b.maxExclusive))?.id ?? null, comparableUnits,
            brand: { rawValue: typeof raw.brand === 'string' ? raw.brand : null, value: brandIssues.length ? null : source.brand, issues: brandIssues, evidence: evidence('brand'),...(proof?{scopeBasis:proof.scopeBasis}:{}) },
            listing: { rawValue: rawDate, value: listingDate, ageMonths: age, bucketId: age === null ? null : MARKET_LISTING_AGE_BANDS.find(b => age >= b.minInclusive && (b.maxExclusive === null || age < b.maxExclusive))!.id, issues: listingIssues, evidence: evidence('shelfDate'),...(proof?{scopeBasis:proof.scopeBasis}:{}) },
        };
    });
    const segment = (kind: 'all' | 'shape', labelId: string | null, rows: Row[]) => ({ kind, labelId, requestedAsins: rows.map(r => r.asin), eligibleAsins: rows.filter(r => eligible.has(r.asin)).map(r => r.asin),
        brands: [...new Set(rows.map(r => r.brand.value))].sort((a, b) => a === null ? 1 : b === null ? -1 : a < b ? -1 : a > b ? 1 : 0).map(brand => {
            const members = rows.filter(r => r.brand.value === brand);
            return { brand, asins: members.map(r => r.asin), stats: stats(members, rows, analysis.months.length),
                bands: [...bands.map(b => b.id), null].filter(id => members.some(r => r.priceBandId === id)).map(bandId => { const matching = members.filter(r => r.priceBandId === bandId); return { bandId, asins: matching.map(r => r.asin), stats: stats(matching, rows.filter(r => r.priceBandId === bandId), analysis.months.length) }; }) };
        }),
        ages: [...MARKET_LISTING_AGE_BANDS.map(b => b.id), null].map(bucketId => { const members = rows.filter(r => r.listing.bucketId === bucketId); return { bucketId, asins: members.map(r => r.asin), stats: stats(members, rows, analysis.months.length) }; }),
    });
    return MarketShapeStructureSchema.parse({ ruleVersion: options.requestBound?'market-shape-structure/v2':'market-shape-structure/v1', referenceMonth: month, ageBasis: 'calendar-month-difference-at-reference', attributeBasis: 'reference-observation', salesBasis: 'complete-common-members', monthCount: analysis.months.length, products,
        segments: [segment('all', null, products), ...analysis.shapes.map(s => segment('shape', s.shape, products.filter(p => p.shape === s.shape)))] });
}
