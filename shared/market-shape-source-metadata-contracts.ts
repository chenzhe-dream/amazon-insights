import {z} from 'zod';
const text=z.string().max(4000),num=z.number().finite().nonnegative().nullable();
const evidence=z.object({sourceRef:z.string().regex(/^market-source:[a-f0-9]{64}$/),inputSnapshotId:z.string().regex(/^market-input:[a-f0-9]{64}$/),payloadPath:z.tuple([z.literal('data'),z.number().int().nonnegative(),z.enum(['totalRevenue','rating','ratings','sellerName','sellerType','shelfDate'])])}).strict();
const issues=z.array(z.enum(['missing','invalid','scope-unconfirmed','currency-unconfirmed','period-unconfirmed','period-outside-provider-history','listed-after-reference-month']));
const numeric=z.object({rawValue:num,value:num,issues,evidence}).strict(),string=z.object({rawValue:text.nullable(),value:text.nullable(),issues,evidence}).strict();
export const MarketShapeSourceMetadataSchema=z.object({basis:z.literal('reference-observation'),referenceMonth:z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/),
 revenue:numeric,rating:numeric.extend({value:z.number().min(0).max(5).nullable()}),ratingCount:numeric.extend({value:z.number().int().nonnegative().safe().nullable()}),sellerName:string,sellerType:string,listedAt:string.extend({value:z.string().date().nullable()}),
}).strict();
export type MarketShapeSourceMetadata=z.infer<typeof MarketShapeSourceMetadataSchema>;
