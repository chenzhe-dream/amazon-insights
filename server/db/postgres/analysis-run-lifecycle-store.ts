import { createHash, randomUUID } from "node:crypto";

import type { QueryResultRow } from "pg";

import {
  AgentRunTerminalMetadataSchema,
  DateTimeSchema,
  EntityIdSchema,
  Sha256Schema,
  type AgentRunTerminalMetadata,
} from "../../../shared/agent-contracts";
import {
  JobLeaseLostError,
  type AnalysisRunRecord,
  type CancelAnalysisRunInput,
  type JobAttemptRecord,
  type RetryFailedRunStageInput,
  type RetryFailedRunStageResult,
  type ResumeWaitingInputRunStageInput,
  type ResumeWaitingInputRunStageResult,
  type RunStageRecord,
} from "../repository";
import { PostgresQueryContext } from "./query-context";

type PostgresRow = Record<string, unknown>;

interface JobRow extends QueryResultRow {
  id: string;
  stage_id: string;
  run_id: string;
  stage: RunStageRecord["stage"];
  attempt_number: number;
  max_attempts: number;
  retry_cycle_start_attempt: number;
  logical_execution_cycle_id: string;
  report_publication_cycle: number;
  report_publication_attempt_count: number;
  report_publication_max_attempts: number | null;
  report_publication_initial_delay_ms: number | null;
  report_publication_max_delay_ms: number | null;
  report_publication_retry_at: Date | string | null;
  status: JobAttemptRecord["status"];
  available_at: Date | string;
  leased_by: string | null;
  lease_expires_at: Date | string | null;
  lease_generation: number;
  retryable: boolean;
  started_at: Date | string | null;
  completed_at: Date | string | null;
  error_json: Record<string, unknown> | null;
  created_at: Date | string;
  updated_at: Date | string;
}

type DurableCycleDisposition =
  | Readonly<{
      kind: "recover";
      mode: "unstarted" | "pending" | "report-only" | "completion-only";
    }>
  | Readonly<{
      kind: "retry-new-cycle";
      error: Record<string, unknown>;
    }>
  | Readonly<{
      kind: "settle";
      attemptStatus: "failed" | "cancelled";
      stageStatus: "failed" | "budget-exceeded" | "cancelled";
      error: Record<string, unknown>;
    }>;

export class PostgresAnalysisRunLifecycleStoreError extends Error {
  constructor(message = "PostgreSQL analysis run lifecycle store operation failed") {
    super(message);
    this.name = "PostgresAnalysisRunLifecycleStoreError";
  }
}

export class PostgresAnalysisRunLifecycleStore {
  readonly #queries: PostgresQueryContext;

  constructor(queries: PostgresQueryContext) {
    this.#queries = queries;
  }

