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

export interface CreateAnalysisRunResult {
  run: AnalysisRunRecord;
  created: boolean;
}

export interface CancelAnalysisRunInput {
  runId: string;
  cancelledAt: string;
  error: Record<string, unknown>;
}

export interface RetryFailedRunStageInput {
  runId: string;
  stageId: string;
  staleStageIds: readonly string[];
  jobId: string;
  retriedAt: string;
  maxAutomaticAttempts: number;
}

export interface RetryFailedRunStageResult {
  stage: RunStageRecord;
  attempt: JobAttemptRecord;
}

export class JobLeaseLostError extends Error {
  constructor() {
    super("Job lease owner or generation does not match the active lease");
    this.name = "JobLeaseLostError";
  }
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
  runId: string;
  stage: RunStageRecord["stage"];
  attemptNumber: number;
  maxAttempts: number;
  retryCycleStartAttempt: number;
  logicalExecutionCycleId: string;
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
  stage?: RunStageRecord["stage"];
}

export interface RenewJobLeaseInput {
  jobId: string;
  ownerId: string;
  leaseGeneration: number;
  renewedAt: string;
  leaseDurationMs: number;
}

export interface ReleaseJobLeaseInput {
  jobId: string;
  ownerId: string;
  leaseGeneration: number;
  releasedAt: string;
}

export interface CompleteJobInput {
  jobId: string;
  ownerId: string;
  leaseGeneration: number;
  completedAt: string;
}

export interface FailJobInput {
  jobId: string;
  ownerId: string;
  leaseGeneration: number;
  failedAt: string;
  retryable: boolean;
  retryAt: string | null;
  error: Record<string, unknown>;
  attemptStatus?: "failed" | "cancelled";
  stageStatus?:
    | "queued"
    | "waiting-input"
    | "failed"
    | "budget-exceeded"
    | "cancelled";
}

export interface AgentRepository {
  transaction<T>(
    operation: (repository: AgentRepository) => Promise<T>,
  ): Promise<T>;
  createUser(user: UserRecord): Promise<UserRecord>;
  findUserById(id: string): Promise<UserRecord | null>;
  createProject(project: CreateProjectInput): Promise<ProjectRecord>;
  findProjectById(id: string): Promise<ProjectRecord | null>;
  createAnalysisRunOnce(
    run: AnalysisRunRecord,
  ): Promise<CreateAnalysisRunResult>;
  createAnalysisRun(run: AnalysisRunRecord): Promise<AnalysisRunRecord>;
  findAnalysisRun(id: string): Promise<AnalysisRunRecord | null>;
  cancelAnalysisRun(
    input: CancelAnalysisRunInput,
  ): Promise<AnalysisRunRecord | null>;
  retryFailedRunStage(
    input: RetryFailedRunStageInput,
  ): Promise<RetryFailedRunStageResult | null>;
  listAnalysisRuns(projectId: string): Promise<AnalysisRunRecord[]>;
  createRunStage(stage: RunStageRecord): Promise<RunStageRecord>;
  findRunStage(id: string): Promise<RunStageRecord | null>;
  listRunStages(runId: string): Promise<RunStageRecord[]>;
  enqueueJob(job: EnqueueJobInput): Promise<JobAttemptRecord>;
  claimNextJob(input: ClaimJobInput): Promise<JobAttemptRecord | null>;
  renewJobLease(input: RenewJobLeaseInput): Promise<JobAttemptRecord>;
  releaseJobLease(input: ReleaseJobLeaseInput): Promise<JobAttemptRecord>;
  completeJob(input: CompleteJobInput): Promise<JobAttemptRecord>;
  failJob(input: FailJobInput): Promise<JobAttemptRecord>;
  listJobAttempts(stageId: string): Promise<JobAttemptRecord[]>;
}
