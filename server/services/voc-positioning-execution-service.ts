import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { z } from "zod";

import { EntityIdSchema } from "../../shared/agent-contracts";
import { agentDefinitions } from "../skills/agent-definitions";
import {
  AnalysisReportConflictError,
  AnalysisReportDataError,
  AnalysisReportLeaseLostError,
  AnalysisReportSubjectNotFoundError,
  type AnalysisReportRepository,
} from "../db/analysis-report-repository";
import type { DataSnapshotRepository } from "../db/data-snapshot-repository";
import { assertVocDataSnapshotRecordIntegrity } from "../data/voc-data-snapshot";
import {
  parseVocDeterministicPreprocessingResult,
  preprocessVocSnapshot,
  type VocDeterministicPreprocessingResult,
} from "../domain/voc/preprocess-voc-snapshot";
import {
  buildVocPositioningInput,
  canonicalizeVocPositioningOutput,
} from "../domain/voc/voc-positioning-contracts";
import {
  AmazonVocInsightInputSchema,
  createAmazonVocInsightOutputSchema,
  type AmazonVocInsightOutput,
} from "../domain/voc/amazon-voc-insight-contracts";
import {
  AuditedSkillRunner,
  type AuditedSkillExecutionContext,
} from "../runtime/agent-run-service";
import { ModelProviderError } from "../runtime/model-provider";
import { SkillRuntimeError, type ModelExecutionConfig } from "../runtime/skill-runner";
import { WorkerTaskError } from "../runtime/retry-policy";

type VocPositioningRepository = DataSnapshotRepository & AnalysisReportRepository;

const VocPositioningAgentDefinition = agentDefinitions.find(
  (definition) => definition.id === "voc-positioning",
)!;

export interface VocPositioningExecutionRequest {
  snapshotId: string;
  facts: unknown;
  model: ModelExecutionConfig;
  signal?: AbortSignal;
}

export interface VocPositioningExecutionContext
  extends AuditedSkillExecutionContext {
  actorId: string;
}

export interface VocPositioningExecutionResult {
  report: Awaited<
    ReturnType<AnalysisReportRepository["publishVocPositioningReport"]>
  >["report"];
  agentRun: Awaited<
    ReturnType<AuditedSkillRunner["run"]>
  >["agentRun"];
  replayed: boolean;
}

interface VocPositioningExecutionServiceDependencies {
  repository: VocPositioningRepository;
  auditedRunner: AuditedSkillRunner;
  clock?: () => Date;
  createId?: () => string;
}

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

export class VocPositioningExecutionConflictError extends SkillRuntimeError {
  constructor() {
    super(
      "INPUT_VALIDATION_ERROR",
      "VOC snapshot and deterministic facts identity conflict",
    );
    this.name = "VocPositioningExecutionConflictError";
  }
}

export class VocPositioningInputUnavailableError extends WorkerTaskError {
  constructor() {
    super("data-quality", "VOC positioning requires at least one evidence fact");
    this.name = "VocPositioningInputUnavailableError";
  }
}

export class VocPositioningConfigurationError extends WorkerTaskError {
  constructor() {
    super(
      "configuration",
      "VOC positioning model configuration exceeds published Agent limits",
    );
    this.name = "VocPositioningConfigurationError";
  }
}

export class VocPositioningExecutionService {
  readonly #repository: VocPositioningRepository;
  readonly #auditedRunner: AuditedSkillRunner;
  readonly #clock: () => Date;
  readonly #createId: () => string;

  constructor(dependencies: VocPositioningExecutionServiceDependencies) {
    this.#repository = dependencies.repository;
    this.#auditedRunner = dependencies.auditedRunner;
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#createId = dependencies.createId ?? randomUUID;
  }

