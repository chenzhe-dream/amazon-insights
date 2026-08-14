import type { AgentRunAttempt, AgentRunAudit, ApiError } from "../../shared/agent-contracts";
import type {
  AgentRunRepository,
  JobAttemptModelUsage,
} from "../db/agent-run-repository";
import { BudgetExceededError } from "./budget-policy";
import { createSkillExecutionFingerprint } from "./model-request-accounting";
import { redactStringForLog, summarizeContent, type ContentSummary } from "./redaction";
import {
  getSkillRunFailureAudit,
  SkillRunner,
  SkillRuntimeError,
  type PreparedSkillExecution,
  type SkillExecutionRequest,
  type SkillRunFailureAudit,
} from "./skill-runner";
import { WorkerTaskError } from "./retry-policy";

export interface AuditedSkillExecutionContext {
  organizationId: string;
  runId: string;
  projectId: string;
  stageId: string;
  jobAttemptId: string;
  leaseOwnerId: string;
  leaseGeneration: number;
  dataCutoffAt: string;
}

export interface AgentRunLogSummary {
  event: "completed" | "failed" | "replayed" | "recovery-failed";
  schemaVersion: "1.1.0";
  runId: string;
  stageId: string;
  jobAttemptId: string;
  agentRunId: string;
  skill: { id: string; version: string; contentHash: string };
  snapshotCount: number;
  provider: string;
  model: string;
  responseId: string | null;
  inputSummary: ContentSummary;
  outputSummary: ContentSummary | null;
  outputSchemaVersion: string;
  validationStatus: "passed" | "failed";
  usageCompleteness: "complete" | "partial" | "unavailable";
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCostMicros: number | null;
  durationMs: number | null;
  attemptCount: number;
  errorClassification: AgentRunAttempt["errorClassification"];
}

export interface AuditedSkillExecutionResult<O> {
  value: O;
  agentRun: Readonly<AgentRunAudit>;
  replayed: boolean;
}

interface AuditedSkillRunnerDependencies {
  skillRunner: SkillRunner;
  repository: AgentRunRepository;
  clock?: () => Date;
  createId?: () => string;
  logger?: (entry: Readonly<AgentRunLogSummary>) => void;
  claimLeaseMs?: number;
  claimPollIntervalMs?: number;
  sleep?: (durationMs: number) => Promise<void>;
}

export class AgentRunPersistenceError extends Error {
  readonly code = "AGENT_RUN_PERSISTENCE_FAILED";

  constructor() {
    super("Agent run audit persistence failed");
    this.name = "AgentRunPersistenceError";
  }
}

export class AgentRunReplayError extends Error {
  readonly code = "AGENT_RUN_REPLAY_INVALID";

  constructor() {
    super("Persisted agent run cannot be replayed safely");
    this.name = "AgentRunReplayError";
  }
}

export class AuditedSkillRunner {
  readonly #skillRunner: SkillRunner;
  readonly #repository: AgentRunRepository;
  readonly #clock: () => Date;
  readonly #createId: () => string;
  readonly #logger?: (entry: Readonly<AgentRunLogSummary>) => void;
  readonly #claimLeaseMs: number;
  readonly #claimPollIntervalMs: number;
  readonly #sleep: (durationMs: number) => Promise<void>;

