import { z } from "zod";
import { MarketResearchIdempotencyKeySchema, MarketResearchJobResponseSchema, MarketResearchListResponseSchema, MarketResearchScopeSchema, type MarketResearchScope } from "../../shared/market-research-contracts";
import { localAgentErrorMessage, localAgentFetch } from "./local-agent-browser";

export function createMarketResearchHistoryReader() {
  let active: { signal: AbortSignal } | null = null;
  return {
    async run(signal: AbortSignal, read: () => Promise<void>) {
      if (signal.aborted || (active && !active.signal.aborted)) return;
      const owner = { signal };
      active = owner;
      try {
        await read();
      } finally {
        if (active === owner) active = null;
      }
    },
  };
}

async function request<T>(path: string, schema: z.ZodType<T>, init: RequestInit = {}): Promise<T> {
  init.signal?.throwIfAborted();
  const response = await localAgentFetch(path, { ...init, cache: "no-store" });
  const payload: unknown = await response.json().catch(() => null);
  init.signal?.throwIfAborted();
  if (!response.ok) throw new Error(localAgentErrorMessage(payload, "市场调研请求失败，请稍后重试。"));
  const result = schema.safeParse(payload);
  if (!result.success) throw new Error("市场调研响应格式不正确，未加载该结果。");
  return result.data;
}

export async function listMarketResearchJobs(signal?: AbortSignal) {
  return (await request("/v1/market-research/jobs", MarketResearchListResponseSchema, { signal })).jobs;
}

export async function readMarketResearchJob(id: string, signal?: AbortSignal) {
  z.string().uuid().parse(id);
  return (await request(`/v1/market-research/jobs/${encodeURIComponent(id)}`, MarketResearchJobResponseSchema, { signal })).job;
}

export async function createMarketResearchJob(scope: MarketResearchScope, idempotencyKey: string, signal?: AbortSignal) {
  const parsed = MarketResearchScopeSchema.parse(scope);
  MarketResearchIdempotencyKeySchema.parse(idempotencyKey);
  return (await request("/v1/market-research/jobs", MarketResearchJobResponseSchema, {
    method: "POST", signal, headers: { "idempotency-key": idempotencyKey }, body: JSON.stringify(parsed),
  })).job;
}

export async function retryMarketResearchJob(id: string, signal?: AbortSignal) {
  z.string().uuid().parse(id);
  return (await request(`/v1/market-research/jobs/${encodeURIComponent(id)}/retry`, MarketResearchJobResponseSchema, {
    method: "POST", signal, body: JSON.stringify({}),
  })).job;
}
