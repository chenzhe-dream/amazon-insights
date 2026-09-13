import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { MarketInputRecordSchema, type MarketJsonValue } from '../../../shared/market-analysis-contracts';
import { MARKET_KEYWORD_ABA_SOURCE_VERSION, MarketKeywordAbaSourceRequestSchema, type MarketKeywordAbaSourceData, type MarketKeywordAbaSourceFailure, type MarketKeywordAbaSourceMember, type MarketKeywordAbaSourceMetric, type MarketKeywordAbaSourceResult } from '../../../shared/market-keyword-aba-source-contracts';
import type { MarketSourceEvidenceInput, MarketSourceIdentityField, MarketSourcePayloadPath } from '../../../shared/market-source-contracts';
import { createMarketSourceEvidence } from './source-evidence';
import { marketKeywordMemberId } from './keyword-source-normalization';

const operation = 'market_get_keyword_history' as const;
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const share = z.number().min(0).max(1).nullable();
const rowSchema = z.object({
  keyword: z.string().min(1).max(500), data_points: count,
  dates: z.array(z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/)),
  volumes: z.array(count.nullable()), ranks: z.array(count.nullable()),
  top3_click_shares: z.array(share), top3_conversion_shares: z.array(share),
}).passthrough().superRefine((row, ctx) => {
  if ([row.volumes, row.ranks, row.top3_click_shares, row.top3_conversion_shares].some(values => values.length !== row.dates.length)
    || row.data_points !== row.dates.length || row.dates.some((date, index) => index > 0 && date <= row.dates[index - 1])) {
    ctx.addIssue({ code: 'custom', message: 'History must have aligned arrays and strictly increasing unique months' });
  }
});
const payloadSchema = z.object({ country: z.literal('US'), granularity: z.literal('month'), keywords: z.array(rowSchema).max(10) }).passthrough();
type JsonObject = { [key: string]: MarketJsonValue };
function object(value: unknown): value is JsonObject { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function failed(code: MarketKeywordAbaSourceFailure['failure']['code'], rawPayload: MarketJsonValue | null = null): MarketKeywordAbaSourceFailure {
  return freeze({ schemaVersion: MARKET_KEYWORD_ABA_SOURCE_VERSION, status: 'failed', operation, failure: { code }, rawPayload });
}

/** Pure admission only. Authorization, transport, persistence and scoring belong to callers. */
export function normalizeMarketKeywordAbaSource(value: unknown, now: Date = new Date()): MarketKeywordAbaSourceResult {
  // This must precede even reading scope/rawPayload, so envelope and nested getters never run.
  const json = MarketInputRecordSchema.shape.data.safeParse(value);
  if (!json.success || !object(json.data)) return failed('invalid-request');
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) return failed('invalid-request');
  const { rawPayload, ...requestInput } = json.data;
  const request = MarketKeywordAbaSourceRequestSchema.safeParse(requestInput);
  if (!request.success) return failed('invalid-request');
  const { scope, keywords, referenceMonth, fetchedAt } = request.data;
  if (referenceMonth < scope.fromMonth || referenceMonth > scope.toMonth || scope.toMonth >= now.toISOString().slice(0, 7)
    || referenceMonth >= fetchedAt.slice(0, 7) || Date.parse(fetchedAt) > now.getTime()) return failed('invalid-request');
  if (rawPayload === undefined || Buffer.byteLength(JSON.stringify(rawPayload), 'utf8') > 8_000_000) return failed('malformed-response');
  const raw = JSON.parse(JSON.stringify(rawPayload)) as MarketJsonValue;
  const parsed = payloadSchema.safeParse(raw);
  if (!parsed.success) return failed(object(raw) && Object.hasOwn(raw, 'country') && raw.country !== 'US' ? 'identity-conflict' : 'malformed-response', raw);
  const rows = parsed.data.keywords;
  if (new Set(rows.map(row => row.keyword)).size !== rows.length || rows.some(row => !keywords.includes(row.keyword))) return failed('identity-conflict', raw);

  const paths: MarketSourceEvidenceInput['responseIdentityPaths'] = { marketplace: [['country']] };
  // Check explicit identity echoes wherever this documented response has records.
  // The history is still exact-word market data even when an extra node echo matches.
  const aliases: Partial<Record<MarketSourceIdentityField, string[]>> = {
    marketplace: ['marketplace', 'site', 'country'], nodeIdPath: ['nodeIdPath', 'node_id_path'], nodeId: ['nodeId', 'node_id'],
    month: ['month'], currency: ['currency'],
  };
  const visit = (record: Record<string, unknown>, prefix: (string | number)[]) => {
    for (const [field, names] of Object.entries(aliases) as [MarketSourceIdentityField, string[]][]) {
      for (const name of names) if (Object.hasOwn(record, name) && !(prefix.length === 0 && name === 'country')) (paths[field] ??= []).push([...prefix, name]);
    }
  };
  visit(parsed.data, []);
  // A singular root keyword echo cannot identify a multi-word response.
  if (Object.hasOwn(parsed.data, 'keyword') && (keywords.length !== 1 || parsed.data.keyword !== keywords[0])) return failed('identity-conflict', raw);
  const members: MarketKeywordAbaSourceMember[] = keywords.map(keyword => {
    const index = rows.findIndex(row => row.keyword === keyword);
    const row = rows[index];
    const monthIndex = row ? row.dates.indexOf(referenceMonth) : -1;
    if (row) visit(row, ['keywords', index]);
    const monthPath = monthIndex >= 0 ? ['keywords', index, 'dates', monthIndex] : null;
    if (monthPath) (paths.month ??= []).push(monthPath);
    const metric = (field: 'volumes' | 'top3_click_shares' | 'top3_conversion_shares'): MarketKeywordAbaSourceMetric => {
      if (!row) return { value: null, reason: 'missing-keyword', path: null };
      if (monthIndex < 0) return { value: null, reason: 'missing-reference-month', path: null };
      const value = row[field][monthIndex];
      return { value, reason: value === null ? 'missing-value' : null, path: ['keywords', index, field, monthIndex] };
    };
    return { keyword, memberId: marketKeywordMemberId(scope, keyword), referenceMonth, keywordPath: row ? ['keywords', index, 'keyword'] : null,
      monthPath, searchVolume: metric('volumes'), top3ClickShare: metric('top3_click_shares'), top3ConversionShare: metric('top3_conversion_shares') };
  });
  try {
    const evidence = createMarketSourceEvidence({
      scope, provider: 'sif', operation, requestIdentity: { marketplace: 'US', month: referenceMonth }, responseIdentityPaths: paths,
      fetchedAt, payload: raw,
      // Describes the admitted slice; other historical months remain in raw payload only.
      observationPeriod: { kind: 'calendar-months', fromMonth: referenceMonth, toMonth: referenceMonth },
      units: { searchVolume: { status: 'known', unit: 'count', rawUnit: 'SIF exact-keyword search volume' },
        top3ClickShare: { status: 'known', unit: 'ratio', rawUnit: 'SIF Top3 click share fraction 0-1' },
        top3ConversionShare: { status: 'known', unit: 'ratio', rawUnit: 'SIF Top3 conversion share fraction 0-1' } },
      coverage: { receivedCount: rows.length, expectedCount: keywords.length, truncation: rows.length < keywords.length
        ? { status: 'truncated', reason: 'Response omits requested exact keywords' } : { status: 'not-truncated' } },
    }, now);
    const metrics = members.flatMap(member => [member.searchVolume, member.top3ClickShare, member.top3ConversionShare]);
    return freeze({ schemaVersion: MARKET_KEYWORD_ABA_SOURCE_VERSION, status: metrics.every(metric => metric.value !== null) ? 'ready' : metrics.every(metric => metric.value === null) ? 'empty' : 'partial',
      operation, referenceMonth, keywords, members, sourceScope: { kind: 'exact-keyword-marketplace', marketplace: 'US', nodeIdPath: null, nodeBinding: 'unverified' }, evidence, payloadHash: evidence.payloadHash });
  } catch (error) {
    return failed(error instanceof TypeError && /conflict|identity|outside research scope/.test(error.message) ? 'identity-conflict' : 'malformed-response', raw);
  }
}

/** Replay distrusts saved projections, paths, scope claims and hashes; no external calls. */
export function replayMarketKeywordAbaSource(value: unknown, now: Date = new Date()): MarketKeywordAbaSourceData {
  const checked = MarketInputRecordSchema.shape.data.safeParse(value);
  if (!checked.success || !object(checked.data) || !object(checked.data.evidence)) throw new TypeError('Invalid ABA source replay input');
  const saved = checked.data;
  const evidence = saved.evidence as JsonObject;
  const result = normalizeMarketKeywordAbaSource({ scope: evidence.scope, keywords: saved.keywords, referenceMonth: saved.referenceMonth, fetchedAt: evidence.fetchedAt, rawPayload: evidence.payload }, now);
  if (result.status === 'failed' || !isDeepStrictEqual(result, saved)) throw new TypeError('ABA source replay does not match admitted evidence');
  return result;
}