  async execute(
    request: VocPositioningExecutionRequest,
    executionContext: VocPositioningExecutionContext,
  ): Promise<VocPositioningExecutionResult> {
    assertPublishedModelLimits(request.model);
    const context = ContextSchema.parse(executionContext);
    const snapshotId = EntityIdSchema.parse(request.snapshotId);
    const snapshot = await this.#repository.findDataSnapshotById({
      actorOrganizationId: context.organizationId,
      snapshotId,
    });
    if (!snapshot) throw new VocPositioningExecutionConflictError();
    assertVocDataSnapshotRecordIntegrity(snapshot);
    const facts = parseVocDeterministicPreprocessingResult(request.facts);
    assertExecutionIdentity(snapshot, facts, context);
    const recomputedFacts = preprocessVocSnapshot(snapshot);
    if (!isDeepStrictEqual(facts, recomputedFacts)) {
      throw new VocPositioningExecutionConflictError();
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
    if (facts.evidenceIndex.length === 0) {
      throw new VocPositioningInputUnavailableError();
    }

    const input = buildVocPositioningInput(facts);
    let audited;
    try {
      audited = await this.#auditedRunner.run({
        skill: {
          id: VocPositioningAgentDefinition.skill.id,
          version: VocPositioningAgentDefinition.skill.version,
        },
        inputContract: {
          name: VocPositioningAgentDefinition.inputSchema,
          schema: AmazonVocInsightInputSchema,
          allowedFields: [
            "schemaVersion",
            "kind",
            "snapshot",
            "factsDigest",
            "coverage",
            "dimensions",
            "evidenceIndex",
          ],
        },
        outputContract: {
          name: VocPositioningAgentDefinition.outputSchema,
          schema: createAmazonVocInsightOutputSchema(input),
          canonicalizeOutput: (candidate) =>
            canonicalizeAmazonVocInsightOutput(candidate, facts),
        },
        input,
        snapshotIds: [snapshot.id],
        model: request.model,
        ...(request.signal ? { signal: request.signal } : {}),
      }, { ...context, executionLineage: "stage-input" });
    } catch (error) {
      if (
        error instanceof SkillRuntimeError &&
        error.cause instanceof ModelProviderError &&
        (error.cause.kind === "transient" || error.cause.kind === "timeout")
      ) {
        throw new WorkerTaskError(
          "upstream-temporary",
          "Model provider remained temporarily unavailable",
          { cause: error },
        );
      }
      if (
        error instanceof SkillRuntimeError &&
        error.code === "MODEL_OUTPUT_ERROR"
      ) {
        throw new WorkerTaskError(
          "model-output",
          "Model output failed deterministic VOC validation",
          { cause: error },
        );
      }
      throw error;
    }
    if (!audited.logicalExecutionLineage) {
      throw new VocPositioningExecutionConflictError();
    }
    const output = audited.value as AmazonVocInsightOutput;
    let published;
    try {
      published = await this.#repository.publishVocPositioningReport({
        id: this.#createId(),
        actorId: context.actorId,
        actorOrganizationId: context.organizationId,
        expectedProjectId: context.projectId,
        runId: context.runId,
        stageId: context.stageId,
        jobAttemptId: context.jobAttemptId,
        agentRunId: audited.agentRun.id,
        logicalExecutionLineage: audited.logicalExecutionLineage,
        snapshotId: snapshot.id,
        factsDigest: facts.factsDigest,
        skill: audited.agentRun.skill,
        model: audited.agentRun.model,
        leaseOwnerId: context.leaseOwnerId,
        leaseGeneration: context.leaseGeneration,
        publishedAt: this.#now(),
        result: output,
      });
    } catch (error) {
      if (
        error instanceof AnalysisReportConflictError ||
        error instanceof AnalysisReportDataError ||
        error instanceof AnalysisReportLeaseLostError ||
        error instanceof AnalysisReportSubjectNotFoundError
      ) {
        throw error;
      }
      throw new WorkerTaskError(
        "upstream-temporary",
        "Analysis report persistence is temporarily unavailable",
        { cause: error instanceof Error ? error : undefined },
      );
    }
    return {
      report: published.report,
      agentRun: audited.agentRun,
      replayed: audited.replayed || !published.created,
    };
  }

  #now() {
    const value = this.#clock();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new TypeError("Invalid VOC positioning execution clock");
    }
    return new Date(value.getTime()).toISOString();
  }
}

function canonicalizeAmazonVocInsightOutput(
  candidate: unknown,
  facts: VocDeterministicPreprocessingResult,
) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return candidate;
  }
  const value = candidate as Record<string, unknown>;
  return {
    ...value,
    positioningProjection: canonicalizeVocPositioningOutput(
      value.positioningProjection,
      facts,
    ),
  };
}

function assertPublishedModelLimits(model: ModelExecutionConfig) {
  const limits = VocPositioningAgentDefinition.budget;
  if (
    model.estimatedInputTokens > limits.maxInputTokens ||
    model.maxOutputTokens > limits.maxOutputTokens ||
    model.timeoutMs > limits.timeoutMs
  ) {
    throw new VocPositioningConfigurationError();
  }
}

function assertExecutionIdentity(
  snapshot: Parameters<typeof assertVocDataSnapshotRecordIntegrity>[0],
  facts: VocDeterministicPreprocessingResult,
  context: z.infer<typeof ContextSchema>,
) {
  if (
    snapshot.id !== facts.snapshot.id ||
    snapshot.runId !== facts.snapshot.runId ||
    snapshot.runId !== context.runId ||
    snapshot.contentHash !== facts.snapshot.contentHash ||
    snapshot.marketplace !== facts.snapshot.marketplace ||
    !isDeepStrictEqual(snapshot.asins, facts.snapshot.asins) ||
    new Date(snapshot.dataCutoffAt).getTime() !==
      new Date(facts.snapshot.dataCutoffAt).getTime() ||
    new Date(snapshot.dataCutoffAt).getTime() !==
      new Date(context.dataCutoffAt).getTime()
  ) {
    throw new VocPositioningExecutionConflictError();
  }
}
