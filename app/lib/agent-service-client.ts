import "server-only";

import { randomUUID } from "node:crypto";

import { z } from "zod";
import { ADMIN_READ_WRITE_ROUTES } from '../../shared/admin-request-timing';
import {MARKET_SERVICE_ERROR_MESSAGES,type MarketServiceErrorCode} from '../../shared/market-service-errors';

import {
  ApiErrorResponseSchema,
  AlexaVocNormalizationStatusQuerySchema,
  AlexaVocNormalizationStatusResponseSchema,
  findHttpContract,
  normalizeRequestId,
  v1Contracts,
  type ApiErrorCode,
  type ApiErrorResponse,
  type AlexaVocNormalizationStatusResponse,
  type ProjectableSyncStage,
  type StageName,
} from "../../shared/agent-contracts";

type AgentServiceEnvironment = Readonly<Record<string, string | undefined>>;

type AgentServiceRouteRequest =
  | { method: 'POST'; path: `/v1/runs/${string}/traffic-details/refresh` }
  | { method: "GET"; path: "/v1/capabilities" }
  | { method: "GET"; path: "/v1/connectors" }
  | {
      method: "PUT" | "DELETE";
      path: `/v1/connectors/${string}/credential`;
    }
  | { method: "GET"; path: "/v1/auth/session" }
  | { method: "GET"; path: "/v1/auth/dingtalk/config" }
  | { method: "POST"; path: "/v1/auth/login" | "/v1/auth/logout" }
  | {
      method: "POST";
      path:
        | "/v1/auth/dingtalk/workbench"
        | "/v1/auth/dingtalk/oauth/start"
        | "/v1/auth/dingtalk/oauth/callback";
    }
  | { method: "POST"; path: "/v1/auth/password" | "/v1/feedback" }
  | { method: "POST"; path: "/v1/projects" }
  | { method: "POST"; path: `/v1/projects/${string}/selling-point-translations/${string}` }
  | { method: "GET"; path: `/v1/projects/${string}/selling-point-translations/${string}` | `/v1/projects/${string}/selling-point-translations/${string}?${string}` }
  | { method: "GET"; path: `/v1/projects/${string}` }
  | { method: "POST"; path: `/v1/projects/${string}/runs` }
  | { method: "GET"; path: `/v1/runs/${string}` }
  | { method: "POST"; path: `/v1/runs/${string}/cancel` }
  | {
      method: "POST";
      path: `/v1/runs/${string}/stages/${StageName}/retry`;
    }
  | { method: "GET"; path: `/v1/runs/${string}/reports` }
  | { method: "POST"; path: `/v1/runs/${string}/voc-import` }
  | { method: "POST"; path: "/v1/manual-alexa-voc/import" }
  | {
      method: "GET";
      path: "/v1/manual-alexa-voc" | `/v1/manual-alexa-voc?${string}`;
    }
  | { method: "GET"; path: `/v1/manual-alexa-voc/normalization-status?${string}` }
  | { method: "GET"; path: `/v1/reports/${string}` }
  | { method: "POST"; path: "/v1/local-voc" }
  | { method: "GET" | "POST"; path: "/v1/local-data/projects" | `/v1/local-data/projects?${string}` }
  | { method: "GET" | "PATCH" | "DELETE"; path: `/v1/local-data/projects/${string}` }
  | { method: "GET" | "POST"; path: "/v1/local-data/sync-asins" | `/v1/local-data/sync-asins?${string}` }
  | { method: "GET"; path: `/v1/local-data/sync-asins/${string}` }
  | { method: "GET"; path: `/v1/projects/${string}/runs/${string}/sync-jobs/${string}/stages/${ProjectableSyncStage}/output` };

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

