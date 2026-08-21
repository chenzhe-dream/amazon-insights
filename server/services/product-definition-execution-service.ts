import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { z } from "zod";

import { EntityIdSchema } from "../../shared/agent-contracts";
import type { AnalysisReportRepository } from "../db/analysis-report-repository";
import {
  AnalysisReportConflictError,
  AnalysisReportDataError,
  AnalysisReportLeaseLostError,
  AnalysisReportSubjectNotFoundError,
} from "../db/analysis-report-repository";
import type { DataSnapshotRepository } from "../db/data-snapshot-repository";
import type { KeywordAnalysisSnapshotRepository } from "../db/keyword-analysis-snapshot-repository";
import {
  ProductDefinitionInputSchema,
  buildProductDefinitionInput,
  canonicalizeProductDefinitionOutput,
  createProductDefinitionOutputSchema,
  type ProductDefinitionInput,
} from "../domain/product/product-definition-contracts";
import { agentDefinitions } from "../skills/agent-definitions";
import {
  AuditedSkillRunner,
  type AuditedSkillExecutionContext,
} from "../runtime/agent-run-service";
import { ModelProviderError } from "../runtime/model-provider";
import { WorkerTaskError } from "../runtime/retry-policy";
import { SkillRuntimeError, type ModelExecutionConfig } from "../runtime/skill-runner";

const ProductDefinitionAgentDefinition = agentDefinitions.find(
  ({ id }) => id === "product-definition",
)!;

type ProductDefinitionRepository = AnalysisReportRepository &
  KeywordAnalysisSnapshotRepository & DataSnapshotRepository;

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

export interface ProductDefinitionExecutionRequest {
  vocReportId: string;
  keywordSnapshotId: string;
  input: ProductDefinitionInput;
  model: ModelExecutionConfig;
  signal?: AbortSignal;
}

export interface ProductDefinitionExecutionContext
  extends AuditedSkillExecutionContext {
  actorId: string;
}

export class ProductDefinitionExecutionService {
  readonly #repository: ProductDefinitionRepository;
  readonly #auditedRunner: AuditedSkillRunner;
  readonly #clock: () => Date;
  readonly #createId: () => string;

  constructor(dependencies: {
    repository: ProductDefinitionRepository;
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
    request: ProductDefinitionExecutionRequest,
    executionContext: ProductDefinitionExecutionContext,
  ) {
    assertPublishedModelLimits(request.model);
    const context = ContextSchema.parse(executionContext);
    const vocReportId = EntityIdSchema.parse(request.vocReportId);
    const keywordSnapshotId = EntityIdSchema.parse(request.keywordSnapshotId);
    const input = ProductDefinitionInputSchema.parse(request.input);
    const vocReport = await this.#repository.findAnalysisReportById({
      actorOrganizationId: context.organizationId,
      reportId: vocReportId,
    });
    const keywordSnapshot = await this.#repository.findKeywordAnalysisSnapshotById({
      actorOrganizationId: context.organizationId,
      snapshotId: keywordSnapshotId,
    });
    if (!vocReport || vocReport.runId !== context.runId ||
      vocReport.stage !== "voc-positioning" ||
      (vocReport.status !== "complete" && vocReport.status !== "partial") ||
      !keywordSnapshot || keywordSnapshot.runId !== context.runId
    ) {
      throw new WorkerTaskError("data-quality", "Product definition dependencies are unavailable");
    }
    if (keywordSnapshot.marketplace !== "US") {
      throw new WorkerTaskError("data-quality", "Product definition dependencies are unavailable");
    }
    const expectedInput = buildProductDefinitionInput({
      marketplace: "US",
      asins: keywordSnapshot.asins,
      dataCutoffAt: keywordSnapshot.dataCutoffAt,
      vocReport,
      keywordSnapshot,
    });
    if (!isDeepStrictEqual(input, expectedInput) || input.dataCutoffAt !== context.dataCutoffAt) {
      throw new SkillRuntimeError("INPUT_VALIDATION_ERROR", "Product definition dependency identity conflicts with execution input");
    }
    await this.#repository.revalidateDataSnapshotSubject({
      actorId: context.actorId,
      actorOrganizationId: context.organizationId,
      runId: context.runId,
      expectedProjectId: context.projectId,
      expectedMarketplace: keywordSnapshot.marketplace,
      expectedAsins: keywordSnapshot.asins,
      expectedRunCutoffAt: keywordSnapshot.dataCutoffAt,
    });

    let audited;
    try {
      audited = await this.#auditedRunner.run({
        skill: ProductDefinitionAgentDefinition.skill,
        inputContract: {
          name: ProductDefinitionAgentDefinition.inputSchema,
          schema: ProductDefinitionInputSchema,
          allowedFields: ["schemaVersion", "kind", "marketplace", "asins", "dataCutoffAt", "voc", "keywords", "commercialData"],
        },
        outputContract: {
          name: ProductDefinitionAgentDefinition.outputSchema,
          schema: createProductDefinitionOutputSchema(input),
          canonicalizeOutput: (candidate) => canonicalizeProductDefinitionOutput(candidate, input),
        },
        input,
        snapshotIds: input.voc.snapshotIds,
        model: request.model,
        ...(request.signal ? { signal: request.signal } : {}),
      }, { ...context, executionLineage: "stage-input" });
    } catch (error) {
      if (error instanceof SkillRuntimeError && error.cause instanceof ModelProviderError &&
        (error.cause.kind === "transient" || error.cause.kind === "timeout")) {
        throw new WorkerTaskError("upstream-temporary", "Model provider remained temporarily unavailable", { cause: error });
      }
      throw error;
    }
    if (!audited.logicalExecutionLineage) {
      throw new SkillRuntimeError("INPUT_VALIDATION_ERROR", "Product definition execution lineage is unavailable");
    }
    try {
      const published = await this.#repository.publishProductDefinitionReport({
        id: this.#createId(),
        actorId: context.actorId,
        actorOrganizationId: context.organizationId,
        expectedProjectId: context.projectId,
        runId: context.runId,
        stageId: context.stageId,
        jobAttemptId: context.jobAttemptId,
        agentRunId: audited.agentRun.id,
        logicalExecutionLineage: audited.logicalExecutionLineage,
        vocReportId,
        keywordSnapshotId,
        skill: audited.agentRun.skill,
        model: audited.agentRun.model,
        leaseOwnerId: context.leaseOwnerId,
        leaseGeneration: context.leaseGeneration,
        publishedAt: this.#now(),
        result: audited.value,
      });
      return { report: published.report, agentRun: audited.agentRun, replayed: audited.replayed || !published.created };
    } catch (error) {
      if (error instanceof AnalysisReportConflictError || error instanceof AnalysisReportDataError ||
        error instanceof AnalysisReportLeaseLostError || error instanceof AnalysisReportSubjectNotFoundError) throw error;
      throw new WorkerTaskError("upstream-temporary", "Product definition report persistence is temporarily unavailable", {
        cause: error instanceof Error ? error : undefined,
      });
    }
  }

  #now() {
    const value = this.#clock();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new TypeError("Invalid product definition execution clock");
    return value.toISOString();
  }
}

function assertPublishedModelLimits(model: ModelExecutionConfig) {
  const limits = ProductDefinitionAgentDefinition.budget;
  if (model.estimatedInputTokens > limits.maxInputTokens ||
    model.maxOutputTokens > limits.maxOutputTokens ||
    model.timeoutMs > limits.timeoutMs) {
    throw new WorkerTaskError("configuration", "Product definition model configuration exceeds published Agent limits");
  }
}