  cancelAnalysisRun(
    input: CancelAnalysisRunInput,
  ): Promise<AnalysisRunRecord | null> {
    return this.#execute(async () => {
      const runId = EntityIdSchema.parse(input.runId);
      const cancelledAt = canonicalDateTime(input.cancelledAt);
      const errorJson = JSON.stringify(input.error);
      return await this.#queries.transaction(async () => {
        const current = await this.#findAnalysisRun(runId, true);
        if (!current || current.status === "cancelled") return current;

        await this.#queries.query(
          `UPDATE job_attempts
              SET status = 'cancelled', leased_by = NULL,
                  lease_expires_at = NULL,
                  lease_generation = lease_generation + 1,
                  retryable = FALSE, retry_scheduled_at = NULL,
                  completed_at = COALESCE(completed_at, $1),
                  error_json = $2::jsonb, updated_at = $1,
                  report_publication_retry_at = NULL
            WHERE stage_id IN (
              SELECT id FROM run_stages WHERE run_id = $3
            ) AND status IN ('queued', 'running')`,
          [cancelledAt, errorJson, runId],
        );
        await this.#queries.query(
          `UPDATE run_stages
              SET status = 'cancelled',
                  completed_at = COALESCE(completed_at, $1),
                  last_error_json = $2::jsonb, updated_at = $1
            WHERE run_id = $3 AND status <> 'succeeded'`,
          [cancelledAt, errorJson, runId],
        );
        await this.#queries.query(
          `UPDATE analysis_runs
              SET status = 'cancelled', updated_at = $1
            WHERE id = $2`,
          [cancelledAt, runId],
        );
        return await this.#findAnalysisRun(runId);
      });
    });
  }

  retryFailedRunStage(
    input: RetryFailedRunStageInput,
  ): Promise<RetryFailedRunStageResult | null> {
    return this.#execute(async () => {
      const runId = EntityIdSchema.parse(input.runId);
      const stageId = EntityIdSchema.parse(input.stageId);
      const jobId = EntityIdSchema.parse(input.jobId);
      const retriedAt = canonicalDateTime(input.retriedAt);
      const staleStageIds = [...new Set(input.staleStageIds)].map((id) =>
        EntityIdSchema.parse(id),
      );
      if (input.maxAutomaticAttempts <= 0) {
        throw new TypeError("maxAutomaticAttempts must be positive");
      }

      return await this.#queries.transaction(async () => {
        const currentStage = await this.#queries.query<PostgresRow>(
          `SELECT id, run_id, stage, status, progress, attempt_count,
                  started_at, completed_at, last_error_json, created_at,
                  updated_at
             FROM run_stages
            WHERE id = $1 AND run_id = $2
              AND status IN ('failed', 'succeeded')
            FOR UPDATE`,
          [stageId, runId],
        );
        if (!currentStage.rows[0]) return null;

        const latestJob = await this.#latestJobForStage(stageId);
        const durable = latestJob
          ? await this.#durableCycleDisposition(latestJob)
          : null;
        const publicationRecovery =
          currentStage.rows[0].status === "failed" &&
          latestJob !== null &&
          latestJob.status === "failed" &&
          latestJob.reportPublicationAttemptCount > 0 &&
          durable?.kind === "recover" &&
          (durable.mode === "report-only" ||
            durable.mode === "completion-only");

        if (publicationRecovery) {
          const stageUpdate = await this.#queries.query(
            `UPDATE run_stages
                SET status = 'queued', progress = 0, completed_at = NULL,
                    last_error_json = NULL, updated_at = $1
              WHERE id = $2 AND run_id = $3 AND status = 'failed'`,
            [retriedAt, stageId, runId],
          );
          if (stageUpdate.rowCount !== 1) return null;
          await this.#markStaleStages(staleStageIds, runId, retriedAt);
          const reset = await this.#queries.query(
            `UPDATE job_attempts
                SET status = 'queued', available_at = $1, leased_by = NULL,
                    lease_expires_at = NULL, retryable = FALSE,
                    retry_scheduled_at = NULL, completed_at = NULL,
                    error_json = NULL,
                    report_publication_cycle = report_publication_cycle + 1,
                    report_publication_attempt_count = 0,
                    report_publication_max_attempts = NULL,
                    report_publication_initial_delay_ms = NULL,
                    report_publication_max_delay_ms = NULL,
                    report_publication_retry_at = NULL, updated_at = $1
              WHERE id = $2 AND status = 'failed'`,
            [retriedAt, latestJob!.id],
          );
          if (reset.rowCount !== 1) throw new JobLeaseLostError();
          await this.#refreshAnalysisRunStatus(runId, retriedAt);
          return {
            stage: (await this.#findRunStage(stageId))!,
            attempt: (await this.#findJob(latestJob!.id))!,
          };
        }

        const nextAttempt = await this.#nextAttemptNumber(stageId);
        const stageUpdate = await this.#queries.query(
          `UPDATE run_stages
              SET status = 'queued', progress = 0, completed_at = NULL,
                  last_error_json = NULL, updated_at = $1
            WHERE id = $2 AND run_id = $3
              AND status IN ('failed', 'succeeded')`,
          [retriedAt, stageId, runId],
        );
        if (stageUpdate.rowCount !== 1) return null;
        await this.#markStaleStages(staleStageIds, runId, retriedAt);
        await this.#queries.query(
          `INSERT INTO job_attempts (
             id, stage_id, attempt_number, max_attempts,
             retry_cycle_start_attempt, logical_execution_cycle_id,
             status, available_at, leased_by, lease_expires_at,
             lease_generation, retryable, retry_scheduled_at, started_at,
             completed_at, error_json, created_at, updated_at
           ) VALUES ($1, $2, $3, $4, $3, $5, 'queued', $6, NULL, NULL, 0,
                     FALSE, NULL, NULL, NULL, NULL, $6, $6)`,
          [
            jobId,
            stageId,
            nextAttempt,
            nextAttempt + input.maxAutomaticAttempts - 1,
            createLogicalExecutionCycleId(),
            retriedAt,
          ],
        );
        await this.#refreshAnalysisRunStatus(runId, retriedAt);
        return {
          stage: (await this.#findRunStage(stageId))!,
          attempt: (await this.#findJob(jobId))!,
        };
      });
    });
  }

  resumeWaitingInputRunStage(
    input: ResumeWaitingInputRunStageInput,
  ): Promise<ResumeWaitingInputRunStageResult | null> {
    return this.#execute(async () => {
      const runId = EntityIdSchema.parse(input.runId);
      const stageId = EntityIdSchema.parse(input.stageId);
      const resumedAt = canonicalDateTime(input.resumedAt);
      return await this.#queries.transaction(async () => {
        const stage = await this.#queries.query<PostgresRow>(
          `SELECT id
             FROM run_stages
            WHERE id = $1 AND run_id = $2 AND stage = 'voc-positioning'
              AND status = 'waiting-input'
            FOR UPDATE`,
          [stageId, runId],
        );
        if (!stage.rows[0]) return null;

        const job = await this.#queries.query<JobRow>(
          `SELECT ja.*, rs.run_id, rs.stage
             FROM job_attempts ja
             JOIN run_stages rs ON rs.id = ja.stage_id
            WHERE ja.stage_id = $1
              AND ja.status = 'failed'
              AND ja.retryable = FALSE
            ORDER BY ja.attempt_number DESC
            FOR UPDATE OF ja
            LIMIT 1`,
          [stageId],
        );
        const latest = job.rows[0] ? mapJob(job.rows[0]) : null;
        if (!latest) return null;

        const stageUpdate = await this.#queries.query(
          `UPDATE run_stages
              SET status = 'queued', progress = 0, completed_at = NULL,
                  last_error_json = NULL, updated_at = $1
            WHERE id = $2 AND run_id = $3 AND status = 'waiting-input'`,
          [resumedAt, stageId, runId],
        );
        if (stageUpdate.rowCount !== 1) return null;
        const jobUpdate = await this.#queries.query(
          `UPDATE job_attempts
              SET status = 'queued', available_at = $1, leased_by = NULL,
                  lease_expires_at = NULL, retryable = FALSE,
                  retry_scheduled_at = NULL, completed_at = NULL,
                  error_json = NULL, updated_at = $1
            WHERE id = $2 AND status = 'failed' AND retryable = FALSE`,
          [resumedAt, latest.id],
        );
        if (jobUpdate.rowCount !== 1) throw new JobLeaseLostError();
        await this.#refreshAnalysisRunStatus(runId, resumedAt);
        return {
          stage: (await this.#findRunStage(stageId))!,
          attempt: (await this.#findJob(latest.id))!,
        };
      });
    });
  }

  async #latestJobForStage(stageId: string): Promise<JobAttemptRecord | null> {
    const result = await this.#queries.query<JobRow>(
      `SELECT ja.*, rs.run_id, rs.stage
         FROM job_attempts ja
         JOIN run_stages rs ON rs.id = ja.stage_id
        WHERE ja.stage_id = $1
        ORDER BY ja.attempt_number DESC
        FOR UPDATE OF ja
        LIMIT 1`,
      [stageId],
    );
    return result.rows[0] ? mapJob(result.rows[0]) : null;
  }

  async #nextAttemptNumber(stageId: string): Promise<number> {
    const result = await this.#queries.query<{ attempt: string | number }>(
      `SELECT COALESCE(MAX(attempt_number), 0) + 1 AS attempt
         FROM job_attempts
        WHERE stage_id = $1`,
      [stageId],
    );
    return Number(result.rows[0]?.attempt ?? 1);
  }

  async #markStaleStages(
    stageIds: readonly string[],
    runId: string,
    updatedAt: string,
  ) {
    for (const stageId of stageIds) {
      await this.#queries.query(
        `UPDATE run_stages
            SET status = 'stale', updated_at = $1
          WHERE id = $2 AND run_id = $3 AND status = 'succeeded'`,
        [updatedAt, stageId, runId],
      );
    }
  }

  async #durableCycleDisposition(
    current: JobAttemptRecord,
  ): Promise<DurableCycleDisposition> {
    const result = await this.#queries.query<
      QueryResultRow & {
        validation_status: "pending" | "passed" | "failed";
        terminal_status: string | null;
        terminal_metadata_json: unknown;
        report_exists: boolean;
      }
    >(
      `SELECT ar.validation_status, ar.terminal_status,
              ar.terminal_metadata_json,
              EXISTS (
                SELECT 1 FROM analysis_reports report
                 WHERE report.agent_run_id = ar.id
              ) AS report_exists
         FROM agent_runs ar
        WHERE ar.stage_id = $1 AND ar.logical_execution_cycle_id = $2`,
      [current.stageId, current.logicalExecutionCycleId],
    );
    if (result.rows.length > 1) {
      throw new PostgresAnalysisRunLifecycleStoreError();
    }
    const row = result.rows[0];
    if (!row) {
      return current.status === "running"
        ? { kind: "recover", mode: "unstarted" }
        : {
            kind: "retry-new-cycle",
            error: current.error ?? durableFailureError("infrastructure"),
          };
    }
    if (row.validation_status === "pending") {
      return { kind: "recover", mode: "pending" };
    }
    let metadata: AgentRunTerminalMetadata;
    try {
      metadata = AgentRunTerminalMetadataSchema.parse(
        row.terminal_metadata_json,
      );
    } catch {
      throw new PostgresAnalysisRunLifecycleStoreError();
    }
    if (
      row.validation_status === "passed" &&
      row.terminal_status === "succeeded" &&
      metadata.kind === "succeeded"
    ) {
      return {
        kind: "recover",
        mode: row.report_exists ? "completion-only" : "report-only",
      };
    }
    if (row.validation_status !== "failed") {
      throw new PostgresAnalysisRunLifecycleStoreError();
    }
    if (metadata.kind === "budget-exceeded") {
      return {
        kind: "settle",
        attemptStatus: "failed",
        stageStatus: "budget-exceeded",
        error: {
          classification: "configuration",
          code: "CONFIGURATION_ERROR",
          message: "Configured model budget was exceeded",
          scope: metadata.scope,
          metric: metadata.metric,
          used: metadata.used,
          projected: metadata.projected,
          limit: metadata.limit,
        },
      };
    }
    if (metadata.kind === "cancelled") {
      return {
        kind: "settle",
        attemptStatus: "cancelled",
        stageStatus: "cancelled",
        error: {
          classification: "cancelled",
          code: "CANCELLED",
          message: "Skill execution was cancelled",
        },
      };
    }
    if (metadata.kind !== "failed") {
      throw new PostgresAnalysisRunLifecycleStoreError();
    }
    const error = durableFailureError(metadata.classification);
    if (
      metadata.classification === "upstream-temporary" ||
      metadata.classification === "rate-limit"
    ) {
      return { kind: "retry-new-cycle", error };
    }
    return {
      kind: "settle",
      attemptStatus: "failed",
      stageStatus: "failed",
      error,
    };
  }

  async #refreshAnalysisRunStatus(runId: string, updatedAt: string) {
    const run = await this.#queries.query<{ status: string }>(
      "SELECT status FROM analysis_runs WHERE id = $1",
      [runId],
    );
    if (!run.rows[0] || run.rows[0].status === "cancelled") return;
    const stages = await this.#queries.query<{ status: RunStageRecord["status"] }>(
      "SELECT status FROM run_stages WHERE run_id = $1",
      [runId],
    );
    const jobs = await this.#queries.query<{ running: string; queued: string }>(
      `SELECT
         COUNT(*) FILTER (WHERE ja.status = 'running')::text AS running,
         COUNT(*) FILTER (WHERE ja.status = 'queued')::text AS queued
       FROM job_attempts ja
       JOIN run_stages rs ON rs.id = ja.stage_id
       WHERE rs.run_id = $1`,
      [runId],
    );
    const status = deriveRunStatus(
      stages.rows.map(({ status: stageStatus }) => stageStatus),
      Number(jobs.rows[0]?.running ?? 0),
      Number(jobs.rows[0]?.queued ?? 0),
    );
    await this.#queries.query(
      "UPDATE analysis_runs SET status = $1, updated_at = $2 WHERE id = $3",
      [status, updatedAt, runId],
    );
  }

  async #findAnalysisRun(
    id: string,
    forUpdate = false,
  ): Promise<AnalysisRunRecord | null> {
    const result = await this.#queries.query<PostgresRow>(
      `SELECT id, project_id, mode, status, created_by, data_cutoff_at,
              idempotency_scope, idempotency_key, created_at, updated_at
         FROM analysis_runs
        WHERE id = $1
        ${forUpdate ? "FOR UPDATE" : ""}`,
      [id],
    );
    return result.rows[0] ? mapAnalysisRun(result.rows[0]) : null;
  }

  async #findRunStage(id: string): Promise<RunStageRecord | null> {
    const result = await this.#queries.query<PostgresRow>(
      `SELECT id, run_id, stage, status, progress, attempt_count,
              started_at, completed_at, last_error_json, created_at, updated_at
         FROM run_stages
        WHERE id = $1`,
      [id],
    );
    return result.rows[0] ? mapRunStage(result.rows[0]) : null;
  }

  async #findJob(id: string): Promise<JobAttemptRecord | null> {
    const result = await this.#queries.query<JobRow>(
      `SELECT ja.*, rs.run_id, rs.stage
         FROM job_attempts ja
         JOIN run_stages rs ON rs.id = ja.stage_id
        WHERE ja.id = $1`,
      [id],
    );
    return result.rows[0] ? mapJob(result.rows[0]) : null;
  }

  async #execute<Result>(operation: () => Promise<Result>): Promise<Result> {
    try {
      return await operation();
    } catch (error) {
      if (
        error instanceof JobLeaseLostError ||
        error instanceof PostgresAnalysisRunLifecycleStoreError ||
        error instanceof TypeError
      ) {
        throw error;
      }
      const code = postgresErrorCode(error);
      if (code === "23503" || code === "23505") {
        throw new JobLeaseLostError();
      }
      throw new PostgresAnalysisRunLifecycleStoreError();
    }
  }
}

