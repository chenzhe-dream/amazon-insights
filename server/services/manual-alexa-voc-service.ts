import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

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
  ManualAlexaVocRepositoryCapability,
} from "../db/repository";
import { canonicalJsonSha256 } from "../runtime/model-request-accounting";
import type { ManualAlexaVocCipher } from "../security/manual-alexa-voc-cipher";

const NORMALIZED_SCHEMA_VERSION = "alexa-voc-record/v2" as const;
const PARSER_VERSION = "deterministic-alexa-parser/v3" as const;

export type ManualAlexaVocPrincipal = Readonly<{
  organizationId: string;
  userId: string;
}>;

export class ManualAlexaVocServiceError extends Error {
  constructor(
    readonly kind: "validation" | "too-large" | "incomplete",
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

  constructor(options: Readonly<{
    repository: ManualAlexaVocServiceRepository;
    cipher: ManualAlexaVocCipher;
  }>) {
    this.#repository = options.repository;
    this.#cipher = options.cipher;
  }

  async importReport(input: Readonly<{
    principal: ManualAlexaVocPrincipal;
    request: unknown;
  }>): Promise<ManualAlexaVocWriteResponse> {
    const request = parseImportRequest(input.request);
    const processed = parseReport(request);
    const normalized = ManualAlexaVocNormalizedRecordSchema.safeParse({
      asin: request.asin,
      ...processed.sections,
      captureStatus: "dialog",
      alexaReport: {
        title: "顾客评价深度分析",
        asin: request.asin,
        rating: processed.rating ?? 0,
        reviewCount: processed.reviewCount ?? 0,
        ...(processed.starBreakdown
          ? { starBreakdown: processed.starBreakdown }
          : {}),
        prompt: MANUAL_ALEXA_VOC_SEVEN_QUESTION_PROMPT,
        overallConclusion:
          processed.overallConclusion ||
          "Alexa 七问报告已录入，总体结论待人工补全。",
        captureStatus: "dialog",
      },
    });
    if (!normalized.success) {
      throw new ManualAlexaVocServiceError(
        "incomplete",
        "Alexa report normalized data is invalid",
      );
    }
    const normalizedRecord = normalized.data;
    const rawReportSha256 = sha256(Buffer.from(request.rawText, "utf8"));
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

    return ManualAlexaVocWriteResponseSchema.parse({
      record: {
        asin: result.record.asin,
        marketplace: result.record.marketplace,
        revision: result.record.revision,
        contentHash: result.record.contentHash,
        normalizedRecord: result.record.normalizedRecord,
        source: "postgres",
        generation: result.publication.generation,
        capturedAt: result.record.capturedAt,
      },
    });
  }

  async listReports(input: Readonly<{
    principal: ManualAlexaVocPrincipal;
    query: unknown;
  }>): Promise<ManualAlexaVocListResponse> {
    const query = parseListQuery(input.query);
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

function parseReport(request: ManualAlexaVocImportRequest) {
  try {
    validateAlexaVocReportLimits(request.rawText);
    const processed = processAlexaVocText(request.rawText, request.asin, {
      reviewCount: 0,
      rating: 0,
    });
    if (processed.reportAsin !== request.asin) {
      throw new ManualAlexaVocServiceError(
        "incomplete",
        "Alexa report ASIN does not match the requested ASIN",
      );
    }
    if (processed.filled < 3) {
      throw new ManualAlexaVocServiceError(
        "incomplete",
        "Alexa report must contain at least three valid dimensions",
      );
    }
    return processed;
  } catch (error) {
    if (error instanceof ManualAlexaVocServiceError) throw error;
    if (error instanceof Error && error.message === "report_limits_bytes") {
      throw new ManualAlexaVocServiceError("too-large", "Alexa report is too large");
    }
    throw new ManualAlexaVocServiceError(
      "incomplete",
      "Alexa report is invalid",
    );
  }
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
