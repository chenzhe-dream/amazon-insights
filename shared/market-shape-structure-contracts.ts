import { z } from 'zod';
import {MARKET_SHAPE_REQUEST_BOUND_CATALOG_VERSION,MarketProductScopeBasisSchema} from './market-product-source-policy';
export const MARKET_SHAPE_STRUCTURE_CATALOG_VERSION = 'market-shape-price-catalog/v2' as const;
export const MarketShapeCatalogVersionSchema = z.enum(['market-shape-price-catalog/v1', MARKET_SHAPE_STRUCTURE_CATALOG_VERSION,MARKET_SHAPE_REQUEST_BOUND_CATALOG_VERSION]);
export const MARKET_LISTING_AGE_BANDS = [
    { id: '0-2', label: '0–2个月', minInclusive: 0, maxExclusive: 3 },
    { id: '3-5', label: '3–5个月', minInclusive: 3, maxExclusive: 6 },
    { id: '6-11', label: '6–11个月', minInclusive: 6, maxExclusive: 12 },
    { id: '12-23', label: '12–23个月', minInclusive: 12, maxExclusive: 24 },
    { id: '24+', label: '24个月及以上', minInclusive: 24, maxExclusive: null },
] as const;
const text = z.string().max(4000), asin = z.string().regex(/^[A-Z0-9]{10}$/), count = z.number().int().nonnegative().safe();
const units = z.number().finite().nonnegative().nullable();
const ratio = z.object({ numerator: units, denominator: units, value: z.number().min(0).max(1).nullable() }).strict();
const stats = z.object({ requestedLinks: count, comparableLinks: count, units, monthlyUnitsPerLink: units, linkShare: ratio, salesShare: ratio }).strict();
const source = z.object({ sourceRef: z.string().regex(/^market-source:[a-f0-9]{64}$/), inputSnapshotId: z.string().regex(/^market-input:[a-f0-9]{64}$/), payloadPath: z.tuple([z.literal('data'), count, z.enum(['brand', 'shelfDate'])]) }).strict();
const issue = z.array(z.enum(['scope-unconfirmed', 'brand-missing', 'listing-date-missing', 'listing-date-invalid', 'listed-after-reference-month'])).max(5);
export const MarketShapeStructureSchema = z.object({
    ruleVersion: z.enum(['market-shape-structure/v1','market-shape-structure/v2']), referenceMonth: z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/),
    ageBasis: z.literal('calendar-month-difference-at-reference'), attributeBasis: z.literal('reference-observation'),
    salesBasis: z.literal('complete-common-members'), monthCount: count.min(1),
    products: z.array(z.object({ asin, shape: text.nullable(), priceBandId: text.nullable(), comparableUnits: units,
        brand: z.object({ rawValue: text.nullable(), value: text.nullable(), issues: issue, evidence: source, scopeBasis:MarketProductScopeBasisSchema.optional() }).strict(),
        listing: z.object({ rawValue: text.nullable(), value: z.string().date().nullable(), ageMonths: count.nullable(), bucketId: text.nullable(), issues: issue, evidence: source, scopeBasis:MarketProductScopeBasisSchema.optional() }).strict(),
    }).strict()).max(100),
    segments: z.array(z.object({ kind: z.enum(['all', 'shape']), labelId: text.nullable(), requestedAsins: z.array(asin).max(100), eligibleAsins: z.array(asin).max(100),
        brands: z.array(z.object({ brand: text.nullable(), asins: z.array(asin).max(100), stats,
            bands: z.array(z.object({ bandId: text.nullable(), asins: z.array(asin).max(100), stats }).strict()).max(33),
        }).strict()).max(100),
        ages: z.array(z.object({ bucketId: text.nullable(), asins: z.array(asin).max(100), stats }).strict()).max(6),
    }).strict()).max(34),
}).strict();
export type MarketShapeStructure = z.infer<typeof MarketShapeStructureSchema>;
