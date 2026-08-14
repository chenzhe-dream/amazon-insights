import type {
  AgentRunAttempt,
  AgentRunAudit,
  AgentRunTerminalMetadata,
  ApiError,
} from "../../shared/agent-contracts";
import type { SkillManifest } from "../skills/manifest";

export interface SkillVersionRecord {
  id: string;
  skillId: string;
  version: string;
  contentHash: string;
  manifest: SkillManifest;
  createdAt: string;
}

export type RegisterSkillVersionInput = SkillVersionRecord;

export interface BeginAgentRunInput {
  id: string;
  organizationId: string;
  runId: string;
  stageId: string;
  jobAttemptId: string;
  skillVersionId: string;
  snapshotIds: readonly string[];
  executionFingerprint: string;
  outputSchemaDigest: string;
  provider: string;
  model: string;
  inputSummary: {
    contentHash: string;
    recordCount: number;
  };
  outputSchemaVersion: string;
  dataCutoffAt: string;
  startedAt: string;
  leaseOwnerId: string;
  leaseGeneration: number;
  claimToken: string;
  claimAcquiredAt: string;
  claimExpiresAt: string;
}

export interface BeginAgentRunResult {
  record: AgentRunAudit;
  created: boolean;
  claimStatus: "acquired" | "observing" | "terminal";
}

export interface FinalizeAgentRunOutcome {
  terminalStatus: "succeeded" | "failed" | "budget-exceeded" | "cancelled";
  validationStatus: "passed" | "failed";
  responseId: string | null;
  output: Record<string, unknown> | null;
  error: ApiError | null;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCostMicros: number | null;
  durationMs: number | null;
  attemptCount: number;
  usageCompleteness: "complete" | "partial" | "unavailable";
  attempts: readonly AgentRunAttempt[];
  terminalMetadata: AgentRunTerminalMetadata;
}

export interface FinalizeAgentRunInput {
  agentRunId: string;
  organizationId: string;
  leaseOwnerId: string;
  leaseGeneration: number;
  claimToken: string;
  completedAt: string;
  outcome: FinalizeAgentRunOutcome;
}

export interface FinalizeAgentRunResult {
  record: AgentRunAudit;
  transitioned: boolean;
}

export interface ListAgentRunsInput {
  organizationId: string;
  runId: string;
}

export interface AgentRunUsageSummary {
  usageCompleteness: "complete" | "partial" | "unavailable";
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCostMicros: number | null;
  durationMs: number | null;
  attemptCount: number | null;
  agentRunCount: number;
}

export interface JobAttemptModelUsageInput {
  organizationId: string;
  runId: string;
  jobAttemptId: string;
}

export interface JobAttemptModelUsage {
  usageCompleteness: "complete" | "partial" | "unavailable";
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCostMicros: number | null;
  responseId: string | null;
  attempts: AgentRunAttempt[];
}

export interface AgentRunRepository {
  registerSkillVersion(input: RegisterSkillVersionInput): Promise<SkillVersionRecord>;
  beginAgentRun(input: BeginAgentRunInput): Promise<BeginAgentRunResult>;
  finalizeAgentRun(input: FinalizeAgentRunInput): Promise<FinalizeAgentRunResult>;
  listAgentRuns(input: ListAgentRunsInput): Promise<AgentRunAudit[]>;
  getAgentRunUsage(input: ListAgentRunsInput): Promise<AgentRunUsageSummary>;
  getJobAttemptModelUsage(input: JobAttemptModelUsageInput): Promise<JobAttemptModelUsage>;
}

export class SkillVersionConflictError extends Error {
  readonly code = "SKILL_VERSION_CONFLICT";

  constructor() {
    super("Skill version conflicts with persisted provenance");
    this.name = "SkillVersionConflictError";
  }
}

export class AgentRunConflictError extends Error {
  readonly code = "AGENT_RUN_CONFLICT";

  constructor() {
    super("Agent run conflicts with persisted execution identity");
    this.name = "AgentRunConflictError";
  }
}

export class AgentRunSubjectNotFoundError extends Error {
  readonly code = "AGENT_RUN_SUBJECT_NOT_FOUND";

  constructor() {
    super("Agent run subject was not found or is not available");
    this.name = "AgentRunSubjectNotFoundError";
  }
}

export class AgentRunLeaseLostError extends Error {
  readonly code = "AGENT_RUN_LEASE_LOST";

  constructor() {
    super("Agent run lease owner or generation is no longer active");
    this.name = "AgentRunLeaseLostError";
  }
}

export class AgentRunClaimLostError extends Error {
  readonly code = "AGENT_RUN_CLAIM_LOST";

  constructor() {
    super("Agent run execution claim is no longer active");
    this.name = "AgentRunClaimLostError";
  }
}

export class AgentRunDataError extends Error {
  readonly code = "AGENT_RUN_DATA_INVALID";

  constructor() {
    super("Stored agent run audit data is invalid");
    this.name = "AgentRunDataError";
  }
}
