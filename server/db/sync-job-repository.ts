export type SyncJobModuleStatus =
  | "ready"
  | "upstream-empty"
  | "timeout"
  | "connector-failed"
  | "pending"
  | "manual";

export type CatalogProviderPlan = Readonly<{
  preferredConnectorId: "sellerSprite" | "sorftime";
  unavailableConnectorIds: readonly ("sellerSprite" | "sorftime")[];
}>;

export type SyncCatalogCapture = Readonly<{
  catalog: readonly Record<string, unknown>[];
  evidence: Readonly<{
    sourceKind: "generated-file";
    sourceRef: "app/competitor-data.ts#refreshedCatalog";
    sourceSha256: string;
    sourceUpdatedAt: string;
    capturedAt: string;
    sourceJobId?: string;
  }>;
}>;

export interface SyncJobStageRecord {
  readonly id: string;
  readonly label: string;
  readonly kind: "auto" | "manual";
  readonly status: string;
  readonly estimatedSeconds: number;
  readonly detail?: string;
  readonly manualNote?: string;
  readonly startedAt?: string | null;
  readonly completedAt?: string | null;
  readonly catalogProviderPlan?: CatalogProviderPlan;
  readonly repairAsins?: string[];
  readonly imageAction?: "refresh" | "analyze";
  readonly repairParentJobId?: string;
  readonly repairXydcAsins?: string[];
}

export interface SyncJobModuleRecord {
  readonly asin: string;
  readonly module: string;
  readonly status: SyncJobModuleStatus;
  readonly reason: string | null;
  readonly updatedAt: string;
}

export interface SyncJobRecord {
  readonly jobId: string;
  readonly organizationId: string;
  readonly projectId: string | null;
  readonly runId: string | null;
  readonly actorId: string | null;
  readonly fingerprint: string;
  readonly asins: readonly string[];
  readonly marketplace: "US";
  readonly status: "queued" | "running" | "completed" | "failed";
  readonly message: string;
  readonly currentStageId: string;
  readonly stages: readonly SyncJobStageRecord[];
  readonly asinProgress: Readonly<
    Record<
      string,
      Readonly<Record<string, Omit<SyncJobModuleRecord, "asin" | "module">>>
    >
  >;
  readonly leasedBy: string | null;
  readonly leaseGeneration: number;
  readonly jobVersion?: number;
  readonly leaseExpiresAt: string | null;
  readonly policyVersion?: string;
  readonly error: Record<string, unknown> | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt?: string;
  readonly dynamicSnapshot?: "pending" | "ready";
  readonly resumableStages?: readonly string[];
  readonly queuePosition?: number | null;
  readonly scope: {
    readonly organizationId: string;
    readonly projectId: string | null;
    readonly runId: string | null;
    readonly marketplace: "US";
    readonly asins: readonly string[];
  };
}

export type ProjectableSyncStage =
  | "keywords"
  | "reviews"
  | "sales_trend"
  | "fba"
  | "listing"
  | "category"
  | "traffic"
  | "child_sales"
  | "price_strategy"
  | "image_remarks";

export interface StageOutputDraft {
  readonly organizationId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly stage: ProjectableSyncStage;
  readonly stageStatus: "done" | "partial" | "failed";
  readonly contentHash: string;
  readonly updatedAt: string;
  readonly data?: Record<string, unknown>;
  readonly gap?: {
    readonly state: "partial" | "failed";
    readonly reasonCode: "CONNECT_TIMEOUT" | "UPSTREAM_EMPTY" | "CONNECTOR_FAILED" | "SIF_KEYWORD_SCHEMA_INVALID" | "MCP_SCHEMA";
    readonly items?: readonly Record<string, unknown>[];
  };
}

export interface StageOutputProjection extends Omit<StageOutputDraft, "organizationId"> {
  readonly jobId: string;
  readonly jobVersion: number;
  readonly outputVersion: number;
}

export interface BuildPublicationRecoveryEvidence {
  readonly jobId: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly fingerprint: string;
  readonly marketplace: "US";
  readonly asins: readonly string[];
  readonly outputs: readonly StageOutputDraft[];
}

export interface AdmitSyncJobInput {
  readonly jobId: string;
  readonly organizationId: string;
  readonly projectId: string | null;
  readonly runId: string | null;
  readonly actorId: string | null;
  readonly fingerprint: string;
  readonly asins: readonly string[];
  readonly marketplace: "US";
  readonly createdAt: string;
  readonly stages: readonly SyncJobStageRecord[];
  readonly currentStageId: string;
  readonly message: string;
  readonly canonicalRun?: {
    readonly runId: string;
    readonly stageId: string;
    readonly dataCutoffAt: string;
  };
}

export interface SyncJobLease {
  readonly job: SyncJobRecord;
  readonly leaseGeneration: number;
}

