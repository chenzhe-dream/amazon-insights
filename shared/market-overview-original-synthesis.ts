import {z} from 'zod';
import {MARKET_OVERVIEW_ZIP_RULE_VERSION} from './market-overview-zip-baseline';
const score=z.number().finite().nullable();
const scores=z.object({marketDemand:score,marketCompetition:score,marketMaturity:score,newEntryBarrier:score,productOpportunity:score,priceOpportunity:score}).strict();
const item=z.object({id:z.string(),label:z.string(),status:z.enum(['known','missing']),score,missing:z.array(z.string()),group:z.enum(['scale','growth']).optional()}).strict();
const dimension=z.object({status:z.enum(['ready','partial','insufficient']),missing:z.array(z.string()),items:z.array(item).optional()}).strict();
export const OverviewScoreEvaluationSchema=z.object({version:z.enum(['observed-inputs/1','observed-items/2']),status:z.enum(['ready','partial','insufficient']),dimensions:z.object({marketDemand:dimension,marketCompetition:dimension,marketMaturity:dimension,newEntryBarrier:dimension,productOpportunity:dimension,priceOpportunity:dimension}).strict()}).strict();
const chapterStatus=z.enum(['ready','partial','insufficient']);
export const MarketOverviewChapterExplanationSchema=z.object({
 id:z.string().min(1).max(80),status:chapterStatus,performance:z.string().min(1).max(1000),meaning:z.string().min(1).max(1000),conclusion:z.string().min(1).max(1000),missing:z.array(z.string().max(240)).max(20),sourceRefs:z.array(z.string().regex(/^market-source:[a-f0-9]{64}$/)).max(200)
}).strict();
export const MarketOverviewOriginalSynthesisSchema=z.object({
 version:z.literal(6),
 summary:z.object({version:z.literal(6),ruleVersion:z.literal(MARKET_OVERVIEW_ZIP_RULE_VERSION),score,grade:z.enum(['极高机会','高机会','良好机会','一般机会','谨慎机会','低机会']).nullable(),gradeLabel:z.enum(['重点准入','优先准入','建议准入','可评估准入','谨慎准入','不建议准入']).nullable(),gradeDefinition:z.string(),scores,sections:z.object({demand:z.string(),competition:z.string(),maturity:z.string(),newEntry:z.string(),productOpportunity:z.string(),priceOpportunity:z.string()}).strict(),topOpportunities:z.array(z.string()),topRisks:z.array(z.string()),finalVerdict:z.string(),crossSignals:z.array(z.string())}).strict(),
 evaluation:OverviewScoreEvaluationSchema.optional(),
 inputGaps:z.array(z.string()),sourceRefs:z.array(z.string().regex(/^market-source:[a-f0-9]{64}$/)),originalAssumptions:z.array(z.string()),chapters:z.array(MarketOverviewChapterExplanationSchema).length(15).optional(),
}).strict();
export type MarketOverviewOriginalSynthesis=z.infer<typeof MarketOverviewOriginalSynthesisSchema>;
