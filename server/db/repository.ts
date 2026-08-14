export interface StorageConnectionDiagnostics {
  foreignKeys: boolean;
  journalMode: string;
  busyTimeoutMs: number;
}

export interface AppliedMigration {
  version: number;
  name: string;
  checksum: string;
}

export interface UserRecord {
  id: string;
  organizationId: string;
  email: string;
  displayName: string;
  role: "admin" | "member";
  status: "active" | "disabled";
  createdAt: string;
  updatedAt: string;
}

export interface ProjectRecord {
  id: string;
  organizationId: string;
  name: string;
  marketplace: string;
  asins: string[];
  createdBy: string;
  currentRunId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type CreateProjectInput = Omit<ProjectRecord, "currentRunId">;

export interface AnalysisRunRecord {
  id: string;
  projectId: string;
  mode: "existing-data" | "collect-missing";
  status:
    | "queued"
    | "running"
    | "waiting-input"
    | "succeeded"
    | "partial"
    | "failed"
    | "budget-exceeded"
    | "cancelled";
  createdBy: string;
  dataCutoffAt: string;
  idempotencyScope: string;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
}

export interface RunStageRecord {
  id: string;
  runId: string;
  stage: "traffic-analysis" | "voc-positioning" | "product-definition";
  status:
    | "queued"
    | "running"
    | "waiting-input"
    | "succeeded"
    | "failed"
    | "skipped"
    | "budget-exceeded"
    | "cancelled"
    | "stale";
  progress: number;
  attemptCount: number;
  startedAt: string | null;
  completedAt: string | null;
  lastError: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface EnqueueJobInput {
  id: string;
  stageId: string;
  attemptNumber: number;
  maxAttempts: number;
  availableAt: string;
  createdAt: string;
}

export interface JobAttemptRecord {
  id: string;
  stageId: string;
  attemptNumber: number;
  maxAttempts: number;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  availableAt: string;
  leasedBy: string | null;
  leaseExpiresAt: string | null;
  leaseGeneration: number;
  retryable: boolean;
  startedAt: string | null;
  completedAt: string | null;
  error: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface ClaimJobInput {
  ownerId: string;
  claimedAt: string;
  leaseDurationMs: number;
}

export interface RenewJobLeaseInput {
  jobId: string;
  ownerId: string;
  renewedAt: string;
  leaseDurationMs: number;
}

export interface CompleteJobInput {
  jobId: string;
  ownerId: string;
  completedAt: string;
}

export interface FailJobInput {
  jobId: string;
  ownerId: string;
  failedAt: string;
  retryable: boolean;
  retryAt: string | null;
  error: Record<string, unknown>;
}

export interface AgentRepository {
  getConnectionDiagnostics(): StorageConnectionDiagnostics;
  listAppliedMigrations(): AppliedMigration[];
  transaction<T>(
    operation: (repository: AgentRepository) => Promise<T>,
  ): Promise<T>;
  createUser(user: UserRecord): Promise<UserRecord>;
  findUserById(id: string): Promise<UserRecord | null>;
  createProject(project: CreateProjectInput): Promise<ProjectRecord>;
  createAnalysisRun(run: AnalysisRunRecord): Promise<AnalysisRunRecord>;
  listAnalysisRuns(projectId: string): Promise<AnalysisRunRecord[]>;
  createRunStage(stage: RunStageRecord): Promise<RunStageRecord>;
  enqueueJob(job: EnqueueJobInput): Promise<JobAttemptRecord>;
  claimNextJob(input: ClaimJobInput): Promise<JobAttemptRecord | null>;
  renewJobLease(input: RenewJobLeaseInput): Promise<JobAttemptRecord>;
  completeJob(input: CompleteJobInput): Promise<JobAttemptRecord>;
  failJob(input: FailJobInput): Promise<JobAttemptRecord>;
  listJobAttempts(stageId: string): Promise<JobAttemptRecord[]>;
  close(): void;
}