function mapAnalysisRun(row: PostgresRow): AnalysisRunRecord {
  return {
    id: requireString(row.id),
    projectId: requireString(row.project_id),
    mode: requireString(row.mode) as AnalysisRunRecord["mode"],
    status: requireString(row.status) as AnalysisRunRecord["status"],
    createdBy: requireString(row.created_by),
    dataCutoffAt: mapDateTime(row.data_cutoff_at),
    idempotencyScope: requireString(row.idempotency_scope),
    idempotencyKey: requireString(row.idempotency_key),
    createdAt: mapDateTime(row.created_at),
    updatedAt: mapDateTime(row.updated_at),
  };
}

function mapRunStage(row: PostgresRow): RunStageRecord {
  return {
    id: requireString(row.id),
    runId: requireString(row.run_id),
    stage: requireString(row.stage) as RunStageRecord["stage"],
    status: requireString(row.status) as RunStageRecord["status"],
    progress: requireNumber(row.progress),
    attemptCount: requireNumber(row.attempt_count),
    startedAt: row.started_at === null ? null : mapDateTime(row.started_at),
    completedAt:
      row.completed_at === null ? null : mapDateTime(row.completed_at),
    lastError:
      row.last_error_json === null
        ? null
        : (row.last_error_json as Record<string, unknown>),
    createdAt: mapDateTime(row.created_at),
    updatedAt: mapDateTime(row.updated_at),
  };
}

