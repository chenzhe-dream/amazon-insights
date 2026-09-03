import "server-only";

import { SessionResponseSchema, type User } from "../../shared/agent-contracts";
import { createAgentServiceClient, type AgentServiceClient } from "./agent-service-client";

type UserRole = User["role"];
export type WebMutationAuthorization =
  | Readonly<{ ok: true; role: UserRole }>
  | Readonly<{ ok: false; response: Response }>;

function rejected(status: 401 | 403 | 503, error: string) {
  return Object.freeze({ ok: false as const, response: Response.json({ error }, { status }) });
}

export async function authorizeWebMutation(
  request: Request,
  options: Readonly<{ allowedRoles: readonly UserRole[]; client?: AgentServiceClient }>,
): Promise<WebMutationAuthorization> {
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(request.url).origin) return rejected(403, "请求来源未获授权");

  const headers = new Headers({ origin });
  const cookie = request.headers.get("cookie");
  if (cookie) headers.set("cookie", cookie);
  const result = await (options.client ?? createAgentServiceClient())({
    method: "GET", path: "/v1/auth/session", headers,
  });
  if (result.status !== 200) return rejected(503, "登录状态暂时无法验证");
  const parsed = SessionResponseSchema.safeParse(result.body);
  if (!parsed.success) return rejected(503, "登录状态暂时无法验证");
  if (!parsed.data.authenticated || !parsed.data.user) return rejected(401, "请先登录后再操作");
  if (!options.allowedRoles.includes(parsed.data.user.role)) return rejected(403, "当前账号无权执行此操作");
  return Object.freeze({ ok: true, role: parsed.data.user.role });
}
