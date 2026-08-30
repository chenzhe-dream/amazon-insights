import type { ManualAlexaVocNormalizedRecord } from "../../shared/agent-contracts";
import type { ManualAlexaVocEncryptedRaw } from "../security/manual-alexa-voc-cipher";

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

  constructor() {
    super("Idempotency-Key was already used for a different run request");
    this.name = "IdempotencyKeyReusedError";
  }
}
