import type { JobAttemptRecord } from "../db/repository";
import {
  ManualAlexaVocRepositoryError,
  type AlexaVocNormalizationTerminalCategory,
} from "../db/manual-alexa-voc-repository";
import { SkillRuntimeError, type ModelExecutionConfig } from "../runtime/skill-runner";
import { WorkerTaskError } from "../runtime/retry-policy";
import type { JobHandler } from "../runtime/worker-loop";
import type {
  AlexaVocNormalizationExecutionContext,
  AlexaVocNormalizationExecutionRequest,
  AlexaVocNormalizationExecutionResult,
} from "./alexa-voc-normalization-execution-service";

export interface PreparedAlexaVocNormalizationJob {
  readonly snapshots: readonly Readonly<{
    id: string;
    asin: string;
    executionFingerprint?: string;
    replay?: Readonly<{
      agentRunId: string;
      revision: string;
    }>;
  }>[];
  readonly model: ModelExecutionConfig;
  readonly context: Pick<
    AlexaVocNormalizationExecutionContext,
    "actorId" | "organizationId" | "projectId" | "dataCutoffAt"
  >;
}

export interface AlexaVocNormalizationWorkerService {
  execute(
    request: AlexaVocNormalizationExecutionRequest,
    context: AlexaVocNormalizationExecutionContext,
  ): Promise<AlexaVocNormalizationExecutionResult>;
}

export interface AlexaVocNormalizationJobHandlerOptions {
  readonly service: AlexaVocNormalizationWorkerService;
  readonly prepare: (
    job: JobAttemptRecord,
  ) => Promise<PreparedAlexaVocNormalizationJob> | PreparedAlexaVocNormalizationJob;
  readonly onTerminal: (input: Readonly<{
    job: JobAttemptRecord;
    snapshotId: string;
    asin: string;
    executionFingerprint: string | null;
    status: "success" | "failure";
    category: AlexaVocNormalizationTerminalCategory | null;
    agentRunId: string | null;
  }>) => Promise<void> | void;
  readonly onReplay?: (input: Readonly<{
    job: JobAttemptRecord;
    snapshotId: string;
    asin: string;
    executionFingerprint: string;
    agentRunId: string;
    revision: string;
  }>) => Promise<void> | void;
  readonly finalize: (input: Readonly<{
    job: JobAttemptRecord;
    processedSnapshotIds: readonly string[];
  }>) => Promise<boolean> | boolean;
}

export function createAlexaVocNormalizationJobHandler(
  options: AlexaVocNormalizationJobHandlerOptions,
): JobHandler {
  return async ({ job, signal }) => {
    if (job.stage !== "alexa-voc-normalization" || !job.leasedBy) {
      throw new WorkerTaskError(
        "configuration",
        "Alexa VOC normalization handler received invalid job authority",
      );
    }
    const processedSnapshotIds = new Set<string>();
    while (true) {
      const prepared = await options.prepare(job);
      const page = prepared.snapshots.filter(
        (snapshot) => !processedSnapshotIds.has(snapshot.id),
      );
      if (page.length === 0) {
        const completed = await options.finalize({
          job,
          processedSnapshotIds: [...processedSnapshotIds],
        });
        if (completed) return { status: "succeeded" } as const;
        continue;
      }
      for (const snapshot of page) {
        processedSnapshotIds.add(snapshot.id);
        try {
          if (snapshot.replay) {
            if (!options.onReplay || !snapshot.executionFingerprint) {
              throw new WorkerTaskError(
                "configuration",
                "Alexa VOC normalization replay is not configured",
              );
            }
            await options.onReplay({
              job,
              snapshotId: snapshot.id,
              asin: snapshot.asin,
              executionFingerprint: snapshot.executionFingerprint,
              agentRunId: snapshot.replay.agentRunId,
              revision: snapshot.replay.revision,
            });
            continue;
          }
          const result = await options.service.execute(
            {
              snapshotId: snapshot.id,
              model: prepared.model,
              ...(signal ? { signal } : {}),
            },
            {
              ...prepared.context,
              runId: job.runId,
              stageId: job.stageId,
              jobAttemptId: job.id,
              leaseOwnerId: job.leasedBy,
              leaseGeneration: job.leaseGeneration,
              logicalExecutionCycleId: job.logicalExecutionCycleId,
            },
          );
          await options.onTerminal({
            job,
            snapshotId: snapshot.id,
            asin: snapshot.asin,
            executionFingerprint: snapshot.executionFingerprint ?? null,
            status: "success",
            category: null,
            agentRunId: result.agentRunId,
          });
        } catch (error) {
          if (isInfrastructureFailure(error)) throw error;
          await options.onTerminal({
            job,
            snapshotId: snapshot.id,
            asin: snapshot.asin,
            executionFingerprint: snapshot.executionFingerprint ?? null,
            status: "failure",
            category: classifyTerminalFailure(error),
            agentRunId: null,
          });
        }
      }
    }
  };
}

function classifyTerminalFailure(
  error: unknown,
): AlexaVocNormalizationTerminalCategory {
  if (error instanceof SkillRuntimeError) {
    if (error.code === "MODEL_OUTPUT_ERROR") return "model-output";
    if (error.code === "INPUT_VALIDATION_ERROR") return "schema";
    if (error.code === "INPUT_SECURITY_ERROR") return "authorization";
  }
  if (
    error instanceof ManualAlexaVocRepositoryError &&
    error.kind === "permission"
  ) {
    return "authorization";
  }
  return "persistence";
}

function isInfrastructureFailure(error: unknown): boolean {
  if (error instanceof WorkerTaskError) {
    return (
      error.category === "infrastructure" ||
      error.category === "upstream-temporary"
    );
  }
  return (
    error instanceof ManualAlexaVocRepositoryError &&
    (error.kind === "connection" || error.kind === "timeout")
  );
}
