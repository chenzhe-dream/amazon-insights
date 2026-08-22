import { randomUUID } from "node:crypto";

import {
  ApiErrorResponseSchema,
  findHttpContract,
  normalizeRequestId,
  type ApiErrorResponse,
} from "../../../../shared/agent-contracts";
import {
  createAgentServiceClient,
  type AgentServiceClient,
  type AgentServiceRequest,
} from "../../../lib/agent-service-client";

type RouteContext = { params: Promise<{ path: string[] }> };
type FeedbackTransferOptions = {
  env?: Readonly<Record<string, string | undefined>>;
  fetchImplementation?: typeof fetch;
  timeoutMs?: number;
};

const MAX_FEEDBACK_MULTIPART_BYTES = 3 * 5 * 1_048_576 + 128 * 1_024;
const MAX_FEEDBACK_ATTACHMENT_BYTES = 5 * 1_048_576;
const MAX_FEEDBACK_JSON_BYTES = 1_048_576;
const DEFAULT_FEEDBACK_TRANSFER_TIMEOUT_MS = 10_000;
const MULTIPART_WITH_BOUNDARY =
  /^multipart\/form-data\s*;[^\r\n]*\bboundary=(?:"[^"]+"|[^;\s]+)(?:\s*;|$)/i;
const FEEDBACK_ATTACHMENT_CONTRACTS = new Set([
  "/v1/feedback/mine/:feedbackId/attachments/:attachmentId",
  "/v1/feedback/admin/:feedbackId/attachments/:attachmentId",
]);

function jsonError(
  status: number,
  code: ApiErrorResponse["error"]["code"],
  message: string,
  requestId: string,
) {
  return Response.json(
    { error: { code, message, requestId } } satisfies ApiErrorResponse,
    {
      status,
      headers: { "x-request-id": requestId },
    },
  );
}

function feedbackServiceConfig(
  env: Readonly<Record<string, string | undefined>>,
) {
  const rawUrl = env.AGENT_SERVICE_INTERNAL_URL?.trim();
  const proxyToken = env.AGENT_SERVICE_PROXY_TOKEN?.trim();
  if (!rawUrl || !proxyToken) return null;

  try {
    const url = new URL(rawUrl);
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
    return { internalUrl: url.origin, proxyToken };
  } catch {
    return null;
  }
}

function cancelBody(response: Response) {
  try {
    const cancellation = response.body?.cancel();
    void cancellation?.catch(() => undefined);
  } catch {
    // The upstream body is already closed or locked.
  }
}

async function readLimitedBytes(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
) {
  const declared = response.headers.get("content-length");
  const declaredLength = declared === null ? Number.NaN : Number(declared);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    cancelBody(response);
    throw new RangeError("response too large");
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  const aborted = new Promise<never>((_resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("response read aborted"));
      return;
    }
    signal?.addEventListener(
      "abort",
      () => reject(new Error("response read aborted")),
      { once: true },
    );
  });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
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
  return bytes;
}

async function readBoundedRequest(request: Request, maxBytes: number) {
  const declared = request.headers.get("content-length");
  const declaredLength = declared === null ? Number.NaN : Number(declared);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) return null;
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > maxBytes) {
        await reader.cancel();
        return null;
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
  return bytes;
}

