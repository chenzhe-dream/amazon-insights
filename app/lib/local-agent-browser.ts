function localAgentProxyPath(path: string) {
  const parsed = new URL(path, "http://same-origin.local");
  const normalized = `${parsed.pathname}${parsed.search}`;
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    parsed.origin !== "http://same-origin.local" ||
    normalized !== path
  ) {
    throw new TypeError("Agent Service path must be same-origin relative");
  }
  return `/api/agent${normalized}`;
}

export function localAgentFetch(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return fetch(localAgentProxyPath(path), { ...init, headers });
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