export class SyncJobLeaseLostError extends Error {
  constructor() {
    super("Sync job lease generation does not match the active lease");
    this.name = "SyncJobLeaseLostError";
  }
}

export class SyncJobQueueUnavailableError extends Error {
  constructor() {
    super("Sync job queue requires PostgreSQL storage");
    this.name = "SyncJobQueueUnavailableError";
  }
}

export class SyncJobDataError extends Error {
  constructor(message = "PostgreSQL sync job row contains invalid data") {
    super(message);
    this.name = "SyncJobDataError";
  }
}

export class SyncJobRunConflictError extends Error {
  constructor() {
    super("Sync scope is not available for the requested run");
    this.name = "SyncJobRunConflictError";
  }
}

export interface SyncJobRepository {
  findLatestCompletedForProject?(input: {
    organizationId: string;
    projectId: string;
  }): Promise<{ jobId: string; runId: string } | null>;
  admit(input: AdmitSyncJobInput): Promise<{
    job: SyncJobRecord;
    disposition: "created" | "deduplicated";
  }>;
  findById(jobId: string): Promise<SyncJobRecord | null>;
  readStageOutput(input: {
    organizationId: string;
    projectId: string;
    runId: string;
    jobId: string;
    stage: ProjectableSyncStage;
  }): Promise<StageOutputProjection | null>;
  ownsCanonicalTrafficRun?(input: {
    jobId: string;
    runId: string;
    actorId: string;
  }): Promise<boolean>;
  beginCanonicalTrafficRun?(input: {
    jobId: string;
    runId: string;
    actorId: string;
    leaseGeneration: number;
    workerId: string;
    maxAttempts: number;
    startedAt: string;
  }): Promise<"started" | "exhausted" | false>;
  settleCanonicalTrafficRun?(input: {
    jobId: string;
    runId: string;
    outcome: "succeeded" | "partial" | "failed" | "cancelled";
    settledAt: string;
    error: Record<string, unknown> | null;
  }): Promise<boolean>;
  resume(input: {
    jobId: string;
    organizationId: string;
    actorId: string | null;
    resumedAt: string;
    buildPublicationRecoveryEvidence?: BuildPublicationRecoveryEvidence;
  }): Promise<{
    job: SyncJobRecord;
    disposition: "resumed" | "deduplicated";
    resumedStages: readonly string[];
  } | null>;
  claimNext(input: {
    workerId: string;
    leaseMs: number;
    wholeJobLimit: number;
    claimedAt?: string;
  }): Promise<SyncJobLease | null>;
  heartbeat(input: {
    jobId: string;
    leaseGeneration: number;
    workerId: string;
    heartbeatAt: string;
    leaseMs: number;
  }): Promise<SyncJobRecord>;
  recordProgress(input: {
    jobId: string;
    leaseGeneration: number;
    workerId?: string;
    recordedAt: string;
    currentStageId?: string;
    stage?: Partial<SyncJobStageRecord> & Pick<SyncJobStageRecord, "id">;
    stages?: readonly (Partial<SyncJobStageRecord> & Pick<SyncJobStageRecord, "id">)[];
    modules?: readonly SyncJobModuleRecord[];
    outputs?: readonly StageOutputDraft[];
    message?: string;
  }): Promise<SyncJobRecord>;
  complete(input: {
    jobId: string;
    leaseGeneration: number;
    workerId?: string;
    completedAt: string;
    message: string;
    catalogCapture?: SyncCatalogCapture;
  }): Promise<SyncJobRecord>;
  fail(input: {
    jobId: string;
    leaseGeneration: number;
    workerId?: string;
    failedAt: string;
    message: string;
    error: Record<string, unknown>;
  }): Promise<SyncJobRecord>;
}

export class UnavailableSyncJobRepository implements SyncJobRepository {
  admit(): Promise<never> {
    return Promise.reject(new SyncJobQueueUnavailableError());
  }
  findById(): Promise<never> {
    return Promise.reject(new SyncJobQueueUnavailableError());
  }
  readStageOutput(): Promise<never> {
    return Promise.reject(new SyncJobQueueUnavailableError());
  }
  resume(): Promise<never> {
    return Promise.reject(new SyncJobQueueUnavailableError());
  }
  claimNext(): Promise<never> {
    return Promise.reject(new SyncJobQueueUnavailableError());
  }
  heartbeat(): Promise<never> {
    return Promise.reject(new SyncJobQueueUnavailableError());
  }
  recordProgress(): Promise<never> {
    return Promise.reject(new SyncJobQueueUnavailableError());
  }
  complete(): Promise<never> {
    return Promise.reject(new SyncJobQueueUnavailableError());
  }
  fail(): Promise<never> {
    return Promise.reject(new SyncJobQueueUnavailableError());
  }
}
