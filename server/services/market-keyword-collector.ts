import { normalizeMarketKeywordPageMembers, marketKeywordMemberId as memberId, missingKeywordMetric as missing, parseKeywordDecimal as decimalValue } from '../domain/market-research/keyword-source-normalization';
import { performance } from "node:perf_hooks";
import { z } from "zod";
import {sorftimeMarketSite} from '../../shared/market-sites';
import { MarketInputRecordSchema, type MarketAnalysisScope, type MarketJsonValue } from "../../shared/market-analysis-contracts";
import {
  MarketKeywordPageRequestSchema, MarketKeywordTrendRequestSchema,
  type MarketKeywordGrowth, type MarketKeywordIssue, type MarketKeywordMetric,
  type MarketKeywordPageRequest, type MarketKeywordPageResult, type MarketKeywordSourceFailure,
  type MarketKeywordTrendPoint, type MarketKeywordTrendRequest, type MarketKeywordTrendResult,
} from "../../shared/market-keyword-source-contracts";
import {
  MarketSourceIdentityValueSchemas, type MarketObservationPeriod, type MarketSourceEvidence,
  type MarketSourceEvidenceInput, type MarketSourceIdentityField, type MarketSourcePayloadPath,
} from "../../shared/market-source-contracts";
import { ConnectorError, type ConnectorRequest, type ConnectorResult, type RemoteMcpConnector } from "../connectors/connector-contract";
import { createMarketSourceEvidence } from "../domain/market-research/source-evidence";

type Operation = "keyword_extends" | "keyword_trend";
type FailureCode = MarketKeywordSourceFailure["failure"]["code"];
interface Dependencies { connector: RemoteMcpConnector; signal?: AbortSignal }
export type CollectMarketKeywordPageInput = MarketKeywordPageRequest & Dependencies;
export type CollectMarketKeywordTrendInput = MarketKeywordTrendRequest & Dependencies;
type JsonObject = { [key: string]: MarketJsonValue };
const count = z.number().finite().int().min(0).max(Number.MAX_SAFE_INTEGER);
const aliases: Record<MarketSourceIdentityField, readonly string[]> = {
  marketplace: ["site", "keyword_support_site", "marketplace"],
  nodeIdPath: ["nodeIdPath", "node_id_path"], nodeId: ["nodeId", "node_id"],
  month: ["month"], asin: ["asin"], keyword: ["keyword"], page: ["page"], currency: ["currency"],
};

function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function own(value: unknown, key: string): unknown {
  if (!object(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}
function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) freezeDeep(item);
    Object.freeze(value);
  }
  return value;
}
function copyPayload(value: unknown): MarketJsonValue | undefined {
  // Never traverse payload properties before T1 rejects getters/non-JSON data.
  const checked = MarketInputRecordSchema.shape.data.safeParse(value);
  if (!checked.success) return undefined;
  const text = JSON.stringify(checked.data);
  if (Buffer.byteLength(text, "utf8") > 8_000_000) return undefined;
  return freezeDeep(JSON.parse(text) as MarketJsonValue);
}
function failed(operation: Operation, code: FailureCode, rawPayload: MarketJsonValue | null = null, issues: MarketKeywordIssue[] = [], retryable = false): MarketKeywordSourceFailure {
  return { status: "failed", operation, failure: { code, retryable }, rawPayload, issues };
}