function mapJob(row: JobRow): JobAttemptRecord {
  const logicalExecutionCycleId = Sha256Schema.safeParse(
    row.logical_execution_cycle_id,
  );
  if (!logicalExecutionCycleId.success) {
    throw new PostgresAnalysisRunLifecycleStoreError();
  }
  return {
    id: row.id,
    stageId: row.stage_id,
    runId: row.run_id,
    stage: row.stage,
    attemptNumber: row.attempt_number,
    maxAttempts: row.max_attempts,
    retryCycleStartAttempt: row.retry_cycle_start_attempt,
    logicalExecutionCycleId: logicalExecutionCycleId.data,
    reportPublicationCycle: row.report_publication_cycle,
    reportPublicationAttemptCount: row.report_publication_attempt_count,
    reportPublicationMaxAttempts: row.report_publication_max_attempts,
    reportPublicationInitialDelayMs: row.report_publication_initial_delay_ms,
    reportPublicationMaxDelayMs: row.report_publication_max_delay_ms,
    reportPublicationRetryAt:
      row.report_publication_retry_at === null
        ? null
        : mapDateTime(row.report_publication_retry_at),
    status: row.status,
    availableAt: mapDateTime(row.available_at),
    leasedBy: row.leased_by,
    leaseExpiresAt:
      row.lease_expires_at === null ? null : mapDateTime(row.lease_expires_at),
    leaseGeneration: row.lease_generation,
    retryable: row.retryable,
    startedAt: row.started_at === null ? null : mapDateTime(row.started_at),
    completedAt:
      row.completed_at === null ? null : mapDateTime(row.completed_at),
    error: row.error_json,
    createdAt: mapDateTime(row.created_at),
    updatedAt: mapDateTime(row.updated_at),
  };
}

