import {
  EntityIdSchema,
  ManualAlexaVocNormalizedRecordSchema,
  Sha256Schema,
} from "../../shared/agent-contracts";
import type {
  AlexaVocNormalizationInputSnapshot,
  ManualAlexaVocRevision,
} from "../db/manual-alexa-voc-repository";
import {
  ALEXA_VOC_NORMALIZATION_SKILL,
  ALEXA_VOC_FACTS_ONLY_INSTRUCTION,
  AlexaVocNormalizationFactsSchemaDigest,
  AlexaVocNormalizationExecutionIdentitySchema,
  AlexaVocNormalizationInputSchema,
  AlexaVocNormalizationOutputSchema,
  canonicalizeAlexaVocNormalizationOutputRecord,
  createAlexaVocNormalizationFingerprint,
} from "../domain/voc/alexa-voc-normalization-contracts";
import type {
  AuditedSkillExecutionContext,
  AuditedSkillExecutionResult,
} from "../runtime/agent-run-service";
import type {
  ModelExecutionConfig,
  SkillExecutionRequest,
} from "../runtime/skill-runner";
import type { AlexaVocNormalizationInputCipher } from "../security/alexa-voc-normalization-input-cipher";

export interface AlexaVocNormalizationExecutionRequest {
  readonly snapshotId: string;
  readonly providerName: string;
  readonly model: ModelExecutionConfig;
  readonly signal?: AbortSignal;
}

export interface AlexaVocNormalizationExecutionContext
  extends AuditedSkillExecutionContext {
  readonly actorId: string;
  readonly logicalExecutionCycleId: string;
}

export interface AlexaVocNormalizationExecutionResult {
  readonly revision: ManualAlexaVocRevision;
  readonly agentRunId: string;
  readonly replayed: boolean;
}

export interface AlexaVocNormalizationCommitInput {
  readonly actorId: string;
  readonly actorOrganizationId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly stageId: string;
  readonly jobAttemptId: string;
  readonly leaseOwnerId: string;
  readonly leaseGeneration: number;
  readonly snapshotId: string;
  readonly agentRunId: string;
  readonly asin: string;
  readonly marketplace: "US";
  readonly contentHash: string;
  readonly rawReportSha256: string;
  readonly rawReportPlaintextBytes: number;
  readonly capturedAt: string;
  readonly normalizedRecord: ReturnType<
    typeof ManualAlexaVocNormalizedRecordSchema.parse
  >;
  readonly normalizedSchemaVersion: "alexa-voc-record/v2";
  readonly parserVersion: "deterministic-alexa-parser/v3";
  readonly schemaDigest: string;
  readonly skill: typeof ALEXA_VOC_NORMALIZATION_SKILL;
  readonly model: ModelExecutionConfig;
}

export interface AlexaVocNormalizationExecutionRepository {
  findNormalizationInputSnapshot(input: Readonly<{
    actorOrganizationId: string;
    snapshotId: string;
  }>): Promise<AlexaVocNormalizationInputSnapshot | null>;
  findCommittedNormalizationByFingerprint(input: Readonly<{
    actorOrganizationId: string;
    marketplace: "US";
    asin: string;
    executionFingerprint: string;
  }>): Promise<ManualAlexaVocRevision | null>;
  commitNormalizationAndWake(input: AlexaVocNormalizationCommitInput): Promise<
    Readonly<{ revision: ManualAlexaVocRevision; wakeCreated: boolean }>
  >;
}

interface AlexaVocNormalizationAuditedRunner {
  run<I, O>(
    request: SkillExecutionRequest<I, O>,
    context: AuditedSkillExecutionContext,
  ): Promise<AuditedSkillExecutionResult<O>>;
}

export class AlexaVocNormalizationExecutionService {
  readonly #repository: AlexaVocNormalizationExecutionRepository;
  readonly #normalizationInputCipher: AlexaVocNormalizationInputCipher;
  readonly #auditedRunner: AlexaVocNormalizationAuditedRunner;

  constructor(dependencies: Readonly<{
    repository: AlexaVocNormalizationExecutionRepository;
    normalizationInputCipher: AlexaVocNormalizationInputCipher;
    auditedRunner: AlexaVocNormalizationAuditedRunner;
  }>) {
    this.#repository = dependencies.repository;
    this.#normalizationInputCipher = dependencies.normalizationInputCipher;
    this.#auditedRunner = dependencies.auditedRunner;
  }

