import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";

import {
  LocalVocImportRequestSchema,
  LocalVocImportResponseSchema,
  LocalVocSubmissionRequestSchema,
  LocalVocSubmissionResponseSchema,
  RunIdParamsSchema,
} from "../../shared/agent-contracts";
import {
  DataSnapshotConflictError,
  DataSnapshotCutoffConflictError,
  DataSnapshotDataError,
  DataSnapshotSubjectNotFoundError,
} from "../db/data-snapshot-repository";
import type { RuntimeAgentRepository } from "../db/repository";
import { ManualAlexaVocRepositoryError } from "../db/manual-alexa-voc-repository";
import { RepositoryVocSourceReader } from "../data/repository-voc-source";
import {
  assertVocSnapshotCandidateIntegrity,
  canonicalizeVocSnapshotCandidate,
  type VocSnapshotCandidate,
} from "../data/voc-data-snapshot";
import type { AnalysisExecutionContext } from "../services/analysis-run-service";
import type { RequestPrincipal } from "../auth/authorization";
import { ContractRouteError } from "./analysis-runs";

export interface VocSubmissionRuntimeCapability {
  readonly available: boolean;
  readonly reason: string | null;
}

export function registerLocalVocRoute(
  app: FastifyInstance,
  repository: RuntimeAgentRepository | null,
  resolveContext: ((principal: RequestPrincipal) => AnalysisExecutionContext | null) | null,
  runtime: VocSubmissionRuntimeCapability | null,
) {
  app.post("/v1/local-voc", async (request) => {
    const context = request.authPrincipal && resolveContext
      ? resolveContext(request.authPrincipal)
      : null;
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
    let source;
    try {
      source = await new RepositoryVocSourceReader({
        manualVoc: repository.manualAlexaVoc,
      }).read({
        organizationId: context.organizationId,
        marketplace: parsed.data.marketplace,
        asins: parsed.data.asins,
        dataCutoffAt: now,
      });
    } catch (error) {
      if (error instanceof ManualAlexaVocRepositoryError) {
        throw new ContractRouteError(
          503,
          "INFRASTRUCTURE_ERROR",
          "Manual Alexa VOC storage is unavailable",
        );
      }
      throw error;
    }
    const candidate = source.candidate;
    if (!candidate) {
      throw new ContractRouteError(422, "VALIDATION_ERROR", "VOC data is unavailable for the requested ASINs");
    }
    const projectId = randomUUID();
    const runId = randomUUID();
    const stageId = randomUUID();
    await repository.transaction(async (transactionRepository) => {
      const scopedRepository = transactionRepository as RuntimeAgentRepository;
      const actor = await scopedRepository.findUserById(context.actorId);
      if (!actor) {
        await scopedRepository.createUser({
          id: context.actorId, organizationId: context.organizationId,
          email: `${context.actorId}@local.invalid`, displayName: "Local VOC operator",
          role: "admin", status: "active", createdAt: now, updatedAt: now,
        });
      }
      await scopedRepository.createProject({
        id: projectId, organizationId: context.organizationId, name: "Local VOC smoke",
        marketplace: "US", asins: parsed.data.asins, createdBy: context.actorId,
        createdAt: now, updatedAt: now,
      });
      await scopedRepository.createAnalysisRun({
        id: runId, projectId, mode: "existing-data", status: "running", createdBy: context.actorId,
        dataCutoffAt: candidate.dataCutoffAt,
        idempotencyScope: `local-voc:${context.organizationId}:${runId}`,
        idempotencyKey: runId, createdAt: now, updatedAt: now,
      });
      await scopedRepository.createRunStage({
        id: stageId, runId, stage: "voc-positioning", status: "queued", progress: 0,
        attemptCount: 0, startedAt: null, completedAt: null, lastError: null, createdAt: now, updatedAt: now,
      });
      await scopedRepository.createDataSnapshotForRun({
        actorId: context.actorId, actorOrganizationId: context.organizationId, runId,
        expectedProjectId: projectId, expectedMarketplace: "US", expectedAsins: parsed.data.asins,
        expectedRunCutoffAt: candidate.dataCutoffAt, candidateId: randomUUID(), createdAt: now,
        candidate,
      });
      await scopedRepository.enqueueJob({
        id: randomUUID(), stageId, attemptNumber: 1, maxAttempts: 3, availableAt: now, createdAt: now,
      });
    });
    return LocalVocSubmissionResponseSchema.parse({ projectId, runId });
  });

  app.post("/v1/runs/:runId/voc-import", async (request) => {
    const context = request.authPrincipal && resolveContext
      ? resolveContext(request.authPrincipal)
      : null;
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
    const params = RunIdParamsSchema.safeParse(request.params);
    const parsed = LocalVocImportRequestSchema.safeParse(request.body);
    if (!params.success || !parsed.success) {
      throw new ContractRouteError(400, "VALIDATION_ERROR", "VOC import validation failed");
    }

    let candidate: VocSnapshotCandidate;
    try {
      candidate = canonicalizeVocSnapshotCandidate(parsed.data.candidate);
      assertVocSnapshotCandidateIntegrity(candidate);
    } catch {
      throw new ContractRouteError(400, "VALIDATION_ERROR", "VOC import validation failed");
    }

    const importedAt = new Date().toISOString();
    try {
      return await repository.transaction(async () => {
        const actor = await repository.findUserById(context.actorId);
        if (
          !actor ||
          actor.status !== "active" ||
          actor.organizationId !== context.organizationId
        ) {
          throw new ContractRouteError(403, "FORBIDDEN", "VOC import is not authorized");
        }
        const run = await repository.findAnalysisRun(params.data.runId);
        const project = run
          ? await repository.findProjectById(run.projectId)
          : null;
        if (!run || !project || project.organizationId !== context.organizationId) {
          throw new ContractRouteError(404, "NOT_FOUND", "Analysis run not found");
        }
        const stage = (await repository.listRunStages(run.id)).find(
          (item) => item.stage === "voc-positioning",
        );
        if (!stage) {
          throw new ContractRouteError(404, "NOT_FOUND", "VOC stage not found");
        }
        if (stage.status !== "waiting-input") {
          throw new ContractRouteError(409, "CONFLICT", "VOC stage is not waiting for input");
        }

        const snapshot = await repository.createDataSnapshotForRun({
          actorId: context.actorId,
          actorOrganizationId: context.organizationId,
          runId: run.id,
          expectedProjectId: project.id,
          expectedMarketplace: project.marketplace,
          expectedAsins: project.asins,
          expectedRunCutoffAt: run.dataCutoffAt,
          candidateId: randomUUID(),
          createdAt: importedAt,
          candidate,
        });
        const resumed = await repository.resumeWaitingInputRunStage({
          runId: run.id,
          stageId: stage.id,
          resumedAt: importedAt,
        });
        if (!resumed) {
          throw new ContractRouteError(409, "CONFLICT", "VOC stage could not be resumed");
        }
        return LocalVocImportResponseSchema.parse({
          runId: run.id,
          snapshotId: snapshot.snapshot.id,
          stageId: resumed.stage.id,
          jobId: resumed.attempt.id,
          importMode: parsed.data.importMode,
        });
      });
    } catch (error) {
      if (error instanceof ContractRouteError) throw error;
      if (
        error instanceof DataSnapshotCutoffConflictError
      ) {
        throw new ContractRouteError(
          409,
          "CONFLICT",
          "VOC snapshot cutoff must match the analysis run cutoff",
        );
      }
      if (
        error instanceof DataSnapshotConflictError ||
        error instanceof DataSnapshotDataError ||
        error instanceof DataSnapshotSubjectNotFoundError
      ) {
        throw new ContractRouteError(409, "CONFLICT", "VOC import conflicts with the analysis run");
      }
      throw error;
    }
  });
}