function durableFailureError(
  classification: Exclude<
    AgentRunTerminalMetadata,
    { kind: "succeeded" | "budget-exceeded" | "cancelled" }
  >["classification"],
): Record<string, unknown> {
  const messages: Record<typeof classification, string> = {
    validation: "Skill input validation failed",
    configuration: "Skill execution configuration failed",
    authentication: "Model provider authentication failed",
    "rate-limit": "Model provider rate limit was exceeded",
    "upstream-temporary": "Model provider remained temporarily unavailable",
    "upstream-permanent": "Model provider request failed",
    "data-quality": "Skill data quality validation failed",
    "model-output": "Model output failed validation",
    infrastructure: "Agent execution infrastructure failed",
  };
  const codes: Record<typeof classification, string> = {
    validation: "VALIDATION_ERROR",
    configuration: "CONFIGURATION_ERROR",
    authentication: "AUTHENTICATION_REQUIRED",
    "rate-limit": "RATE_LIMITED",
    "upstream-temporary": "UPSTREAM_TEMPORARY",
    "upstream-permanent": "UPSTREAM_PERMANENT",
    "data-quality": "DATA_QUALITY_ERROR",
    "model-output": "MODEL_OUTPUT_ERROR",
    infrastructure: "INFRASTRUCTURE_ERROR",
  };
  return {
    classification,
    code: codes[classification],
    message: messages[classification],
  };
}

