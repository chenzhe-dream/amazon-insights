import {z} from 'zod';
import {CALENDAR_HISTORY_POLICY} from './product-history-windows';
const month=z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/),units=z.number().nonnegative().int().safe().nullable();
export const ProductHistoryPointSchema=z.object({month,units,issues:z.array(z.enum(['invalid-value','conflicting-month'])).max(2)}).strict();
export type ProductHistoryPoint=z.infer<typeof ProductHistoryPointSchema>;
export const ProductHistoryPublicSchema=z.object({
 provider:z.enum(['sorftime','sellerSprite','mixed']),metric:z.literal('SalesVolume'),referenceMonth:month,
 products:z.array(z.object({asin:z.string().regex(/^[A-Z0-9]{10}$/),status:z.enum(['queued','running','ready','partial','empty','failed','cancelled']),
  sourceRef:z.string().regex(/^market-source:[a-f0-9]{64}$/).nullable(),inputSnapshotId:z.string().regex(/^market-input:[a-f0-9]{64}$/).nullable(),
  periodPolicy:z.literal(CALENDAR_HISTORY_POLICY).optional(),provider:z.enum(['sorftime','sellerSprite']).optional(),fetchedAt:z.string().datetime().nullable(),errorCode:z.string().max(100).nullable(),
  points:z.array(ProductHistoryPointSchema).max(120),
  periods:z.array(z.object({id:z.string(),fromMonth:month,toMonth:month,units,missingMonths:z.array(month).max(12)}).strict()).max(4)
 }).strict()).max(300)
}).strict();

const amount=z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable();
export const ProductAmountHistoryPointSchema=z.object({month,amount,issues:z.array(z.enum(['invalid-value','conflicting-month'])).max(2)}).strict();
export type ProductAmountHistoryPoint=z.infer<typeof ProductAmountHistoryPointSchema>;
export const ProductAmountHistoryPublicSchema=z.object({
 provider:z.enum(['sorftime','sellerSprite','mixed']),metric:z.literal('SalesAmount'),currency:z.string().regex(/^[A-Z]{3}$/),referenceMonth:month,
 products:z.array(z.object({asin:z.string().regex(/^[A-Z0-9]{10}$/),status:z.enum(['queued','running','ready','partial','empty','failed','cancelled']),
  sourceRef:z.string().regex(/^market-source:[a-f0-9]{64}$/).nullable(),inputSnapshotId:z.string().regex(/^market-input:[a-f0-9]{64}$/).nullable(),
  periodPolicy:z.literal(CALENDAR_HISTORY_POLICY).optional(),provider:z.enum(['sorftime','sellerSprite']).optional(),fetchedAt:z.string().datetime().nullable(),errorCode:z.string().max(100).nullable(),
  points:z.array(ProductAmountHistoryPointSchema).max(120),
  periods:z.array(z.object({id:z.string(),fromMonth:month,toMonth:month,months:z.array(month).max(120),amount,missingMonths:z.array(month).max(120)}).strict()).max(4)
 }).strict()).max(300)
}).strict();
