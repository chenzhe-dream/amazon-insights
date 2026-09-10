import type { AnalysisReport } from "../../shared/agent-contracts";
import type { TrafficAnalysisOutput } from "../domain/traffic/traffic-analysis-contracts";
import type { ProductDefinitionOutput } from "../domain/product/product-definition-contracts";
import type {
  AnalysisReportRepository,
  FindAnalysisReportByIdInput,
  ListAnalysisReportsInput,
  VocPositioningReportOutput,
} from "./analysis-report-repository";
import type { AgentRunRepository } from "./agent-run-repository";
import type { DataSnapshotRepository } from "./data-snapshot-repository";
import type { KeywordAnalysisSnapshotRepository } from "./keyword-analysis-snapshot-repository";
import type { ModelBudgetLedgerRepository } from "./model-budget-repository";
import type { ManualAlexaVocRepository } from "./manual-alexa-voc-repository";
import type { ConcurrencyControlRepository } from "./concurrency-control-repository";
import type { SyncJobRepository } from "./sync-job-repository";
import type { TrafficDataSnapshotRepository } from "./traffic-data-snapshot-repository";
import type { AdminUserPresenceRepositoryCapability } from "./admin-user-presence-repository";

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

export interface InitialAdminInput {
  readonly id: string;
  readonly organizationId: string;
  readonly email: string;
  readonly displayName: string;
  readonly passwordHash: string;
  readonly createdAt: string;
}

export interface LocalUserInput extends UserRecord {
  readonly passwordHash: string;
}

export interface CreateLocalUserResult {
  readonly user: UserRecord;
  readonly created: boolean;
}

export interface AuthenticationUserRecord {
  readonly user: UserRecord;
  readonly passwordHash: string | null;
}

export interface SessionRecord {
  readonly id: string;
  readonly userId: string;
  readonly tokenHash: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly createdAt: string;
  readonly lastSeenAt: string | null;
}

export interface ActiveSessionPrincipalRecord {
  readonly sessionId: string;
  readonly userId: string;
  readonly organizationId: string;
  readonly email: string;
  readonly role: "admin" | "member";
}

export type DingTalkIdentityBinding = Readonly<{
  userId: string;
  organizationId: string;
  corpId: string;
  subjectId: string;
}>;

export interface OAuthLoginStateRecord {
  readonly stateHash: string;
  readonly returnPath: string;
  readonly expiresAt: string;
  readonly consumedAt: string | null;
  readonly createdAt: string;
}

export interface CreateOAuthLoginStateInput {
  readonly stateHash: string;
  readonly returnPath: string;
  readonly expiresAt: string;
  readonly createdAt: string;
}

export interface VerifiedDingTalkUserInput {
  readonly id: string;
  readonly organizationId: string;
  readonly corpId: string;
  readonly subjectId: string;
  readonly candidateEmail: string;
  readonly fallbackEmail: string;
  readonly displayName: string;
  readonly createdAt: string;
  readonly auditEventId: string;
}

export interface DingTalkAuthenticationRepository {
  createOAuthLoginState(
    input: CreateOAuthLoginStateInput,
  ): Promise<OAuthLoginStateRecord>;
  consumeOAuthLoginState(input: {
    stateHash: string;
    asOf: string;
    consumedAt: string;
  }): Promise<OAuthLoginStateRecord | null>;
  findOrCreateDingTalkUser(input: VerifiedDingTalkUserInput): Promise<{
    user: UserRecord;
    created: boolean;
  }>;
}

