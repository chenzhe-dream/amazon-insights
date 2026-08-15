import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";

import {
  LocalVocSubmissionRequestSchema,
  LocalVocSubmissionResponseSchema,
} from "../../shared/agent-contracts";
import type { SqliteAgentRepository } from "../db/sqlite-repository";
import { RepositoryVocSourceReader } from "../data/repository-voc-source";
import type { AnalysisExecutionContext } from "../services/analysis-run-service";
import { ContractRouteError } from "./analysis-runs";

export interface VocSubmissionRuntimeCapability {
  readonly available: boolean;
  readonly reason: string | null;
}

export function registerLocalVocRoute(
  app: FastifyInstance,
  repository: SqliteAgentRepository | null,
  context: AnalysisExecutionContext | null,
  runtime: VocSubmissionRuntimeCapability | null,
) {
  app.post("/v1/local-voc", async (request) => {
    if (!repository || !context) {
      throw new ContractRouteError(503, "CONFIGURATION_ERROR", "Analysis lifecycle is not configured");
    }
    if (!runtime?.available) {
      throw new ContractRouteError(
        503,
        "CONFIGURATION_ERROR",
        runtime?.reason ?? "VOC positioning runtime is not available",
      );
    }
    const parsed = LocalVocSubmissionRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ContractRouteError(400, "VALIDATION_ERROR", "Request validation failed");
    }
    const now = new Date().toISOString();
    const source = new RepositoryVocSourceReader().read({
      marketplace: parsed.data.marketplace,
      asins: parsed.data.asins,
      dataCutoffAt: now,
    });
    if (!source.candidate) {
      throw new ContractRouteError(422, "VALIDATION_ERROR", "VOC data is unavailable for the requested ASINs");
    }
    const actor = await repository.findUserById(context.actorId);
    if (!actor) {
      await repository.createUser({
        id: context.actorId, organizationId: context.organizationId,
        email: `${context.actorId}@local.invalid`, displayName: "Local VOC operator",
        role: "admin", status: "active", createdAt: now, updatedAt: now,
      });
    }
    const projectId = randomUUID();
    const runId = randomUUID();
    const stageId = randomUUID();
    await repository.createProject({
      id: projectId, organizationId: context.organizationId, name: "Local VOC smoke",
      marketplace: "US", asins: parsed.data.asins, createdBy: context.actorId,
      createdAt: now, updatedAt: now,
    });
    await repository.createAnalysisRun({
      id: runId, projectId, mode: "existing-data", status: "running", createdBy: context.actorId,
      dataCutoffAt: source.candidate.dataCutoffAt,
      idempotencyScope: `local-voc:${context.organizationId}:${runId}`,
      idempotencyKey: runId, createdAt: now, updatedAt: now,
    });
    await repository.createRunStage({
      id: stageId, runId, stage: "voc-positioning", status: "queued", progress: 0,
      attemptCount: 0, startedAt: null, completedAt: null, lastError: null, createdAt: now, updatedAt: now,
    });
    await repository.createDataSnapshotForRun({
      actorId: context.actorId, actorOrganizationId: context.organizationId, runId,
      expectedProjectId: projectId, expectedMarketplace: "US", expectedAsins: parsed.data.asins,
      expectedRunCutoffAt: source.candidate.dataCutoffAt, candidateId: randomUUID(), createdAt: now,
      candidate: source.candidate,
    });
    await repository.enqueueJob({
      id: randomUUID(), stageId, attemptNumber: 1, maxAttempts: 3, availableAt: now, createdAt: now,
    });
    return LocalVocSubmissionResponseSchema.parse({ projectId, runId });
  });
}