  constructor(dependencies: AuditedSkillRunnerDependencies) {
    this.#skillRunner = dependencies.skillRunner;
    this.#repository = dependencies.repository;
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#createId = dependencies.createId ?? randomUUID;
    this.#logger = dependencies.logger;
    this.#claimLeaseMs = positiveSafeInteger(
      dependencies.claimLeaseMs ?? 30_000,
      "claimLeaseMs",
    );
    this.#claimPollIntervalMs = positiveSafeInteger(
      dependencies.claimPollIntervalMs ?? 25,
      "claimPollIntervalMs",
    );
    this.#sleep = dependencies.sleep ?? defaultSleep;
  }

  async run<I, O>(
    request: SkillExecutionRequest<I, O>,
    context: AuditedSkillExecutionContext,
  ): Promise<AuditedSkillExecutionResult<O>> {
    const prepared = await this.#skillRunner.prepare(request);
    const startedAt = this.#now();
    const inputSummary = summarizeContent(prepared.parsedInput);
    const outputSchemaVersion = schemaVersion(prepared.outputContract.name);
    const executionFingerprint = createSkillExecutionFingerprint({
      runId: context.runId,
      stageId: context.stageId,
      jobAttemptId: context.jobAttemptId,
      skill: {
        id: prepared.skill.id,
        version: prepared.skill.version,
        contentHash: prepared.skill.contentHash,
        inputSchema: prepared.skill.inputSchema,
        outputSchema: prepared.skill.outputSchema,
      },
      snapshotIds: prepared.snapshotIds,
      dataCutoffAt: context.dataCutoffAt,
      provider: prepared.providerName,
      model: prepared.model,
      inputContract: {
        name: prepared.inputContract.name,
        schemaDigest: prepared.inputContract.schemaDigest,
        value: prepared.parsedInput,
      },
      outputContract: {
        name: prepared.outputContract.name,
        schemaDigest: prepared.outputContract.schemaDigest,
      },
    });
    const skillVersion = await this.#repository.registerSkillVersion({
      id: this.#createId(),
      skillId: prepared.skill.id,
      version: prepared.skill.version,
      contentHash: prepared.skill.contentHash,
      manifest: {
        ...prepared.skill,
        allowedReferences: [...prepared.skill.allowedReferences],
        fixtures: [...prepared.skill.fixtures],
      },
      createdAt: startedAt,
    });
    const agentRunId = this.#createId();
    const claimToken = this.#createId();
    const beginInput = (claimAcquiredAt: string) => ({
      id: agentRunId,
      organizationId: context.organizationId,
      runId: context.runId,
      stageId: context.stageId,
      jobAttemptId: context.jobAttemptId,
      skillVersionId: skillVersion.id,
      snapshotIds: prepared.snapshotIds,
      executionFingerprint,
      outputSchemaDigest: prepared.outputContract.schemaDigest,
      provider: prepared.providerName,
      model: prepared.model.name,
      inputSummary,
      outputSchemaVersion,
      dataCutoffAt: context.dataCutoffAt,
      startedAt,
      leaseOwnerId: context.leaseOwnerId,
      leaseGeneration: context.leaseGeneration,
      claimToken,
      claimAcquiredAt,
      claimExpiresAt: addMilliseconds(
        claimAcquiredAt,
        Math.max(this.#claimLeaseMs, prepared.model.timeoutMs * 4 + 10_000),
      ),
    });
    let begun = await this.#repository.beginAgentRun(beginInput(startedAt));

    while (begun.claimStatus === "observing") {
      if (prepared.signal?.aborted) {
        throw new SkillRuntimeError("CANCELLED", "Skill execution was aborted");
      }
      await this.#sleep(this.#claimPollIntervalMs);
      begun = await this.#repository.beginAgentRun(beginInput(this.#now()));
    }

    if (begun.claimStatus === "terminal" || begun.record.validationStatus !== "pending") {
      return this.#replayTerminal(prepared, begun.record, inputSummary);
    }

    let usageBeforeExecution: JobAttemptModelUsage;
    try {
      usageBeforeExecution = await this.#usage(context);
    } catch {
      throw new AgentRunPersistenceError();
    }
    if (usageBeforeExecution.attempts.length > 0) {
      await this.#recoverUncommittedExecution(
        begun.record,
        context,
        inputSummary,
        outputSchemaVersion,
        usageBeforeExecution,
        claimToken,
      );
      throw new AgentRunPersistenceError();
    }

    let execution;
    try {
      execution = await this.#skillRunner.runPrepared(
        prepared,
        {
          runId: context.runId,
          projectId: context.projectId,
          jobAttemptId: context.jobAttemptId,
        },
        {
          agentRunId: begun.record.id,
          organizationId: context.organizationId,
          jobAttemptId: context.jobAttemptId,
          leaseOwnerId: context.leaseOwnerId,
          leaseGeneration: context.leaseGeneration,
          claimToken,
        },
      );
    } catch (error) {
      await this.#persistExecutionFailure(
        error,
        begun.record,
        context,
        inputSummary,
        outputSchemaVersion,
        claimToken,
      );
      throw error;
    }

    if (!isStructuredOutput(execution.value)) {
      throw new AgentRunPersistenceError();
    }
    let usage: JobAttemptModelUsage;
    try {
      usage = await this.#usage(context);
    } catch {
      throw new AgentRunPersistenceError();
    }
    const attempts = mergeAttemptMetadata(usage.attempts, execution.record.attempts);
    let finalized;
    try {
      finalized = await this.#repository.finalizeAgentRun({
        agentRunId: begun.record.id,
        organizationId: context.organizationId,
        leaseOwnerId: context.leaseOwnerId,
        leaseGeneration: context.leaseGeneration,
        claimToken,
        completedAt: this.#now(),
        outcome: {
          terminalStatus: "succeeded",
          validationStatus: "passed",
          responseId: execution.record.responseId,
          output: execution.value,
          error: null,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          estimatedCostMicros: usage.estimatedCostMicros,
          durationMs: execution.record.durationMs,
          attemptCount: attempts.length,
          usageCompleteness: usage.usageCompleteness,
          attempts,
          terminalMetadata: { kind: "succeeded" },
        },
      });
    } catch {
      throw new AgentRunPersistenceError();
    }
    this.#log(
      "completed",
      finalized.record,
      inputSummary,
      summarizeContent(execution.value),
      lastErrorClassification(attempts),
    );
    return {
      value: execution.value,
      agentRun: finalized.record,
      replayed: false,
    };
  }

  #replayTerminal<I, O>(
    prepared: PreparedSkillExecution<I, O>,
    record: AgentRunAudit,
    inputSummary: ContentSummary,
  ): AuditedSkillExecutionResult<O> {
    this.#skillRunner.assertPreparedContractIdentity(prepared);
    if (record.validationStatus !== "passed" || record.output === null) {
      this.#log(
        "replayed",
        record,
        inputSummary,
        null,
        lastErrorClassification(record.attempts),
      );
      const metadata = record.terminalMetadata;
      if (metadata?.kind === "budget-exceeded") {
        throw new BudgetExceededError(
          metadata.scope,
          metadata.metric,
          metadata.used,
          metadata.projected,
          metadata.limit,
        );
      }
      if (metadata?.kind === "cancelled") {
        throw new WorkerTaskError("cancelled", "Skill execution was cancelled");
      }
      if (metadata?.kind === "failed") {
        throw new WorkerTaskError(
          metadata.classification,
          safeMessageForClassification(metadata.classification),
        );
      }
      throw new AgentRunReplayError();
    }
    const parsed = prepared.outputContract.schema.safeParse(record.output);
    if (!parsed.success) throw new AgentRunReplayError();
    this.#log(
      "replayed",
      record,
      inputSummary,
      summarizeContent(parsed.data),
      lastErrorClassification(record.attempts),
    );
    return { value: parsed.data, agentRun: record, replayed: true };
  }

  async #persistExecutionFailure(
    error: unknown,
    pending: AgentRunAudit,
    context: AuditedSkillExecutionContext,
    inputSummary: ContentSummary,
    outputSchemaVersion: string,
    claimToken: string,
  ) {
    const local = getSkillRunFailureAudit(error);
    let usage: JobAttemptModelUsage;
    try {
      usage = await this.#usage(context);
    } catch {
      throw new AgentRunPersistenceError();
    }
    const attempts = mergeAttemptMetadata(usage.attempts, local?.attempts ?? []);
    const normalized = normalizeExecutionError(error, local, pending.id);
    let finalized;
    try {
      finalized = await this.#repository.finalizeAgentRun({
        agentRunId: pending.id,
        organizationId: context.organizationId,
        leaseOwnerId: context.leaseOwnerId,
        leaseGeneration: context.leaseGeneration,
        claimToken,
        completedAt: this.#now(),
        outcome: {
          terminalStatus: normalized.terminalStatus,
          validationStatus: "failed",
          responseId: local?.responseId ?? usage.responseId,
          output: null,
          error: normalized.error,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          estimatedCostMicros: usage.estimatedCostMicros,
          durationMs: local?.durationMs ?? null,
          attemptCount: attempts.length,
          usageCompleteness: usage.usageCompleteness,
          attempts,
          terminalMetadata: normalized.terminalMetadata,
        },
      });
    } catch {
      throw new AgentRunPersistenceError();
    }
    this.#log(
      "failed",
      finalized.record,
      inputSummary,
      null,
      normalized.classification,
      outputSchemaVersion,
    );
  }

  async #recoverUncommittedExecution(
    pending: AgentRunAudit,
    context: AuditedSkillExecutionContext,
    inputSummary: ContentSummary,
    outputSchemaVersion: string,
    usage: JobAttemptModelUsage,
    claimToken: string,
  ) {
    const error: ApiError = {
      code: "INFRASTRUCTURE_ERROR",
      message: "Agent execution result was not durably committed",
      requestId: `agent-run:${pending.id}`,
      retryable: false,
    };
    try {
      const finalized = await this.#repository.finalizeAgentRun({
        agentRunId: pending.id,
        organizationId: context.organizationId,
        leaseOwnerId: context.leaseOwnerId,
        leaseGeneration: context.leaseGeneration,
        claimToken,
        completedAt: this.#now(),
        outcome: {
          terminalStatus: "failed",
          validationStatus: "failed",
          responseId: usage.responseId,
          output: null,
          error,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          estimatedCostMicros: usage.estimatedCostMicros,
          durationMs: null,
          attemptCount: usage.attempts.length,
          usageCompleteness: usage.usageCompleteness,
          attempts: usage.attempts,
          terminalMetadata: {
            kind: "failed",
            classification: "infrastructure",
          },
        },
      });
      this.#log(
        "recovery-failed",
        finalized.record,
        inputSummary,
        null,
        "unavailable",
        outputSchemaVersion,
      );
    } catch {
      throw new AgentRunPersistenceError();
    }
  }

  #usage(context: AuditedSkillExecutionContext) {
    return this.#repository.getJobAttemptModelUsage({
      organizationId: context.organizationId,
      runId: context.runId,
      jobAttemptId: context.jobAttemptId,
    });
  }

  #log(
    event: AgentRunLogSummary["event"],
    record: AgentRunAudit,
    inputSummary: ContentSummary,
    outputSummary: ContentSummary | null,
    errorClassification: AgentRunAttempt["errorClassification"],
    outputSchemaVersion = record.outputSchemaVersion,
  ) {
    if (!this.#logger) return;
    try {
      this.#logger(Object.freeze({
        event,
        schemaVersion: "1.1.0" as const,
        runId: record.runId,
        stageId: record.stageId,
        jobAttemptId: record.jobAttemptId,
        agentRunId: record.id,
        skill: { ...record.skill },
        snapshotCount: record.snapshotIds.length,
        provider: redactStringForLog(record.model.provider),
        model: redactStringForLog(record.model.model),
        responseId: record.model.responseId
          ? redactStringForLog(record.model.responseId)
          : null,
        inputSummary,
        outputSummary,
        outputSchemaVersion,
        validationStatus: record.validationStatus as "passed" | "failed",
        usageCompleteness: record.usageCompleteness ?? "unavailable",
        inputTokens: record.inputTokens,
        outputTokens: record.outputTokens,
        estimatedCostMicros: record.estimatedCostMicros,
        durationMs: record.durationMs,
        attemptCount: record.attemptCount ?? 0,
        errorClassification,
      }));
    } catch {
      // Observability must not replace durable execution or replay semantics.
    }
  }

  #now() {
    const value = this.#clock();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new AgentRunPersistenceError();
    }
    return value.toISOString();
  }
}

