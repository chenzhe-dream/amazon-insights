import {
  AlexaVocNormalizationStatusResponseSchema,
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
