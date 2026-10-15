import { z } from "zod";
import { MarketAnalysisScopeSchema, type ReadonlyMarketJsonValue } from "./market-analysis-contracts";
import { MarketSourceIdentityValueSchemas, type MarketSourceEvidence } from "./market-source-contracts";

const request = {
  scope: MarketAnalysisScopeSchema,
  jobId: z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  timeoutMs: z.number().finite().int().min(1).max(60_000).default(15_000),
};
export const MarketKeywordPageRequestSchema = z.object({
  ...request, seed: MarketSourceIdentityValueSchemas.keyword, page: MarketSourceIdentityValueSchemas.page,
}).strict();
export const MarketKeywordTrendRequestSchema = z.object({ ...request, keyword: MarketSourceIdentityValueSchemas.keyword }).strict();
export type MarketKeywordPageRequest = z.input<typeof MarketKeywordPageRequestSchema>;
export type MarketKeywordTrendRequest = z.input<typeof MarketKeywordTrendRequestSchema>;

export interface MarketKeywordMetric<T> {
  readonly value: T | null;
  readonly reason: "missing" | "incomplete-month" | null;
}
export interface MarketKeywordIssue {
  readonly code: "missing" | "invalid" | "duplicate-member" | "duplicate-month" | "conflicting-month" | "incomplete-month" | "unknown-unit";
  readonly path: readonly (string | number)[];
}
export interface MarketKeywordSourceFailure {
  readonly status: "failed";
  readonly operation: "keyword_extends" | "keyword_trend";
  readonly failure: Readonly<{
    code: "quota-exhausted" | "local-admission" | "invalid-request" | "cancelled" | "identity-conflict" | "configuration" | "authentication" | "rate-limit" | "timeout" | "upstream-temporary" | "upstream-permanent" | "malformed-response";
    retryable: boolean;
  }>;
  /** Diagnostics only; rejected responses are never valid evidence. */
  readonly rawPayload: ReadonlyMarketJsonValue | null;
  readonly issues: readonly MarketKeywordIssue[];
}
export interface MarketKeywordPageMember {
  /** Stable per research + normalized keyword; independent of seed and page. */
  readonly id: string;
  readonly keyword: string;
  readonly rawKeyword: string;
  readonly weeklySearchVolume: MarketKeywordMetric<number>;
  readonly weeklySearchRank: MarketKeywordMetric<number>;
  readonly monthlySearchVolume: MarketKeywordMetric<number>;
  /** USD is documented by keyword_extends; its calendar window is unstated. */
  readonly recommendedCpcUsd: MarketKeywordMetric<number>;
  readonly seasonality: MarketKeywordMetric<string>;
}
export interface MarketKeywordPageData {
  readonly status: "ready" | "partial" | "empty";
  readonly operation: "keyword_extends";
  readonly sourceMode: "seed-extensions";
  readonly seed: string;
  readonly page: number;
  readonly receivedCount: number;
  readonly members: readonly MarketKeywordPageMember[];
  readonly pagination: Readonly<{ pageLimit: 20; nextPageCandidate: number | null; hasMore: "unknown"; totalCount: null }>;
  readonly evidence: MarketSourceEvidence;
  readonly issues: readonly MarketKeywordIssue[];
}
export type MarketKeywordPageResult = MarketKeywordPageData | MarketKeywordSourceFailure;

export interface MarketKeywordTrendPoint {
  readonly month: string;
  readonly measurement: MarketKeywordMetric<number>;
}
export interface MarketKeywordGrowth {
  /** Fractional change; 0.2 means +20%, -1 means -100%. */
  readonly value: number | null;
  readonly reason: "missing-current" | "missing-baseline" | "zero-baseline" | null;
  readonly baselineMonth: string;
  readonly baselineValue: number | null;
  readonly formulaVersion: "calendar-month-growth/v1";
}
export interface MarketKeywordTrendMonth {
  readonly month: string;
  readonly searchVolume: MarketKeywordMetric<number>;
  readonly searchRank: MarketKeywordMetric<number>;
  readonly recommendedBid: MarketKeywordMetric<number>;
  readonly yoyGrowth: MarketKeywordGrowth;
  /** Month-over-month only; not an unspecified multi-month growth window. */
  readonly recentGrowth: MarketKeywordGrowth;
}
export interface MarketKeywordTrendData {
  readonly status: "ready" | "partial" | "empty";
  readonly operation: "keyword_trend";
  readonly keyword: string;
  readonly memberId: string;
  /** Trend source does not state currency; numeric bid is retained separately. */
  readonly cpcCurrency: null;
  readonly series: Readonly<Record<"searchVolume" | "searchRank" | "recommendedBid", readonly MarketKeywordTrendPoint[]>>;
  readonly observedCompleteMonths: readonly string[];
  readonly months: readonly MarketKeywordTrendMonth[];
  readonly evidence: MarketSourceEvidence;
  readonly issues: readonly MarketKeywordIssue[];
}
export type MarketKeywordTrendResult = MarketKeywordTrendData | MarketKeywordSourceFailure;
