import { z } from 'zod';
import { MarketAnalysisScopeSchema, type ReadonlyMarketJsonValue } from './market-analysis-contracts';
import { MarketSourcePayloadPathSchema, type MarketSourceEvidence } from './market-source-contracts';

export const MARKET_KEYWORD_ABA_SOURCE_VERSION = 'market-keyword-aba-source/v1' as const;
/** Preserve exact provider request text: no stemming, case folding or positional association. */
const keyword = z.string().min(1).max(500).refine(value => value.trim().length > 0);
export const MarketKeywordAbaSourceRequestSchema = z.object({
  scope: MarketAnalysisScopeSchema,
  keywords: z.array(keyword).min(1).max(10).refine(values => new Set(values).size === values.length, 'Duplicate requested keywords'),
  referenceMonth: z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/),
  fetchedAt: z.string().datetime(),
}).strict();
export type MarketKeywordAbaSourceRequest = z.infer<typeof MarketKeywordAbaSourceRequestSchema>;
export type MarketKeywordAbaSourceInput = MarketKeywordAbaSourceRequest & { rawPayload: unknown };
export type MarketKeywordAbaSourcePath = readonly (string | number)[];
export interface MarketKeywordAbaSourceMetric {
  readonly value: number | null;
  readonly reason: 'missing-keyword' | 'missing-reference-month' | 'missing-value' | null;
  readonly path: MarketKeywordAbaSourcePath | null;
}
export interface MarketKeywordAbaSourceMember {
  readonly keyword: string;
  readonly memberId: string;
  readonly referenceMonth: string;
  readonly keywordPath: MarketKeywordAbaSourcePath | null;
  readonly monthPath: MarketKeywordAbaSourcePath | null;
  readonly searchVolume: MarketKeywordAbaSourceMetric;
  readonly top3ClickShare: MarketKeywordAbaSourceMetric;
  readonly top3ConversionShare: MarketKeywordAbaSourceMetric;
}
function metricSchema(value: z.ZodNumber) {
  return z.object({ value: value.nullable(), reason: z.enum(['missing-keyword', 'missing-reference-month', 'missing-value']).nullable(), path: MarketSourcePayloadPathSchema.nullable() }).strict()
    .refine(metric => metric.value === null ? metric.reason !== null : metric.reason === null && metric.path !== null, 'Known metrics require evidence paths; missing metrics require reasons')
    .refine(metric => metric.reason === 'missing-value' ? metric.path !== null : metric.reason === null || metric.path === null, 'Missing words/months have no value path');
}
/** Read-model validation; source admission and persisted replay still establish provenance. */
export const MarketKeywordAbaMemberSchema = z.object({
  keyword, memberId: z.string().regex(/^kw_[a-f0-9]{64}$/), referenceMonth: z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/),
  keywordPath: MarketSourcePayloadPathSchema.nullable(), monthPath: MarketSourcePayloadPathSchema.nullable(),
  searchVolume: metricSchema(z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)),
  top3ClickShare: metricSchema(z.number().min(0).max(1)), top3ConversionShare: metricSchema(z.number().min(0).max(1)),
}).strict();
export type MarketKeywordAbaMember = z.infer<typeof MarketKeywordAbaMemberSchema>;
export interface MarketKeywordAbaSourceData {
  readonly schemaVersion: typeof MARKET_KEYWORD_ABA_SOURCE_VERSION;
  readonly status: 'ready' | 'partial' | 'empty';
  readonly operation: 'market_get_keyword_history';
  readonly referenceMonth: string;
  readonly keywords: readonly string[];
  readonly members: readonly MarketKeywordAbaSourceMember[];
  /** Exact-word marketplace measures; neither category nor cluster denominators. */
  readonly sourceScope: Readonly<{ kind: 'exact-keyword-marketplace'; marketplace: 'US'; nodeIdPath: null; nodeBinding: 'unverified' }>;
  /** One complete raw payload per batch, including unused latest and formatted narrative. */
  readonly evidence: MarketSourceEvidence;
  readonly payloadHash: string;
}
export interface MarketKeywordAbaSourceFailure {
  readonly schemaVersion: typeof MARKET_KEYWORD_ABA_SOURCE_VERSION;
  readonly status: 'failed';
  readonly operation: 'market_get_keyword_history';
  readonly failure: Readonly<{ code: 'invalid-request' | 'malformed-response' | 'identity-conflict' }>;
  /** Diagnostics only; this rejected payload is never admitted evidence. */
  readonly rawPayload: ReadonlyMarketJsonValue | null;
}
export type MarketKeywordAbaSourceResult = MarketKeywordAbaSourceData | MarketKeywordAbaSourceFailure;
