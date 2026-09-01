import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";

import {
  MANUAL_ALEXA_VOC_SEVEN_QUESTION_PROMPT,
  ManualAlexaVocImportRequestSchema,
  ManualAlexaVocListQuerySchema,
  ManualAlexaVocListResponseSchema,
  ManualAlexaVocNormalizedRecordSchema,
  ManualAlexaVocWriteResponseSchema,
  type ManualAlexaVocImportRequest,
  type ManualAlexaVocListQuery,
  type ManualAlexaVocListResponse,
  type ManualAlexaVocWriteResponse,
} from "../../shared/agent-contracts";
import {
  processAlexaVocText,
  validateAlexaVocReportLimits,
} from "../../scripts/lib/alexa-voc-processing.mjs";
import type {
  AgentRepository,
  AnalysisRunRecord,
  ManualAlexaVocRepositoryCapability,
  ProjectRecord,
} from "../db/repository";
import { AlexaVocMatrixRecordSchema } from "../domain/voc/alexa-voc-normalization-contracts";
import { canonicalJsonSha256 } from "../runtime/model-request-accounting";
import type {
  AlexaVocNormalizationInputCipher,
  AlexaVocNormalizationInputCipherIdentity,
} from "../security/alexa-voc-normalization-input-cipher";
import type { ManualAlexaVocCipher } from "../security/manual-alexa-voc-cipher";

const NORMALIZED_SCHEMA_VERSION = "alexa-voc-record/v2" as const;
const PARSER_VERSION = "deterministic-alexa-parser/v3" as const;
const NORMALIZATION_INPUT_SCHEMA = "alexa-voc-normalization-input/v1" as const;
const ALEXA_SKILL = Object.freeze({
  id: "alexa-for-shopping-voc",
  version: "1.0.0",
  contentHash: "dd97dda58ce916ed5c8cf5f39957e1a7b6e52af95be4bfed4a088caafd8dc3c3",
});
const MATRIX_SCHEMA_DIGEST = canonicalJsonSha256({
  schema: "AlexaVocMatrixRecord@1.0.0",
  dimensions: ["attention", "positives", "negatives", "unmet", "audiences", "scenarios", "motives"],
  matrixHeaders: ["人群分类｜特征", "场景｜说明与示例", "动机｜重要性｜说明"],
});

export type ManualAlexaVocPrincipal = Readonly<{
  organizationId: string;
  userId: string;
}>;

export class ManualAlexaVocServiceError extends Error {
  constructor(
    readonly kind: "validation" | "too-large" | "incomplete" | "unavailable" | "forbidden" | "not-found" | "conflict",
    message: string,
  ) {
    super(message);
    this.name = "ManualAlexaVocServiceError";
  }
}

type ManualAlexaVocServiceRepository = AgentRepository &
  ManualAlexaVocRepositoryCapability;

export class ManualAlexaVocService {
  readonly #repository: ManualAlexaVocServiceRepository;
  readonly #cipher: ManualAlexaVocCipher;
  readonly #normalizationInputCipher: AlexaVocNormalizationInputCipher | null;
  readonly #writeEnabled: boolean;
  readonly #publicationEnabled: boolean;
  readonly #createId: () => string;
  readonly #now: () => string;
  readonly #model: Readonly<{ provider: string; model: string; temperature: number }>;

