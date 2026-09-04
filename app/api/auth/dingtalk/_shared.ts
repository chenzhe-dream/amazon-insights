import {
  ApiErrorResponseSchema,
  type ApiErrorCode,
} from "../../../../shared/agent-contracts";
import type {
  AgentServiceClient,
  AgentServiceResult,
} from "../../../lib/agent-service-client";

export type DingTalkWebRouteDependencies = Readonly<{
  client: AgentServiceClient;
}>;

export function agentRequestHeaders(request: Request): Headers {
  const headers = new Headers({ origin: new URL(request.url).origin });
  for (const name of ["cookie", "x-request-id"] as const) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

export function appendForwardedCookies(
  target: Headers,
  source: Headers,
): void {
  for (const cookie of readSetCookies(source)) {
    if (/\r|\n/i.test(cookie)) continue;
    const safeCookie = cookie.replace(/;?\s*Domain=[^;]*/gi, "").trim();
    if (safeCookie) target.append("set-cookie", safeCookie);
  }
}

export function responseRequestId(
  target: Headers,
  result: AgentServiceResult,
): void {
  const requestId = result.headers.get("x-request-id");
  if (requestId) target.set("x-request-id", requestId);
}

export function safeLocalReturnPath(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 2_000 ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    /[\r\n\0]/.test(value)
  ) {
    return null;
  }
  return value;
}

export function fixedDingTalkErrorCode(body: unknown): string {
  const parsed = ApiErrorResponseSchema.safeParse(body);
  const code: ApiErrorCode | null = parsed.success
    ? parsed.data.error.code
    : null;
  switch (code) {
    case "DINGTALK_INVALID_STATE":
      return "invalid_state";
    case "DINGTALK_INVALID_CODE":
      return "invalid_code";
    case "DINGTALK_NOT_MEMBER":
      return "not_member";
    case "DINGTALK_DISABLED":
      return "disabled";
    default:
      return "unavailable";
  }
}

export function localRedirect(
  request: Request,
  path: string,
  headers = new Headers(),
): Response {
  const origin = new URL(request.url).origin;
  headers.set("location", new URL(path, origin).toString());
  headers.set("cache-control", "no-store");
  return new Response(null, { status: 302, headers });
}

export function clearDingTalkOAuthStateCookieHeader(request: Request): string {
  const secure = new URL(request.url).protocol === "https:";
  const name = secure
    ? "__Host-dingtalk_oauth_state"
    : "dingtalk_oauth_state";
  return [
    `${name}=`,
    "Max-Age=0",
    "Path=/",
    "HttpOnly",
    ...(secure ? ["Secure"] : []),
    "SameSite=Lax",
  ].join("; ");
}

function readSetCookies(headers: Headers): string[] {
  const getter = (headers as Headers & { getSetCookie?: () => string[] })
    .getSetCookie;
  if (getter) return getter.call(headers);
  const combined = headers.get("set-cookie");
  return combined ? [combined] : [];
}