export interface AuthenticationRepository
  extends Partial<DingTalkAuthenticationRepository> {
  createInitialAdmin(input: InitialAdminInput): Promise<UserRecord | null>;
  createLocalUser?(input: LocalUserInput): Promise<CreateLocalUserResult>;
  findAuthenticationUserByEmail(
    email: string,
  ): Promise<AuthenticationUserRecord | null>;
  findAuthenticationUserById?(
    userId: string,
  ): Promise<AuthenticationUserRecord | null>;
  findDingTalkIdentityByUserId?(
    userId: string,
  ): Promise<DingTalkIdentityBinding | null>;
  createSession(session: SessionRecord): Promise<SessionRecord>;
  findActiveSessionPrincipalByTokenHash(input: {
    tokenHash: string;
    asOf: string;
  }): Promise<ActiveSessionPrincipalRecord | null>;
  revokeSessionByTokenHash(input: {
    tokenHash: string;
    revokedAt: string;
  }): Promise<boolean>;
  revokeUserSessions(input: {
    userId: string;
    revokedAt: string;
  }): Promise<number>;
  changeUserPassword?(input: {
    userId: string;
    currentSessionId: string;
    expectedPasswordHash: string;
    passwordHash: string;
    changedAt: string;
    auditEventId: string;
  }): Promise<boolean>;
}

export interface UserFeedbackRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly category: "bug" | "suggestion" | "other";
  readonly title: string;
  readonly description: string;
  readonly pagePath: string;
  readonly appVersion: string | null;
  readonly createdAt: string;
}

export type FeedbackStatus = "new" | "processing" | "resolved" | "closed";
export type FeedbackImageMediaType = "image/png" | "image/jpeg" | "image/webp";

export interface FeedbackAttachmentWrite {
  readonly id: string;
  readonly fileName: string;
  readonly mediaType: FeedbackImageMediaType;
  readonly byteSize: number;
  readonly sha256: string;
  readonly imageContent: Uint8Array;
  readonly createdAt: string;
}

export interface FeedbackAttachmentMetadata
  extends Omit<FeedbackAttachmentWrite, "imageContent"> {
  readonly feedbackId: string;
}

export interface FeedbackAttachmentRecord extends FeedbackAttachmentMetadata {
  readonly imageContent: Uint8Array;
}

export interface FeedbackStatusEventRecord {
  readonly id: string;
  readonly feedbackId: string;
  readonly actorUserId: string;
  readonly eventType: "created" | "status_changed";
  readonly fromStatus: FeedbackStatus | null;
  readonly toStatus: FeedbackStatus;
  readonly createdAt: string;
}

export interface FeedbackListRecord extends UserFeedbackRecord {
  readonly status: FeedbackStatus;
  readonly workflowVersion: number;
  readonly adminSeenAt: string | null;
  readonly attachmentCount: number;
}

export interface FeedbackDetailRecord extends FeedbackListRecord {
  readonly attachments: readonly FeedbackAttachmentMetadata[];
  readonly events: readonly FeedbackStatusEventRecord[];
}

export interface CreateUserFeedbackInput extends UserFeedbackRecord {
  readonly initialEventId?: string;
  readonly attachments?: readonly FeedbackAttachmentWrite[];
}

export interface UserFeedbackRepository {
  createUserFeedback(input: CreateUserFeedbackInput): Promise<UserFeedbackRecord | null>;
  listOwnFeedback(input: {
    organizationId: string;
    actorUserId: string;
  }): Promise<readonly FeedbackListRecord[]>;
  getOwnFeedbackDetail(input: {
    organizationId: string;
    actorUserId: string;
    feedbackId: string;
  }): Promise<FeedbackDetailRecord | null>;
  readOwnFeedbackAttachment(input: {
    organizationId: string;
    actorUserId: string;
    feedbackId: string;
    attachmentId: string;
  }): Promise<FeedbackAttachmentRecord | null>;
  listOrganizationFeedback(input: {
    organizationId: string;
    status: FeedbackStatus | null;
  }): Promise<readonly FeedbackListRecord[]>;
  getOrganizationFeedbackDetail(input: {
    organizationId: string;
    feedbackId: string;
  }): Promise<FeedbackDetailRecord | null>;
  readOrganizationFeedbackAttachment(input: {
    organizationId: string;
    feedbackId: string;
    attachmentId: string;
  }): Promise<FeedbackAttachmentRecord | null>;
  countUnreadOrganizationFeedback(organizationId: string): Promise<number>;
  markOrganizationFeedbackSeen(input: {
    organizationId: string;
    feedbackId: string;
    seenAt: string;
  }): Promise<"changed" | "unchanged" | null>;
  changeOrganizationFeedbackStatus(input: {
    organizationId: string;
    feedbackId: string;
    actorUserId: string;
    expectedVersion: number;
    status: FeedbackStatus;
    eventId: string;
    changedAt: string;
  }): Promise<FeedbackListRecord | null>;
}

