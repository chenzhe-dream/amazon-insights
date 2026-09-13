import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { MarketAnalysisScope, MarketJsonValue } from '../../../shared/market-analysis-contracts';
import { MarketSourceIdentityValueSchemas } from '../../../shared/market-source-contracts';
import type { MarketKeywordIssue, MarketKeywordMetric, MarketKeywordPageMember } from '../../../shared/market-keyword-source-contracts';
const count = z.number().finite().int().min(0).max(Number.MAX_SAFE_INTEGER);
const decimal = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
function object(value: MarketJsonValue): value is { [key: string]: MarketJsonValue } { return value !== null && typeof value === 'object' && !Array.isArray(value); }

export function marketKeywordMemberId(scope: MarketAnalysisScope, keyword: string): string {
  return `kw_${createHash("sha256").update(JSON.stringify([scope.organizationId, scope.researchId, scope.marketplace, scope.nodeIdPath, keyword])).digest("hex")}`;
}
export function missingKeywordMetric<T>(): MarketKeywordMetric<T> { return { value: null, reason: "missing" }; }
export function parseKeywordDecimal(raw: string): number | null {
  if (!decimal.test(raw)) return null;
  const [whole, fraction = ""] = raw.split(".");
  const maximum = String(Number.MAX_SAFE_INTEGER);
  // Check the source boundary before rounding can hide MAX_SAFE_INTEGER + 0.1.
  if (whole.length > maximum.length || (whole.length === maximum.length && whole > maximum)
    || (whole === maximum && /[1-9]/.test(fraction))) return null;
  const value = Number(raw);
  // A positive source token underflowing to zero is not a genuine reported zero.
  return Number.isFinite(value) && !(value === 0 && /[1-9]/.test(raw)) ? value : null;
}
function measure(raw: MarketJsonValue | undefined, type: "count" | "decimal" | "text", path: (string | number)[], issues: MarketKeywordIssue[]): MarketKeywordMetric<number | string> {
  if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) {
    issues.push({ code: "missing", path }); return missingKeywordMetric();
  }
  const value = type === "count" ? (count.safeParse(raw).success ? raw as number : null)
    : type === "text" ? (typeof raw === "string" ? raw : null)
      : typeof raw === "string" ? parseKeywordDecimal(raw) : null;
  if (value === null) { issues.push({ code: "invalid", path }); return missingKeywordMetric(); }
  return { value, reason: null };
}

/** Shared deterministic page normalization; pool assembly replays it to verify
 * persisted numeric fields against the original response without a network call. */
export function normalizeMarketKeywordPageMembers(scope: MarketAnalysisScope, rows: readonly MarketJsonValue[]) {
  const issues: MarketKeywordIssue[] = [], members: MarketKeywordPageMember[] = [];
  const ids = new Set<string>();
  for (const [index, item] of rows.entries()) {
    if (!object(item)) { issues.push({ code: 'invalid', path: ['data', index] }); continue; }
    const identity = MarketSourceIdentityValueSchemas.keyword.safeParse(item.keyword);
    if (!identity.success) { issues.push({ code: 'invalid', path: ['data', index, 'keyword'] }); continue; }
    const id = marketKeywordMemberId(scope, identity.data);
    if (ids.has(id)) issues.push({ code: 'duplicate-member', path: ['data', index, 'keyword'] });
    ids.add(id);
    const metric = <T extends number | string>(key: string, type: 'count' | 'decimal' | 'text') => measure(item[key], type, ['data', index, key], issues) as MarketKeywordMetric<T>;
    members.push({ id, keyword: identity.data, rawKeyword: item.keyword as string,
      weeklySearchVolume: metric<number>('weekly_search_volume', 'count'), weeklySearchRank: metric<number>('weekly_search_rank', 'count'),
      monthlySearchVolume: metric<number>('monthly_search_volume', 'count'), recommendedCpcUsd: metric<number>('recommended_cpc_bid', 'decimal'), seasonality: metric<string>('seasonality', 'text') });
  }
  return { members, issues };
}