function schemaVersion(contractName: string) {
  const match = /@(\d+\.\d+\.\d+)$/.exec(contractName);
  if (!match) throw new AgentRunPersistenceError();
  return match[1];
}

function isStructuredOutput(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveSafeInteger(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`Invalid audited Skill runner ${label}`);
  }
  return value;
}

function addMilliseconds(timestamp: string, durationMs: number) {
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0) {
    throw new AgentRunPersistenceError();
  }
  const value = new Date(timestamp).getTime() + durationMs;
  if (!Number.isFinite(value)) throw new AgentRunPersistenceError();
  return new Date(value).toISOString();
}

function defaultSleep(durationMs: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, durationMs));
}

function sameAttemptIdentity(left: AgentRunAttempt, right: AgentRunAttempt) {
  return (
    left.ordinal === right.ordinal &&
    left.kind === right.kind &&
    left.transientRetryCount === right.transientRetryCount &&
    left.formatRepair === right.formatRepair
  );
}

function mergeAttemptMetadata(
  ledger: readonly AgentRunAttempt[],
  local: readonly AgentRunAttempt[],
) {
  return ledger.map((attempt) => {
    const matching = local.find((candidate) => sameAttemptIdentity(attempt, candidate));
    return Object.freeze({
      ...attempt,
      errorClassification: matching
        ? matching.errorClassification
        : "unavailable",
    });
  });
}

