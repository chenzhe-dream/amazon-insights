import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { z } from "zod";

import { EntityIdSchema } from "../../shared/agent-contracts";
import {
  AnalysisReportConflictError,
  AnalysisReportDataError,
  AnalysisReportLeaseLostError,
  AnalysisReportSubjectNotFoundError,
  type AnalysisReportRepository,
} from "../db/analysis-report-repository";
import type { AgentRunRepository } from "../db/agent-run-repository";
import type { DataSnapshotRepository } from "../db/data-snapshot-repository";
import type { TrafficDataSnapshotRepository } from "../db/traffic-data-snapshot-repository";
import {
  TrafficAnalysisInputSchema,
  TrafficAnalysisOutputSchema,
  canonicalizeTrafficAnalysisOutput,
  type TrafficAnalysisInput,
} from "../domain/traffic/traffic-analysis-contracts";
import { AuditedSkillRunner, type AuditedSkillExecutionContext } from "../runtime/agent-run-service";
import { SkillRuntimeError, type ModelExecutionConfig } from "../runtime/skill-runner";
import { WorkerTaskError } from "../runtime/retry-policy";
import { agentDefinitions } from "../skills/agent-definitions";

const TrafficAnalysisAgentDefinition = agentDefinitions.find(
  (definition) => definition.id === "traffic-analysis",
)!;

type TrafficAnalysisRepository = AnalysisReportRepository &
  AgentRunRepository &
  DataSnapshotRepository &
  TrafficDataSnapshotRepository;

const ContextSchema = z.strictObject({
  actorId: EntityIdSchema,
  organizationId: EntityIdSchema,
  runId: EntityIdSchema,
  projectId: EntityIdSchema,
  stageId: EntityIdSchema,
  jobAttemptId: EntityIdSchema,
  leaseOwnerId: z.string().trim().min(1).max(500),
  leaseGeneration: z.number().int().positive(),
  logicalExecutionCycleId: z.string().regex(/^[0-9a-f]{64}$/),
  dataCutoffAt: z.iso.datetime({ offset: true }),
});

export interface TrafficAnalysisExecutionRequest {
  snapshotId: string;
  input: TrafficAnalysisInput;
  model: ModelExecutionConfig;
  signal?: AbortSignal;
}

export interface TrafficAnalysisExecutionContext extends AuditedSkillExecutionContext {
  actorId: string;
}

export interface TrafficAnalysisExecutionResult {
  report: Awaited<ReturnType<AnalysisReportRepository["publishTrafficAnalysisReport"]>>["report"];
  agentRun: Awaited<ReturnType<AuditedSkillRunner["run"]>>["agentRun"];
  replayed: boolean;
}

export class TrafficAnalysisConfigurationError extends WorkerTaskError {
  constructor() {
    super("configuration", "Traffic analysis model configuration exceeds published Agent limits");
    this.name = "TrafficAnalysisConfigurationError";
  }
}

export class TrafficAnalysisExecutionService {
  readonly #repository: TrafficAnalysisRepository;
  readonly #auditedRunner: AuditedSkillRunner;
  readonly #clock: () => Date;
  readonly #createId: () => string;

  constructor(dependencies: {
    repository: TrafficAnalysisRepository;
    auditedRunner: AuditedSkillRunner;
    clock?: () => Date;
    createId?: () => string;
  }) {
    this.#repository = dependencies.repository;
    this.#auditedRunner = dependencies.auditedRunner;
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#createId = dependencies.createId ?? randomUUID;
  }

  async execute(
    request: TrafficAnalysisExecutionRequest,
    executionContext: TrafficAnalysisExecutionContext,
  ): Promise<TrafficAnalysisExecutionResult> {
    assertPublishedModelLimits(request.model);
    const context = ContextSchema.parse(executionContext);
    const snapshotId = EntityIdSchema.parse(request.snapshotId);
    const input = TrafficAnalysisInputSchema.parse(request.input);
    if (new Date(input.dataCutoffAt).getTime() !== new Date(context.dataCutoffAt).getTime()) {
      throw new SkillRuntimeError("INPUT_VALIDATION_ERROR", "Traffic input cutoff conflicts with execution context");
    }
    const snapshot = await this.#repository.findTrafficDataSnapshotById({
      actorOrganizationId: context.organizationId,
      snapshotId,
    });
    if (
      !snapshot ||
      snapshot.runId !== context.runId ||
      !isDeepStrictEqual(snapshot.payload.input, input)
    ) {
      throw new SkillRuntimeError(
        "INPUT_VALIDATION_ERROR",
        "Traffic snapshot conflicts with execution input",
      );
    }
    await this.#repository.revalidateDataSnapshotSubject({
      actorId: context.actorId,
      actorOrganizationId: context.organizationId,
      runId: context.runId,
      expectedProjectId: context.projectId,
      expectedMarketplace: snapshot.marketplace,
      expectedAsins: snapshot.asins,
      expectedRunCutoffAt: snapshot.dataCutoffAt,
    });
    const audited = await this.#auditedRunner.run({
      skill: TrafficAnalysisAgentDefinition.skill,
      inputContract: {
        name: TrafficAnalysisAgentDefinition.inputSchema,
        schema: TrafficAnalysisInputSchema,
        allowedFields: ["schemaVersion", "kind", "marketplace", "dataCutoffAt", "inputDigest", "capabilityBoundary", "competitors"],
      },
      outputContract: {
        name: TrafficAnalysisAgentDefinition.outputSchema,
        schema: TrafficAnalysisOutputSchema,
        canonicalizeOutput: (candidate) => canonicalizeTrafficAnalysisOutput(candidate, input),
      },
      input,
      snapshotIds: [snapshotId],
      model: request.model,
      ...(request.signal ? { signal: request.signal } : {}),
    }, { ...context, executionLineage: "stage-input" });
    if (!audited.logicalExecutionLineage) {
      throw new SkillRuntimeError("INPUT_VALIDATION_ERROR", "Traffic execution lineage is unavailable");
    }
    try {
      const published = await this.#repository.publishTrafficAnalysisReport({
        id: this.#createId(), actorId: context.actorId, actorOrganizationId: context.organizationId,
        expectedProjectId: context.projectId, runId: context.runId, stageId: context.stageId,
        jobAttemptId: context.jobAttemptId, agentRunId: audited.agentRun.id,
        logicalExecutionLineage: audited.logicalExecutionLineage, snapshotId,
        skill: audited.agentRun.skill, model: audited.agentRun.model,
        leaseOwnerId: context.leaseOwnerId, leaseGeneration: context.leaseGeneration,
        publishedAt: this.#now(), result: audited.value,
      });
      return { report: published.report, agentRun: audited.agentRun, replayed: audited.replayed || !published.created };
    } catch (error) {
      if (error instanceof AnalysisReportConflictError || error instanceof AnalysisReportDataError || error instanceof AnalysisReportLeaseLostError || error instanceof AnalysisReportSubjectNotFoundError) throw error;
      throw new WorkerTaskError("upstream-temporary", "Traffic analysis report persistence is temporarily unavailable", { cause: error instanceof Error ? error : undefined });
    }
  }

  #now() {
    const value = this.#clock();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new TypeError("Invalid traffic analysis execution clock");
    return value.toISOString();
  }
}

function assertPublishedModelLimits(model: ModelExecutionConfig) {
  const limits = TrafficAnalysisAgentDefinition.budget;
  if (model.estimatedInputTokens > limits.maxInputTokens || model.maxOutputTokens > limits.maxOutputTokens || model.timeoutMs > limits.timeoutMs) {
    throw new TrafficAnalysisConfigurationError();
  }
}
