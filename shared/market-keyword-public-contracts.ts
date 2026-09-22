import { z } from 'zod';
import { MarketAnalysisScopeSchema } from './market-analysis-contracts';
import { MarketKeywordStartRequestSchema } from './market-keyword-flow-contracts';
import { MarketKeywordSemanticsOutputSchema } from './market-semantic-contracts';
import { MarketModuleStepPublicSchema } from './market-module-contracts';
import {MarketKeywordReconciliationReportSchema} from './market-keyword-reconciliation-contracts';
import {MarketKeywordRuleReportSchema} from './market-keyword-rule-report-contracts';
import {MarketKeywordComparisonMonthsSchema} from './market-keyword-comparison-contracts';
import {MarketKeywordAbaMemberSchema} from './market-keyword-aba-source-contracts';
import {MarketKeywordScoreInputAuditSchema} from './market-keyword-score-input-audit-contracts';
import {MarketRuleBaselineSchema} from './market-rule-baseline-contracts';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const inputId = z.string().regex(/^market-input:[a-f0-9]{64}$/);
const sourceRef = z.string().regex(/^market-source:[a-f0-9]{64}$/);
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const value = z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER).nullable();
const month = z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/);
const measurement = z.object({ value, reason: z.enum(['missing', 'incomplete-month']).nullable() }).strict();
const growth = z.object({ value: z.number().finite().min(-1).nullable(), reason: z.enum(['missing-current', 'missing-baseline', 'zero-baseline']).nullable(),
  baselineMonth: month, baselineValue: value, formulaVersion: z.literal('calendar-month-growth/v1') }).strict();
const trendMonth = z.object({ month, searchVolume: measurement, searchRank: measurement, recommendedBid: measurement,
  yoyGrowth: growth, recentGrowth: growth }).strict();
const pageIdentity = MarketKeywordStartRequestSchema.shape.plannedPages.element;
const occurrence = z.object({ inputSnapshotId: inputId, sourceRef, seed: z.string(), page: count, sourceIndex: count, memberHash: hash }).strict();

export const MarketKeywordFactsSchema = z.object({
  version: z.literal('market-keyword-facts/v1'), factsId: z.string().regex(/^market-keyword-facts:[a-f0-9]{64}$/),
  moduleRunId: z.string().uuid(), scope: MarketAnalysisScopeSchema, referenceMonth: month,
  pool: z.object({ attemptId: z.string().uuid(), rawInputSnapshotId: inputId, semanticInputSnapshotId: inputId, basisHash: hash,
    dataCutoffAt: z.string().datetime(), plannedPageCount: count, receivedPageCount: count,
    missingPages: z.array(pageIdentity), emptyPages: z.array(pageIdentity), fullPages: z.array(pageIdentity),
    collectionCoverage: z.enum(['none', 'partial', 'complete']), exhaustive: z.literal(false), maxMembers: count,
    uniqueObservedMemberCount: count, omittedMemberIds: z.array(z.string()), conflictingMemberIds: z.array(z.string()),
    duplicateMemberCount: count, memberLimitReached: z.boolean(), selectionPolicy: z.literal('seed-page-source-order/first-observation/v1'),
  }).strict(), ruleBaseline:MarketRuleBaselineSchema.optional(),
  members: z.array(z.object({ keywordId: z.string(), keyword: z.string(), sourceRef, occurrences: z.array(occurrence),
    aba:z.object({status:z.enum(['pending','failed','cancelled','ready','partial','empty','unsupported']),stepId:z.string().uuid().nullable(),attemptId:z.string().uuid().nullable(),
      inputSnapshotId:inputId.nullable(),sourceRef:sourceRef.nullable(),fetchedAt:z.string().datetime().nullable(),referenceMonth:month,
      sourceScope:z.literal('exact-keyword-marketplace'),nodeBinding:z.literal('not-provided'),member:MarketKeywordAbaMemberSchema.nullable()}).strict().optional(),
    pageMetrics: z.object({ monthlySearchVolume: measurement, weeklySearchVolume: measurement, weeklySearchRank: measurement,
      recommendedCpcUsd: measurement, period: z.literal('unspecified-source-window') }).strict(),
    trend: z.object({ status: z.enum(['pending', 'failed', 'cancelled', 'ready', 'partial', 'empty']),
      stepId: z.string().uuid().nullable(), attemptId: z.string().uuid().nullable(), inputSnapshotId: inputId.nullable(),
      sourceRef: sourceRef.nullable(), fetchedAt: z.string().datetime().nullable(), cpcCurrency: z.null(), months: z.array(trendMonth),
      comparisonMonths:MarketKeywordComparisonMonthsSchema.optional(),
    }).strict(),
    reference: z.object({ searchVolume: value, yoyGrowth: z.number().finite().min(-1).nullable(), recentGrowth: z.number().finite().min(-1).nullable(),
      actualCpcUsd: z.null(), actualCpcReason: z.literal('source-provides-recommended-bid-only') }).strict(),
  }).strict()).max(2000),
  semantics: z.object({ status: z.enum(['unavailable', 'pending', 'partial', 'validated']),
    unavailableKeywordIds: z.array(z.string()), unknownDimensionCount: count, unknownClusterCount: count,
    batches: z.array(z.object({ stepId: z.string().uuid(), attemptId: z.string().uuid(), agentRunId: z.string().uuid(), bindingId: z.string().uuid(),
      inputDigest: hash, output: MarketKeywordSemanticsOutputSchema }).strict()).max(2000),
  }).strict(),
}).strict();
export const MarketKeywordRunResponseSchema = z.object({ run: z.object({ id: z.string().uuid(), scope: MarketAnalysisScopeSchema,
  status: z.enum(['queued', 'running', 'partial', 'succeeded', 'failed', 'cancelled']), createdAt: z.string().datetime(),
  params: MarketKeywordStartRequestSchema, steps: z.array(MarketModuleStepPublicSchema), facts: MarketKeywordFactsSchema.nullable(), ruleStatus:z.enum(['complete','partial','unavailable']).optional(), semanticStatus:z.enum(['skipped','pending','partial','complete','unavailable']).optional(),
  reconciliation:MarketKeywordReconciliationReportSchema.optional(),
  ruleReport:MarketKeywordRuleReportSchema.optional(),
  scoreInputAudit:MarketKeywordScoreInputAuditSchema.optional(),
  history: z.array(z.object({ revisionId: z.string().regex(/^market-keyword-revision:[a-f0-9]{64}$/),
    parentRevisionId: z.string().regex(/^market-keyword-revision:[a-f0-9]{64}$/).nullable(), ordinal: count,
    createdAt: z.string().datetime(), factsId: z.string().regex(/^market-keyword-facts:[a-f0-9]{64}$/) }).strict()).optional(),
}).strict() }).strict();
export type MarketKeywordFacts = z.infer<typeof MarketKeywordFactsSchema>;
export type MarketKeywordRunResponse = z.infer<typeof MarketKeywordRunResponseSchema>;
