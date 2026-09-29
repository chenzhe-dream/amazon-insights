import {z} from 'zod';
const score=z.number().finite().nullable();
const scores=z.object({marketDemand:score,marketCompetition:score,marketMaturity:score,newEntryBarrier:score,productOpportunity:score,priceOpportunity:score}).strict();
const dimension=z.object({status:z.enum(['ready','insufficient']),missing:z.array(z.string())}).strict();
export const OverviewScoreEvaluationSchema=z.object({version:z.literal('observed-inputs/1'),status:z.enum(['ready','partial','insufficient']),dimensions:z.object({marketDemand:dimension,marketCompetition:dimension,marketMaturity:dimension,newEntryBarrier:dimension,productOpportunity:dimension,priceOpportunity:dimension}).strict()}).strict();
export const MarketOverviewOriginalSynthesisSchema=z.object({
 version:z.literal(6),
 summary:z.object({version:z.literal(6),score,grade:z.enum(['极高机会','高机会','良好机会','一般机会','谨慎机会','低机会']).nullable(),gradeLabel:z.enum(['重点准入','优先准入','建议准入','可评估准入','谨慎准入','不建议准入']).nullable(),gradeDefinition:z.string(),scores,sections:z.object({demand:z.string(),competition:z.string(),maturity:z.string(),newEntry:z.string(),productOpportunity:z.string(),priceOpportunity:z.string()}).strict(),topOpportunities:z.array(z.string()),topRisks:z.array(z.string()),finalVerdict:z.string(),crossSignals:z.array(z.string())}).strict(),
 evaluation:OverviewScoreEvaluationSchema.optional(),
 inputGaps:z.array(z.string()),sourceRefs:z.array(z.string().regex(/^market-source:[a-f0-9]{64}$/)),originalAssumptions:z.array(z.string()),
}).strict();
export type MarketOverviewOriginalSynthesis=z.infer<typeof MarketOverviewOriginalSynthesisSchema>;
