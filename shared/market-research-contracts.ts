import { z } from "zod";
import {MarketSiteSchema,MarketCurrencySchema,marketSiteCurrency} from './market-sites';

const object = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();
const numberOrMissing = z.number().finite().nonnegative().nullable();
export const MarketResearchScopeSchema = object({
  marketplace: MarketSiteSchema,
  nodeQuery: z.string().trim().min(1).max(240).regex(/^\d+(?::\d+)*$/),
  month: z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/),
  headTopN: z.union([z.literal(5), z.literal(10), z.literal(20)]),
  newProductMonths: z.union([z.literal(1), z.literal(3), z.literal(6), z.literal(12)]),
});
export type MarketResearchScope = z.infer<typeof MarketResearchScopeSchema>;

export const MarketResearchIssueSchema = object({
  dataset: z.enum(["node", "research", "statistics"]),
  code: z.enum(["configuration", "authentication", "rate-limit", "timeout", "upstream-temporary", "upstream-permanent", "malformed-response", "empty", "scope-mismatch", "interrupted"]),
  message: z.string().max(240),
  retryable: z.boolean(),
});
export type MarketResearchIssue = z.infer<typeof MarketResearchIssueSchema>;
export const MarketResearchEvidenceSchema = object({
  dataset: z.enum(["node", "research", "statistics"]),
  operation: z.enum(["product_node", "market_research", "market_research_statistics"]),
  fetchedAt: z.string().datetime(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export const MarketOverviewMetricsSchema = object({
  sampleProducts: numberOrMissing, brands: numberOrMissing, sellers: numberOrMissing,
  totalUnits: numberOrMissing, totalRevenue: numberOrMissing,
  avgPrice: numberOrMissing, avgUnits: numberOrMissing,
  avgRatings: numberOrMissing, avgRating: z.number().min(0).max(5).nullable(),
  // Ratios are retained exactly as supplied until the upstream unit is confirmed.
  productConcentrationRaw: numberOrMissing, brandConcentrationRaw: numberOrMissing,
  sellerConcentrationRaw: numberOrMissing,
  newCount: numberOrMissing, newAvgPrice: numberOrMissing, newAvgUnits: numberOrMissing,
});
export type MarketOverviewMetrics = z.infer<typeof MarketOverviewMetricsSchema>;
export const MarketOverviewReportSchema = object({
  schemaVersion: z.literal("market-overview/v1"),
  scope: MarketResearchScopeSchema,
  nodeId: z.string().regex(/^\d+$/),
  nodeIdPath: z.string().regex(/^\d+(?::\d+)*$/),
  categoryName: z.string().max(300),
  currency: MarketCurrencySchema,
  collectedAt: z.string().datetime(),
  metrics: MarketOverviewMetricsSchema,
  evidence: z.array(MarketResearchEvidenceSchema).max(3),
  issues: z.array(MarketResearchIssueSchema).max(3),
  boundaries: z.array(z.string().max(300)).max(10),
}).refine(report=>marketSiteCurrency(report.scope.marketplace)===report.currency,'Report currency differs from marketplace');
export type MarketOverviewReport = z.infer<typeof MarketOverviewReportSchema>;
export const MarketResearchJobSchema = object({
  id: z.string().uuid(),
  scope: MarketResearchScopeSchema,
  status: z.enum(["queued", "running", "succeeded", "partial", "failed"]),
  attempts: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  report: MarketOverviewReportSchema.nullable(),
  error: MarketResearchIssueSchema.nullable(),
}).superRefine((job, ctx) => {
  if (["succeeded", "partial"].includes(job.status) !== Boolean(job.report)) ctx.addIssue({code:"custom",message:"Successful or partial jobs require a report; other jobs cannot have one"});
  if ((job.status === "failed") !== Boolean(job.error)) ctx.addIssue({code:"custom",message:"Only failed jobs require an error"});
  if (job.report && JSON.stringify(job.scope) !== JSON.stringify(job.report.scope)) ctx.addIssue({code:"custom",message:"Report scope differs from job scope"});
});
export type MarketResearchJob = z.infer<typeof MarketResearchJobSchema>;
export const MarketResearchJobResponseSchema = object({ job: MarketResearchJobSchema });
export const MarketResearchListResponseSchema = object({ jobs: z.array(MarketResearchJobSchema).max(30) });
export const MarketResearchIdempotencyKeySchema = z.string().uuid();

