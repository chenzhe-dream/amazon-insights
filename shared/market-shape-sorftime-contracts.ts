import {z} from 'zod';
const text=z.string().max(4000).nullable(),num=z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable();
export const SorftimeShapeProductSchema=z.object({
 asin:z.string().regex(/^[A-Z0-9]{10}$/),sourceIndex:z.number().int().nonnegative(),title:text,brand:text,
 price:num,units:num.refine(v=>v===null||Number.isSafeInteger(v)),revenue:num,sourceRank:num,
 rating:z.number().min(0).max(5).nullable(),ratingCount:num.refine(v=>v===null||Number.isSafeInteger(v)),sellerName:text,sellerType:text,listedAt:text,
 imageUrl:z.string().url().max(4000).nullable(),grossProfitMargin:z.number().finite().min(-1000).max(100).nullable(),
 categoryRank:text,productCategory:text,sellerOrigin:text,
}).strict();
export type SorftimeShapeProduct=z.infer<typeof SorftimeShapeProductSchema>;
export const SorftimeShapePoolPublicSchema=z.object({provider:z.literal('sorftime'),period:z.literal('recent-30-days'),fetchedAt:z.string().datetime(),categoryName:text,
 products:z.array(SorftimeShapeProductSchema).max(300),sourceRefs:z.array(z.string()).max(21),requestedSize:z.number().int().min(1).max(300),
}).strict();
