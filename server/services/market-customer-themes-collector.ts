import {partitionSourceThemes} from '../../shared/market-theme-quality';
import { performance } from "node:perf_hooks";
import { z } from "zod";
import {sorftimeMarketSite,normalizeMarketSite} from '../../shared/market-sites';
import {
  MarketAnalysisScopeSchema, MarketInputRecordSchema,
  type MarketAnalysisScope, type MarketJsonValue, type ReadonlyMarketJsonValue,
} from "../../shared/market-analysis-contracts";
import {
  MarketSourceIdentityValueSchemas, type MarketSourceEvidence, type MarketSourcePayloadPath,
} from "../../shared/market-source-contracts";
import { ConnectorError, type ConnectorErrorCode, type ConnectorResult, type RemoteMcpConnector } from "../connectors/connector-contract";
import { ResourceGovernorAdmissionError } from "../db/concurrency-control-repository";
import { createMarketSourceEvidence } from "../domain/market-research/source-evidence";
import type { CustomerThemesAsinInput } from "../domain/market-research/customer-themes";

export type MarketCustomerThemesIssueCode = Exclude<ConnectorErrorCode, "keyword-not-trending"> | "cancelled" | "governor-rejected" | "identity-mismatch" | "invalid-theme" | "source-mismatch";
export type MarketCustomerThemesIssue = {
  code: MarketCustomerThemesIssueCode;
  message: string;
  retryable: boolean;
  path?: (string | number)[];
  reason?: 'count-exceeds-mention';
};
export type CollectMarketCustomerThemesInput = {
  scope: MarketAnalysisScope;
  asin: string;
  connector: RemoteMcpConnector;
  jobId: string;
  signal?: AbortSignal;
  now?: () => Date;
  timeoutMs?: number;
  quarantineInvalidThemes?: boolean;
};
export type MarketCustomerThemesCollection = {
  scope: MarketAnalysisScope;
  asin: string;
  result: CustomerThemesAsinInput;
  summary: string | null;
  evidence: MarketSourceEvidence | null;
  /** Complete bounded JSON for diagnostics; a failed result never exposes valid evidence. */
  rawPayload: ReadonlyMarketJsonValue | null;
  rawUnavailableReason: string | null;
  issues: MarketCustomerThemesIssue[];
};

const OPERATION = "product_customers_say";
const messages: Record<MarketCustomerThemesIssueCode, string> = {
  "local-admission": "Local request capacity is unavailable",
  "quota-exhausted": "Customers Say source quota is exhausted; collection paused",
  "saved-source-missing":"仅使用已保存证据，此项暂无可复用来源，保留待补；未发送上游请求。",
  configuration: "Customers Say connector configuration is unavailable",
  authentication: "Customers Say connector authentication failed",
  "rate-limit": "Customers Say request was limited by connector capacity or rate policy",
  timeout: "Customers Say request timed out",
  "upstream-temporary": "Customers Say source is temporarily unavailable",
  "upstream-permanent": "Customers Say source request failed",
  "malformed-response": "Customers Say response does not match the supported source format",
  cancelled: "Customers Say collection was cancelled",
  "governor-rejected": "Customers Say request was rejected by resource governance",
  "identity-mismatch": "Customers Say response identity differs from the requested ASIN or site",
  "invalid-theme": "Customers Say contains an invalid source theme",
  "source-mismatch": "Customers Say connector source metadata is invalid or inconsistent",
};
function issue(code: MarketCustomerThemesIssueCode, retryable = false, path?: (string | number)[]): MarketCustomerThemesIssue {
  return { code, message: messages[code], retryable, ...(path ? { path } : {}) };
}
class CollectionStopped extends Error {
  constructor(readonly code: "cancelled" | "timeout") { super(messages[code]); }
}
function collectionIssue(error: unknown): MarketCustomerThemesIssue {
  if (error instanceof CollectionStopped) return issue(error.code, error.code === "timeout");
  if (error instanceof ResourceGovernorAdmissionError) return issue("governor-rejected", true);
  if (error instanceof ConnectorError) return issue(error.code === "keyword-not-trending" ? "upstream-permanent" : error.code, error.retryable);
  return issue("upstream-permanent");
}

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const sourceSchema = z.object({
  connectorId: z.literal("sorftime"), operation: z.literal(OPERATION),
  fetchedAt: z.string().datetime(), attemptCount: count.min(1),
}).strict();

function isRecord(value: MarketJsonValue | undefined): value is Record<string, MarketJsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.values(value).forEach(freezeDeep);
    Object.freeze(value);
  }
  return value;
}
function validNow(clock: () => Date): Date {
  const time = clock();
  if (!(time instanceof Date) || !Number.isFinite(time.getTime())) throw new TypeError("A valid current time is required");
  return time;
}

