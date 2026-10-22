import type { ProjectMarketplace } from "../../shared/project-marketplaces";
import {
  AlexaVocNormalizationStatusResponseSchema,
  ManualAlexaVocListResponseSchema,
  type ManualAlexaVocRecord,
  type AlexaVocNormalizationStatusResponse,
  type AlexaVocNormalizationStatus,
} from "../../shared/agent-contracts";

class AlexaVocScopeError extends Error {}
const scopeErrorMessage = "当前项目或站点与导入任务不匹配，或登录权限已失效，请刷新项目后重试。";

export type AlexaVocNormalizationStatusFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

function normalizedAsins(asins: readonly string[]) {
  return [...new Set(
    asins
      .map(asin => asin.trim().toUpperCase())
      .filter(asin => /^[A-Z0-9]{10}$/.test(asin)),
  )].slice(0, 10);
}

export async function readAlexaVocNormalizationStatuses(input: Readonly<{
  projectId: string;
  runId: string;
  marketplace: ProjectMarketplace;
  asins: readonly string[];
  request?: AlexaVocNormalizationStatusFetch;
  signal?: AbortSignal;
}>): Promise<AlexaVocNormalizationStatusResponse> {
  const asins = normalizedAsins(input.asins);
  if (!asins.length) return { records: [] };

  const query = new URLSearchParams({
    projectId: input.projectId,
    runId: input.runId,
    marketplace: input.marketplace,
  });
  for (const asin of asins) query.append("asins", asin);

  const request = input.request ?? fetch;
  const response = await request(`/api/alexa-voc/pending?${query.toString()}`, {
    credentials: "same-origin",
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (response.status === 401 || response.status === 403) throw new AlexaVocScopeError(scopeErrorMessage);
  if (!response.ok) throw new Error("Alexa VOC 标准化状态暂不可用");
  const parsed = AlexaVocNormalizationStatusResponseSchema.safeParse(payload);
  if (!parsed.success) throw new Error("Alexa VOC 标准化状态响应无效");
  return parsed.data;
}

export type AlexaVocPollResult =
  | Readonly<{ phase: "processing" }>
  | Readonly<{ phase: "applying"; revision: string }>
  | Readonly<{ phase: "done"; record: ManualAlexaVocRecord }>
  | Readonly<{ phase: "failure"; error: NonNullable<AlexaVocNormalizationStatus["error"]> }>
  | Readonly<{ phase: "recoverable-error"; message: "状态读取暂时失败，将继续重试" }>;

const recoverablePollError = Object.freeze({
  phase: "recoverable-error" as const,
  message: "状态读取暂时失败，将继续重试" as const,
});

export type AlexaVocDiscoveryResult =
  | Readonly<{ phase: "ready"; response: AlexaVocNormalizationStatusResponse }>
  | Readonly<{ phase: "recoverable-error"; message: string }>;

export async function deliverAlexaVocResultIfActive<T, TResult>(input: Readonly<{
  signal: AbortSignal;
  operation: () => Promise<T>;
  onResult: (result: T) => TResult;
}>): Promise<TResult | undefined> {
  const result = await input.operation();
  if (input.signal.aborted) return undefined;
  return input.onResult(result);
}

export function prepareAlexaVocDiscoveryForPolling(
  response: AlexaVocNormalizationStatusResponse,
): AlexaVocNormalizationStatusResponse {
  return {
    records: response.records.map(record => record.status === "success"
      ? { asin: record.asin, fingerprint: record.fingerprint, status: "pending", revision: null, error: null }
      : record),
  };
}

export async function discoverAlexaVocNormalizationStatuses(
  input: Parameters<typeof readAlexaVocNormalizationStatuses>[0],
): Promise<AlexaVocDiscoveryResult> {
  try {
    const response = await readAlexaVocNormalizationStatuses(input);
    return { phase: "ready", response: prepareAlexaVocDiscoveryForPolling(response) };
  } catch (error) {
    if (input.signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) throw error;
    return { phase: "recoverable-error", message: error instanceof AlexaVocScopeError ? scopeErrorMessage : "状态发现暂时失败，请重试读取" };
  }
}

export async function pollAlexaVocNormalizationOnce(input: Readonly<{
  projectId: string;
  runId: string;
  marketplace: ProjectMarketplace;
  asin: string;
  fingerprint: string;
  request?: AlexaVocNormalizationStatusFetch;
  signal?: AbortSignal;
}>): Promise<AlexaVocPollResult> {
  const request = input.request ?? fetch;
  try {
    const status = await readAlexaVocNormalizationStatuses({
      projectId: input.projectId,
      runId: input.runId,
      marketplace: input.marketplace,
      asins: [input.asin],
      request,
      signal: input.signal,
    });
    const asin = input.asin.trim().toUpperCase();
    const observed = status.records.find(record =>
      record.asin === asin && record.fingerprint === input.fingerprint
    );
    if (!observed || observed.status === "pending") return { phase: "processing" };
    if (observed.status === "failure") return { phase: "failure", error: observed.error! };

    const query = new URLSearchParams({ projectId: input.projectId, marketplace: input.marketplace });
    query.append("asins", asin);
    const response = await request(`/api/alexa-voc?${query.toString()}`, {
      credentials: "same-origin",
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const payload: unknown = await response.json().catch(() => null);
    if (response.status === 401 || response.status === 403) return { phase: "failure", error: "authorization" };
    if (!response.ok) return recoverablePollError;
    const parsed = ManualAlexaVocListResponseSchema.safeParse(payload);
    if (!parsed.success) return recoverablePollError;
    const record = parsed.data.records.find(candidate =>
      candidate.marketplace === input.marketplace
      && candidate.asin === asin
      && candidate.contentHash === input.fingerprint
      && candidate.revision === observed.revision
    );
    return record ? { phase: "done", record } : { phase: "applying", revision: observed.revision! };
  } catch (error) {
    if (input.signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) throw error;
    return error instanceof AlexaVocScopeError ? { phase: "failure", error: "authorization" } : recoverablePollError;
  }
}