export async function getAlexaVocNormalizationStatus(input: Readonly<{
  client: AgentServiceClient;
  marketplace: import("../../shared/project-marketplaces").ProjectMarketplace;
  projectId: string;
  runId: string;
  asins: readonly string[];
  headers?: HeadersInit;
  requestId?: string;
}>): Promise<AgentServiceResult<AlexaVocNormalizationStatusResponse>> {
  const query = AlexaVocNormalizationStatusQuerySchema.parse({
    projectId: input.projectId,
    runId: input.runId,
    marketplace: input.marketplace,
    asins: input.asins,
  });
  const params = new URLSearchParams({ projectId: query.projectId, runId: query.runId, marketplace: query.marketplace });
  for (const asin of query.asins) params.append("asins", asin);
  const result = await input.client({
    method: "GET",
    path: `/v1/manual-alexa-voc/normalization-status?${params.toString()}`,
    headers: input.headers,
    requestId: input.requestId,
  });
  if (result.status < 200 || result.status >= 300) return result as AgentServiceResult<AlexaVocNormalizationStatusResponse>;
  const parsed = AlexaVocNormalizationStatusResponseSchema.safeParse(result.body);
  if (!parsed.success) {
    const requestId = result.headers.get("x-request-id") ?? normalizeRequestId(input.requestId, randomUUID);
    return errorResult(502, "AGENT_SERVICE_INVALID_RESPONSE", "Agent Service returned an invalid response", requestId);
  }
  return { ...result, body: parsed.data };
}

interface CreateAgentServiceClientOptions {
  env?: AgentServiceEnvironment;
  fetchImplementation?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
  onTiming?: (record: AdminProxyTiming) => void;
}

type AdminProxyTiming={event:'admin-proxy-timing';requestId:string;route:string;method:string;phase:string;timedOut:boolean;upstreamStatus:number|null;headersMs:number|null;bodyMs:number|null;totalMs:number;deadlineMs:number};

const DEFAULT_TIMEOUT_MS = 10_000;
export function agentRequestTimeoutMs(contractPath: string, override?: number) {
  return override ?? (contractPath === '/v1/market-analysis/shape-price/resolve-category' ? 65_000 : ADMIN_READ_WRITE_ROUTES.has(contractPath) || SHAPE_REPORT_PATHS.has(contractPath) ? 60_000 : contractPath === '/v1/runs/:runId/traffic-details/refresh' ? 55_000 : DEFAULT_TIMEOUT_MS);
}
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;
// Overview responses include evidence-backed rule baselines and saved versions.
// A real single-month run exceeds 1 MiB; give only these contracts a bounded
// report budget, keeping the default and explicit caller limits unchanged.
const OVERVIEW_MAX_RESPONSE_BYTES = 8 * DEFAULT_MAX_RESPONSE_BYTES;
// A 100-keyword report includes verified monthly history and rule evidence.
// Apply the existing bounded report budget only to its result-bearing routes.
const KEYWORD_REPORT_ROUTES = new Set([
  'POST /v1/market-analysis/keywords/query',
  'POST /v1/market-analysis/studies/:id/keywords',
  'GET /v1/market-analysis/runs/:id/keywords',
  'POST /v1/market-analysis/runs/:id/keywords/revisions',
  'GET /v1/market-analysis/runs/:id/keywords/revisions/:revisionId',
]);
const THEME_QUERY_REPORT_ROUTES = new Set(['POST /v1/market-analysis/customer-themes/query']);
const SHAPE_REPORT_ROUTES = new Set([
 'POST /v1/market-analysis/shape-price/query',
 'POST /v1/market-analysis/studies/:id/shape-price',
 'GET /v1/market-analysis/runs/:id/shape-price',
 'POST /v1/market-analysis/runs/:id/shape-price/revisions',
 'GET /v1/market-analysis/runs/:id/shape-price/revisions/:revisionId',
]);
// Restoring a 300-product report verifies persisted history/image snapshots.
// Bound these database-only reads and revision captures separately from small APIs.
const SHAPE_REPORT_PATHS = new Set([...SHAPE_REPORT_ROUTES].map(route => route.slice(route.indexOf(' ') + 1)));
const OVERVIEW_REPORT_ROUTES = new Set([
  'POST /v1/market-analysis/studies/:id/overview',
  'GET /v1/market-analysis/runs/:id/overview',
  'GET /v1/market-analysis/runs/:id/reports/:attemptId/overview',
]);

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
    "origin",
    "x-agent-client-ip",
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