export class DeadlineError extends Error {
  constructor(readonly code: "cancelled" | "timeout") { super(code); }
}
export async function executeOnce(connector: RemoteMcpConnector, request: ConnectorRequest, timeoutMs: number, signal?: AbortSignal): Promise<ConnectorResult> {
  if (signal?.aborted) throw new DeadlineError("cancelled");
  const deadlineAt = performance.now() + timeoutMs;
  const controller = new AbortController();
  let rejectDeadline: (error: DeadlineError) => void = () => {};
  const deadline = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
  // Settle our semantic reason before an abort-aware connector can reject.
  const stop = (code: "cancelled" | "timeout") => { rejectDeadline(new DeadlineError(code)); controller.abort(); };
  const cancel = () => stop("cancelled");
  signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => stop("timeout"), timeoutMs);
  const assertActive = () => {
    if (signal?.aborted) throw new DeadlineError("cancelled");
    if (controller.signal.aborted || performance.now() >= deadlineAt) {
      controller.abort();
      throw new DeadlineError("timeout");
    }
  };
  try {
    let pending: Promise<ConnectorResult>;
    try { pending = connector.execute({ ...request, signal: controller.signal }); }
    catch (error) { pending = Promise.reject(error); }
    const response = await Promise.race([pending, deadline]);
    // A synchronous connector can prevent timer delivery or settle both race
    // promises before handlers attach. Validate cancellation and elapsed time.
    assertActive();
    return response;
  } catch (error) {
    // Rejections also have to honor a cancellation or a delayed timer callback.
    assertActive();
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}
function transportFailure(operation: Operation, error: unknown): MarketKeywordSourceFailure {
  if (error instanceof DeadlineError) return failed(operation, error.code, null, [], error.code === "timeout");
  if (error instanceof ConnectorError) return failed(operation, error.code === 'local-admission' ? 'rate-limit' : error.code, null, [], error.retryable);
  return failed(operation, "upstream-temporary", null, [], true);
}
function validNow(now: Date): boolean { return now instanceof Date && Number.isFinite(now.getTime()); }
function canRequest(scope: MarketAnalysisScope, connector: RemoteMcpConnector, now: Date): boolean {
  return validNow(now) && scope.toMonth < now.toISOString().slice(0, 7) && connector?.id === "sorftime";
}
function fetchedAt(result: ConnectorResult, operation: Operation, now: Date): string | null {
  const source = copyPayload(own(result, "source"));
  const parsed = z.object({ connectorId: z.literal("sorftime"), operation: z.literal(operation), fetchedAt: z.string().datetime(), attemptCount: count.min(1) }).safeParse(source);
  return parsed.success && Date.parse(parsed.data.fetchedAt) <= now.getTime() ? new Date(parsed.data.fetchedAt).toISOString() : null;
}

