import type { FastifyInstance, FastifyRequest } from "fastify";

import {
  ConnectorCredentialListSchema,
  ConnectorCredentialRequestSchema,
  ConnectorCredentialStateSchema,
  ConnectorHealthSchema,
  ConnectorIdSchema,
} from "../../shared/agent-contracts";
import {
  ConnectorCredentialAuthorizationError,
  ConnectorCredentialConflictError,
} from "../db/repository";
import { ConnectorCredentialCipherError } from "../security/connector-credential-cipher";
import type { ConnectorCredentialService } from "../services/connector-credential-service";
import type { ConnectorProbeService } from "../services/connector-probe-service";
import type { AuthenticationService } from "../auth/authentication-service";
import { ContractRouteError } from "./analysis-runs";

export type ConnectorCredentialServiceResolver = (
  organizationId: string,
) => ConnectorCredentialService | null;

function adminPrincipal(request: FastifyRequest) {
  if (
    request.authPrincipal?.kind !== "user" ||
    request.authPrincipal.role !== "admin"
  ) {
    throw new ContractRouteError(403, "FORBIDDEN", "Request is not authorized");
  }
  return request.authPrincipal;
}

async function primaryAdminPrincipal(
  request: FastifyRequest,
  authService: AuthenticationService | null,
) {
  const principal = adminPrincipal(request);
  const user = authService
    ? await authService.findPublicUser(principal.userId)
    : null;
  if (
    !user ||
    user.organizationId !== principal.organizationId ||
    user.status !== "active" ||
    user.role !== "admin" ||
    user.email.trim().toLowerCase() !== "admin@example.com"
  ) {
    throw new ContractRouteError(403, "FORBIDDEN", "Request is not authorized");
  }
  return principal;
}

function credentialService(
  resolver: ConnectorCredentialServiceResolver | null,
  organizationId: string,
) {
  const service = resolver?.(organizationId) ?? null;
  if (!service) {
    throw new ContractRouteError(
      503,
      "CONFIGURATION_ERROR",
      "Connector credential management is not configured",
    );
  }
  return service;
}

function connectorId(value: unknown) {
  const parsed = ConnectorIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new ContractRouteError(
      400,
      "VALIDATION_ERROR",
      "Connector identifier is invalid",
    );
  }
  return parsed.data;
}

function mapCredentialError(error: unknown): never {
  if (error instanceof ConnectorCredentialAuthorizationError) {
    throw new ContractRouteError(403, "FORBIDDEN", "Request is not authorized");
  }
  if (error instanceof ConnectorCredentialConflictError) {
    throw new ContractRouteError(409, "CONFLICT", "Connector credential changed concurrently");
  }
  if (error instanceof ConnectorCredentialCipherError) {
    const invalid = error.message === "Connector credential is invalid";
    throw new ContractRouteError(
      invalid ? 400 : 503,
      invalid ? "VALIDATION_ERROR" : "CONFIGURATION_ERROR",
      invalid
        ? "Connector credential is invalid"
        : "Connector credential encryption is unavailable",
    );
  }
  throw error;
}

export function registerConnectorRoutes(
  app: FastifyInstance,
  probeService: ConnectorProbeService | null,
  credentialServiceResolver: ConnectorCredentialServiceResolver | null,
  authService: AuthenticationService | null,
) {
  app.get("/v1/connectors", async (request) => {
    const principal = adminPrincipal(request);
    const service = credentialService(
      credentialServiceResolver,
      principal.organizationId,
    );
    return ConnectorCredentialListSchema.parse({
      connectors: await service.listSafeStates(),
    });
  });

  app.put("/v1/connectors/:connectorId/credential", async (request) => {
    const principal = await primaryAdminPrincipal(request, authService);
    const id = connectorId(
      (request.params as { connectorId?: unknown }).connectorId,
    );
    const parsed = ConnectorCredentialRequestSchema.safeParse(request.body);
    if (!parsed.success) {
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
    try {
      const service = credentialService(
        credentialServiceResolver,
        principal.organizationId,
      );
      const current = await service.getSafeState(id);
      if (
        current.source === "environment"
        && parsed.data.confirmEnvironmentReplacement !== true
      ) {
        throw new ContractRouteError(
          400,
          "VALIDATION_ERROR",
          "Explicit environment credential replacement confirmation is required",
        );
      }
      return ConnectorCredentialStateSchema.parse(
        await service.rotate({
          connector: id,
          secret: parsed.data.secret,
          actorUserId: principal.userId,
        }),
      );
    } catch (error) {
      mapCredentialError(error);
    }
  });

  app.delete("/v1/connectors/:connectorId/credential", async (request) => {
    const principal = await primaryAdminPrincipal(request, authService);
    const id = connectorId(
      (request.params as { connectorId?: unknown }).connectorId,
    );
    try {
      return ConnectorCredentialStateSchema.parse(
        await credentialService(
          credentialServiceResolver,
          principal.organizationId,
        ).revoke({ connector: id, actorUserId: principal.userId }),
      );
    } catch (error) {
      mapCredentialError(error);
    }
  });

  app.post("/v1/connectors/:connectorId/probe", async (request) => {
    const principal = await primaryAdminPrincipal(request, authService);
    const id = connectorId(
      (request.params as { connectorId?: unknown }).connectorId,
    );
    if (!probeService) {
      throw new ContractRouteError(
        503,
        "CONFIGURATION_ERROR",
        "Connector health probing is not configured",
      );
    }
    return ConnectorHealthSchema.parse(await probeService.probe(id, {
      organizationId: principal.organizationId,
      actorId: principal.userId,
    }));
  });
}
