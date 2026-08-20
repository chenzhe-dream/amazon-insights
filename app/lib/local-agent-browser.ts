import { ApiErrorResponseSchema } from "../../shared/agent-contracts";

const authenticationRequiredListeners = new Set<() => void>();

export function subscribeToAuthenticationRequired(listener: () => void): () => void {
  authenticationRequiredListeners.add(listener);
  return () => authenticationRequiredListeners.delete(listener);
}

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

export async function localAgentFetch(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(localAgentProxyPath(path), { ...init, headers, credentials: "same-origin" });
  if (await responseRequiresAuthentication(response)) {
    for (const listener of [...authenticationRequiredListeners]) listener();
  }
  return response;
}

async function responseRequiresAuthentication(response: Response) {
  if (response.status !== 401) return false;
  try {
    const parsed = ApiErrorResponseSchema.safeParse(await response.clone().json());
    return !parsed.success || parsed.data.error.code === "AUTHENTICATION_REQUIRED";
  } catch {
    return true;
  }
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