async function executeOnce(input: CollectMarketCustomerThemesInput, asin: string, organizationId: string, jobId: string, timeoutMs: number): Promise<ConnectorResult> {
  if (input.signal?.aborted) throw new CollectionStopped("cancelled");
  const controller = new AbortController();
  const deadlineAt = performance.now() + timeoutMs;
  const throwIfStopped = () => {
    const code = input.signal?.aborted ? "cancelled"
      : controller.signal.aborted || performance.now() >= deadlineAt ? "timeout" : null;
    if (code !== null) {
      controller.abort();
      throw new CollectionStopped(code);
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    onAbort = () => { reject(new CollectionStopped("cancelled")); controller.abort(); };
    input.signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => { reject(new CollectionStopped("timeout")); controller.abort(); }, timeoutMs);
  });
  try {
    const running = Promise.resolve().then(() => {
      throwIfStopped();
      return input.connector.execute({
        operation: OPERATION, input: { asin, site: sorftimeMarketSite(input.scope.marketplace) }, signal: controller.signal,
        governorScope: { organizationId, jobId },
      });
    });
    const result = await Promise.race([running, stopped]);
    // A synchronous connector can starve the timer; reject its late result as
    // soon as control returns instead of accepting a resolved promise first.
    throwIfStopped();
    return result;
  } catch (error) {
    throwIfStopped();
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort) input.signal?.removeEventListener("abort", onAbort);
  }
}

type EchoField = "asin" | "marketplace";
type Echo = { field: EchoField; path: MarketSourcePayloadPath; value: MarketJsonValue };
function identityEchoes(raw: MarketJsonValue): Echo[] {
  const echoes: Echo[] = [];
  const inspect = (object: Record<string, MarketJsonValue>, prefix: MarketSourcePayloadPath) => {
    for (const [field, aliases] of [["asin", ["asin", "ASIN", "Asin"]], ["marketplace", ["site", "marketplace", "amz_site"]]] as const) {
      for (const alias of aliases) if (Object.hasOwn(object, alias)) echoes.push({ field, path: [...prefix, alias], value: object[alias] });
    }
  };
  if (isRecord(raw)) {
    inspect(raw, []);
    if (isRecord(raw.data)) {
      inspect(raw.data, ["data"]);
      if (Array.isArray(raw.data.details)) raw.data.details.forEach((row, index) => {
        if (isRecord(row)) inspect(row, ["data", "details", index]);
      });
    }
  }
  return echoes;
}
function isObservedEmptyText(raw: Record<string, MarketJsonValue>): boolean {
  if (Object.hasOwn(raw, "structuredContent") || Object.hasOwn(raw, "data") || raw.isError === true || !Array.isArray(raw.content) || raw.content.length !== 1) return false;
  const block = raw.content[0];
  return isRecord(block) && block.type === "text" && typeof block.text === "string" && block.text.trim() === "No relevant data.";
}