function identityPaths(payload: JsonObject, operation: Operation): MarketSourceEvidenceInput["responseIdentityPaths"] {
  const paths: Partial<Record<MarketSourceIdentityField, MarketSourcePayloadPath[]>> = {};
  const visit = (record: JsonObject, prefix: (string | number)[], isMember = false) => {
    for (const [field, names] of Object.entries(aliases) as [MarketSourceIdentityField, readonly string[]][]) {
      if (isMember && field === "keyword") continue;
      for (const name of names) {
        if (Object.hasOwn(record, name)) (paths[field] ??= []).push([...prefix, name]);
      }
    }
  };
  visit(payload, []);
  if (object(payload.data)) visit(payload.data, ["data"]);
  if (operation === "keyword_extends" && Array.isArray(payload.data)) {
    payload.data.forEach((row, index) => { if (object(row)) visit(row, ["data", index], true); });
  }
  if (operation === "keyword_trend" && !paths.keyword?.some(path => path.length === 2 && path[0] === "data" && path[1] === "keyword")) {
    (paths.keyword ??= []).push(["data", "keyword"]);
  }
  return paths;
}
class EvidencePayloadError extends Error {}
function evidence(scope: MarketAnalysisScope, operation: Operation, keyword: string, page: number | null, payload: JsonObject, timestamp: string, period: MarketObservationPeriod, receivedCount: number, now: Date): MarketSourceEvidence {
  const countUnit = { status: "known", unit: "count", rawUnit: "count" } as const;
  const input: MarketSourceEvidenceInput = {
    scope, provider: "sorftime", operation,
    requestIdentity: { marketplace: scope.marketplace, keyword, ...(page === null ? {} : { page }) },
    responseIdentityPaths: identityPaths(payload, operation), payload, fetchedAt: timestamp, observationPeriod: period,
    units: operation === "keyword_extends" ? {
      weeklySearchVolume: countUnit, weeklySearchRank: countUnit, monthlySearchVolume: countUnit,
      recommendedCpcUsd: { status: "known", unit: "currency", rawUnit: "USD", currency: "USD" },
    } : {
      searchVolume: countUnit, searchRank: countUnit,
      recommendedBid: { status: "unknown", rawUnit: "CPC recommended bid", reason: object(payload.data) && Object.hasOwn(payload.data, "cpc_trend") ? "cpc_trend amount scale is ambiguous between documented cents and returned values" : "keyword_trend documentation does not state currency" },
      yoyGrowth: { status: "known", unit: "ratio", rawUnit: "fractional change" },
      recentGrowth: { status: "known", unit: "ratio", rawUnit: "fractional change" },
    },
    coverage: { receivedCount, expectedCount: null, truncation: { status: "unknown", reason: operation === "keyword_extends" ? "One page only; source does not state total count or hasMore" : "Source returns a history window without a requested start/end or guaranteed continuity" } },
  };
  // The evidence wrapper adds depth/nodes to an otherwise valid raw response.
  if (!MarketInputRecordSchema.shape.data.safeParse(input).success) throw new EvidencePayloadError();
  return createMarketSourceEvidence(input, now);
}
/** One seed/page only. Caller owns authorization, persistence and pool deduplication. */
export async function collectMarketKeywordPage(input: CollectMarketKeywordPageInput, now?: Date): Promise<MarketKeywordPageResult> {
  const operation = "keyword_extends";
  const parsed = MarketKeywordPageRequestSchema.safeParse({ scope: input.scope, jobId: input.jobId, seed: input.seed, page: input.page, ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }) });
  if (!parsed.success || !canRequest(parsed.data.scope, input.connector, now ?? new Date())) return failed(operation, "invalid-request");
  const request = parsed.data;
  let response: ConnectorResult;
  try {
    response = await executeOnce(input.connector, { operation, input: { keyword: request.seed, keyword_support_site: sorftimeMarketSite(request.scope.marketplace), page: request.page }, governorScope: { organizationId: request.scope.organizationId, jobId: request.jobId } }, request.timeoutMs, input.signal);
  } catch (error) { return transportFailure(operation, error); }
  const raw = copyPayload(own(response, "data"));
  if (raw === undefined) return failed(operation, "malformed-response");
  const checkedNow = now ?? new Date();
  const timestamp = fetchedAt(response, operation, checkedNow);
  if (!timestamp || !object(raw) || !Array.isArray(raw.data) || raw.data.length > 20) return failed(operation, "malformed-response", raw);
  const { issues, members } = normalizeMarketKeywordPageMembers(request.scope, raw.data);
  if (issues.some(issue => issue.code === "invalid" || issue.code === "duplicate-member")) return failed(operation, "malformed-response", raw, issues);
  let source: MarketSourceEvidence;
  try { source = evidence(request.scope, operation, request.seed, request.page, raw, timestamp, { kind: "unknown", reason: "keyword_extends supplies weekly/monthly values without calendar boundaries" }, raw.data.length, checkedNow); }
  catch (error) { return failed(operation, error instanceof EvidencePayloadError ? "malformed-response" : "identity-conflict", raw, issues); }
  return { status: members.length === 0 ? "empty" : issues.length ? "partial" : "ready", operation, sourceMode: "seed-extensions", seed: request.seed, page: request.page, receivedCount: raw.data.length, members,
    pagination: { pageLimit: 20, nextPageCandidate: raw.data.length === 20 && request.page < Number.MAX_SAFE_INTEGER ? request.page + 1 : null, hasMore: "unknown", totalCount: null }, evidence: source, issues };
}

