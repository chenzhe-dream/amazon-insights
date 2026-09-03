import type { FastifyInstance, FastifyRequest } from "fastify";

import {
  ConcurrencyAdminResponseSchema,
  ConcurrencyPauseRequestSchema,
  ConcurrencyPolicyUpdateRequestSchema,
  ConnectorCircuitResetParamsSchema,
  SellerSpriteQuotaTotalRequestSchema,
  type User,
} from "../../shared/agent-contracts";
import type { AuthenticationService } from "../auth/authentication-service";
import type { ConcurrencyAdminService } from "../services/seller-sprite-quota-service";
import { ContractRouteError } from "./analysis-runs";

function adminPrincipal(request: FastifyRequest) {
  if (
    request.authPrincipal?.kind !== "user" ||
    request.authPrincipal.role !== "admin"
  ) {
    throw new ContractRouteError(403, "FORBIDDEN", "Request is not authorized");
  }
  return request.authPrincipal;
}

function parseBody<T>(
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } } },
  body: unknown,
): T {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  throw new ContractRouteError(
    400,
    "VALIDATION_ERROR",
    "Request validation failed",
    parsed.error.issues.map((issue) => ({
      path: issue.path.length > 0 ? issue.path.join(".") : "request",
      message: issue.message,
    })),
  );
}

async function requirePrimaryAdmin(
  request: FastifyRequest,
  authService: AuthenticationService | null,
): Promise<{ organizationId: string; actorUserId: string }> {
  const principal = adminPrincipal(request);
  const user = authService
    ? await authService.findPublicUser(principal.userId)
    : null;
  if (!isPrimaryAdminUser(user) || user.organizationId !== principal.organizationId) {
    throw new ContractRouteError(403, "FORBIDDEN", "Request is not authorized");
  }
  return {
    organizationId: principal.organizationId,
    actorUserId: principal.userId,
  };
}

function isPrimaryAdminUser(user: User | null): user is User {
  return Boolean(
    user &&
      user.status === "active" &&
      user.role === "admin" &&
      user.email.trim().toLowerCase() === "admin@example.com",
  );
}

function serviceOrThrow(service: ConcurrencyAdminService | null) {
  if (!service) {
    throw new ContractRouteError(
      503,
      "CONFIGURATION_ERROR",
      "Concurrency administration is not configured",
    );
  }
  return service;
}

export function registerConcurrencyAdminRoutes(
  app: FastifyInstance,
  service: ConcurrencyAdminService | null,
  authService: AuthenticationService | null,
) {
  app.get("/v1/admin/concurrency", async (request) => {
    const principal = adminPrincipal(request);
    return ConcurrencyAdminResponseSchema.parse(
      await serviceOrThrow(service).read({
        organizationId: principal.organizationId,
      }),
    );
  });

  app.put("/v1/admin/concurrency/policy", async (request) => {
    const primary = await requirePrimaryAdmin(request, authService);
    const candidate = request.body && typeof request.body === "object"
      ? { profile: (request.body as { profile?: unknown }).profile }
      : request.body;
    const body = parseBody(ConcurrencyPolicyUpdateRequestSchema, candidate);
    return ConcurrencyAdminResponseSchema.parse(
      await serviceOrThrow(service).setPolicy({
        ...primary,
        profile: body.profile,
      }),
    );
  });

  app.put("/v1/admin/seller-sprite/quota/total", async (request) => {
    const primary = await requirePrimaryAdmin(request, authService);
    const body = parseBody(SellerSpriteQuotaTotalRequestSchema, request.body);
    return ConcurrencyAdminResponseSchema.parse(
      await serviceOrThrow(service).setManualTotal({
        ...primary,
        total: body.total,
      }),
    );
  });

  app.post("/v1/admin/seller-sprite/quota/refresh", async (request) => {
    const primary = await requirePrimaryAdmin(request, authService);
    return ConcurrencyAdminResponseSchema.parse(
      await serviceOrThrow(service).refreshQuota(primary),
    );
  });

  app.post("/v1/admin/concurrency/pause", async (request) => {
    const primary = await requirePrimaryAdmin(request, authService);
    const body = parseBody(ConcurrencyPauseRequestSchema, request.body);
    return ConcurrencyAdminResponseSchema.parse(
      await serviceOrThrow(service).setPause({
        ...primary,
        resource: body.resource,
        paused: body.paused,
      }),
    );
  });

  app.post("/v1/admin/connectors/:connectorId/circuit/reset", async (request) => {
    const primary = await requirePrimaryAdmin(request, authService);
    const params = parseBody(ConnectorCircuitResetParamsSchema, request.params);
    return ConcurrencyAdminResponseSchema.parse(
      await serviceOrThrow(service).resetCircuit({
        ...primary,
        connectorId: params.connectorId,
      }),
    );
  });
}
