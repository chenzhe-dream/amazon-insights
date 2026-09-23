import type {
  ApiErrorCode,
  LegacyProjectEligibilityResponse,
} from "../../shared/agent-contracts";
import { EntityIdSchema } from "../../shared/agent-contracts";
import type { RequestPrincipal } from "../auth/authorization";
import {
  LegacyProjectOwnerBindingError,
  type AgentRepository,
  type BindLegacyProjectOwnerResult,
  type LegacyProjectOwnerBindingRecord,
} from "../db/repository";

export class LegacyProjectOwnershipServiceError extends Error {
  constructor(
    readonly statusCode: 400 | 403 | 404 | 409 | 503,
    readonly apiErrorCode: ApiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LegacyProjectOwnershipServiceError";
  }
}

export class LegacyProjectOwnershipService {
  constructor(
    private readonly repository: AgentRepository,
    private readonly readLegacyProject: (legacyProjectId: string) => unknown = () => null,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async getEligibility(input: Readonly<{
    principal: RequestPrincipal;
    legacyProjectId: string;
  }>): Promise<LegacyProjectEligibilityResponse> {
    const project = this.readLegacyProject(input.legacyProjectId);
    if (input.principal.kind !== "user" || !project || typeof project !== "object") {
      throw notFound();
    }
    if (!("id" in project) || project.id !== input.legacyProjectId) throw notFound();
    const createdBy = "createdBy" in project ? project.createdBy : null;
    const creatorId = EntityIdSchema.safeParse(createdBy);
    const find = this.repository.findLegacyProjectOwnerBinding;
    const binding = find ? await find.call(this.repository, input.legacyProjectId) : null;
    if (binding && (
      binding.legacyProjectId !== input.legacyProjectId
      || binding.organizationId !== input.principal.organizationId
      || binding.ownerUserId !== input.principal.userId
      || (creatorId.success && creatorId.data !== binding.ownerUserId)
    )) throw notFound();
    const ownerId = binding?.ownerUserId ?? (creatorId.success ? creatorId.data : null);
    if (ownerId !== input.principal.userId) throw notFound();
    const owner = await this.repository.findUserById(ownerId);
    if (!owner || owner.status !== "active" || owner.organizationId !== input.principal.organizationId) {
      throw notFound();
    }
    return {
      legacyProjectId: input.legacyProjectId,
      readOnly: true,
      importAllowed: true,
    };
  }

  async bindOnce(input: Readonly<{
    principal: RequestPrincipal;
    legacyProjectId: string;
    ownerUserId: string;
  }>): Promise<BindLegacyProjectOwnerResult> {
    if (input.principal.kind !== "user" || input.principal.role !== "admin") {
      throw new LegacyProjectOwnershipServiceError(403, "FORBIDDEN", "Operator access is required");
    }
    const bind = this.repository.bindLegacyProjectOwnerOnce;
    if (!bind) {
      throw new LegacyProjectOwnershipServiceError(
        503,
        "CONFIGURATION_ERROR",
        "Legacy project ownership is not configured",
      );
    }
    try {
      return await bind.call(this.repository, {
        legacyProjectId: input.legacyProjectId,
        organizationId: input.principal.organizationId,
        ownerUserId: input.ownerUserId,
        operatorUserId: input.principal.userId,
        boundAt: this.now(),
      });
    } catch (error) {
      if (error instanceof LegacyProjectOwnerBindingError) {
        throw new LegacyProjectOwnershipServiceError(409, "CONFLICT", error.message);
      }
      throw error;
    }
  }

  async findOwnedBinding(input: Readonly<{
    principal: RequestPrincipal;
    legacyProjectId: string;
  }>): Promise<LegacyProjectOwnerBindingRecord | null> {
    if (input.principal.kind !== "user") return null;
    const find = this.repository.findLegacyProjectOwnerBinding;
    if (!find) return null;
    const binding = await find.call(this.repository, input.legacyProjectId);
    if (
      !binding ||
      binding.organizationId !== input.principal.organizationId ||
      binding.ownerUserId !== input.principal.userId
    ) {
      return null;
    }
    return binding;
  }
}

function notFound(): LegacyProjectOwnershipServiceError {
  return new LegacyProjectOwnershipServiceError(404, "NOT_FOUND", "Legacy project not found");
}
