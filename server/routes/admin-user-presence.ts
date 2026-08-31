import type { FastifyInstance, FastifyRequest } from "fastify";

import {
  ActivityRequestSchema,
  ActivityResponseSchema,
} from "../../shared/agent-contracts";
import type { AuthenticatedPrincipal } from "../auth/authentication-service";
import type { AdminUserPresenceRepository } from "../db/admin-user-presence-repository";
import { AdminUserPresenceService } from "../services/admin-user-presence-service";
import { ContractRouteError } from "./analysis-runs";

function userPrincipal(request: FastifyRequest): AuthenticatedPrincipal {
  if (request.authPrincipal?.kind === "user") return request.authPrincipal;
  throw new ContractRouteError(
    401,
    "AUTHENTICATION_REQUIRED",
    "Authentication is required",
  );
}

function repositoryOrThrow(
  repository: AdminUserPresenceRepository | null,
): AdminUserPresenceRepository {
  if (repository) return repository;
  throw new ContractRouteError(
    503,
    "CONFIGURATION_ERROR",
    "User presence is not configured",
  );
}

function parseActivityRequest(body: unknown): void {
  if (ActivityRequestSchema.safeParse(body).success) return;
  throw new ContractRouteError(
    400,
    "VALIDATION_ERROR",
    "Request validation failed",
  );
}

export function registerAdminUserPresenceRoutes(
  app: FastifyInstance,
  repository: AdminUserPresenceRepository | null,
  clock: () => Date = () => new Date(),
) {
  app.get("/v1/admin/users", async (request) => {
    const principal = userPrincipal(request);
    const asOf = clock();
    const asOfIso = asOf.toISOString();
    const result = await repositoryOrThrow(repository).listOrganizationUsers({
      organizationId: principal.organizationId,
      asOf: asOfIso,
    });
    return new AdminUserPresenceService({ asOf: () => asOf }).list(result.users);
  });

  app.post("/v1/auth/activity", async (request) => {
    const principal = userPrincipal(request);
    parseActivityRequest(request.body === undefined ? {} : request.body);
    const result = await repositoryOrThrow(repository).recordHeartbeat({
      organizationId: principal.organizationId,
      userId: principal.userId,
      sessionId: principal.sessionId,
      asOf: clock().toISOString(),
    });
    if (result === "inactive") {
      throw new ContractRouteError(
        401,
        "AUTHENTICATION_REQUIRED",
        "Authentication is required",
      );
    }
    if (result === "recorded" || result === "throttled") {
      return ActivityResponseSchema.parse({ ok: true });
    }
    throw new Error("Unexpected user presence heartbeat result");
  });
}