function parseSeries(raw: MarketJsonValue | undefined, field: string, label: string, integer: boolean, completeBefore: string, issues: MarketKeywordIssue[]): MarketKeywordTrendPoint[] {
  if (raw === undefined || raw === null) { issues.push({ code: "missing", path: ["data", field] }); return []; }
  if (!Array.isArray(raw)) { issues.push({ code: "invalid", path: ["data", field] }); return []; }
  // Count tokens must have integer syntax before any lossy Number conversion.
  const tokenPattern = integer ? "(?:0|[1-9]\\d*)" : "(?:0|[1-9]\\d*)(?:\\.\\d+)?";
  const pattern = new RegExp(`^(20\\d{2}-(?:0[1-9]|1[0-2])) ${label} (${tokenPattern})$`);
  // The observed -1 bid cannot be a nonnegative bid. Preserve it as unknown;
  // the supplier documentation does not establish what the negative value means.
  const unavailableBidPattern = field === "recommended_bid_trend"
    ? /^(20\d{2}-(?:0[1-9]|1[0-2])) CPC recommended bid -1(?:\.0+)?$/ : null;
  const points = new Map<string, { value: number | null; index: number; conflict: boolean }>();
  // Current Sorftime monthly format alternates yyyyMM and a numeric string.
  // Preserve legacy text parsing byte-for-byte for frozen historical evidence.
  const pairs = raw.length > 0 && typeof raw[0] === 'string' && /^\d{6,8}$/.test(raw[0]);
  if (pairs && raw.length % 2 !== 0) { issues.push({ code: 'invalid', path: ['data', field] }); return []; }
  const entries = pairs ? Array.from({ length: raw.length / 2 }, (_, pair) => {
    const index = pair * 2, month = raw[index], value = raw[index + 1];
    const item = typeof month === 'string' && /^20\d{2}(?:0[1-9]|1[0-2])$/.test(month) && typeof value === 'string'
      ? `${month.slice(0, 4)}-${month.slice(4)} ${label} ${value}` : null;
    return { item, index };
  }) : raw.map((item, index) => ({ item, index }));
  entries.forEach(({ item, index }) => {
    const unavailableBid = typeof item === "string" ? unavailableBidPattern?.exec(item) : null;
    const match = unavailableBid ?? (typeof item === "string" ? pattern.exec(item) : null);
    const value = match && !unavailableBid ? (integer ? Number(match[2]) : decimalValue(match[2])) : null;
    if (!match || (!unavailableBid && (value === null || !Number.isFinite(value) || value > Number.MAX_SAFE_INTEGER || (integer && !Number.isSafeInteger(value))))) {
      issues.push({ code: "invalid", path: ["data", field, index] }); return;
    }
    if (unavailableBid) issues.push({ code: "missing", path: ["data", field, index] });
    const previous = points.get(match[1]);
    if (previous) {
      const conflict = previous.conflict || previous.value !== value;
      issues.push({ code: conflict ? "conflicting-month" : "duplicate-month", path: ["data", field, index] });
      if (conflict) points.set(match[1], { value: null, index: previous.index, conflict: true });
    } else points.set(match[1], { value, index, conflict: false });
  });
  return [...points.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([month, point]) => {
    if (month >= completeBefore) {
      issues.push({ code: "incomplete-month", path: ["data", field, point.index] });
      return { month, measurement: { value: null, reason: "incomplete-month" } };
    }
    return { month, measurement: { value: point.value, reason: point.value === null ? "missing" : null } };
  });
}
function shiftMonth(month: string, delta: number): string {
  const [year, index] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year, index - 1 + delta, 1));
  return date.toISOString().slice(0, 7);
}
function growth(current: number | null, month: string, delta: number, volume: ReadonlyMap<string, MarketKeywordMetric<number>>): MarketKeywordGrowth {
  const baselineMonth = shiftMonth(month, delta);
  const baselineValue = volume.get(baselineMonth)?.value ?? null;
  const reason = current === null ? "missing-current" : baselineValue === null ? "missing-baseline" : baselineValue === 0 ? "zero-baseline" : null;
  return { value: reason === null ? current! / baselineValue! - 1 : null, reason, baselineMonth, baselineValue, formulaVersion: "calendar-month-growth/v1" };
}