function requestBody(bytes: Uint8Array) {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function feedbackTransferHeaders(request: Request, requestId: string) {
  const headers = new Headers();
  for (const name of ["accept", "content-type", "cookie", "idempotency-key"]) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  headers.set("origin", new URL(request.url).origin);
  headers.set("x-agent-client-ip", "unknown-source");
  headers.set("x-request-id", requestId);
  return headers;
}

function safeProxyValue(value: string, secrets: readonly string[]) {
  return secrets.reduce(
    (safe, secret) => secret ? safe.replaceAll(secret, "[redacted]") : safe,
    value,
  );
}

async function feedbackJsonResponse(
  upstream: Response,
  route: NonNullable<ReturnType<typeof findHttpContract>>,
  requestId: string,
  secrets: readonly string[],
  signal: AbortSignal,
) {
  if (
    !/^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|$)/i.test(
      upstream.headers.get("content-type") ?? "",
    )
  ) {
    cancelBody(upstream);
    return jsonError(
      502,
      "AGENT_SERVICE_INVALID_RESPONSE",
      "Agent Service returned an invalid response",
      requestId,
    );
  }

  let bytes: Uint8Array;
  try {
    bytes = await readLimitedBytes(upstream, MAX_FEEDBACK_JSON_BYTES, signal);
  } catch (error) {
    if (signal.aborted) {
      return jsonError(
        504,
        "AGENT_SERVICE_TIMEOUT",
        "Agent Service request timed out",
        requestId,
      );
    }
    return jsonError(
      502,
      error instanceof RangeError
        ? "AGENT_SERVICE_RESPONSE_TOO_LARGE"
        : "AGENT_SERVICE_INVALID_RESPONSE",
      error instanceof RangeError
        ? "Agent Service response exceeded the size limit"
        : "Agent Service returned an invalid response",
      requestId,
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return jsonError(
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
    return jsonError(
      502,
      "AGENT_SERVICE_UPSTREAM_ERROR",
      "Agent Service failed to process the request",
      requestId,
    );
  }
  if (upstream.status >= 400) {
    const parsed = ApiErrorResponseSchema.safeParse(body);
    if (!parsed.success) {
      return jsonError(
        502,
        "AGENT_SERVICE_INVALID_RESPONSE",
        "Agent Service returned an invalid error response",
        requestId,
      );
    }
    return jsonError(
      upstream.status,
      parsed.data.error.code,
      safeProxyValue(parsed.data.error.message, secrets),
      requestId,
    );
  }

  const parsed = route.response.safeParse(body);
  if (!parsed.success) {
    return jsonError(
      502,
      "AGENT_SERVICE_INVALID_RESPONSE",
      "Agent Service response did not match its contract",
      requestId,
    );
  }
  return new Response(JSON.stringify(parsed.data), {
    status: upstream.status,
    headers: {
      "content-type": "application/json",
      "x-request-id": requestId,
    },
  });
}

async function proxyFeedbackTransfer(
  request: Request,
  pathWithSearch: string,
  route: NonNullable<ReturnType<typeof findHttpContract>>,
  requestId: string,
  multipart: boolean,
  options: FeedbackTransferOptions,
) {
  const config = feedbackServiceConfig(options.env ?? process.env);
  if (!config) {
    return jsonError(
      503,
      "CONFIGURATION_ERROR",
      "Agent Service is not configured",
      requestId,
    );
  }

  let body: ArrayBuffer | undefined;
  if (multipart) {
    const bytes = await readBoundedRequest(
      request,
      MAX_FEEDBACK_MULTIPART_BYTES,
    );
    if (!bytes) {
      return jsonError(
        413,
        "VALIDATION_ERROR",
        "Request body exceeded the size limit",
        requestId,
      );
    }
    body = requestBody(bytes);
  }

  const headers = feedbackTransferHeaders(request, requestId);
  headers.set("x-agent-proxy-token", config.proxyToken);
  const controller = new AbortController();
  const timeoutSignal = Symbol("feedback transfer timeout");
  let resolveTimeout!: (value: typeof timeoutSignal) => void;
  const deadline = new Promise<typeof timeoutSignal>((resolve) => {
    resolveTimeout = resolve;
  });
  const timeout = setTimeout(() => {
    controller.abort();
    resolveTimeout(timeoutSignal);
  }, options.timeoutMs ?? DEFAULT_FEEDBACK_TRANSFER_TIMEOUT_MS);
  let upstream: Response;
  try {
    try {
      const fetchResult = await Promise.race([
        (options.fetchImplementation ?? fetch)(
          `${config.internalUrl}${pathWithSearch}`,
          {
            method: request.method,
            headers,
            body,
            signal: controller.signal,
            redirect: "error",
          },
        ),
        deadline,
      ]);
      if (fetchResult === timeoutSignal) {
        return jsonError(
          504,
          "AGENT_SERVICE_TIMEOUT",
          "Agent Service request timed out",
          requestId,
        );
      }
      upstream = fetchResult;
    } catch {
      return controller.signal.aborted
        ? jsonError(
            504,
            "AGENT_SERVICE_TIMEOUT",
            "Agent Service request timed out",
            requestId,
          )
        : jsonError(
            502,
            "AGENT_SERVICE_UNAVAILABLE",
            "Agent Service is unavailable",
            requestId,
          );
    }

    const secrets = [config.internalUrl, config.proxyToken];
    if (upstream.status < 200 || upstream.status >= 300) {
      return await feedbackJsonResponse(
        upstream,
        route,
        requestId,
        secrets,
        controller.signal,
      );
    }
    if (multipart) {
      return await feedbackJsonResponse(
        upstream,
        route,
        requestId,
        secrets,
        controller.signal,
      );
    }

    const mediaType = upstream.headers.get("content-type")?.trim().toLowerCase();
    if (
      mediaType !== "image/png" &&
      mediaType !== "image/jpeg" &&
      mediaType !== "image/webp"
    ) {
      cancelBody(upstream);
      return jsonError(
        502,
        "AGENT_SERVICE_INVALID_RESPONSE",
        "Agent Service returned an invalid response",
        requestId,
      );
    }
    let bytes: Uint8Array;
    try {
      bytes = await readLimitedBytes(
        upstream,
        MAX_FEEDBACK_ATTACHMENT_BYTES,
        controller.signal,
      );
    } catch (error) {
      if (controller.signal.aborted) {
        return jsonError(
          504,
          "AGENT_SERVICE_TIMEOUT",
          "Agent Service request timed out",
          requestId,
        );
      }
      return jsonError(
        502,
        error instanceof RangeError
          ? "AGENT_SERVICE_RESPONSE_TOO_LARGE"
          : "AGENT_SERVICE_INVALID_RESPONSE",
        error instanceof RangeError
          ? "Agent Service response exceeded the size limit"
          : "Agent Service returned an invalid response",
        requestId,
      );
    }
    if (!route.response.safeParse(bytes).success) {
      return jsonError(
        502,
        "AGENT_SERVICE_INVALID_RESPONSE",
        "Agent Service returned an invalid response",
        requestId,
      );
    }

    const responseHeaders = new Headers({
      "cache-control": "private, max-age=300, no-transform",
      "content-length": String(bytes.byteLength),
      "content-type": mediaType,
      "x-content-type-options": "nosniff",
      "x-request-id": requestId,
    });
    const disposition = upstream.headers.get("content-disposition");
    if (disposition && /^inline; filename="[^"\r\n]{1,255}"$/i.test(disposition)) {
      responseHeaders.set("content-disposition", disposition);
    }
    return new Response(requestBody(bytes), {
      status: upstream.status,
      headers: responseHeaders,
    });
  } finally {
    clearTimeout(timeout);
  }
}

export async function proxyAgentRequest(
  request: Request,
  context: RouteContext,
  client: AgentServiceClient = createAgentServiceClient(),
  feedbackTransferOptions: FeedbackTransferOptions = {},
) {
  const requestId = normalizeRequestId(
    request.headers.get("x-request-id"),
    randomUUID,
  );
  const { path: segments } = await context.params;
  const requestUrl = new URL(request.url);
  const path = `/${segments.join("/")}`;
  const route = findHttpContract(request.method, path);

  if (!route || !path.startsWith("/v1/")) {
    return jsonError(404, "NOT_FOUND", "Route not found", requestId);
  }

  const multipartFeedback =
    request.method === "POST" &&
    route.path === "/v1/feedback" &&
    MULTIPART_WITH_BOUNDARY.test(request.headers.get("content-type") ?? "");
  const feedbackAttachment =
    request.method === "GET" && FEEDBACK_ATTACHMENT_CONTRACTS.has(route.path);
  if (multipartFeedback || feedbackAttachment) {
    return proxyFeedbackTransfer(
      request,
      `${path}${requestUrl.search}`,
      route,
      requestId,
      multipartFeedback,
      feedbackTransferOptions,
    );
  }

  let body: string | undefined;
  if (route.request && request.method === "GET") {
    const parsedQuery = route.request.safeParse(
      Object.fromEntries(requestUrl.searchParams),
    );
    if (!parsedQuery.success) {
      return jsonError(
        400,
        "VALIDATION_ERROR",
        "Request query did not match its contract",
        requestId,
      );
    }
  } else if (route.request) {
    let rawBody: unknown = {};
    if (request.headers.get("content-length") !== "0") {
      const text = await request.text();
      if (text.length > 0) {
        try {
          rawBody = JSON.parse(text);
        } catch {
          return jsonError(
            400,
            "VALIDATION_ERROR",
            "Request body must be valid JSON",
            requestId,
          );
        }
      }
    }
    const parsedBody = route.request.safeParse(rawBody);
    if (!parsedBody.success) {
      return jsonError(
        400,
        "VALIDATION_ERROR",
        "Request body did not match its contract",
        requestId,
      );
    }
    body = JSON.stringify(parsedBody.data);
  }

  const serviceHeaders = new Headers(request.headers);
  serviceHeaders.delete("x-agent-proxy-token");
  serviceHeaders.delete("x-agent-client-ip");
  serviceHeaders.delete("x-forwarded-for");
  serviceHeaders.delete("forwarded");
  serviceHeaders.set("x-agent-client-ip", "unknown-source");
  serviceHeaders.set("origin", new URL(request.url).origin);
  const serviceRequest = {
    method: route.method,
    path: `${path}${requestUrl.search}`,
    headers: serviceHeaders,
    body,
    requestId,
  } as AgentServiceRequest;
  const result = await client(serviceRequest);

  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: result.headers,
  });
}

export async function GET(request: Request, context: RouteContext) {
  return proxyAgentRequest(request, context);
}

export async function POST(request: Request, context: RouteContext) {
  return proxyAgentRequest(request, context);
}

export async function PUT(
  request: Request,
  context: RouteContext,
  client?: AgentServiceClient,
) {
  return proxyAgentRequest(request, context, client);
}

export async function PATCH(
  request: Request,
  context: RouteContext,
  client?: AgentServiceClient,
) {
  return proxyAgentRequest(request, context, client);
}

export async function DELETE(
  request: Request,
  context: RouteContext,
  client?: AgentServiceClient,
) {
  return proxyAgentRequest(request, context, client);
}