export interface ProjectRecord {
  id: string;
  organizationId: string;
  name: string;
  marketplace: "US";
  asins: string[];
  createdBy: string;
  currentRunId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type CreateProjectInput = Omit<ProjectRecord, "currentRunId">;

export interface CreateProjectOnceInput {
  readonly idempotencyKey: string;
  readonly project: CreateProjectInput;
}

export interface CreateProjectResult {
  readonly project: ProjectRecord;
  readonly created: boolean;
}

export interface UpdateProjectMetadataInput {
  readonly organizationId: string;
  readonly projectId: string;
  readonly name?: string;
  readonly marketplace?: "US";
  readonly asins?: readonly string[];
  readonly updatedAt: string;
}

export interface LegacyProjectOwnerBindingRecord {
  readonly legacyProjectId: string;
  readonly organizationId: string;
  readonly ownerUserId: string;
  readonly operatorUserId: string;
  readonly boundAt: string;
}

export type BindLegacyProjectOwnerInput = LegacyProjectOwnerBindingRecord;

export interface BindLegacyProjectOwnerResult {
  readonly binding: LegacyProjectOwnerBindingRecord;
  readonly created: boolean;
}

export class ProjectCreationIdempotencyConflictError extends Error {
  readonly code = "IDEMPOTENCY_KEY_REUSED" as const;

  constructor() {
    super("Project creation idempotency key was reused with a different payload");
    this.name = "ProjectCreationIdempotencyConflictError";
  }
}

export class ImmutableProjectScopeError extends Error {
  readonly code = "IMMUTABLE_SCOPE" as const;

  constructor() {
    super("Project marketplace and ordered ASIN scope are immutable");
    this.name = "ImmutableProjectScopeError";
  }
}

export class LegacyProjectOwnerBindingError extends Error {
  readonly code = "LEGACY_PROJECT_OWNER_BINDING_REJECTED" as const;

