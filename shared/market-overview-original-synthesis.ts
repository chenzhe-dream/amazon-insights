import {z} from 'zod';
const scores=z.object({marketDemand:z.number().finite(),marketCompetition:z.number().finite(),marketMaturity:z.number().finite(),newEntryBarrier:z.number().finite(),productOpportunity:z.number().finite(),priceOpportunity:z.number().finite()}).strict();
export const MarketOverviewOriginalSynthesisSchema=z.object({
 version:z.literal(6),
 summary:z.object({version:z.literal(6),score:z.number().finite(),grade:z.enum(['极高机会','高机会','良好机会','一般机会','谨慎机会','低机会']),gradeLabel:z.enum(['重点准入','优先准入','建议准入','可评估准入','谨慎准入','不建议准入']),gradeDefinition:z.string(),scores,sections:z.object({demand:z.string(),competition:z.string(),maturity:z.string(),newEntry:z.string(),productOpportunity:z.string(),priceOpportunity:z.string()}).strict(),topOpportunities:z.array(z.string()),topRisks:z.array(z.string()),finalVerdict:z.string(),crossSignals:z.array(z.string())}).strict(),
 inputGaps:z.array(z.string()),sourceRefs:z.array(z.string().regex(/^market-source:[a-f0-9]{64}$/)),originalAssumptions:z.array(z.string()),
}).strict();
export type MarketOverviewOriginalSynthesis=z.infer<typeof MarketOverviewOriginalSynthesisSchema>;
