import {
  AlexaVocNormalizationStatusResponseSchema,
  ManualAlexaVocListResponseSchema,
  type ManualAlexaVocRecord,
  type AlexaVocNormalizationStatusResponse,
} from "../../shared/agent-contracts";

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
  asins: readonly string[];
  request?: AlexaVocNormalizationStatusFetch;
  signal?: AbortSignal;
}>): Promise<AlexaVocNormalizationStatusResponse> {
  const asins = normalizedAsins(input.asins);
  if (!asins.length) return { records: [] };

  const query = new URLSearchParams({
    projectId: input.projectId,
    runId: input.runId,
    marketplace: "US",
  });
  for (const asin of asins) query.append("asins", asin);

  const request = input.request ?? fetch;
  const response = await request(`/api/alexa-voc/pending?${query.toString()}`, {
    credentials: "same-origin",
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error("Alexa VOC 标准化状态暂不可用");
  const parsed = AlexaVocNormalizationStatusResponseSchema.safeParse(payload);
  if (!parsed.success) throw new Error("Alexa VOC 标准化状态响应无效");
  return parsed.data;
}

export type AlexaVocPollResult =
  | Readonly<{ phase: "processing" }>
  | Readonly<{ phase: "applying"; revision: string }>
  | Readonly<{ phase: "done"; record: ManualAlexaVocRecord }>
  | Readonly<{ phase: "failure"; error: "model-output" | "schema" | "persistence" | "authorization" }>
  | Readonly<{ phase: "recoverable-error"; message: "状态读取暂时失败，将继续重试" }>;

const recoverablePollError = Object.freeze({
  phase: "recoverable-error" as const,
  message: "状态读取暂时失败，将继续重试" as const,
});

export async function pollAlexaVocNormalizationOnce(input: Readonly<{
  projectId: string;
  runId: string;
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

    const query = new URLSearchParams({ projectId: input.projectId, marketplace: "US" });
    query.append("asins", asin);
    const response = await request(`/api/alexa-voc?${query.toString()}`, {
      credentials: "same-origin",
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) return recoverablePollError;
    const parsed = ManualAlexaVocListResponseSchema.safeParse(payload);
    if (!parsed.success) return recoverablePollError;
    const record = parsed.data.records.find(candidate =>
      candidate.asin === asin
      && candidate.contentHash === input.fingerprint
      && candidate.revision === observed.revision
    );
    return record ? { phase: "done", record } : { phase: "applying", revision: observed.revision! };
  } catch (error) {
    if (input.signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) throw error;
    return recoverablePollError;
  }
}