  async execute(
    request: AlexaVocNormalizationExecutionRequest,
    context: AlexaVocNormalizationExecutionContext,
  ): Promise<AlexaVocNormalizationExecutionResult> {
    const snapshotId = EntityIdSchema.parse(request.snapshotId);
    const organizationId = EntityIdSchema.parse(context.organizationId);
    const snapshot = await this.#repository.findNormalizationInputSnapshot({
      actorOrganizationId: organizationId,
      snapshotId,
    });
    if (
      !snapshot ||
      snapshot.organizationId !== organizationId ||
      snapshot.projectId !== context.projectId ||
      snapshot.runId !== context.runId
    ) {
      throw new Error("Alexa normalization snapshot scope conflicts with execution authority");
    }
    const fingerprint = Sha256Schema.parse(snapshot.executionFingerprint);
    const rawText = this.#normalizationInputCipher.decrypt({
      identity: {
        organizationId,
        projectId: snapshot.projectId,
        runId: snapshot.runId,
        snapshotId: snapshot.id,
        marketplace: snapshot.marketplace,
        asin: snapshot.asin,
        schema: "alexa-voc-normalization-input/v1",
      },
      envelope: snapshot.envelope,
    });
    const declaredIdentity = AlexaVocNormalizationExecutionIdentitySchema.parse(
      snapshot.executionIdentity,
    );
    const actualIdentity = AlexaVocNormalizationExecutionIdentitySchema.parse({
      providerName: request.providerName,
      model: request.model,
    });
    const declaredFingerprint = createAlexaVocNormalizationFingerprint({
      rawReportSha256: snapshot.rawReportSha256,
      executionIdentity: declaredIdentity,
    });
    const actualFingerprint = createAlexaVocNormalizationFingerprint({
      rawReportSha256: snapshot.rawReportSha256,
      executionIdentity: actualIdentity,
    });
    if (fingerprint !== declaredFingerprint || fingerprint !== actualFingerprint) {
      throw new Error("Alexa normalization execution identity conflicts with input snapshot");
    }
    const input = AlexaVocNormalizationInputSchema.parse({
      schemaVersion: "1.0.0",
      kind: "alexa-voc-normalization-input",
      marketplace: snapshot.marketplace,
      asin: snapshot.asin,
      rawText,
      normalizationInstructions: ALEXA_VOC_FACTS_ONLY_INSTRUCTION,
      knownMeta: {
        rating: null,
        reviewCount: null,
        capturedAt: snapshot.createdAt,
        captureMode: "automatic",
      },
    });
    const audited = await this.#auditedRunner.run({
      skill: {
        id: ALEXA_VOC_NORMALIZATION_SKILL.id,
        version: ALEXA_VOC_NORMALIZATION_SKILL.version,
      },
      inputContract: {
        name: "AlexaVocNormalizationInput@1.0.0",
        schema: AlexaVocNormalizationInputSchema,
        allowedFields: [
          "schemaVersion",
          "kind",
          "marketplace",
          "asin",
          "rawText",
          "normalizationInstructions",
          "knownMeta",
        ],
      },
      outputContract: {
        name: "AlexaVocNormalizationOutput@1.1.0",
        schema: AlexaVocNormalizationOutputSchema,
      },
      input,
      snapshotIds: [snapshot.id],
      model: request.model,
      executionFingerprint: fingerprint,
      ...(request.signal ? { signal: request.signal } : {}),
    }, { ...context, executionLineage: "stage-input" });
    if (audited.agentRun.executionFingerprint !== fingerprint) {
      throw new Error("Alexa normalization audit fingerprint conflicts with input snapshot");
    }
    const output = AlexaVocNormalizationOutputSchema.parse(audited.value);
    const normalizedRecord = ManualAlexaVocNormalizedRecordSchema.parse(
      canonicalizeAlexaVocNormalizationOutputRecord(output.record, {
        asin: snapshot.asin,
        rawText,
        knownMeta: input.knownMeta,
      }),
    );
    const committed = await this.#repository.commitNormalizationAndWake({
      actorId: context.actorId,
      actorOrganizationId: organizationId,
      projectId: snapshot.projectId,
      runId: snapshot.runId,
      stageId: context.stageId,
      jobAttemptId: context.jobAttemptId,
      leaseOwnerId: context.leaseOwnerId,
      leaseGeneration: context.leaseGeneration,
      snapshotId: snapshot.id,
      agentRunId: audited.agentRun.id,
      asin: snapshot.asin,
      marketplace: snapshot.marketplace,
      contentHash: fingerprint,
      rawReportSha256: snapshot.rawReportSha256,
      rawReportPlaintextBytes: snapshot.plaintextBytes,
      capturedAt: context.dataCutoffAt,
      normalizedRecord,
      normalizedSchemaVersion: "alexa-voc-record/v2",
      parserVersion: "deterministic-alexa-parser/v3",
      schemaDigest: AlexaVocNormalizationFactsSchemaDigest,
      skill: ALEXA_VOC_NORMALIZATION_SKILL,
      model: request.model,
    });
    return Object.freeze({
      revision: committed.revision,
      agentRunId: audited.agentRun.id,
      replayed: audited.replayed || !committed.wakeCreated,
    });
  }
}
