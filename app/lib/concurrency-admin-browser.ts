import {
  ConcurrencyAdminResponseSchema,
  type ConcurrencyAdminResponse,
} from "../../shared/agent-contracts";
import { localAgentFetch, localAgentErrorMessage } from "./local-agent-browser";

async function parseAdminResponse(response: Response): Promise<ConcurrencyAdminResponse> {
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(localAgentErrorMessage(payload, "并发与额度状态读取失败"));
  }
  return ConcurrencyAdminResponseSchema.parse(payload);
}

export async function readConcurrencyAdminState(): Promise<ConcurrencyAdminResponse> {
  return parseAdminResponse(await localAgentFetch("/v1/admin/concurrency"));
}

export async function updateConcurrencyPolicy(profile: "conservative" | "standard" | "fast") {
  return parseAdminResponse(await localAgentFetch("/v1/admin/concurrency/policy", {
    method: "PUT",
    body: JSON.stringify({ profile }),
  }));
}

export async function updateSellerSpriteQuotaTotal(total: number | null) {
  return parseAdminResponse(await localAgentFetch("/v1/admin/seller-sprite/quota/total", {
    method: "PUT",
    body: JSON.stringify({ total }),
  }));
}

export async function refreshSellerSpriteQuota() {
  return parseAdminResponse(await localAgentFetch("/v1/admin/seller-sprite/quota/refresh", {
    method: "POST",
    body: JSON.stringify({}),
  }));
}

export async function setSellerSpritePause(paused: boolean) {
  return parseAdminResponse(await localAgentFetch("/v1/admin/concurrency/pause", {
    method: "POST",
    body: JSON.stringify({ resource: "sellerSprite", paused }),
  }));
}

export async function resetSellerSpriteCircuit() {
  return parseAdminResponse(await localAgentFetch("/v1/admin/connectors/sellerSprite/circuit/reset", {
    method: "POST",
    body: JSON.stringify({}),
  }));
}