  constructor(message = "Legacy project owner binding requires active organization users") {
    super(message);
    this.name = "LegacyProjectOwnerBindingError";
  }
}

export function parseProjectCreationIdempotencyKey(value: string): string {
  if (!/^[A-Za-z0-9._:-]{16,128}$/.test(value)) {
    throw new TypeError("Invalid project creation idempotency key");
  }
  return value;
}

export function canonicalProjectCreationPayload(project: CreateProjectInput): string {
  return JSON.stringify({
    name: project.name.trim(),
    marketplace: project.marketplace,
    asins: [...project.asins],
  });
}

export function canonicalLegacyProjectCreationPayload(project: CreateProjectInput): string {
  return JSON.stringify({
    kind: "legacy-project-scope-v1",
    projectId: project.id,
    organizationId: project.organizationId,
    marketplace: project.marketplace,
    asins: [...project.asins].sort(),
  });
}

export function hasSameProjectImmutableScope(
  existing: ProjectRecord,
  requested: CreateProjectInput,
): boolean {
  if (
    existing.id !== requested.id
    || existing.organizationId !== requested.organizationId
    || existing.marketplace !== requested.marketplace
    || existing.asins.length !== requested.asins.length
  ) {
    return false;
  }
  const existingAsins = [...existing.asins].sort();
  const requestedAsins = [...requested.asins].sort();
  return existingAsins.every((asin, index) => asin === requestedAsins[index]);
}

export interface ComparisonProjectRepository {
  createProjectOnce(input: CreateProjectOnceInput): Promise<CreateProjectResult>;
  listProjectsByOrganization(organizationId: string): Promise<ProjectRecord[]>;
  updateProjectMetadata(input: UpdateProjectMetadataInput): Promise<ProjectRecord | null>;
  bindLegacyProjectOwnerOnce(
    input: BindLegacyProjectOwnerInput,
  ): Promise<BindLegacyProjectOwnerResult>;
  findLegacyProjectOwnerBinding(
    legacyProjectId: string,
  ): Promise<LegacyProjectOwnerBindingRecord | null>;
}

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

export interface ResumeWaitingInputRunStageInput {
  runId: string;
  stageId: string;
  resumedAt: string;
}

export interface ResumeWaitingInputRunStageResult {
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
  stage:
    | "traffic-analysis"
    | "alexa-voc-normalization"
    | "voc-positioning"
    | "product-definition";
  status:
    | "queued"
    | "running"
    | "waiting-input"
    | "succeeded"
    | "partial"
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
  reportPublicationCycle: number;
  reportPublicationAttemptCount: number;
  reportPublicationMaxAttempts: number | null;
  reportPublicationInitialDelayMs: number | null;
  reportPublicationMaxDelayMs: number | null;
  reportPublicationRetryAt: string | null;
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
  queueTimeoutMs?: number;
}

export interface ExpireVocQueueInput {
  checkedAt: string;
  timeoutMs: number;
  limit?: number;
  runId?: string;
}

export interface VocQueueRepositoryCapability {
  expireVocQueue(input: ExpireVocQueueInput): Promise<number>;
}

export interface ConnectorStatusError {
  code: "probe-failed";
  message: string;
}

export interface ConnectorStatusRecord {
  id: string;
  organizationId: string;
  connector: "sif" | "sorftime" | "sellerSprite";
  configured: boolean;
  health: "unknown" | "available" | "unavailable";
  lastCheckedAt: string | null;
  lastError: ConnectorStatusError | null;
  updatedAt: string;
}

export interface ConnectorStatusRepository {
  upsertConnectorStatus(
    status: ConnectorStatusRecord,
  ): Promise<ConnectorStatusRecord>;
  findConnectorStatus(
    organizationId: string,
    connector: ConnectorStatusRecord["connector"],
  ): Promise<ConnectorStatusRecord | null>;
  listConnectorStatuses(
    organizationId: string,
  ): Promise<ConnectorStatusRecord[]>;
}

export type ConnectorCredentialStatus = "active" | "revoked";

export interface ConnectorCredentialRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly connector: ConnectorStatusRecord["connector"];
  readonly version: number;
  readonly status: ConnectorCredentialStatus;
  readonly ciphertext: Uint8Array;
  readonly nonce: Uint8Array;
  readonly authTag: Uint8Array;
  readonly keyId: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly revokedBy: string | null;
  readonly revokedAt: string | null;
}

export interface RotateConnectorCredentialInput {
  readonly id: string;
  readonly organizationId: string;
  readonly connector: ConnectorCredentialRecord["connector"];
  readonly version: number;
  readonly expectedLatestVersion: number | null;
  readonly ciphertext: Uint8Array;
  readonly nonce: Uint8Array;
  readonly authTag: Uint8Array;
  readonly keyId: string;
  readonly actorUserId: string;
  readonly rotatedAt: string;
  readonly statusId: string;
  readonly auditEventId: string;
}

export interface RevokeConnectorCredentialInput {
  readonly organizationId: string;
  readonly connector: ConnectorCredentialRecord["connector"];
  readonly expectedLatestVersion: number | null;
  readonly actorUserId: string;
  readonly revokedAt: string;
  readonly tombstoneId: string;
  readonly ciphertext: Uint8Array;
  readonly nonce: Uint8Array;
  readonly authTag: Uint8Array;
  readonly keyId: string;
  readonly statusId: string;
  readonly auditEventId: string;
}

