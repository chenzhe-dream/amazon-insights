import type {
  AlexaVocNormalizationStatus,
  ManualAlexaVocNormalizedRecord,
} from "../../shared/agent-contracts";
import type { ManualAlexaVocEncryptedRaw } from "../security/manual-alexa-voc-cipher";
import type { AlexaVocNormalizationInputEncryptedEnvelope } from "../security/alexa-voc-normalization-input-cipher";
import type { AlexaVocNormalizationExecutionIdentity } from "../domain/voc/alexa-voc-normalization-contracts";
import { canonicalJsonSha256 } from "../runtime/model-request-accounting";

export type ManualAlexaVocMarketplace = "US";

export type ManualAlexaVocScope = Readonly<{
  organizationId: string;
  marketplace: ManualAlexaVocMarketplace;
  asin: string;
}>;

export type ManualAlexaVocRevision = ManualAlexaVocScope &
  Readonly<{
    revision: string;
    contentHash: string;
    capturedAt: string;
    normalizedRecord: ManualAlexaVocNormalizedRecord;
    normalizedSchemaVersion: "alexa-voc-record/v2";
    parserVersion: "deterministic-alexa-parser/v3";
  }>;

export type PutManualAlexaVocInput = ManualAlexaVocScope &
  Readonly<{
    createdBy: string;
    expectedRevision: string;
    normalizedRecord: ManualAlexaVocNormalizedRecord;
    normalizedSchemaVersion: "alexa-voc-record/v2";
    parserVersion: "deterministic-alexa-parser/v3";
    contentHash: string;
    raw: ManualAlexaVocEncryptedRaw;
    capturedAt?: string;
  }>;

export type PutCommittedAlexaVocNormalizationInput = ManualAlexaVocScope &
  Readonly<{
    createdBy: string;
    expectedRevision: string;
    normalizedRecord: ManualAlexaVocNormalizedRecord;
    normalizedSchemaVersion: "alexa-voc-record/v2";
    parserVersion: "deterministic-alexa-parser/v3";
    contentHash: string;
    rawReportSha256: string;
    rawReportPlaintextBytes: number;
    capturedAt: string;
  }>;

export type ManualAlexaVocWriteResult = Readonly<{
  record: ManualAlexaVocRevision;
  idempotent: boolean;
  publication: Readonly<{
    status: "pending" | "deduplicated" | "disabled";
    generation: string | null;
  }>;
}>;

export type CommittedAlexaVocNormalizationReplay = Readonly<{
  revision: ManualAlexaVocRevision;
  agentRunId: string;
}>;

export type AlexaVocNormalizationInputSnapshot = Readonly<{
  id: string;
  organizationId: string;
  projectId: string;
  runId: string;
  marketplace: "US";
  asin: string;
  rawReportSha256: string;
  plaintextBytes: number;
  executionFingerprint: string;
  executionIdentity: AlexaVocNormalizationExecutionIdentity;
  envelope: AlexaVocNormalizationInputEncryptedEnvelope;
  createdAt: string;
}>;

export type QueueAlexaVocNormalizationInput = Readonly<{
  actorUserId: string;
  actorOrganizationId: string;
  projectId: string;
  runId: string;
  marketplace: "US";
  asin: string;
  snapshotId: string;
  stageId: string;
  jobId: string;
  rawReportSha256: string;
  plaintextBytes: number;
  executionFingerprint: string;
  executionIdentity: AlexaVocNormalizationExecutionIdentity;
  envelope: AlexaVocNormalizationInputEncryptedEnvelope;
  queuedAt: string;
}>;

export type QueueAlexaVocNormalizationResult = Readonly<{
  snapshot: AlexaVocNormalizationInputSnapshot;
  snapshotCreated: boolean;
  stageId: string;
  jobId: string;
  jobCreated: boolean;
}>;

export type AlexaVocNormalizationTerminalCategory =
  | "model-output"
  | "schema"
  | "persistence"
  | "authorization";

export type AlexaVocNormalizationTerminal = Readonly<{
  snapshotId: string;
  runId: string;
  jobAttemptId: string;
  agentRunId: string | null;
  asin: string;
  executionFingerprint: string;
  status: "success" | "failure";
  category: AlexaVocNormalizationTerminalCategory | null;
  completedAt: string;
}>;

export type PutAlexaVocNormalizationTerminalInput =
  AlexaVocNormalizationTerminal;

export type RunCreationClaimInput = Readonly<{
  organizationId: string;
  idempotencyKey: string;
  fingerprint: string;
}>;

