import {
  DingTalkOAuthCallbackRequestSchema,
  DingTalkOAuthCallbackResponseSchema,
} from "../../../../../shared/agent-contracts";
import { createAgentServiceClient } from "../../../../lib/agent-service-client";
import {
  agentRequestHeaders,
  appendForwardedCookies,
  clearDingTalkOAuthStateCookieHeader,
  fixedDingTalkErrorCode,
  localRedirect,
  responseRequestId,
  safeLocalReturnPath,
  type DingTalkWebRouteDependencies,
} from "../_shared";

export function createDingTalkOAuthCallbackHandler(
  dependencies: Partial<DingTalkWebRouteDependencies> = {},
) {
  const client = dependencies.client ?? createAgentServiceClient();
  return async function handleDingTalkOAuthCallback(request: Request) {
    const incoming = new URL(request.url);
    const parsedInput = DingTalkOAuthCallbackRequestSchema.safeParse({
      code: incoming.searchParams.get("authCode") ?? incoming.searchParams.get("code"),
      state: incoming.searchParams.get("state"),
    });
    if (!parsedInput.success) {
      const headers = new Headers({
        "set-cookie": clearDingTalkOAuthStateCookieHeader(request),
      });
      return localRedirect(
        request,
        `/?dingtalk_error=${incoming.searchParams.has("state") ? "invalid_code" : "invalid_state"}`,
        headers,
      );
    }

    const result = await client({
      method: "POST",
      path: "/v1/auth/dingtalk/oauth/callback",
      headers: agentRequestHeaders(request),
      body: JSON.stringify(parsedInput.data),
      requestId: request.headers.get("x-request-id") ?? undefined,
    });
    const headers = new Headers();
    appendForwardedCookies(headers, result.headers);
    responseRequestId(headers, result);
    const parsed = DingTalkOAuthCallbackResponseSchema.safeParse(result.body);
    if (result.status !== 200 || !parsed.success) {
      return localRedirect(
        request,
        `/?dingtalk_error=${fixedDingTalkErrorCode(result.body)}`,
        headers,
      );
    }
    const returnPath = safeLocalReturnPath(parsed.data.returnPath);
    return localRedirect(
      request,
      returnPath ?? "/?dingtalk_error=invalid_state",
      headers,
    );
  };
}

export const GET = createDingTalkOAuthCallbackHandler();
