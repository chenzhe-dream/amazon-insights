import "server-only";

import { randomUUID } from "node:crypto";

import { z } from "zod";

import {
  ApiErrorResponseSchema,
  findHttpContract,
  v1Contracts,
  type ApiErrorCode,
  type ApiErrorResponse,
  type StageName,
} from "../../shared/agent-contracts";

type AgentServiceEnvironment = Readonly<Record<string, string | undefined>>;

type AgentServiceRouteRequest =
  | { method: "GET"; path: "/v1/capabilities" }
  | { method: "POST"; path: "/v1/auth/login" | "/v1/auth/logout" }
  | { method: "POST"; path: "/v1/projects" }
  | { method: "GET"; path: `/v1/projects/${string}` }
  | { method: "POST"; path: `/v1/projects/${string}/runs` }
  | { method: "GET"; path: `/v1/runs/${string}` }
  | { method: "POST"; path: `/v1/runs/${string}/cancel` }
  | {
      method: "POST";
      path: `/v1/runs/${string}/stages/${StageName}/retry`;
    }
  | { method: "GET"; path: `/v1/runs/${string}/reports` }
  | { method: "GET"; path: `/v1/reports/${string}` };

interface AgentServiceRequestOptions {
  headers?: HeadersInit;
  body?: BodyInit | null;
  requestId?: string;
}

export type AgentServiceRequest = AgentServiceRouteRequest &
  AgentServiceRequestOptions;

type AgentServiceSuccessResponse = z.infer<
  (typeof v1Contracts)[number]["response"]
>;

export interface AgentServiceResult<T = unknown> {
  status: number;
  headers: Headers;
  body: T | ApiErrorResponse;
}

export type AgentServiceClient = (
  request: AgentServiceRequest,
) => Promise<AgentServiceResult<AgentServiceSuccessResponse>>;

interface CreateAgentServiceClientOptions {
  env?: AgentServiceEnvironment;
  fetchImplementation?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;

const serviceConfigSchema = z.strictObject({
  internalUrl: z.url(),
  proxyToken: z.string().trim().min(1),
});

function loadServiceConfig(env: AgentServiceEnvironment) {
  const parsed = serviceConfigSchema.parse({
    internalUrl: env.AGENT_SERVICE_INTERNAL_URL,
    proxyToken: env.AGENT_SERVICE_PROXY_TOKEN,
  });
  const url = new URL(parsed.internalUrl);

  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error("Agent Service configuration is invalid");
  }

  return {
    internalUrl: url.origin,
    proxyToken: parsed.proxyToken,
  };
}

function safeMessage(value: string, secrets: readonly string[]) {
  return secrets.reduce(
    (message, secret) =>
      secret.length > 0 ? message.replaceAll(secret, "[redacted]") : message,
    value,
  );
}

function sanitizeValue(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") {
    return safeMessage(value, secrets);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, secrets));
  }
  if (value && typeof value === "object") {
    const sanitized: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const baseKey = safeMessage(key, secrets);
      let sanitizedKey = baseKey;
      let collision = 2;
      while (Object.hasOwn(sanitized, sanitizedKey)) {
        sanitizedKey = `${baseKey}#${collision}`;
        collision += 1;
      }
      sanitized[sanitizedKey] = sanitizeValue(item, secrets);
    }
    return sanitized;
  }
  return value;
}

function errorResult(
  status: number,
  code: ApiErrorCode,
  message: string,
  requestId: string,
): AgentServiceResult<never> {
  return {
    status,
    headers: new Headers({
      "content-type": "application/json",
      "x-request-id": requestId,
    }),
    body: {
      error: {
        code,
        message,
        requestId,
      },
    },
  };
}

function copyRequestHeaders(source: HeadersInit | undefined) {
  const input = new Headers(source);
  const output = new Headers();

  for (const name of [
    "accept",
    "content-type",
    "cookie",
    "idempotency-key",
  ]) {
    const value = input.get(name);
    if (value !== null) {
      output.set(name, value);
    }
  }

  return output;
}

function copyResponseHeaders(
  source: Headers,
  requestId: string,
  secrets: readonly string[],
) {
  const output = new Headers({
    "content-type": "application/json",
    "x-request-id": requestId,
  });
  const retryAfter = source.get("retry-after");
  if (retryAfter) {
    output.set("retry-after", safeMessage(retryAfter, secrets));
  }

  const getSetCookie = (
    source as Headers & { getSetCookie?: () => string[] }
  ).getSetCookie;
  const cookies = getSetCookie
    ? getSetCookie.call(source)
    : source.get("set-cookie")
      ? [source.get("set-cookie") as string]
      : [];
  for (const cookie of cookies) {
    const sameOriginCookie = safeMessage(cookie, secrets)
      .replace(/;?\s*Domain=[^;]*/gi, "")
      .trim();
    output.append("set-cookie", sameOriginCookie);
  }

  return output;
}

