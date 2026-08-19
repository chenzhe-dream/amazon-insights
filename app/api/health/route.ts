type WebHealthEnvironment = Readonly<Record<string, string | undefined>>;

type ProbeAgentHealthOptions = Readonly<{
  env?: WebHealthEnvironment;
  fetchImplementation?: typeof fetch;
  timeoutMs?: number;
}>;

const DEFAULT_AGENT_HEALTH_TIMEOUT_MS = 2_000;

function agentHealthUrl(env: WebHealthEnvironment): string | null {
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
    return `${url.origin}/health`;
  } catch {
    return null;
  }
}

function webHealth(status: 200 | 503, agent: "ok" | "degraded") {
  return Response.json(
    {
      status: status === 200 ? "ok" : "degraded",
      service: "web",
      agent,
    },
    { status },
  );
}

export async function probeAgentHealth(
  options: ProbeAgentHealthOptions = {},
): Promise<Response> {
  const url = agentHealthUrl(options.env ?? process.env);
  if (!url) return webHealth(503, "degraded");

  const timeoutMs = options.timeoutMs ?? DEFAULT_AGENT_HEALTH_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await (options.fetchImplementation ?? fetch)(url, {
      method: "GET",
      signal: controller.signal,
      redirect: "error",
    });
    if (!response.ok) return webHealth(503, "degraded");
    const payload = await response.json();
    return payload?.status === "ok" && payload?.service === "agent-service"
      ? webHealth(200, "ok")
      : webHealth(503, "degraded");
  } catch {
    return webHealth(503, "degraded");
  } finally {
    clearTimeout(timeout);
  }
}

export async function GET() {
  return probeAgentHealth();
}
