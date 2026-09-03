import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  EntityIdSchema,
  LegacyProjectEligibilityResponseSchema,
  LegacyProjectIdParamsSchema,
} from "../../shared/agent-contracts";
import type { AgentRepository } from "../db/repository";
import {
  LegacyProjectOwnershipService,
  LegacyProjectOwnershipServiceError,
} from "../services/legacy-project-ownership-service";

const AdminLegacyProjectIdParamsSchema = z.strictObject({
  projectId: z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/),
});
const BindLegacyProjectOwnerRequestSchema = z.strictObject({
  ownerUserId: EntityIdSchema,
});

export function registerLegacyProjectOwnershipRoutes(
  app: FastifyInstance,
  repository: AgentRepository | null,
  readLegacyProject: (legacyProjectId: string) => unknown = () => null,
): void {
  app.get("/v1/legacy-projects/:legacyProjectId/eligibility", async (request) => {
    const params = parseRequest(LegacyProjectIdParamsSchema, request.params);
    if (!repository || !request.authPrincipal) {
      throw new LegacyProjectOwnershipServiceError(
        503,
        "CONFIGURATION_ERROR",
        "Legacy project ownership is not configured",
      );
    }
    return LegacyProjectEligibilityResponseSchema.parse(
      await new LegacyProjectOwnershipService(repository, readLegacyProject).getEligibility({
        principal: request.authPrincipal,
        legacyProjectId: params.legacyProjectId,
      }),
    );
  });

  app.post("/v1/admin/legacy-project-ownership/:projectId", async (request, reply) => {
    const params = parseRequest(AdminLegacyProjectIdParamsSchema, request.params);
    const body = parseRequest(BindLegacyProjectOwnerRequestSchema, request.body);
    if (!repository || !request.authPrincipal) {
      throw new LegacyProjectOwnershipServiceError(
        503,
        "CONFIGURATION_ERROR",
        "Legacy project ownership is not configured",
      );
    }
    const result = await new LegacyProjectOwnershipService(repository).bindOnce({
      principal: request.authPrincipal,
      legacyProjectId: params.projectId,
      ownerUserId: body.ownerUserId,
    });
    reply.status(result.created ? 201 : 200);
    return result;
  });
}

function parseRequest<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new LegacyProjectOwnershipServiceError(
    400,
    "VALIDATION_ERROR",
    "Request validation failed",
  );
}
