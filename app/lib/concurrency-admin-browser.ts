import {
  ConnectorCredentialListSchema,
  ConnectorCredentialStateSchema,
  ConnectorHealthSchema,
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

export type ConnectorCredentialState = ReturnType<
  typeof ConnectorCredentialStateSchema.parse
>;
export type ManagedConnectorId = ConnectorCredentialState["connectorId"];

async function parseConnectorResponse<T>(
  response: Response,
  schema: { parse(value: unknown): T },
  fallback: string,
): Promise<T> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(fallback);
  }
  if (!response.ok) throw new Error(fallback);
  return schema.parse(payload);
}

export async function listConnectorCredentials() {
  return parseConnectorResponse(
    await localAgentFetch("/v1/connectors"),
    ConnectorCredentialListSchema,
    "连接器配置状态读取失败",
  );
}

export async function saveConnectorCredential(
  connectorId: ManagedConnectorId,
  secret: string,
) {
  return parseConnectorResponse(
    await localAgentFetch(`/v1/connectors/${connectorId}/credential`, {
      method: "PUT",
      body: JSON.stringify({ secret }),
    }),
    ConnectorCredentialStateSchema,
    "连接器凭证保存失败",
  );
}

export async function revokeConnectorCredential(connectorId: ManagedConnectorId) {
  return parseConnectorResponse(
    await localAgentFetch(`/v1/connectors/${connectorId}/credential`, {
      method: "DELETE",
    }),
    ConnectorCredentialStateSchema,
    "连接器凭证撤销失败",
  );
}

export async function probeConnector(connectorId: ManagedConnectorId) {
  return parseConnectorResponse(
    await localAgentFetch(`/v1/connectors/${connectorId}/probe`, {
      method: "POST",
    }),
    ConnectorHealthSchema,
    "连接器测试失败",
  );
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
