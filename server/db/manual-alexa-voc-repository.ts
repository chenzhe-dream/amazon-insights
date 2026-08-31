import type { ManualAlexaVocNormalizedRecord } from "../../shared/agent-contracts";
import type { ManualAlexaVocEncryptedRaw } from "../security/manual-alexa-voc-cipher";
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
  }>;

export type ManualAlexaVocWriteResult = Readonly<{
  record: ManualAlexaVocRevision;
  idempotent: boolean;
  publication: Readonly<{
    status: "pending" | "deduplicated" | "disabled";
    generation: string | null;
  }>;
}>;

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

export interface ManualAlexaVocRepository {
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
  recordRawAccess(input: Readonly<{
    id: string;
    organizationId: string;
    marketplace: "US";
    asin: string;
    revision: string;
    actorUserId: string;
    purpose: "decrypt" | "reparse" | "export" | "key-rewrap";
    occurredAt: string;
    result: "succeeded" | "denied" | "failed";
  }>): Promise<void>;
  clearExpiredRaw(input: Readonly<{
    organizationId: string;
    before: string;
    clearedAt: string;
    actorUserId: string;
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
