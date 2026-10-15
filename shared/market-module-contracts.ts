import { z } from 'zod';
import { MarketAnalysisScopeSchema } from './market-analysis-contracts';
export { MarketRuleBaselineSchema, normalizeMarketRuleBaseline } from './market-rule-baseline-contracts';
import {marketSiteCurrencyMatches} from './market-sites';
import {MarketThemeSourceIssueSchema} from './market-theme-source-issue';

export const MarketModuleIdSchema = z.string().uuid().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i).toLowerCase();
const { organizationId: _organizationId, researchId: _researchId, ...publicScopeShape } = MarketAnalysisScopeSchema.shape;
export const MarketStudyRequestSchema = z.object(publicScopeShape).strict().refine(v=>!v.overviewPeriod||v.fromMonth===v.toMonth,'Rolling overview uses one historical cutoff').refine(v => v.fromMonth <= v.toMonth, 'Research period is reversed').refine(marketSiteCurrencyMatches,'Market currency differs from marketplace');
export const MarketStudyResponseSchema = z.object({ study: z.object({ id: MarketModuleIdSchema, scope: MarketAnalysisScopeSchema, createdAt: z.string().datetime() }).strict() }).strict();
export const MarketThemeStartRequestSchema = z.object({ memberCount: z.number().int().min(1).max(20).default(20),
  poolSize: z.number().int().min(1).max(100).default(100), newProductMonths: z.union([z.literal(1), z.literal(3), z.literal(6), z.literal(12)]).default(6),
  topN: z.number().int().min(0).max(2000).optional() }).strict().refine(v => v.poolSize >= v.memberCount);
export const MarketModuleRetryRequestSchema = z.object({ steps: z.array(z.object({ stepId: MarketModuleIdSchema, failedAttemptId: MarketModuleIdSchema }).strict()).min(1).max(2000) }).strict();
export const MarketModuleRetryResponseSchema = z.object({ moduleRunId: MarketModuleIdSchema, stepIds: z.array(MarketModuleIdSchema).max(2000) }).strict();
export const MarketModuleCancelResponseSchema = z.object({ moduleRunId: MarketModuleIdSchema, cancelled: z.literal(true) }).strict();
const count = z.number().int().nonnegative().safe();
export const MarketThemeReadinessCountsSchema = z.object({ requestedCount: count.min(1).max(20), selectedCount: count.max(20), successfulCount: count,
  emptyCount: count, failedCount: count, missingCount: count, expectedMemberCount: count, validatedMemberCount: count,
  quarantinedThemeCount:count.optional(), mappedMemberCount: count, unknownCount: count, unavailableCount: count, reconciliationRequired: z.boolean() }).strict();
const hash = z.string().regex(/^[a-f0-9]{64}$/), version = z.string().min(1).max(240);
export const MarketThemeReportSchema = z.object({ reportVersion: z.enum(['market-theme-report/v1','market-theme-report/v2','market-theme-report/v3']), moduleRunId: MarketModuleIdSchema,
  scope: MarketAnalysisScopeSchema, versions: z.object({ source: version, rule: version, mapping: version, planner: version, model: version.nullable(), prompt: version.nullable(), configuration: version.nullable() }).strict(),
  basis: z.enum(['rules', 'empty-selection','reconciliation-evaluation']), basisAttemptId: MarketModuleIdSchema, inputSnapshotId: z.string().regex(/^market-input:[a-f0-9]{64}$/), resultHash: hash.nullable(),
  dataCutoffAt: z.string().datetime(),categoryName:z.string().max(500).nullable().optional(), selectedAsins: z.array(z.string().regex(/^[A-Z0-9]{10}$/)).max(20), selectionBasis: z.literal('provider-row-order'), bsrTopVerified: z.literal(false),
  metricKind: z.literal('customers_say_topic_share'), reviewDeduplication: z.literal('unavailable'), status: z.enum(['complete', 'partial', 'no-data']),
  dataReady: z.boolean(), semanticsReady: z.boolean(), counts: MarketThemeReadinessCountsSchema,
  reasons: z.array(z.enum(['selection-shortfall', 'no-theme-data', 'empty-asins', 'source-results-missing', 'model-results-missing', 'unknown-themes', 'reconciliation-required', 'quarantined-themes'])).max(8), reportHash: hash,
  ruleStatus: z.enum(['complete','partial','unavailable']).optional(), semanticStatus: z.enum(['skipped','pending','partial','complete','unavailable']).optional() }).strict()
  .refine(v=>(v.basis==='reconciliation-evaluation')===(v.reportVersion==='market-theme-report/v2')&&
    (['market-theme-flow/rules-v2','market-theme-flow/rules-v3'].includes(v.versions.planner))===(v.reportVersion==='market-theme-report/v3'),'Theme report version differs from its basis');
export const MarketThemeReportEntrySchema = z.object({ attemptId: MarketModuleIdSchema, current: z.boolean(), report: MarketThemeReportSchema }).strict();
export const MarketModuleStepPublicSchema = z.object({ id: MarketModuleIdSchema, kind: z.enum(['collect-product-month', 'collect-product-history', 'collect-product-amount-history','collect-product-image', 'collect-shape-pool', 'collect-shape-category', 'collect-overview-month', 'collect-keyword-page', 'collect-keyword-trend', 'collect-keyword-aba', 'collect-customer-themes',
  'prepare-members', 'prepare-keyword-pool', 'prepare-model-batches', 'reconcile', 'model-batch', 'rules', 'report']), status: z.enum(['queued', 'running', 'succeeded', 'empty', 'failed', 'cancelled']),
  latestAttemptId: MarketModuleIdSchema.nullable(), attemptCount: count, current: z.boolean(), canRetry: z.boolean(), asin: z.string().regex(/^[A-Z0-9]{10}$/).nullable(),
  nextAttemptAt:z.string().datetime().nullable().optional(),
  sourceIssue:MarketThemeSourceIssueSchema.optional(),
  errorCode: z.enum(['quota-exhausted', 'rate-limit', 'local-admission', 'upstream-temporary', 'timeout', 'interrupted', 'authentication', 'governance', 'invalid-data', 'scope-mismatch', 'cancelled', 'internal', 'unsupported-marketplace']).nullable() }).strict();
export const MarketThemeRunResponseSchema = z.object({ run: z.object({ id: MarketModuleIdSchema, scope: MarketAnalysisScopeSchema,
  status: z.enum(['queued', 'running', 'partial', 'succeeded', 'failed', 'cancelled']), createdAt: z.string().datetime(), planRevision: count,
  params: MarketThemeStartRequestSchema, steps: z.array(MarketModuleStepPublicSchema), currentReport: MarketThemeReportEntrySchema.nullable(),
  latestSavedReport: MarketThemeReportEntrySchema.nullable(), history: z.array(MarketThemeReportEntrySchema) }).strict() }).strict();
export type MarketThemeRunResponse = z.infer<typeof MarketThemeRunResponseSchema>;
