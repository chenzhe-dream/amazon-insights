import type { JobAttemptRecord } from "../db/repository";
import { WorkerTaskError } from "../runtime/retry-policy";
import type { JobHandler } from "../runtime/worker-loop";
import {
  TrafficAnalysisExecutionService,
  type TrafficAnalysisExecutionContext,
  type TrafficAnalysisExecutionRequest,
} from "./traffic-analysis-execution-service";

export interface PreparedTrafficAnalysisJob {
  readonly request: Omit<TrafficAnalysisExecutionRequest, "signal">;
  readonly context: Pick<TrafficAnalysisExecutionContext, "actorId" | "organizationId" | "projectId" | "dataCutoffAt">;
}

export function createTrafficAnalysisJobHandler(options: {
  service: TrafficAnalysisExecutionService;
  prepare: (job: JobAttemptRecord) => Promise<PreparedTrafficAnalysisJob> | PreparedTrafficAnalysisJob;
}): JobHandler {
  return async ({ job, signal }) => {
    if (job.stage !== "traffic-analysis" || !job.leasedBy) {
      throw new WorkerTaskError("configuration", "Traffic analysis handler received an invalid job authority");
    }
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
  };
}