function lastErrorClassification(attempts: readonly AgentRunAttempt[]) {
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    const classification = attempts[index]?.errorClassification;
    if (classification) return classification;
  }
  return null;
}

function normalizeExecutionError(
  error: unknown,
  local: Readonly<SkillRunFailureAudit> | null,
  agentRunId: string,
) {
  if (error instanceof BudgetExceededError) {
    return {
      terminalStatus: "budget-exceeded" as const,
      classification: "configuration" as const,
      terminalMetadata: {
        kind: "budget-exceeded" as const,
        scope: error.scope,
        metric: error.metric,
        used: error.used,
        projected: error.projected,
        limit: error.limit,
      },
      error: safeApiError(
        "CONFIGURATION_ERROR",
        "Model execution budget exceeded",
        agentRunId,
        false,
      ),
    };
  }
  const classification =
    lastErrorClassification(local?.attempts ?? []) ??
    (error instanceof SkillRuntimeError
      ? skillRuntimeClassification(error.code)
      : "infrastructure");
  const code = apiCodeForClassification(classification);
  return {
    terminalStatus: classification === "cancelled" ? ("cancelled" as const) : ("failed" as const),
    classification,
    terminalMetadata:
      classification === "cancelled"
        ? ({ kind: "cancelled" } as const)
        : ({
            kind: "failed",
            classification:
              classification === "unavailable" ? "infrastructure" : classification,
          } as const),
    error: safeApiError(
      code,
      safeMessageForClassification(classification),
      agentRunId,
      classification === "upstream-temporary" || classification === "rate-limit",
    ),
  };
}