export type RunCreationClaim =
  | Readonly<{ kind: "winner" }>
  | Readonly<{ kind: "replay"; runId: string; snapshotId: string }>
  | Readonly<{ kind: "conflict"; code: "IDEMPOTENCY_KEY_REUSED" }>;

export type RunCreationCompleteInput = RunCreationClaimInput &
  Readonly<{
    runId: string;
    snapshotId: string;
    completedAt: string;
  }>;

export type RunCreationFingerprintInput = Readonly<{
  organizationId: string;
  projectId: string;
  marketplace: "US";
  asins: readonly string[];
  mode: "existing-data" | "collect-missing";
}>;

export function createRunCreationFingerprint(
  input: RunCreationFingerprintInput,
): string {
  const immutableProjectScopeHash = canonicalJsonSha256({
    organizationId: input.organizationId,
    marketplace: input.marketplace,
    asins: [...input.asins],
  });
  return canonicalJsonSha256({
    projectId: input.projectId,
    mode: input.mode,
    immutableProjectScopeHash,
  });
}

export type ManualAlexaVocOutboxLease = Readonly<{
  organizationId: string;
  marketplace: "US";
  asin: string;
  revision: string;
  contentHash: string;
  generation: string;
  leaseGeneration: string;
  leaseOwner: string;
  leaseExpiresAt: string;
}>;

export type ManualAlexaVocRawAccessPurpose =
  | "create"
  | "decrypt"
  | "reparse"
  | "export"
  | "key-rewrap"
  | "delete-policy";

export type ManualAlexaVocRawAccessResult =
  | "succeeded"
  | "denied"
  | "failed";

export type ManualAlexaVocRawEnvelopeRecord = ManualAlexaVocScope &
  Readonly<{
    revision: string;
    contentHash: string;
    capturedAt: string;
    normalizedSchemaVersion: "alexa-voc-record/v2";
    parserVersion: "deterministic-alexa-parser/v3";
    raw: ManualAlexaVocEncryptedRaw;
  }>;

export type ManualAlexaVocRawAccessAuditEvent = ManualAlexaVocScope &
  Readonly<{
    id: string;
    revision: string | null;
    actorUserId: string;
    purpose: ManualAlexaVocRawAccessPurpose;
    result: ManualAlexaVocRawAccessResult;
    occurredAt: string;
  }>;

