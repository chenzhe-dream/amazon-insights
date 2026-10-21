import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { z } from "zod";
import { productDefinitionRepairGuidance } from "../../shared/product-validation-rules";

import { EntityIdSchema } from "../../shared/agent-contracts";
import {
  ProductDefinitionOutputShapeSchema,
  validateProductDefinitionOutputStructure,
} from "../../shared/product-definition-output";
import {
  VocModelEvidenceSchema,
  toModelEvidenceSelection,
} from "../../shared/voc-evidence-contracts";
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
  collectVocEvidenceIds,
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

const ProductDefinitionModelInputSchema = ProductDefinitionInputSchema.extend({
  evidenceSelection: VocModelEvidenceSchema.optional(),
});

export const ProductDefinitionModelOutputSchema = z.strictObject({
  ...ProductDefinitionOutputShapeSchema.shape,
  evidenceSelection: z.null(),
  evidenceMatrix: ProductDefinitionOutputShapeSchema.shape.evidenceMatrix.max(10),
  configurationLayers: ProductDefinitionOutputShapeSchema.shape.configurationLayers.extend({
    mustHave: ProductDefinitionOutputShapeSchema.shape.configurationLayers.shape.mustHave.max(5),
    differentiation: ProductDefinitionOutputShapeSchema.shape.configurationLayers.shape.differentiation.max(3),
    optional: ProductDefinitionOutputShapeSchema.shape.configurationLayers.shape.optional.max(3),
    notInV1: ProductDefinitionOutputShapeSchema.shape.configurationLayers.shape.notInV1.max(3),
    p0Avoid: ProductDefinitionOutputShapeSchema.shape.configurationLayers.shape.p0Avoid.max(5),
  }),
  finalDefinition: ProductDefinitionOutputShapeSchema.shape.finalDefinition.max(16),
  keywordLanding: ProductDefinitionOutputShapeSchema.shape.keywordLanding.max(10),
  priorities: ProductDefinitionOutputShapeSchema.shape.priorities.max(10),
  identity: z.strictObject({
    ...ProductDefinitionOutputShapeSchema.shape.identity.shape,
    inputFingerprint: z.null(),
  }),
  opportunity: z.strictObject({
    ...ProductDefinitionOutputShapeSchema.shape.opportunity.shape,
    pendingReason: z.string().trim().min(1).max(2_000).nullable(),
  }),
}).superRefine(validateProductDefinitionOutputStructure).describe("Concise product definition: one row per final-definition dimension, focus on up to ten keyword groups and priorities. Use short actionable sentences, preserve evidence links and all required risk checks.");

export function createProductDefinitionModelOutputSchema(input: ProductDefinitionInput) {
  return createProductDefinitionModelOutputContract(input).schema;
}