/** Fetch exactly one selected ASIN through the injected governed connector; never select a TOP pool here. */
export async function collectMarketCustomerThemes(input: CollectMarketCustomerThemesInput): Promise<MarketCustomerThemesCollection> {
  const clock = input.now ?? (() => new Date());
  const start = validNow(clock);
  const scope = MarketAnalysisScopeSchema.parse(input.scope);
  if (scope.toMonth >= start.toISOString().slice(0, 7)) throw new TypeError("Research requires completed calendar months");
  const asin = MarketSourceIdentityValueSchemas.asin.parse(input.asin);
  const jobId = z.string().trim().min(1).max(160).parse(input.jobId);
  const timeoutMs = z.number().int().min(1).max(120_000).parse(input.timeoutMs ?? 60_000);
  if (input.connector.id !== "sorftime") throw new TypeError("A Sorftime connector is required");

  let rawPayload: MarketJsonValue | null = null;
  let rawUnavailableReason: string | null = null;
  let summary: string | null = null;
  const failed = (issues: MarketCustomerThemesIssue[]): MarketCustomerThemesCollection => ({
    scope, asin, result: { asin, status: "failed", source: null, reason: issues[0].message },
    summary, evidence: null, rawPayload, rawUnavailableReason, issues,
  });
  let response: ConnectorResult;
  try { response = await executeOnce(input, asin, scope.organizationId, jobId, timeoutMs); }
  catch (error) { return failed([input.signal?.aborted ? issue("cancelled") : collectionIssue(error)]); }
  if (input.signal?.aborted) return failed([issue("cancelled")]);

  // Validate the entire result before touching payload or source fields; no source getter is executed.
  const checked = MarketInputRecordSchema.shape.data.safeParse(response);
  if (!checked.success || !isRecord(checked.data) || !Object.hasOwn(checked.data, "data")) {
    rawUnavailableReason = "Connector response is not bounded plain JSON with finite numbers";
    return failed([issue("malformed-response")]);
  }
  const rawText = JSON.stringify(checked.data.data);
  if (Buffer.byteLength(rawText, "utf8") > 8_000_000) {
    rawUnavailableReason = "Source payload exceeds the supported byte budget";
    return failed([issue("malformed-response")]);
  }
  rawPayload = freezeDeep(JSON.parse(rawText) as MarketJsonValue);
  const source = sourceSchema.safeParse(checked.data.source);
  const finishedAt = validNow(clock);
  if (!source.success || Date.parse(source.data.fetchedAt) > finishedAt.getTime()) return failed([issue("source-mismatch")]);

  const echoes = identityEchoes(rawPayload);
  const responseIdentityPaths: Partial<Record<EchoField, MarketSourcePayloadPath[]>> = {};
  for (const echo of echoes) {
    const checkedIdentity = MarketSourceIdentityValueSchemas[echo.field].safeParse(echo.value);
    if (!checkedIdentity.success || (echo.field === "asin" ? checkedIdentity.data !== asin : normalizeMarketSite(String(checkedIdentity.data)) !== scope.marketplace)) {
      return failed([issue("identity-mismatch", false, echo.path)]);
    }
    const paths = responseIdentityPaths[echo.field] ?? [];
    paths.push(echo.path);
    responseIdentityPaths[echo.field] = paths;
  }
  if (!isRecord(rawPayload)) return failed([issue("malformed-response")]);
  if (rawPayload.isError === true || Object.hasOwn(rawPayload, "error") || (Object.hasOwn(rawPayload, "code") && rawPayload.code !== "OK")) {
    return failed([issue("upstream-permanent")]);
  }
  const observedEmpty = isObservedEmptyText(rawPayload);
  if (Object.hasOwn(rawPayload, "content") && !observedEmpty) return failed([issue("malformed-response")]);
  const body = observedEmpty ? { details: [] } : isRecord(rawPayload.data) ? rawPayload.data : null;
  if (!body || !Array.isArray(body.details)) return failed([issue("malformed-response")]);
  if (Object.hasOwn(body, "error")) return failed([issue("upstream-permanent")]);
  if (Object.hasOwn(body, "customer_say")) {
    if (typeof body.customer_say !== "string") return failed([issue("malformed-response", false, ["data", "customer_say"])]);
    summary = body.customer_say;
  }
  let partition: ReturnType<typeof partitionSourceThemes>;
  try { partition = partitionSourceThemes(body.details); }
  catch (error) {
    // Oversized quarantine metadata must still retain the bounded raw response.
    if (error instanceof z.ZodError) return failed([issue("invalid-theme", false, ["data", "details"])]);
    throw error;
  }
  const {parsed:themeResults,quarantine}=partition;
  const issues = themeResults.flatMap((result, index) => result.success ? [] : result.error.issues.map((error) =>
    ({...issue("invalid-theme", false, ["data", "details", index, ...error.path.filter((key): key is string | number => typeof key === "string" || typeof key === "number")]),
      ...(error.code==='custom'&&error.params?.reason==='count-exceeds-mention'?{reason:'count-exceeds-mention' as const}:{})})));
  if (issues.length > 0 && (!input.quarantineInvalidThemes || themeResults.every(r=>!r.success))) return failed(issues);
  let totalMentions = 0;
  for (const [index, theme] of themeResults.entries()) {
    if (theme.success) {
      if (theme.data.mention > Number.MAX_SAFE_INTEGER - totalMentions) return failed([issue("invalid-theme", false, ["data", "details", index, "mention"])]);
      totalMentions += theme.data.mention;
    }
  }
  let evidence: MarketSourceEvidence;
  try {
    evidence = createMarketSourceEvidence({
      scope, provider: "sorftime", operation: OPERATION,
      requestIdentity: { asin, marketplace: scope.marketplace }, responseIdentityPaths, payload: rawPayload,
      fetchedAt: source.data.fetchedAt,
      observationPeriod: { kind: "unknown", reason: "Customers Say is a retrieved summary; topic update dates do not establish the review observation window" },
      units: {
        mention: { status: "known", unit: "count", rawUnit: "mention" },
        positive: { status: "known", unit: "count", rawUnit: "positive" },
        negative: { status: "known", unit: "count", rawUnit: "negative" },
      },
      coverage: { receivedCount: body.details.length, expectedCount: null, truncation: { status: "unknown", reason: "No upstream topic total or completeness marker is supplied" } },
    }, finishedAt);
  } catch { return failed([issue("malformed-response")]); }
  if (input.signal?.aborted) return failed([issue("cancelled")]);
  const sourceRecordId = `customers-say:${evidence.payloadHash}:${asin}`;
  const sourceReference = { sourceRecordId, fetchedAt: evidence.fetchedAt, sourceUpdatedAt: null };
  const result: CustomerThemesAsinInput = body.details.length === 0
    ? { asin, status: "empty", source: sourceReference, reason: observedEmpty ? "No relevant data." : "Customers Say returned no source themes" }
    : {
      asin, status: "success", source: sourceReference,
      ...(quarantine?{quarantine}:{}),
      themes: themeResults.flatMap((theme, index) => {
        if (!theme.success) return [];
        return [{
          sourceThemeId: `${sourceRecordId}:${index}`, keyword: theme.data.keyword, content: theme.data.content,
          mention: theme.data.mention, positive: theme.data.positive, negative: theme.data.negative,
          sourceUpdatedAt: theme.data.update_time,
        }];
      }),
    };
  return { scope, asin, result, summary, evidence, rawPayload: evidence.payload, rawUnavailableReason: null, issues };
}