  constructor(options: Readonly<{
    repository: ManualAlexaVocServiceRepository;
    cipher: ManualAlexaVocCipher;
    normalizationInputCipher?: AlexaVocNormalizationInputCipher;
    writeEnabled?: boolean;
    publicationEnabled?: boolean;
    createId?: () => string;
    now?: () => string;
    normalizationModel?: Readonly<{ provider: string; model: string; temperature?: number }>;
  }>) {
    this.#repository = options.repository;
    this.#cipher = options.cipher;
    this.#normalizationInputCipher = options.normalizationInputCipher ?? null;
    this.#writeEnabled = options.writeEnabled ?? true;
    this.#publicationEnabled = options.publicationEnabled ?? true;
    this.#createId = options.createId ?? randomUUID;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#model = Object.freeze({
      provider: options.normalizationModel?.provider ?? "openai",
      model: options.normalizationModel?.model ?? "gpt-5",
      temperature: options.normalizationModel?.temperature ?? 0,
    });
  }

  async importReport(input: Readonly<{
    principal: ManualAlexaVocPrincipal;
    request: unknown;
  }>): Promise<ManualAlexaVocWriteResponse> {
    if (!this.#writeEnabled) {
      throw new ManualAlexaVocServiceError(
        "unavailable",
        "Manual Alexa VOC writes are disabled",
      );
    }
    const request = parseImportRequest(input.request);
    const { project, run } = await this.#authorizeImport(input.principal, request);
    assertReportLimits(request.rawText);
    const rawReportSha256 = sha256(Buffer.from(request.rawText, "utf8"));
    const processed = tryProcessReport(request);
    const candidate = processed === null ? null : AlexaVocMatrixRecordSchema.safeParse({
      attention: processed.sections.attention,
      positives: processed.sections.positives,
      negatives: processed.sections.negatives,
      unmet: processed.sections.unmet,
      audiences: normalizeTwoColumnMatrix(processed.sections.audiences, "人群分类｜特征"),
      scenarios: normalizeTwoColumnMatrix(processed.sections.scenarios, "场景｜说明与示例"),
      motives: normalizeThreeColumnMatrix(processed.sections.motives, "动机｜重要性｜说明"),
      captureStatus: "dialog",
      alexaReport: buildAlexaReportHeader(request.asin, processed),
    });
    if (!candidate?.success) {
      return this.#queueNormalization({
        principal: input.principal,
        project,
        run,
        request,
        rawReportSha256,
      });
    }
    const normalizedRecord = ManualAlexaVocNormalizedRecordSchema.parse({
      asin: request.asin,
      ...candidate.data,
    });
    const contentHash = canonicalJsonSha256({
      marketplace: request.marketplace,
      asin: request.asin,
      normalizedSchemaVersion: NORMALIZED_SCHEMA_VERSION,
      parserVersion: PARSER_VERSION,
      normalizedRecord,
      rawReportSha256,
    });
    const scope = {
      organizationId: input.principal.organizationId,
      marketplace: request.marketplace,
      asin: request.asin,
    } as const;

    const result = await this.#repository.transaction(async transactionRepository => {
      const repository = transactionRepository as ManualAlexaVocServiceRepository;
      const trustedProject = await repository.findProjectById(request.projectId);
      const trustedRun = await repository.findAnalysisRun(request.runId);
      if (
        !trustedProject ||
        trustedProject.organizationId !== input.principal.organizationId ||
        trustedProject.marketplace !== request.marketplace ||
        !trustedProject.asins.includes(request.asin) ||
        !trustedRun ||
        trustedRun.projectId !== trustedProject.id
      ) {
        throw new ManualAlexaVocServiceError(
          "forbidden",
          "Project or analysis run scope changed before persistence",
        );
      }
      if (trustedRun.status === "cancelled") {
        throw new ManualAlexaVocServiceError(
          "conflict",
          "Cancelled analysis run cannot accept input",
        );
      }
      await repository.manualAlexaVoc.lockScopes({
        organizationId: scope.organizationId,
        marketplace: scope.marketplace,
        asins: [scope.asin],
      });
      const nextRevision = await repository.manualAlexaVoc.peekNextRevision(scope);
      const raw = this.#cipher.encrypt({
        identity: {
          ...scope,
          revision: nextRevision,
          normalizedSchemaVersion: NORMALIZED_SCHEMA_VERSION,
          parserVersion: PARSER_VERSION,
        },
        plaintext: request.rawText,
      });
      return repository.manualAlexaVoc.put({
        ...scope,
        createdBy: input.principal.userId,
        expectedRevision: nextRevision,
        normalizedRecord,
        normalizedSchemaVersion: NORMALIZED_SCHEMA_VERSION,
        parserVersion: PARSER_VERSION,
        contentHash,
        raw,
      });
    });

    const publication = this.#publicationEnabled
      ? result.publication
      : { status: "disabled" as const, generation: null };
    return ManualAlexaVocWriteResponseSchema.parse({
      disposition: "success",
      record: {
        asin: result.record.asin,
        marketplace: result.record.marketplace,
        revision: result.record.revision,
        contentHash: result.record.contentHash,
        normalizedRecord: result.record.normalizedRecord,
        source: "postgres",
        generation: publication.generation,
        capturedAt: result.record.capturedAt,
      },
      normalization: {
        asin: result.record.asin,
        fingerprint: contentHash,
        status: "success",
        revision: result.record.revision,
        error: null,
      },
    });
  }

  async listReports(input: Readonly<{
    principal: ManualAlexaVocPrincipal;
    query: unknown;
  }>): Promise<ManualAlexaVocListResponse> {
    const query = parseListQuery(input.query);
    const project = await this.#repository.findProjectById(query.projectId);
    if (!project) {
      throw new ManualAlexaVocServiceError("not-found", "Project was not found");
    }
    if (
      project.organizationId !== input.principal.organizationId ||
      project.marketplace !== query.marketplace ||
      query.asins.some(asin => !project.asins.includes(asin))
    ) {
      throw new ManualAlexaVocServiceError("forbidden", "Project scope is not authorized");
    }
    const records = await this.#repository.manualAlexaVoc.listCurrent({
      organizationId: input.principal.organizationId,
      marketplace: query.marketplace,
      asins: query.asins,
    });
    const requestedAsins = new Set(query.asins);
    return ManualAlexaVocListResponseSchema.parse({
      records: records.filter(record =>
        record.organizationId === input.principal.organizationId &&
        record.marketplace === query.marketplace &&
        requestedAsins.has(record.asin),
      ).map(record => ({
        asin: record.asin,
        marketplace: record.marketplace,
        revision: record.revision,
        contentHash: record.contentHash,
        normalizedRecord: record.normalizedRecord,
        source: "postgres",
        generation: null,
        capturedAt: record.capturedAt,
      })),
    });
  }

  async #authorizeImport(
    principal: ManualAlexaVocPrincipal,
    request: ManualAlexaVocImportRequest,
  ): Promise<{ project: ProjectRecord; run: AnalysisRunRecord }> {
    const project = await this.#repository.findProjectById(request.projectId);
    if (!project) {
      throw new ManualAlexaVocServiceError("not-found", "Project was not found");
    }
    if (
      project.organizationId !== principal.organizationId ||
      project.marketplace !== request.marketplace ||
      !project.asins.includes(request.asin)
    ) {
      throw new ManualAlexaVocServiceError("forbidden", "Project scope is not authorized");
    }
    const run = await this.#repository.findAnalysisRun(request.runId);
    if (!run) {
      throw new ManualAlexaVocServiceError("not-found", "Analysis run was not found");
    }
    if (run.projectId !== project.id) {
      throw new ManualAlexaVocServiceError("forbidden", "Analysis run does not belong to project");
    }
    if (run.status === "cancelled") {
      throw new ManualAlexaVocServiceError("conflict", "Cancelled analysis run cannot accept input");
    }
    return { project, run };
  }

  async #queueNormalization(input: Readonly<{
    principal: ManualAlexaVocPrincipal;
    project: ProjectRecord;
    run: AnalysisRunRecord;
    request: ManualAlexaVocImportRequest;
    rawReportSha256: string;
  }>): Promise<ManualAlexaVocWriteResponse> {
    if (!this.#normalizationInputCipher) {
      throw new ManualAlexaVocServiceError(
        "unavailable",
        "Alexa normalization encryption is unavailable",
      );
    }
    const snapshotId = this.#createId();
    const executionFingerprint = canonicalJsonSha256({
      rawReportSha256: input.rawReportSha256,
      parser: { id: "deterministic-alexa-parser", version: PARSER_VERSION },
      skill: ALEXA_SKILL,
      schemaDigest: MATRIX_SCHEMA_DIGEST,
      model: this.#model,
    });
    const identity: AlexaVocNormalizationInputCipherIdentity = {
      organizationId: input.principal.organizationId,
      projectId: input.project.id,
      runId: input.run.id,
      snapshotId,
      marketplace: input.request.marketplace,
      asin: input.request.asin,
      schema: NORMALIZATION_INPUT_SCHEMA,
    };
    const envelope = this.#normalizationInputCipher.encrypt({
      identity,
      plaintext: input.request.rawText,
    });
    const queued = await this.#repository.transaction(async transactionRepository => {
      const repository = transactionRepository as ManualAlexaVocServiceRepository;
      return repository.manualAlexaVoc.queueNormalizationInput({
        actorUserId: input.principal.userId,
        actorOrganizationId: input.principal.organizationId,
        projectId: input.project.id,
        runId: input.run.id,
        marketplace: input.request.marketplace,
        asin: input.request.asin,
        snapshotId,
        stageId: this.#createId(),
        jobId: this.#createId(),
        rawReportSha256: input.rawReportSha256,
        plaintextBytes: Buffer.byteLength(input.request.rawText, "utf8"),
        executionFingerprint,
        envelope,
        queuedAt: this.#now(),
      });
    });
    return ManualAlexaVocWriteResponseSchema.parse({
      disposition: "pending",
      record: null,
      normalization: {
        asin: queued.snapshot.asin,
        fingerprint: queued.snapshot.executionFingerprint,
        status: "pending",
        revision: null,
        error: null,
      },
    });
  }
}

