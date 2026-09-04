import { DingTalkPublicConfigResponseSchema } from "../../../../../shared/agent-contracts";
import { createAgentServiceClient } from "../../../../lib/agent-service-client";
import {
  agentRequestHeaders,
  responseRequestId,
  type DingTalkWebRouteDependencies,
} from "../_shared";

export function createDingTalkConfigHandler(
  dependencies: Partial<DingTalkWebRouteDependencies> = {},
) {
  const client = dependencies.client ?? createAgentServiceClient();
  return async function handleDingTalkConfig(request: Request) {
    const result = await client({
      method: "GET",
      path: "/v1/auth/dingtalk/config",
      headers: agentRequestHeaders(request),
      requestId: request.headers.get("x-request-id") ?? undefined,
    });
    const headers = new Headers({
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    responseRequestId(headers, result);
    const parsed = DingTalkPublicConfigResponseSchema.safeParse(result.body);
    return Response.json(
      parsed.success ? parsed.data : result.body,
      { status: result.status, headers },
    );
  };
}

export const GET = createDingTalkConfigHandler();