function skillRuntimeClassification(
  code: SkillRuntimeError["code"],
): NonNullable<AgentRunAttempt["errorClassification"]> {
  switch (code) {
    case "CONFIGURATION_ERROR":
      return "configuration";
    case "INPUT_SECURITY_ERROR":
    case "INPUT_VALIDATION_ERROR":
      return "validation";
    case "MODEL_OUTPUT_ERROR":
      return "model-output";
    case "TIMEOUT":
      return "upstream-temporary";
    case "CANCELLED":
      return "cancelled";
    case "PROVIDER_ERROR":
      return "upstream-permanent";
  }
}

function apiCodeForClassification(
  classification: NonNullable<AgentRunAttempt["errorClassification"]>,
): ApiError["code"] {
  switch (classification) {
    case "validation":
      return "VALIDATION_ERROR";
    case "configuration":
      return "CONFIGURATION_ERROR";
    case "authentication":
      return "AUTHENTICATION_REQUIRED";
    case "rate-limit":
      return "RATE_LIMITED";
    case "upstream-temporary":
      return "UPSTREAM_TEMPORARY";
    case "upstream-permanent":
      return "UPSTREAM_PERMANENT";
    case "data-quality":
      return "DATA_QUALITY_ERROR";
    case "model-output":
      return "MODEL_OUTPUT_ERROR";
    case "cancelled":
      return "CANCELLED";
    case "infrastructure":
    case "unavailable":
      return "INFRASTRUCTURE_ERROR";
  }
}

function safeMessageForClassification(
  classification: NonNullable<AgentRunAttempt["errorClassification"]>,
) {
  switch (classification) {
    case "validation":
      return "Skill input validation failed";
    case "configuration":
      return "Skill execution configuration failed";
    case "authentication":
      return "Model provider authentication failed";
    case "rate-limit":
      return "Model provider rate limit was exceeded";
    case "upstream-temporary":
      return "Model provider remained temporarily unavailable";
    case "upstream-permanent":
      return "Model provider request failed";
    case "data-quality":
      return "Skill data quality validation failed";
    case "model-output":
      return "Model output failed validation";
    case "infrastructure":
    case "unavailable":
      return "Agent execution infrastructure failed";
    case "cancelled":
      return "Skill execution was cancelled";
  }
}

function safeApiError(
  code: ApiError["code"],
  message: string,
  agentRunId: string,
  retryable: boolean,
): ApiError {
  return {
    code,
    message,
    requestId: `agent-run:${agentRunId}`,
    retryable,
  };
}
import { randomUUID } from "node:crypto";