export function createProductDefinitionModelOutputContract(input: ProductDefinitionInput) {
  const sorted = (values: Iterable<string>) => [...new Set(values)].sort();
  const vocIds = sorted(collectVocEvidenceIds(input.voc.result));
  const keywordIds = sorted(input.keywords.evidence.map(item => item.id));
  const allIds = sorted([...vocIds, ...keywordIds]);
  const themes = sorted(input.voc.result.themeJudgments.map(item => item.themeKey));
  const groups = sorted(input.keywords.groups.map(item => item.id));
  // An empty allowed set permits zero references, never a fabricated sentinel.
  // Required evidence keeps min(1), making an unsupported row impossible.
  const enumValue = (values: string[]) => values.length ? z.enum(values) : z.string().trim().min(1).max(200);
  const vocId = enumValue(vocIds), keywordId = enumValue(keywordIds), anyId = enumValue(allIds);
  const theme = themes.length ? z.enum(themes) : z.string().regex(/^(?!)$/);
  const group = groups.length ? z.enum(groups) : z.string().regex(/^(?!)$/);
  const ids = (values: string[], item: z.ZodType<string, string>) => values.length
    ? z.array(item).max(100)
    : z.array(z.string().trim().min(1).max(200)).max(0);
  const voc = ids(vocIds, vocId), keyword = ids(keywordIds, keywordId), all = ids(allIds, anyId);
  const s = ProductDefinitionModelOutputSchema.shape;
  const feature = s.configurationLayers.shape.mustHave.element.extend({evidenceIds: all.min(1)});
  const matrix = s.evidenceMatrix.element;
  const both = {themeKey: theme, keywordGroupId: group, vocEvidenceIds: voc.min(1), keywordEvidenceIds: keyword.min(1)};
  const final = s.finalDefinition.element;
  const schema = ProductDefinitionModelOutputSchema.safeExtend({
    evidenceMatrix: z.union([
      matrix.extend({judgment:z.literal('voc-only'),themeKey:theme,keywordGroupId:z.null(),vocEvidenceIds:voc.min(1),keywordEvidenceIds:keyword.max(0)}),
      matrix.extend({judgment:z.literal('keyword-candidate'),themeKey:z.null(),keywordGroupId:group,vocEvidenceIds:voc.max(0),keywordEvidenceIds:keyword.min(1)}),
      matrix.extend({judgment:z.literal('dual-validation'),...both}),
      matrix.extend({judgment:z.literal('conflict'),...both}),
      matrix.extend({judgment:z.literal('avoid'),...both}),
    ]).array().min(1).max(10),
    finalDefinition: z.union([
      final.extend({validationStatus:z.literal('supported'),vocEvidenceIds:voc.min(1),keywordEvidenceIds:keyword.min(1)}),
      final.extend({validationStatus:z.literal('requires-validation'),vocEvidenceIds:voc.min(1),keywordEvidenceIds:keyword}),
      final.extend({validationStatus:z.literal('requires-validation'),vocEvidenceIds:voc,keywordEvidenceIds:keyword.min(1)}),
    ]).array().min(1).max(16),
    configurationLayers: s.configurationLayers.extend({
      mustHave: feature.array().max(5), differentiation: feature.array().max(3),
      optional: feature.array().max(3), notInV1: feature.array().max(3), p0Avoid: feature.array().max(5),
    }),
    keywordLanding: s.keywordLanding.element.extend({
      groupId: group,
      evidenceIds: keyword.min(1),
    }).array().min(1).max(10),
    priorities: s.priorities.element.extend({evidenceIds: all.min(1)}).array().min(1).max(10),
  }).describe("Only emit rows supported by exact frozen evidence; omit unsupported dimensions and never guess or fill references. supported requires both VOC and keyword evidence; requires-validation still needs at least one side. Place commercial unknowns or deferred checks only in risks, opportunity.pendingReason, commercialValidation or dataBoundary. Ordinary narratives must not contain profit, profitability, margin, ROI, 盈利, 利润, 毛利, 投资回报, approval claims or validation-bypass wording, even when negated. Keep concise narratives and every required risk gate.");
  return {schema, schemaDefinitions: {ProductVocEvidenceId:vocId, ProductKeywordEvidenceId:keywordId, ProductAnyEvidenceId:anyId, ProductThemeKey:theme, ProductKeywordGroupId:group}};
}

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
    const vocSnapshotId = vocReport?.snapshotIds[0];
    const vocSnapshot = vocSnapshotId ? await this.#repository.findDataSnapshotById({
      actorOrganizationId: context.organizationId,
      snapshotId: vocSnapshotId,
    }) : null;
    if (!vocReport || vocReport.runId !== context.runId ||
      vocReport.stage !== "voc-positioning" ||
      (vocReport.status !== "complete" && vocReport.status !== "partial") ||
      !keywordSnapshot || keywordSnapshot.runId !== context.runId ||
      !vocSnapshot || vocSnapshot.runId !== context.runId ||
      !isDeepStrictEqual(keywordSnapshot.asins, vocSnapshot.asins)
    ) {
      throw new WorkerTaskError("data-quality", "Product definition dependencies are unavailable");
    }
    if (keywordSnapshot.marketplace !== vocSnapshot.marketplace) {
      throw new WorkerTaskError("data-quality", "Product definition dependencies are unavailable");
    }
    const expectedInput = buildProductDefinitionInput({
      marketplace: keywordSnapshot.marketplace,
      asins: keywordSnapshot.asins,
      dataCutoffAt: keywordSnapshot.dataCutoffAt,
      vocReport,
      keywordSnapshot,
      ...(vocSnapshot.payload.evidenceSelection ? { evidenceSelection: vocSnapshot.payload.evidenceSelection } : {}),
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
      ...(vocSnapshot.payload.evidenceSelection ? { allowAsinSubset: true } : {}),
    });

    let audited;
    try {
      const modelInput = {
        ...input,
        ...(input.evidenceSelection
          ? { evidenceSelection: toModelEvidenceSelection(input.evidenceSelection) }
          : {}),
      };
      const wire = createProductDefinitionModelOutputContract(input);
      audited = await this.#auditedRunner.run({
        skill: ProductDefinitionAgentDefinition.skill,
        inputContract: {
          name: ProductDefinitionAgentDefinition.inputSchema,
          schema: ProductDefinitionModelInputSchema,
          allowedFields: ["schemaVersion", "kind", "marketplace", "asins", "dataCutoffAt", "evidenceSelection", "voc", "keywords", "commercialData"],
        },
        outputContract: {
          name: ProductDefinitionAgentDefinition.outputSchema,
          schema: createProductDefinitionOutputSchema(input),
          responseSchema: wire.schema,
          schemaDefinitions: wire.schemaDefinitions,
          repairGuidance: productDefinitionRepairGuidance,
          canonicalizeOutput: (candidate) => canonicalizeProductDefinitionOutput(candidate, input),
        },
        input: modelInput,
        snapshotIds: input.voc.snapshotIds,
        model: request.model,
        ...(request.signal ? { signal: request.signal } : {}),
      }, { ...context, executionLineage: "stage-input" });
    } catch (error) {
      if (error instanceof SkillRuntimeError && error.cause instanceof ModelProviderError &&
        (error.cause.kind === "transient" || error.cause.kind === "timeout")) {
        throw new WorkerTaskError("upstream-temporary", "Model provider remained temporarily unavailable", { cause: error });
      }
      if (error instanceof SkillRuntimeError && error.code === "MODEL_OUTPUT_ERROR") {
        throw new WorkerTaskError("model-output", "Model output failed deterministic product definition validation", { cause: error });
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
