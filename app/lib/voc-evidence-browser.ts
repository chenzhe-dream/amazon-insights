import { VocAutomationStatusSchema, type VocAutomationRequest } from "../../shared/voc-automation-contracts";
import { z } from "zod";
import { GetRunResponseSchema, ListReportsResponseSchema, CreateRunResponseSchema } from "../../shared/agent-contracts";
import { VocEvidenceInventorySchema, type VocEvidenceSelectionRequest } from "../../shared/voc-evidence-contracts";
import { localAgentFetch, localAgentErrorMessage } from "./local-agent-browser";
export type EvidenceFetch = (path: string, init?: RequestInit) => Promise<Response>;
async function read<T>(path: string, schema: z.ZodType<T>, fetchImpl: EvidenceFetch, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  init?.signal?.addEventListener("abort", abort, { once: true });
  if (init?.signal?.aborted) controller.abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let response: Response, payload: unknown;
  try {
    ({ response, payload } = await Promise.race([
      (async () => { const response = await fetchImpl(path, { ...init, signal: controller.signal }); return { response, payload: await response.json() }; })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("请求超时，请重试")); }, 15000); }),
    ]));
  } finally { clearTimeout(timer); init?.signal?.removeEventListener("abort", abort); }
  if (!response.ok) throw new Error(localAgentErrorMessage(payload, "分析数据暂不可用"));
  return schema.parse(payload);
}
export function readEvidenceInventory(projectId: string, baseSyncRunId: string, asins: string[], signal: AbortSignal, fetchImpl: EvidenceFetch = localAgentFetch) {
  const query = new URLSearchParams({ baseSyncRunId, asins: [...asins].sort().join(",") });
  return read(`/v1/projects/${encodeURIComponent(projectId)}/voc-inputs?${query}`, VocEvidenceInventorySchema, fetchImpl, { signal });
}
export function submitEvidenceRun(projectId: string, evidenceSelection: VocEvidenceSelectionRequest, idempotencyKey: string, signal: AbortSignal, fetchImpl: EvidenceFetch = localAgentFetch) {
  return read(`/v1/projects/${encodeURIComponent(projectId)}/runs`, CreateRunResponseSchema, fetchImpl, { method: "POST", signal, body: JSON.stringify({ mode: "existing-data", idempotencyKey, evidenceSelection }) });
}
export async function readEvidenceRun(projectId: string, runId: string, signal: AbortSignal, fetchImpl: EvidenceFetch = localAgentFetch) {
  const [run, reports] = await Promise.all([
    read(`/v1/runs/${encodeURIComponent(runId)}`, GetRunResponseSchema, fetchImpl, { signal }),
    read(`/v1/runs/${encodeURIComponent(runId)}/reports`, ListReportsResponseSchema, fetchImpl, { signal }),
  ]);
  if (run.run.id !== runId || run.run.projectId !== projectId || run.stages.some(stage => stage.runId !== runId) || reports.reports.some(report => report.runId !== runId)) throw new Error("分析报告范围不匹配");
  return { ...run, reports: [...reports.reports].sort((a, b) => b.version - a.version) };
}

export function registerVocAutomation(projectId: string, body: VocAutomationRequest, signal: AbortSignal, fetchImpl: EvidenceFetch = localAgentFetch) {
  return read(`/v1/projects/${encodeURIComponent(projectId)}/voc-automation`, VocAutomationStatusSchema, fetchImpl, {method:"POST", signal, body:JSON.stringify(body)});
}
export function readVocAutomation(projectId: string, signal: AbortSignal, fetchImpl: EvidenceFetch = localAgentFetch) {
  return read(`/v1/projects/${encodeURIComponent(projectId)}/voc-automation`, VocAutomationStatusSchema, fetchImpl, {signal});
}
