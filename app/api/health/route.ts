import { AgentReadinessResponseSchema } from "../../../shared/agent-contracts";
import { webArtifactId } from "../../lib/web-artifact-id";

type WebHealthEnvironment = Readonly<Record<string, string | undefined>>;

type AgentReadinessConfig = Readonly<{
  origin: string;
  token: string;
  url: string;
}>;

type ProbeAgentReadinessOptions = Readonly<{
  env?: WebHealthEnvironment;
  fetchImplementation?: typeof fetch;
  requestUrl?: string;
  timeoutMs?: number;
}>;

const DEFAULT_AGENT_READINESS_TIMEOUT_MS = 2_000;
const MAX_AGENT_READINESS_JSON_BYTES = 64 * 1_024;

function agentReadinessUrl(env: WebHealthEnvironment): string | null {
  const rawUrl = env.AGENT_SERVICE_INTERNAL_URL?.trim();
  if (!rawUrl) return null;

  try {
    const url = new URL(rawUrl);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return `${url.origin}/v1/readiness`;
  } catch {
    return null;
  }
}

function webOrigin(
  env: WebHealthEnvironment,
  requestUrl: string | undefined,
): string | null {
  const configuredOrigin = env.AGENT_SERVICE_READINESS_ORIGIN;
  if (configuredOrigin !== undefined) {
    try {
      const url = new URL(configuredOrigin.trim());
      if (
        (url.protocol !== "http:" && url.protocol !== "https:") ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        (url.pathname !== "/" && url.pathname !== "")
      ) {
        return null;
      }
      return url.origin;
    } catch {
      return null;
    }
  }

  if (requestUrl) {
    try {
      return new URL(requestUrl).origin;
    } catch {
      return null;
    }
  }

  const host = env.WEB_HOST ?? env.HOST ?? "127.0.0.1";
  const port = env.WEB_PORT ?? env.PORT ?? "3001";
  return `http://${host}:${port}`;
}

function agentReadinessConfig(
  env: WebHealthEnvironment,
  requestUrl: string | undefined,
): AgentReadinessConfig | null {
  const url = agentReadinessUrl(env);
  const token = env.AGENT_SERVICE_PROXY_TOKEN?.trim();
  const origin = webOrigin(env, requestUrl);

  if (!url || !token || !origin) return null;
  return { origin, token, url };
}

function webHealth(
  status: 200 | 503,
  agent: "ok" | "degraded",
  env: WebHealthEnvironment,
) {
  return Response.json(
    {
      status: status === 200 ? "ok" : "degraded",
      service: "web",
      agent,
      artifactId: webArtifactId(env),
    },
    { status },
  );
}

async function readSafeJson(response: Response): Promise<unknown> {
  const contentLength = response.headers.get("content-length");
  if (
    contentLength &&
    Number.isFinite(Number(contentLength)) &&
    Number(contentLength) > MAX_AGENT_READINESS_JSON_BYTES
  ) {
    throw new Error("Agent readiness response is too large");
  }

  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_AGENT_READINESS_JSON_BYTES) {
    throw new Error("Agent readiness response is too large");
  }
  return JSON.parse(text);
}

function agentIsReady(payload: unknown): boolean {
  const parsed = AgentReadinessResponseSchema.safeParse(payload);
  if (!parsed.success) return false;

  const { openai, storage } = parsed.data.readiness;
  return storage && openai;
}

export async function probeAgentReadiness(
  options: ProbeAgentReadinessOptions = {},
): Promise<Response> {
  const env = options.env ?? process.env;
  const readiness = agentReadinessConfig(
    env,
    options.requestUrl,
  );
  if (!readiness) return webHealth(503, "degraded", env);

  const timeoutMs = options.timeoutMs ?? DEFAULT_AGENT_READINESS_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await (options.fetchImplementation ?? fetch)(readiness.url, {
      headers: {
        origin: readiness.origin,
        "x-agent-proxy-token": readiness.token,
      },
      method: "GET",
      signal: controller.signal,
      redirect: "error",
    });
    if (!response.ok) return webHealth(503, "degraded", env);
    return agentIsReady(await readSafeJson(response))
      ? webHealth(200, "ok", env)
      : webHealth(503, "degraded", env);
  } catch {
    return webHealth(503, "degraded", env);
  } finally {
    clearTimeout(timeout);
  }
}

export const probeAgentHealth = probeAgentReadiness;

export async function GET(request: Request) {
  return probeAgentReadiness({ requestUrl: request.url });
}