function deriveRunStatus(
  stages: readonly RunStageRecord["status"][],
  runningJobs: number,
  queuedJobs: number,
): AnalysisRunRecord["status"] {
  const statuses = new Set(stages);
  if (runningJobs > 0 || statuses.has("running")) return "running";
  if (queuedJobs > 0) {
    return statuses.has("succeeded") || statuses.has("failed")
      ? "running"
      : "queued";
  }
  const succeeded = statuses.has("succeeded");
  if (statuses.has("waiting-input")) return succeeded ? "partial" : "waiting-input";
  if (statuses.has("budget-exceeded")) {
    return succeeded ? "partial" : "budget-exceeded";
  }
  if (statuses.has("failed")) return succeeded ? "partial" : "failed";
  if (statuses.has("stale") || statuses.has("skipped")) return "partial";
  if (statuses.size === 1 && statuses.has("succeeded")) return "succeeded";
  if (statuses.size === 1 && statuses.has("cancelled")) return "cancelled";
  if (statuses.has("queued")) return succeeded ? "partial" : "queued";
  return succeeded ? "partial" : "failed";
}

function createLogicalExecutionCycleId(): string {
  return createHash("sha256").update(randomUUID()).digest("hex");
}

function canonicalDateTime(value: string): string {
  const parsed = DateTimeSchema.parse(value);
  return new Date(parsed).toISOString();
}

function mapDateTime(value: unknown): string {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString();
  }
  if (typeof value === "string") return canonicalDateTime(value);
  throw new PostgresAnalysisRunLifecycleStoreError();
}

function requireString(value: unknown): string {
  if (typeof value !== "string") {
    throw new PostgresAnalysisRunLifecycleStoreError();
  }
  return value;
}

function requireNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new PostgresAnalysisRunLifecycleStoreError();
  }
  return value;
}

function postgresErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}
