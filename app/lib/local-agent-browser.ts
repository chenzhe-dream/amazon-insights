const localAgentUrl =
  process.env.NEXT_PUBLIC_AGENT_VOC_LOCAL_URL ?? "http://127.0.0.1:31901";
const localAgentToken =
  process.env.NEXT_PUBLIC_AGENT_VOC_LOCAL_TOKEN ?? "local-ui-token";

export function localAgentFetch(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("x-agent-proxy-token", localAgentToken);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return fetch(`${localAgentUrl}${path}`, { ...init, headers });
}

export function localAgentErrorMessage(payload: unknown, fallback: string) {
  if (payload && typeof payload === "object") {
    const error = (payload as { error?: unknown }).error;
    if (typeof error === "string" && error) return error;
    if (error && typeof error === "object") {
      const message = (error as { message?: unknown }).message;
      if (typeof message === "string" && message) return message;
    }
  }
  return fallback;
}
