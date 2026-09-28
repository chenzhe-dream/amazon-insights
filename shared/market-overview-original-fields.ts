import {z} from 'zod';

const field=z.object({value:z.union([z.number().finite(),z.string(),z.null()]),unit:z.enum(['count','currency','percent','lb','g','in3','cm3','date']),sourceRef:z.string().nullable(),sourceField:z.string().nullable(),scopeBasis:z.enum(['request-bound','response-verified']).nullable(),reason:z.enum(['not-collected','field-absent','invalid-source','unit-unknown']).nullable()}).strict();
/** Read-only projection of the original SellerSprite overview row. It is never a report fact. */
export const MarketOverviewOriginalFieldsSchema=z.object({month:z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/),headTopN:z.union([z.literal(5),z.literal(10),z.literal(20)]),newProductMonths:z.union([z.literal(1),z.literal(3),z.literal(6),z.literal(12)]),currency:z.string().regex(/^[A-Z]{3}$/),fields:z.record(z.string(),field)}).strict();
export type MarketOverviewOriginalFields=z.infer<typeof MarketOverviewOriginalFieldsSchema>;