async function readLimitedBody(response: Response, maxBytes: number) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    cancelResponseBody(response);
    throw new RangeError("response too large");
  }

  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      byteLength += value.byteLength;
      if (byteLength > maxBytes) {
        await reader.cancel();
        throw new RangeError("response too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function cancelResponseBody(response: Response) {
  try {
    const cancellation = response.body?.cancel();
    void cancellation?.catch(() => undefined);
  } catch {
    // The response is already closed or locked; there is nothing left to drain.
  }
}

export function createAgentServiceClient(
  options: CreateAgentServiceClientOptions = {},
): AgentServiceClient {
  const env = options.env ?? process.env;
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes =
    options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

  return async (
    request: AgentServiceRequest,
  ): Promise<AgentServiceResult<AgentServiceSuccessResponse>> => {
    const requestId = request.requestId?.trim() || randomUUID();
    let config: ReturnType<typeof loadServiceConfig>;

    try {
      config = loadServiceConfig(env);
    } catch {
      return errorResult(
        503,
        "AGENT_SERVICE_UNAVAILABLE",
        "Agent Service is not configured",
        requestId,
      );
    }

    const contract = findHttpContract(request.method, request.path);
    if (!contract || !request.path.startsWith("/v1/")) {
      return errorResult(
        502,
        "AGENT_SERVICE_INVALID_RESPONSE",
        "Agent Service request path is invalid",
        requestId,
      );
    }

    const secrets = [config.internalUrl, config.proxyToken];
    const headers = copyRequestHeaders(request.headers);
    headers.set("x-agent-proxy-token", config.proxyToken);
    headers.set("x-request-id", requestId);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let upstream: Response;

    try {
      try {
        upstream = await fetchImplementation(
          `${config.internalUrl}${request.path}`,
          {
            method: request.method,
            headers,
            body: request.method === "GET" ? undefined : request.body,
            signal: controller.signal,
            redirect: "error",
          },
        );
      } catch {
        return controller.signal.aborted
          ? errorResult(
              504,
              "AGENT_SERVICE_TIMEOUT",
              "Agent Service request timed out",
              requestId,
            )
          : errorResult(
              502,
              "AGENT_SERVICE_UNAVAILABLE",
              "Agent Service is unavailable",
              requestId,
            );
      }

      if (
        !/^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|$)/i.test(
          upstream.headers.get("content-type") ?? "",
        )
      ) {
        cancelResponseBody(upstream);
        return errorResult(
          502,
          "AGENT_SERVICE_INVALID_RESPONSE",
          "Agent Service returned an invalid response",
          requestId,
        );
      }

      let rawBody: string;
      try {
        rawBody = await readLimitedBody(upstream, maxResponseBytes);
      } catch (error) {
        if (controller.signal.aborted) {
          return errorResult(
            504,
            "AGENT_SERVICE_TIMEOUT",
            "Agent Service request timed out",
            requestId,
          );
        }
        if (error instanceof RangeError) {
          return errorResult(
            502,
            "AGENT_SERVICE_RESPONSE_TOO_LARGE",
            "Agent Service response exceeded the size limit",
            requestId,
          );
        }
        return errorResult(
          502,
          "AGENT_SERVICE_INVALID_RESPONSE",
          "Agent Service returned an invalid response",
          requestId,
        );
      }

      let body: unknown;
      try {
        body = sanitizeValue(JSON.parse(rawBody), secrets);
      } catch {
        return errorResult(
          502,
          "AGENT_SERVICE_INVALID_RESPONSE",
          "Agent Service returned an invalid response",
          requestId,
        );
      }

      if (
        upstream.status >= 500 ||
        upstream.status < 200 ||
        (upstream.status >= 300 && upstream.status < 400)
      ) {
        return errorResult(
          502,
          "AGENT_SERVICE_UPSTREAM_ERROR",
          "Agent Service failed to process the request",
          requestId,
        );
      }

      if (upstream.status >= 400) {
        const parsedError = ApiErrorResponseSchema.safeParse(body);
        if (!parsedError.success) {
          return errorResult(
            502,
            "AGENT_SERVICE_INVALID_RESPONSE",
            "Agent Service returned an invalid error response",
            requestId,
          );
        }
        return {
          status: upstream.status,
          headers: copyResponseHeaders(upstream.headers, requestId, secrets),
          body: {
            error: {
              ...parsedError.data.error,
              requestId,
            },
          },
        };
      }

      const parsedResponse = contract.response.safeParse(body);
      if (!parsedResponse.success) {
        return errorResult(
          502,
          "AGENT_SERVICE_INVALID_RESPONSE",
          "Agent Service response did not match its contract",
          requestId,
        );
      }
      body = parsedResponse.data;

      return {
        status: upstream.status,
        headers: copyResponseHeaders(upstream.headers, requestId, secrets),
        body: body as AgentServiceSuccessResponse,
      };
    } finally {
      clearTimeout(timeout);
    }
  };
}
