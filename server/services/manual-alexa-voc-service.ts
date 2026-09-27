import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";

import {
  MANUAL_ALEXA_VOC_SEVEN_QUESTION_PROMPT,
  AlexaVocNormalizationStatusQuerySchema,
  AlexaVocNormalizationStatusResponseSchema,
  ManualAlexaVocImportRequestSchema,
  ManualAlexaVocListQuerySchema,
  ManualAlexaVocListResponseSchema,
  ManualAlexaVocNormalizedRecordSchema,
  ManualAlexaVocWriteResponseSchema,
  type ManualAlexaVocImportRequest,
  type AlexaVocNormalizationStatusQuery,
  type AlexaVocNormalizationStatusResponse,
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
import {
  AlexaVocMatrixRecordSchema,
  AlexaVocNormalizationExecutionIdentitySchema,
  createAlexaVocNormalizationFingerprint,
  type AlexaVocNormalizationExecutionIdentity,
} from "../domain/voc/alexa-voc-normalization-contracts";
import { canonicalJsonSha256 } from "../runtime/model-request-accounting";
import {
  publishCumulativeVocSnapshotAndWake,
  type AlexaVocCumulativePublicationInput,
  type VocPositioningMode,
} from "../runtime/alexa-voc-normalization-runtime";
import type {
  AlexaVocNormalizationInputCipher,
  AlexaVocNormalizationInputCipherIdentity,
} from "../security/alexa-voc-normalization-input-cipher";
import type { ManualAlexaVocCipher } from "../security/manual-alexa-voc-cipher";

const NORMALIZED_SCHEMA_VERSION = "alexa-voc-record/v2" as const;
const PARSER_VERSION = "deterministic-alexa-parser/v3" as const;
const NORMALIZATION_INPUT_SCHEMA = "alexa-voc-normalization-input/v1" as const;

export type ManualAlexaVocPrincipal = Readonly<{
  organizationId: string;
  userId: string;
}>;

export class ManualAlexaVocServiceError extends Error {
  constructor(
    readonly kind: "validation" | "too-large" | "incomplete" | "asin-mismatch" | "unavailable" | "forbidden" | "not-found" | "conflict",
    message: string,
  ) {
    super(message);
    this.name = "ManualAlexaVocServiceError";
  }
}

type ManualAlexaVocServiceRepository = AgentRepository &
  ManualAlexaVocRepositoryCapability;
type CumulativePublisher = (
  repository: ManualAlexaVocServiceRepository,
  input: AlexaVocCumulativePublicationInput,
) => Promise<Readonly<{ snapshotCreated: boolean; wakeCreated: boolean }>>;

export class ManualAlexaVocService {
  readonly #repository: ManualAlexaVocServiceRepository;
  readonly #cipher: ManualAlexaVocCipher;
  readonly #normalizationInputCipher: AlexaVocNormalizationInputCipher | null;
  readonly #writeEnabled: boolean;
  readonly #publicationEnabled: boolean;
  readonly #positioningMode: VocPositioningMode;
  readonly #createId: () => string;
  readonly #now: () => string;
  readonly #executionIdentity: AlexaVocNormalizationExecutionIdentity | null;
  readonly #publishCumulativeVocSnapshotAndWake: CumulativePublisher;

  constructor(options: Readonly<{
    repository: ManualAlexaVocServiceRepository;
    cipher: ManualAlexaVocCipher;
    normalizationInputCipher?: AlexaVocNormalizationInputCipher;
    writeEnabled?: boolean;
    publicationEnabled?: boolean;
    positioningMode?: VocPositioningMode;
    createId?: () => string;
    now?: () => string;
    normalizationExecutionIdentity?: AlexaVocNormalizationExecutionIdentity | null;
    publishCumulativeVocSnapshotAndWake?: CumulativePublisher;
  }>) {
    this.#repository = options.repository;
    this.#cipher = options.cipher;
    this.#normalizationInputCipher = options.normalizationInputCipher ?? null;
    this.#writeEnabled = options.writeEnabled ?? true;
    this.#publicationEnabled = options.publicationEnabled ?? true;
    this.#positioningMode = options.positioningMode ?? "local-rules";
    this.#createId = options.createId ?? randomUUID;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#executionIdentity = options.normalizationExecutionIdentity
      ? AlexaVocNormalizationExecutionIdentitySchema.parse(options.normalizationExecutionIdentity)
      : null;
    this.#publishCumulativeVocSnapshotAndWake = options.publishCumulativeVocSnapshotAndWake ??
      ((repository, input) => publishCumulativeVocSnapshotAndWake(repository as never, input));
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
    await this.#authorizeImport(input.principal, request);
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
      const write = await repository.manualAlexaVoc.put({
        ...scope,
        createdBy: input.principal.userId,
        expectedRevision: nextRevision,
        normalizedRecord,
        normalizedSchemaVersion: NORMALIZED_SCHEMA_VERSION,
        parserVersion: PARSER_VERSION,
        contentHash,
        raw,
        capturedAt: trustedRun.dataCutoffAt,
      });
      await this.#publishCumulativeVocSnapshotAndWake(repository, {
        positioningMode: this.#positioningMode,
        actorId: input.principal.userId,
        actorOrganizationId: input.principal.organizationId,
        projectId: trustedProject.id,
        runId: trustedRun.id,
        asins: trustedProject.asins,
        dataCutoffAt: trustedRun.dataCutoffAt,
        createdAt: this.#now(),
      });
      return write;
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

  async getNormalizationStatus(input: Readonly<{
    principal: ManualAlexaVocPrincipal;
    query: unknown;
  }>): Promise<AlexaVocNormalizationStatusResponse> {
    const query = parseNormalizationStatusQuery(input.query);
    const project = await this.#repository.findProjectById(query.projectId);
    if (!project) {
      throw new ManualAlexaVocServiceError("not-found", "Project was not found");
    }
    if (
      project.organizationId !== input.principal.organizationId
      || project.marketplace !== query.marketplace
      || query.asins.some((asin) => !project.asins.includes(asin))
    ) {
      throw new ManualAlexaVocServiceError("forbidden", "Project scope is not authorized");
    }
    const run = await this.#repository.findAnalysisRun(query.runId);
    if (!run) {
      throw new ManualAlexaVocServiceError("not-found", "Analysis run was not found");
    }
    if (run.projectId !== project.id) {
      throw new ManualAlexaVocServiceError("forbidden", "Analysis run does not belong to project");
    }
    const requestedAsins = new Set(query.asins);
    const records = await this.#repository.manualAlexaVoc.listNormalizationStatuses({
      actorOrganizationId: input.principal.organizationId,
      projectId: project.id,
      runId: run.id,
      marketplace: query.marketplace,
      asins: query.asins,
    });
    return AlexaVocNormalizationStatusResponseSchema.parse({
      records: records.filter((record) => requestedAsins.has(record.asin)),
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
    request: ManualAlexaVocImportRequest;
    rawReportSha256: string;
  }>): Promise<ManualAlexaVocWriteResponse> {
    if (!this.#normalizationInputCipher || !this.#executionIdentity) {
      throw new ManualAlexaVocServiceError(
        "unavailable",
        "Alexa normalization encryption is unavailable",
      );
    }
    const normalizationInputCipher = this.#normalizationInputCipher;
    const executionIdentity = this.#executionIdentity;
    const executionFingerprint = createAlexaVocNormalizationFingerprint({
      marketplace: input.request.marketplace,
      asin: input.request.asin,
      rawReportSha256: input.rawReportSha256,
      executionIdentity,
    });
    const result = await this.#repository.transaction(async transactionRepository => {
      const repository = transactionRepository as ManualAlexaVocServiceRepository;
      const trustedProject = await repository.findProjectById(input.request.projectId);
      const trustedRun = await repository.findAnalysisRun(input.request.runId);
      if (
        !trustedProject ||
        trustedProject.organizationId !== input.principal.organizationId ||
        trustedProject.marketplace !== input.request.marketplace ||
        !trustedProject.asins.includes(input.request.asin) ||
        !trustedRun ||
        trustedRun.projectId !== trustedProject.id
      ) {
        throw new ManualAlexaVocServiceError(
          "forbidden",
          "Project or analysis run scope changed before normalization",
        );
      }
      if (trustedRun.status === "cancelled") {
        throw new ManualAlexaVocServiceError(
          "conflict",
          "Cancelled analysis run cannot accept input",
        );
      }
      const committed = await repository.manualAlexaVoc.findCommittedNormalizationByFingerprint({
        actorOrganizationId: input.principal.organizationId,
        marketplace: input.request.marketplace,
        asin: input.request.asin,
        executionFingerprint,
        dataCutoffAt: trustedRun.dataCutoffAt,
      });
      if (committed) {
        await this.#publishCumulativeVocSnapshotAndWake(repository, {
          positioningMode: this.#positioningMode,
          actorId: input.principal.userId,
          actorOrganizationId: input.principal.organizationId,
          projectId: trustedProject.id,
          runId: trustedRun.id,
          asins: trustedProject.asins,
          dataCutoffAt: trustedRun.dataCutoffAt,
          createdAt: this.#now(),
        });
        return Object.freeze({ kind: "committed" as const, record: committed });
      }

      const snapshotId = this.#createId();
      const identity: AlexaVocNormalizationInputCipherIdentity = {
        organizationId: input.principal.organizationId,
        projectId: trustedProject.id,
        runId: trustedRun.id,
        snapshotId,
        marketplace: input.request.marketplace,
        asin: input.request.asin,
        schema: NORMALIZATION_INPUT_SCHEMA,
      };
      const envelope = normalizationInputCipher.encrypt({
        identity,
        plaintext: input.request.rawText,
      });
      const queued = await repository.manualAlexaVoc.queueNormalizationInput({
        actorUserId: input.principal.userId,
        actorOrganizationId: input.principal.organizationId,
        projectId: trustedProject.id,
        runId: trustedRun.id,
        marketplace: input.request.marketplace,
        asin: input.request.asin,
        snapshotId,
        stageId: this.#createId(),
        jobId: this.#createId(),
        rawReportSha256: input.rawReportSha256,
        plaintextBytes: Buffer.byteLength(input.request.rawText, "utf8"),
        executionFingerprint,
        executionIdentity,
        envelope,
        queuedAt: this.#now(),
      });
      return Object.freeze({ kind: "queued" as const, queued });
    });
    if (result.kind === "committed") {
      return ManualAlexaVocWriteResponseSchema.parse({
        disposition: "success",
        record: {
          asin: result.record.asin,
          marketplace: result.record.marketplace,
          revision: result.record.revision,
          contentHash: result.record.contentHash,
          normalizedRecord: result.record.normalizedRecord,
          source: "postgres",
          generation: null,
          capturedAt: result.record.capturedAt,
        },
        normalization: {
          asin: result.record.asin,
          fingerprint: executionFingerprint,
          status: "success",
          revision: result.record.revision,
          error: null,
        },
      });
    }
    const queued = result.queued;
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

function parseNormalizationStatusQuery(value: unknown): AlexaVocNormalizationStatusQuery {
  const parsed = AlexaVocNormalizationStatusQuerySchema.safeParse(value);
  if (!parsed.success) {
    throw new ManualAlexaVocServiceError("validation", "Request validation failed");
  }
  return parsed.data;
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
