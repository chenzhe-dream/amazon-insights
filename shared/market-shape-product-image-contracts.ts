import {z} from 'zod';

const asin=z.string().regex(/^[A-Z0-9]{10}$/);
export function isAllowedAmazonProductImage(value:string){
 try{
  const url=new URL(value);
  return url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&
   ['m.media-amazon.com','images-na.ssl-images-amazon.com','images-eu.ssl-images-amazon.com','images-fe.ssl-images-amazon.com'].includes(url.hostname)&&value.length<=4000;
 }catch{return false;}
}
export const MarketShapeProductImageUrlSchema=z.string().url().refine(isAllowedAmazonProductImage).nullable();
export const MarketShapeProductImageSchema=z.object({
 asin,status:z.enum(['queued','running','ready','empty','failed','cancelled']),imageUrl:MarketShapeProductImageUrlSchema,
 sourceRef:z.string().regex(/^market-source:[a-f0-9]{64}$/).nullable(),inputSnapshotId:z.string().regex(/^market-input:[a-f0-9]{64}$/).nullable(),
 fetchedAt:z.string().datetime().nullable(),errorCode:z.string().max(100).nullable(),
 // Optional read projection of the same frozen detail source; old revisions keep their original fields.
 marginObservation:z.object({grossProfitMargin:z.number().finite().min(-1000).max(100),price:z.number().finite().positive().max(Number.MAX_SAFE_INTEGER)}).strict().nullable().optional(),
}).strict();
export const MarketShapeProductImagesPublicSchema=z.object({provider:z.literal('sorftime'),products:z.array(MarketShapeProductImageSchema).max(300)}).strict();
export type MarketShapeProductImagesPublic=z.infer<typeof MarketShapeProductImagesPublicSchema>;
