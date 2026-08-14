import { randomUUID } from "node:crypto";

import {
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

export async function proxyAgentRequest(
  request: Request,
  context: RouteContext,
  client: AgentServiceClient = createAgentServiceClient(),
) {
  const requestId = normalizeRequestId(
    request.headers.get("x-request-id"),
    randomUUID,
  );
  const { path: segments } = await context.params;
  const path = `/${segments.join("/")}`;
  const route = findHttpContract(request.method, path);

  if (!route || !path.startsWith("/v1/") || new URL(request.url).search) {
    return jsonError(404, "NOT_FOUND", "Route not found", requestId);
  }

  let body: string | undefined;
  if (route.request) {
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
  serviceHeaders.set("origin", new URL(request.url).origin);
  const serviceRequest = {
    method: route.method,
    path,
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
