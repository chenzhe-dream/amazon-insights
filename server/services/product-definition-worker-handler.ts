import type { JobAttemptRecord } from "../db/repository";
import { WorkerTaskError } from "../runtime/retry-policy";
import type { JobHandler } from "../runtime/worker-loop";
import {
  ProductDefinitionExecutionService,
  type ProductDefinitionExecutionContext,
  type ProductDefinitionExecutionRequest,
} from "./product-definition-execution-service";

export function createProductDefinitionJobHandler(options: {
  service: ProductDefinitionExecutionService;
  prepare: (job: JobAttemptRecord) => Promise<{
    request: Omit<ProductDefinitionExecutionRequest, "signal">;
    context: Pick<ProductDefinitionExecutionContext, "actorId" | "organizationId" | "projectId" | "dataCutoffAt">;
  }>;
}): JobHandler {
  return async ({ job, signal }) => {
    if (job.stage !== "product-definition" || !job.leasedBy) {
      throw new WorkerTaskError("configuration", "Product definition handler received invalid job authority");
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