function splitServicePath(path: string) {
  const parsed = new URL(path, "http://agent-service.local");
  const normalized = `${parsed.pathname}${parsed.search}`;
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    parsed.origin !== "http://agent-service.local" ||
    normalized !== path
  ) {
    return null;
  }
  return {
    pathname: parsed.pathname,
    pathWithSearch: normalized,
  };
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

  return async (
    request: AgentServiceRequest,
  ): Promise<AgentServiceResult<AgentServiceSuccessResponse>> => {
    const requestId = normalizeRequestId(request.requestId, randomUUID);
    let config: ReturnType<typeof loadServiceConfig>;

    try {
      config = loadServiceConfig(env);
    } catch {
      return errorResult(
        503,
        "CONFIGURATION_ERROR",
        "Agent Service is not configured",
        requestId,
      );
    }

    const servicePath = splitServicePath(request.path);
    const contract = servicePath
      ? findHttpContract(request.method, servicePath.pathname)
      : undefined;
    if (!contract || !servicePath?.pathname.startsWith("/v1/")) {
      return errorResult(
        502,
        "AGENT_SERVICE_INVALID_RESPONSE",
        "Agent Service request path is invalid",
        requestId,
      );
    }

    const maxResponseBytes = options.maxResponseBytes ?? (
      (THEME_QUERY_REPORT_ROUTES.has(`${request.method} ${contract.path}`)||OVERVIEW_REPORT_ROUTES.has(`${request.method} ${contract.path}`)||SHAPE_REPORT_ROUTES.has(`${request.method} ${contract.path}`)||KEYWORD_REPORT_ROUTES.has(`${request.method} ${contract.path}`))
        ? OVERVIEW_MAX_RESPONSE_BYTES : DEFAULT_MAX_RESPONSE_BYTES
    );
    const secrets = [config.internalUrl, config.proxyToken];
    const headers = copyRequestHeaders(request.headers);
    if (request.body == null) {
      headers.delete("content-type");
    } else if (request.method === "POST" || request.method === "PUT") {
      headers.set("content-type", "application/json");
    }
    headers.set("x-agent-proxy-token", config.proxyToken);
    headers.set("x-request-id", requestId);
    const controller = new AbortController();
    const started=performance.now(),deadlineMs=agentRequestTimeoutMs(contract.path, options.timeoutMs);
    let phase='awaiting-headers',headersMs:number|null=null,bodyMs:number|null=null,upstreamStatus:number|null=null;
    const timeout = setTimeout(() => controller.abort(), deadlineMs);
    let upstream: Response;

    try {
      try {
        upstream = await fetchImplementation(
          `${config.internalUrl}${servicePath.pathWithSearch}`,
          {
            method: request.method,
            headers,
            body: request.method === "GET" ? undefined : request.body,
            signal: controller.signal,
            redirect: "error",
          },
        );
        headersMs=Math.round(performance.now()-started);upstreamStatus=upstream.status;phase='reading-body';
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

      if (upstream.status === 204 && request.method === "DELETE" && /^\/v1\/market-research\/favorites\/[a-f0-9-]+$/i.test(new URL(request.path,"http://local").pathname)) {
        const headers=copyResponseHeaders(upstream.headers,requestId,secrets);
        headers.delete("content-type");
        return {status:204,headers,body:undefined};
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
        bodyMs=Math.round(performance.now()-started)-(headersMs??0);phase='validation';
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

      if (upstream.status === 503 && request.path.startsWith('/v1/market-analysis/')) {
        const parsed = ApiErrorResponseSchema.safeParse(body);
        if (parsed.success && Object.hasOwn(MARKET_SERVICE_ERROR_MESSAGES,parsed.data.error.code)) {
          const code=parsed.data.error.code as MarketServiceErrorCode;
          return errorResult(503,code,MARKET_SERVICE_ERROR_MESSAGES[code],requestId);
        }
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
      phase='complete';

      return {
        status: upstream.status,
        headers: copyResponseHeaders(upstream.headers, requestId, secrets),
        body: body as AgentServiceSuccessResponse,
      };
    } finally {
      clearTimeout(timeout);
      if(ADMIN_READ_WRITE_ROUTES.has(contract.path)){
        const record:AdminProxyTiming={event:'admin-proxy-timing',requestId,route:contract.path,method:request.method,phase,timedOut:controller.signal.aborted,upstreamStatus,headersMs,bodyMs,totalMs:Math.round(performance.now()-started),deadlineMs};
        try{if(options.onTiming)options.onTiming(record);else console.info(JSON.stringify(record));}catch{/* Diagnostics must not change the response. */}
      }
    }
  };
}
