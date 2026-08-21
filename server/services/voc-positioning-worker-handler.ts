import type { JobAttemptRecord } from "../db/repository";
import { WorkerTaskError } from "../runtime/retry-policy";
import type { JobHandler } from "../runtime/worker-loop";
import {
  VocPositioningExecutionService,
  VocPositioningInputUnavailableError,
  type VocPositioningExecutionContext,
  type VocPositioningExecutionRequest,
} from "./voc-positioning-execution-service";

export interface PreparedVocPositioningJob {
  readonly request: Omit<VocPositioningExecutionRequest, "signal">;
  readonly context: Pick<
    VocPositioningExecutionContext,
    "actorId" | "organizationId" | "projectId" | "dataCutoffAt"
  >;
}

export interface VocPositioningJobHandlerOptions {
  readonly service: VocPositioningExecutionService;
  readonly prepare: (
    job: JobAttemptRecord,
  ) => Promise<PreparedVocPositioningJob> | PreparedVocPositioningJob;
}

export function createVocPositioningJobHandler(
  options: VocPositioningJobHandlerOptions,
): JobHandler {
  return async ({ job, signal }) => {
    if (job.stage !== "voc-positioning" || !job.leasedBy) {
      throw new WorkerTaskError(
        "configuration",
        "VOC positioning handler received an invalid job authority",
      );
    }
    try {
      const prepared = await options.prepare(job);
      await options.service.execute(
        { ...prepared.request, signal },
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
      return { status: "succeeded" } as const;
    } catch (error) {
      if (error instanceof VocPositioningInputUnavailableError) {
        return {
          status: "waiting-input",
          error: {
            category: "data-quality",
            message: "VOC input is required; paste or import an Amazon/Alexa VOC file to continue",
          },
        } as const;
      }
      throw error;
    }
  };
}
