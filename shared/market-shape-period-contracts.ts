import {z} from 'zod';
export const MARKET_SHAPE_PERIOD_PROJECTION_VERSION='market-shape-period-projection/v1' as const;
// Display periods can precede the first supported study year (e.g. 1998 for a 2000 study).
const text=z.string().max(4000),month=z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),asin=z.string().regex(/^[A-Z0-9]{10}$/),count=z.number().int().nonnegative().safe(),num=z.number().finite().nonnegative().nullable();
const ratio=z.object({numerator:num,denominator:num,value:z.number().min(0).max(1).nullable()}).strict();
const stats=z.object({requestedLinks:count,comparableLinks:count,units:num,monthlyUnitsPerLink:num,linkShare:ratio,salesShare:ratio}).strict();
const band=z.object({bandId:text.nullable(),stats}).strict();
export const MarketShapePeriodProjectionSchema=z.object({version:z.literal(MARKET_SHAPE_PERIOD_PROJECTION_VERSION),basisCatalogId:z.string().regex(/^market-shape-price:[a-f0-9]{64}$/),comparisonBasis:z.literal('whole-study-complete-common-members'),
 periods:z.array(z.object({id:text,label:text,fromMonth:month,toMonth:month,monthCount:count.min(1),status:z.enum(['available','unavailable']),issues:z.array(z.enum(['period-not-saved','no-comparable-members'])),
  products:z.array(z.object({asin,units:num,issues:z.array(z.enum(['period-not-saved','outside-comparable-cohort']))}).strict()).max(100),
  segments:z.array(z.object({kind:z.enum(['all','shape']),labelId:text.nullable(),requestedAsins:z.array(asin).max(100),eligibleAsins:z.array(asin).max(100),stats,bands:z.array(band).max(33),
   brands:z.array(z.object({brand:text.nullable(),stats,bands:z.array(band).max(33)}).strict()).max(100),
   listingYears:z.array(z.object({year:z.number().int().min(1).max(9999).nullable(),stats}).strict()).max(100),
  }).strict()).max(34),
 }).strict()).max(5),
}).strict();
export type MarketShapePeriodProjection=z.infer<typeof MarketShapePeriodProjectionSchema>;