function parseImportRequest(value: unknown): ManualAlexaVocImportRequest {
  const parsed = ManualAlexaVocImportRequestSchema.safeParse(value);
  if (!parsed.success) {
    throw new ManualAlexaVocServiceError("validation", "Request validation failed");
  }
  const bytes = Buffer.byteLength(parsed.data.rawText, "utf8");
  if (bytes > 128 * 1024) {
    throw new ManualAlexaVocServiceError("too-large", "Alexa report is too large");
  }
  return parsed.data;
}

function parseListQuery(value: unknown): ManualAlexaVocListQuery {
  const parsed = ManualAlexaVocListQuerySchema.safeParse(value);
  if (!parsed.success) {
    throw new ManualAlexaVocServiceError("validation", "Request validation failed");
  }
  return parsed.data;
}

function assertReportLimits(rawText: string): void {
  try {
    validateAlexaVocReportLimits(rawText);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("report_limits_")) {
      throw new ManualAlexaVocServiceError("too-large", "Alexa report is too large");
    }
    throw error;
  }
}

function tryProcessReport(request: ManualAlexaVocImportRequest) {
  try {
    const processed = processAlexaVocText(request.rawText, request.asin, {
      reviewCount: 0,
      rating: 0,
      bindAsinHint: true,
    });
    if (processed.reportAsin && processed.reportAsin !== request.asin) return null;
    return processed;
  } catch {
    return null;
  }
}

