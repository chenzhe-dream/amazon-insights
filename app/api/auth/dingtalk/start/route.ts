import { DingTalkOAuthStartResponseSchema } from "../../../../../shared/agent-contracts";
import { createAgentServiceClient } from "../../../../lib/agent-service-client";
import {
  agentRequestHeaders,
  appendForwardedCookies,
  fixedDingTalkErrorCode,
  localRedirect,
  responseRequestId,
  safeLocalReturnPath,
  type DingTalkWebRouteDependencies,
} from "../_shared";

export function createDingTalkOAuthStartHandler(
  dependencies: Partial<DingTalkWebRouteDependencies> = {},
) {
  const client = dependencies.client ?? createAgentServiceClient();
  return async function handleDingTalkOAuthStart(request: Request) {
    const incoming = new URL(request.url);
    const returnPath = safeLocalReturnPath(incoming.searchParams.get("returnPath")) ?? "/";
    const result = await client({
      method: "POST",
      path: "/v1/auth/dingtalk/oauth/start",
      headers: agentRequestHeaders(request),
      body: JSON.stringify({ returnPath }),
      requestId: request.headers.get("x-request-id") ?? undefined,
    });
    const headers = new Headers();
    appendForwardedCookies(headers, result.headers);
    responseRequestId(headers, result);
    const parsed = DingTalkOAuthStartResponseSchema.safeParse(result.body);
    if (result.status !== 200 || !parsed.success) {
      return localRedirect(
        request,
        `/?dingtalk_error=${fixedDingTalkErrorCode(result.body)}`,
        headers,
      );
    }
    const authorizationUrl = new URL(parsed.data.authorizationUrl);
    if (
      authorizationUrl.protocol !== "https:" ||
      authorizationUrl.hostname !== "login.dingtalk.com" ||
      authorizationUrl.pathname !== "/oauth2/auth"
    ) {
      return localRedirect(request, "/?dingtalk_error=unavailable", headers);
    }
    headers.set("location", authorizationUrl.toString());
    headers.set("cache-control", "no-store");
    return new Response(null, { status: 302, headers });
  };
}

export const GET = createDingTalkOAuthStartHandler();