export interface RevokeConnectorCredentialResult {
  readonly credential: ConnectorCredentialRecord;
  readonly changed: boolean;
}

export class ConnectorCredentialConflictError extends Error {
  constructor() {
    super("Connector credential changed concurrently");
    this.name = "ConnectorCredentialConflictError";
  }
}

export class ConnectorCredentialAuthorizationError extends Error {
  constructor() {
    super("Connector credential operation is not authorized");
    this.name = "ConnectorCredentialAuthorizationError";
  }
}

export interface ConnectorCredentialRepository {
  findLatestConnectorCredential(
    organizationId: string,
    connector: ConnectorCredentialRecord["connector"],
  ): Promise<ConnectorCredentialRecord | null>;
  rotateConnectorCredential(
    input: RotateConnectorCredentialInput,
  ): Promise<ConnectorCredentialRecord>;
  revokeConnectorCredential(
    input: RevokeConnectorCredentialInput,
  ): Promise<RevokeConnectorCredentialResult>;
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
  reportPublicationRetryPolicy?: Readonly<{
    maxAttempts: number;
    initialDelayMs: number;
    maxDelayMs: number;
  }>;
  error: Record<string, unknown>;
  attemptStatus?: "failed" | "cancelled";
  stageStatus?:
    | "queued"
    | "waiting-input"
    | "failed"
    | "budget-exceeded"
    | "cancelled";
}

export interface RuntimeAgentRepositoryLifecycle {
  close(): void | Promise<void>;
}

export interface AgentRepository extends AuthenticationRepository {
  transaction<T>(
    operation: (repository: AgentRepository) => Promise<T>,
  ): Promise<T>;
  createUser(user: UserRecord): Promise<UserRecord>;
  findUserById(id: string): Promise<UserRecord | null>;
  createProject(project: CreateProjectInput): Promise<ProjectRecord>;
  findProjectById(id: string): Promise<ProjectRecord | null>;
  createProjectOnce?: ComparisonProjectRepository["createProjectOnce"];
  listProjectsByOrganization?: ComparisonProjectRepository["listProjectsByOrganization"];
  updateProjectMetadata?: ComparisonProjectRepository["updateProjectMetadata"];
  bindLegacyProjectOwnerOnce?: ComparisonProjectRepository["bindLegacyProjectOwnerOnce"];
  findLegacyProjectOwnerBinding?: ComparisonProjectRepository["findLegacyProjectOwnerBinding"];
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
  resumeWaitingInputRunStage(
    input: ResumeWaitingInputRunStageInput,
  ): Promise<ResumeWaitingInputRunStageResult | null>;
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
  listAnalysisReports?(
    input: ListAnalysisReportsInput,
  ): Promise<ReadonlyArray<Readonly<AnalysisReport<VocPositioningReportOutput | TrafficAnalysisOutput | ProductDefinitionOutput>>>>;
  findAnalysisReportById?(
    input: FindAnalysisReportByIdInput,
  ): Promise<Readonly<AnalysisReport<VocPositioningReportOutput | TrafficAnalysisOutput | ProductDefinitionOutput>> | null>;
}

export interface ManualAlexaVocRepositoryCapability {
  readonly manualAlexaVoc: ManualAlexaVocRepository;
}

export type RuntimeAgentRepository = AgentRepository &
  VocQueueRepositoryCapability &
  UserFeedbackRepository &
  ConnectorStatusRepository &
  ConnectorCredentialRepository &
  ModelBudgetLedgerRepository &
  AgentRunRepository &
  DataSnapshotRepository &
  TrafficDataSnapshotRepository &
  KeywordAnalysisSnapshotRepository &
  AnalysisReportRepository &
  AdminUserPresenceRepositoryCapability &
  ManualAlexaVocRepositoryCapability & {
    readonly trafficDetailRecoveries?: import('./traffic-detail-recovery-repository').TrafficDetailRecoveryRepository;
    readonly syncJobs: SyncJobRepository;
    readonly concurrencyControl?: ConcurrencyControlRepository;
  };