function buildAlexaReportHeader(
  asin: string,
  processed: NonNullable<ReturnType<typeof tryProcessReport>>,
) {
  return {
    title: "顾客评价深度分析" as const,
    asin,
    rating: processed.rating ?? 0,
    reviewCount: processed.reviewCount ?? 0,
    ...(processed.starBreakdown ? { starBreakdown: processed.starBreakdown } : {}),
    prompt: MANUAL_ALEXA_VOC_SEVEN_QUESTION_PROMPT,
    overallConclusion:
      processed.overallConclusion ||
      "Alexa 七问报告已录入，总体结论待人工补全。",
    captureStatus: "dialog" as const,
  };
}

function normalizeTwoColumnMatrix(rows: readonly string[], header: string): string[] {
  const data = rows.filter((row, index) => index > 0 || !row.includes("｜"));
  const normalized = data
    .map(row => row.split("｜").map(cell => cell.trim()).filter(Boolean))
    .filter(parts => parts.length >= 2)
    .map(parts => `${parts[0]}｜${parts.slice(1).join(" · ")}`);
  return normalized.length ? [header, ...normalized] : [];
}

function normalizeThreeColumnMatrix(rows: readonly string[], header: string): string[] {
  const data = rows.filter((row, index) => index > 0 || row !== header);
  const normalized = data
    .map(row => row.split("｜").map(cell => cell.trim()))
    .filter(parts => parts.length >= 3 && parts.slice(0, 3).every(Boolean))
    .map(parts => `${parts[0]}｜${parts[1]}｜${parts.slice(2).join(" · ")}`);
  return normalized.length ? [header, ...normalized] : [];
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
