import {z} from 'zod';
import {MarketTextSpanRefSchema} from './market-semantic-contracts';
const dimension=z.enum(['W1','W2','W3','W4','cluster']);
const decision=z.object({status:z.enum(['supported','unknown','unavailable']),candidateIds:z.array(z.string()),reason:z.string().nullable(),evidence:z.array(MarketTextSpanRefSchema)}).strict();
export const MarketKeywordReconciliationReportSchema=z.object({
 version:z.literal('keyword-reconciliation-report/v1'),moduleRunId:z.string().uuid(),inputSnapshotId:z.string().nullable(),
 status:z.enum(['pending','failed','cancelled','unavailable','empty','waiting-initial-models','ready','partial']),completedRounds:z.number().int().nonnegative(),resultHash:z.string().nullable(),
 catalog:z.array(z.object({candidateId:z.string(),dimension,label:z.string(),definition:z.string(),evidence:z.array(MarketTextSpanRefSchema)}).strict()),
 decisions:z.array(z.object({keywordId:z.string(),W1:decision,W2:decision,W3:decision,W4:decision,cluster:decision}).strict()).max(2000),
}).strict();
export type MarketKeywordReconciliationReport=z.infer<typeof MarketKeywordReconciliationReportSchema>;
