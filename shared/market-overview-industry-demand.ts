import {z} from 'zod';
const month=z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/);
export const MarketOverviewIndustryDemandSchema=z.object({status:z.enum(['ready','partial','empty','failed','not-collected']),seed:z.string().nullable(),referenceMonth:month,series:z.array(z.object({keyword:z.string().min(1).max(500),status:z.enum(['ready','empty','failed']),searches:z.number().finite().nonnegative().nullable(),points:z.array(z.object({month,value:z.number().finite().nonnegative()}).strict()).max(48),sourceRef:z.string().regex(/^market-source:[a-f0-9]{64}$/).nullable(),errorCode:z.string().nullable()}).strict()).max(5),issues:z.array(z.object({operation:z.string(),code:z.string(),retryable:z.boolean()}).strict()).max(20)}).strict();
export type MarketOverviewIndustryDemand=z.infer<typeof MarketOverviewIndustryDemandSchema>;
export const OverviewIndustryDemandInputSchema=z.object({phase:z.literal('overview-industry-demand'),catalogAttemptId:z.string().uuid()}).strict();