/** One keyword only; monthly history is parsed independently of research identity. */
export async function collectMarketKeywordTrend(input: CollectMarketKeywordTrendInput, now?: Date): Promise<MarketKeywordTrendResult> {
  const operation = "keyword_trend";
  const parsed = MarketKeywordTrendRequestSchema.safeParse({ scope: input.scope, jobId: input.jobId, keyword: input.keyword, ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }) });
  if (!parsed.success || !canRequest(parsed.data.scope, input.connector, now ?? new Date())) return failed(operation, "invalid-request");
  const request = parsed.data;
  let response: ConnectorResult;
  try {
    response = await executeOnce(input.connector, { operation, input: { keyword: request.keyword, keyword_support_site: sorftimeMarketSite(request.scope.marketplace), type: 2 }, governorScope: { organizationId: request.scope.organizationId, jobId: request.jobId } }, request.timeoutMs, input.signal);
  } catch (error) { return transportFailure(operation, error); }
  const raw = copyPayload(own(response, "data"));
  if (raw === undefined) return failed(operation, "malformed-response");
  const checkedNow = now ?? new Date();
  const timestamp = fetchedAt(response, operation, checkedNow);
  if (!timestamp || !object(raw) || !object(raw.data)) return failed(operation, "malformed-response", raw);
  const identity = MarketSourceIdentityValueSchemas.keyword.safeParse(raw.data.keyword);
  if (!identity.success || identity.data !== request.keyword) return failed(operation, "identity-conflict", raw);
  const issues: MarketKeywordIssue[] = [];
  const completeBefore = timestamp.slice(0, 7);
  const rankField = Object.hasOwn(raw.data, 'rank_trend') ? 'rank_trend' : 'search_rank_trend';
  const unknownCpc = Object.hasOwn(raw.data, 'cpc_trend');
  const series = {
    searchVolume: parseSeries(raw.data.search_volume_trend, "search_volume_trend", "search volume", true, completeBefore, issues),
    searchRank: parseSeries(raw.data[rankField], rankField, "search rank", true, completeBefore, issues),
    recommendedBid: unknownCpc ? [] : parseSeries(raw.data.recommended_bid_trend, "recommended_bid_trend", "CPC recommended bid", false, completeBefore, issues),
  };
  if (issues.some(issue => issue.code === "invalid")) return failed(operation, "malformed-response", raw, issues);
  const observedCompleteMonths = [...new Set(Object.values(series).flat().filter(point => point.measurement.value !== null).map(point => point.month))].sort();
  const period: MarketObservationPeriod = observedCompleteMonths.length ? { kind: "calendar-months", fromMonth: observedCompleteMonths[0], toMonth: observedCompleteMonths.at(-1)! } : { kind: "unknown", reason: "No valid complete calendar-month observation was returned" };
  let source: MarketSourceEvidence;
  try { source = evidence(request.scope, operation, request.keyword, null, raw, timestamp, period, observedCompleteMonths.length, checkedNow); }
  catch (error) { return failed(operation, error instanceof EvidencePayloadError ? "malformed-response" : "identity-conflict", raw, issues); }
  const maps = {
    searchVolume: new Map(series.searchVolume.map(point => [point.month, point.measurement])),
    searchRank: new Map(series.searchRank.map(point => [point.month, point.measurement])),
    recommendedBid: new Map(series.recommendedBid.map(point => [point.month, point.measurement])),
  };
  const months = [];
  for (let month = request.scope.fromMonth; month <= request.scope.toMonth; month = shiftMonth(month, 1)) {
    const searchVolume = maps.searchVolume.get(month) ?? missing<number>();
    months.push({ month, searchVolume, searchRank: maps.searchRank.get(month) ?? missing<number>(), recommendedBid: maps.recommendedBid.get(month) ?? missing<number>(),
      yoyGrowth: growth(searchVolume.value, month, -12, maps.searchVolume), recentGrowth: growth(searchVolume.value, month, -1, maps.searchVolume) });
  }
  issues.push({ code: "unknown-unit", path: ["data", unknownCpc ? "cpc_trend" : "recommended_bid_trend"] });
  return { status: months.every(month => month.searchVolume.value === null) ? "empty" : "partial", operation, keyword: request.keyword, memberId: memberId(request.scope, request.keyword), cpcCurrency: null,
    series, observedCompleteMonths, months, evidence: source, issues };
}