export interface ManualAlexaVocRepository {
  listNormalizationStatuses(input: Readonly<{
    actorOrganizationId: string;
    projectId: string;
    runId: string;
    marketplace: "US";
    asins: readonly string[];
  }>): Promise<readonly AlexaVocNormalizationStatus[]>;
  queueNormalizationInput(
    input: QueueAlexaVocNormalizationInput,
  ): Promise<QueueAlexaVocNormalizationResult>;
  findNormalizationInputByFingerprint(input: Readonly<{
    actorOrganizationId: string;
    projectId: string;
    runId: string;
    marketplace: "US";
    asin: string;
    executionFingerprint: string;
  }>): Promise<AlexaVocNormalizationInputSnapshot | null>;
  findNormalizationInputSnapshot(input: Readonly<{
    actorOrganizationId: string;
    snapshotId: string;
  }>): Promise<AlexaVocNormalizationInputSnapshot | null>;
  listNormalizationInputSnapshots(input: Readonly<{
    actorOrganizationId: string;
    projectId: string;
    runId: string;
  }>): Promise<readonly AlexaVocNormalizationInputSnapshot[]>;
  lockNormalizationRunAndStage(input: Readonly<{
    runId: string;
  }>): Promise<void>;
  findCommittedNormalizationReplayByFingerprint(input: Readonly<{
    actorOrganizationId: string;
    marketplace: "US";
    asin: string;
    executionFingerprint: string;
    dataCutoffAt?: string;
  }>): Promise<CommittedAlexaVocNormalizationReplay | null>;
  findCommittedNormalizationByFingerprint(input: Readonly<{
    actorOrganizationId: string;
    marketplace: "US";
    asin: string;
    executionFingerprint: string;
    dataCutoffAt?: string;
  }>): Promise<ManualAlexaVocRevision | null>;
  listNormalizationTerminals(input: Readonly<{
    actorOrganizationId: string;
    projectId: string;
    runId: string;
  }>): Promise<readonly AlexaVocNormalizationTerminal[]>;
  putNormalizationTerminal(
    input: PutAlexaVocNormalizationTerminalInput,
  ): Promise<AlexaVocNormalizationTerminal>;
  putCommittedNormalization(
    input: PutCommittedAlexaVocNormalizationInput,
  ): Promise<ManualAlexaVocWriteResult>;
  put(input: PutManualAlexaVocInput): Promise<ManualAlexaVocWriteResult>;
  getCurrent(input: ManualAlexaVocScope): Promise<ManualAlexaVocRevision | null>;
  listCurrent(input: Readonly<{
    organizationId: string;
    marketplace: "US";
    asins: readonly string[];
  }>): Promise<readonly ManualAlexaVocRevision[]>;
  listAtCutoff(input: Readonly<{
    organizationId: string;
    marketplace: "US";
    asins: readonly string[];
    dataCutoffAt: string;
  }>): Promise<readonly ManualAlexaVocRevision[]>;
  lockScopes(input: Readonly<{
    organizationId: string;
    marketplace: "US";
    asins: readonly string[];
  }>): Promise<void>;
  peekNextRevision(input: ManualAlexaVocScope): Promise<string>;
  readDatabaseClock(): Promise<string>;
  claimRunCreation(input: RunCreationClaimInput): Promise<RunCreationClaim>;
  completeRunCreation(input: RunCreationCompleteInput): Promise<void>;
  leasePublication(input: Readonly<{
    ownerId: string;
    leasedAt: string;
    leaseDurationMs: number;
  }>): Promise<ManualAlexaVocOutboxLease | null>;
  markPublicationApplied(input: ManualAlexaVocOutboxLease & Readonly<{
    appliedAt: string;
  }>): Promise<void>;
  markPublicationFailed(input: ManualAlexaVocOutboxLease & Readonly<{
    failedAt: string;
    nextAttemptAt: string;
    errorCode: string;
  }>): Promise<void>;
  reconcilePublication(input: Readonly<{ reconciledAt: string }>): Promise<number>;
  readRawEnvelope(input: ManualAlexaVocScope & Readonly<{
    revision: string;
  }>): Promise<ManualAlexaVocRawEnvelopeRecord | null>;
  listRawEnvelopesForRewrap(input: Readonly<{
    organizationId: string;
    activeKeyId: string;
    limit: number;
  }>): Promise<readonly ManualAlexaVocRawEnvelopeRecord[]>;
  rewrapRawEnvelope(input: Readonly<{
    record: ManualAlexaVocRawEnvelopeRecord;
    rewrapped: ManualAlexaVocEncryptedRaw;
    actorUserId: string;
    occurredAt: string;
  }>): Promise<boolean>;
  recordRawAccess(input: Readonly<{
    id: string;
    organizationId: string;
    marketplace: "US";
    asin: string;
    revision: string;
    actorUserId: string;
    purpose: "decrypt" | "reparse" | "export" | "key-rewrap";
    occurredAt: string;
    result: ManualAlexaVocRawAccessResult;
  }>): Promise<void>;
  listRawAccessAudit(input: Readonly<{
    organizationId: string;
    requestedByUserId: string;
    limit: number;
  }>): Promise<readonly ManualAlexaVocRawAccessAuditEvent[]>;
  clearExpiredRaw(input: Readonly<{
    organizationId: string;
    before: string;
    clearedAt: string;
    actorUserId: string;
    limit?: number;
  }>): Promise<number>;
}

export type ManualAlexaVocRepositoryErrorKind =
  | "connection"
  | "timeout"
  | "permission"
  | "schema"
  | "deserialize"
  | "conflict";

const repositoryErrorMessages: Readonly<
  Record<ManualAlexaVocRepositoryErrorKind, string>
> = Object.freeze({
  connection: "Manual Alexa VOC storage is unavailable",
  timeout: "Manual Alexa VOC storage timed out",
  permission: "Manual Alexa VOC storage access was denied",
  schema: "Manual Alexa VOC storage schema is unavailable",
  deserialize: "Stored Manual Alexa VOC data is invalid",
  conflict: "Manual Alexa VOC storage state conflicts with this operation",
});

export class ManualAlexaVocRepositoryError extends Error {
  readonly code = "MANUAL_ALEXA_VOC_REPOSITORY_ERROR";

  constructor(
    readonly kind: ManualAlexaVocRepositoryErrorKind,
    options?: ErrorOptions,
  ) {
    super(repositoryErrorMessages[kind], options);
    this.name = "ManualAlexaVocRepositoryError";
  }
}

export class IdempotencyKeyReusedError extends Error {
  readonly code = "IDEMPOTENCY_KEY_REUSED";
  readonly statusCode = 409;
  readonly apiErrorCode = "IDEMPOTENCY_KEY_REUSED";

  constructor() {
    super("Idempotency-Key was already used for a different run request");
    this.name = "IdempotencyKeyReusedError";
  }
}
