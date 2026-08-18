import { createHash, randomUUID } from "node:crypto";

import type { QueryResultRow } from "pg";

import type {
  ClaimJobInput,
  CompleteJobInput,
  EnqueueJobInput,
  FailJobInput,
  JobAttemptRecord,
  ReleaseJobLeaseInput,
  RenewJobLeaseInput,
  RunStageRecord,
} from "../repository";
import { JobLeaseLostError } from "../repository";
import { PostgresQueryContext } from "./query-context";

type JobRepositoryContract = {
  enqueueJob(input: EnqueueJobInput): Promise<JobAttemptRecord>;
  claimNextJob(input: ClaimJobInput): Promise<JobAttemptRecord | null>;
  renewJobLease(input: RenewJobLeaseInput): Promise<JobAttemptRecord>;
  releaseJobLease(input: ReleaseJobLeaseInput): Promise<JobAttemptRecord>;
  completeJob(input: CompleteJobInput): Promise<JobAttemptRecord>;
  failJob(input: FailJobInput): Promise<JobAttemptRecord>;
  listJobAttempts(stageId: string): Promise<JobAttemptRecord[]>;
};

interface JobRow extends QueryResultRow {
  id: string;
  stage_id: string;
  run_id: string;
  stage: RunStageRecord["stage"];
  attempt_number: number;
  max_attempts: number;
  retry_cycle_start_attempt: number;
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

export class PostgresJobStoreError extends Error {
  constructor(message = "PostgreSQL job store operation failed") {
    super(message);
    this.name = "PostgresJobStoreError";
  }
}

export class PostgresJobStoreConflictError extends PostgresJobStoreError {
  constructor() {
    super("PostgreSQL job store conflict");
    this.name = "PostgresJobStoreConflictError";
  }
}

export class PostgresJobStore implements JobRepositoryContract {
  readonly #queries: PostgresQueryContext;

  constructor(queries: PostgresQueryContext) {
    this.#queries = queries;
  }

  enqueueJob(input: EnqueueJobInput): Promise<JobAttemptRecord> {
    return this.#execute(async () => {
      assertIdentifier(input.id, "job ID");
      assertIdentifier(input.stageId, "stage ID");
      assertPositiveInteger(input.attemptNumber, "attempt number");
      assertPositiveInteger(input.maxAttempts, "maximum attempts");
      if (input.attemptNumber > input.maxAttempts) {
        throw new TypeError("Job attempt exceeds maximum attempts");
      }
      assertTimestamp(input.availableAt, "availableAt");
      assertTimestamp(input.createdAt, "createdAt");
      const inserted = await this.#queries.query<JobRow>(
        `INSERT INTO job_attempts (
           id, stage_id, attempt_number, max_attempts,
           retry_cycle_start_attempt, status, available_at, leased_by,
           lease_expires_at, lease_generation, retryable, retry_scheduled_at,
           started_at, completed_at, error_json, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $3, 'queued', $5, NULL, NULL, 0,
                   FALSE, NULL, NULL, NULL, NULL, $6, $6)
         RETURNING *`,
        [
          input.id,
          input.stageId,
          input.attemptNumber,
          input.maxAttempts,
          input.availableAt,
          input.createdAt,
        ],
      );
      return await this.#findRequiredJob(inserted.rows[0]!.id);
    });
  }

  claimNextJob(input: ClaimJobInput): Promise<JobAttemptRecord | null> {
    return this.#execute(async () => {
      assertIdentifier(input.ownerId, "lease owner");
      assertTimestamp(input.claimedAt, "claimedAt");
      assertPositiveInteger(input.leaseDurationMs, "lease duration");
      if (input.stage !== undefined && !isStage(input.stage)) {
        throw new TypeError("Invalid job claim stage filter");
      }
      return await this.#queries.transaction(async () => {
        const selected = await this.#queries.query<JobRow>(
          `SELECT ja.*, rs.run_id, rs.stage
             FROM job_attempts ja
             JOIN run_stages rs ON rs.id = ja.stage_id
            WHERE (
              (ja.status = 'queued' AND ja.available_at <= $1)
              OR (
                ja.status = 'failed' AND ja.retryable = TRUE
                AND ja.retry_scheduled_at IS NULL
                AND ja.available_at <= $1
              )
              OR (
                ja.status = 'running' AND ja.lease_expires_at <= $1
              )
            )
              AND ($2::text IS NULL OR rs.stage = $2)
            ORDER BY
              CASE ja.status
                WHEN 'running' THEN ja.lease_expires_at
                ELSE ja.available_at
              END,
              ja.created_at, ja.id
            FOR UPDATE OF ja SKIP LOCKED
            LIMIT 1`,
          [input.claimedAt, input.stage ?? null],
        );
        const candidate = selected.rows[0];
        if (!candidate) return null;

        if (candidate.status === "queued") {
          const claimed = await this.#queries.query(
            `UPDATE job_attempts
                SET status = 'running', leased_by = $1,
                    lease_expires_at = $2, lease_generation = lease_generation + 1,
                    started_at = COALESCE(started_at, $3), updated_at = $3
              WHERE id = $4 AND status = 'queued'`,
            [
              input.ownerId,
              addMilliseconds(input.claimedAt, input.leaseDurationMs),
              input.claimedAt,
              candidate.id,
            ],
          );
          assertOneLeaseMutation(claimed.rowCount);
          await this.#markStageRunning(
            candidate.stage_id,
            candidate.attempt_number,
            input.claimedAt,
          );
          return await this.#findRequiredJob(candidate.id);
        }

        const leaseExpiredError = {
          classification: "infrastructure",
          code: "INFRASTRUCTURE_ERROR",
          message: "Job lease expired before completion",
        };
        if (candidate.attempt_number >= candidate.max_attempts) {
          const terminalError = candidate.error_json ?? leaseExpiredError;
          await this.#queries.query(
            `UPDATE job_attempts
                SET status = 'failed', retryable = FALSE,
                    retry_scheduled_at = NULL, leased_by = NULL,
                    lease_expires_at = NULL,
                    completed_at = COALESCE(completed_at, $1),
                    error_json = $2::jsonb, updated_at = $1
              WHERE id = $3`,
            [input.claimedAt, JSON.stringify(terminalError), candidate.id],
          );
          await this.#queries.query(
            `UPDATE run_stages
                SET status = 'failed', completed_at = $1,
                    last_error_json = $2::jsonb, updated_at = $1
              WHERE id = $3`,
            [input.claimedAt, JSON.stringify(terminalError), candidate.stage_id],
          );
          await this.#refreshAnalysisRunStatus(candidate.run_id, input.claimedAt);
          return null;
        }

        const predecessorError = candidate.error_json ?? leaseExpiredError;
        await this.#queries.query(
          `UPDATE job_attempts
              SET status = 'failed', retryable = TRUE,
                  retry_scheduled_at = $1, leased_by = NULL,
                  lease_expires_at = NULL,
                  completed_at = COALESCE(completed_at, $1),
                  error_json = $2::jsonb, updated_at = $1
            WHERE id = $3`,
          [input.claimedAt, JSON.stringify(predecessorError), candidate.id],
        );
        const nextId = randomUUID();
        const nextAttempt = candidate.attempt_number + 1;
        await this.#queries.query(
          `INSERT INTO job_attempts (
             id, stage_id, attempt_number, max_attempts,
             retry_cycle_start_attempt, status, available_at, leased_by,
             lease_expires_at, lease_generation, retryable, retry_scheduled_at,
             started_at, completed_at, error_json, created_at, updated_at
           ) VALUES ($1, $2, $3, $4, $5, 'running', $6, $7, $8, $9,
                     FALSE, NULL, $6, NULL, NULL, $6, $6)`,
          [
            nextId,
            candidate.stage_id,
            nextAttempt,
            candidate.max_attempts,
            candidate.retry_cycle_start_attempt,
            input.claimedAt,
            input.ownerId,
            addMilliseconds(input.claimedAt, input.leaseDurationMs),
            candidate.lease_generation + 1,
          ],
        );
        await this.#markStageRunning(
          candidate.stage_id,
          nextAttempt,
          input.claimedAt,
        );
        return await this.#findRequiredJob(nextId);
      });
    });
  }

  renewJobLease(input: RenewJobLeaseInput): Promise<JobAttemptRecord> {
    return this.#execute(async () => {
      assertLeaseMutationInput(input);
      assertTimestamp(input.renewedAt, "renewedAt");
      assertPositiveInteger(input.leaseDurationMs, "lease duration");
      const result = await this.#queries.query(
        `UPDATE job_attempts
            SET lease_expires_at = $1, updated_at = $2
          WHERE id = $3 AND status = 'running' AND leased_by = $4
            AND lease_generation = $5 AND lease_expires_at > $2`,
        [
          addMilliseconds(input.renewedAt, input.leaseDurationMs),
          input.renewedAt,
          input.jobId,
          input.ownerId,
          input.leaseGeneration,
        ],
      );
      assertOneLeaseMutation(result.rowCount);
      return await this.#findRequiredJob(input.jobId);
    });
  }

  releaseJobLease(input: ReleaseJobLeaseInput): Promise<JobAttemptRecord> {
    return this.#execute(async () => {
      assertLeaseMutationInput(input);
      assertTimestamp(input.releasedAt, "releasedAt");
      return await this.#queries.transaction(async () => {
        const result = await this.#queries.query(
          `UPDATE job_attempts
              SET status = 'queued', available_at = $1, leased_by = NULL,
                  lease_expires_at = NULL, retryable = FALSE,
                  retry_scheduled_at = NULL, completed_at = NULL,
                  error_json = NULL, updated_at = $1
            WHERE id = $2 AND status = 'running' AND leased_by = $3
              AND lease_generation = $4 AND lease_expires_at > $1`,
          [input.releasedAt, input.jobId, input.ownerId, input.leaseGeneration],
        );
        assertOneLeaseMutation(result.rowCount);
        const job = await this.#findRequiredJob(input.jobId);
        const stage = await this.#queries.query(
          `UPDATE run_stages
              SET status = 'queued', completed_at = NULL, updated_at = $1
            WHERE id = $2 AND status = 'running'`,
          [input.releasedAt, job.stageId],
        );
        assertOneLeaseMutation(stage.rowCount);
        await this.#refreshAnalysisRunStatus(job.runId, input.releasedAt);
        return job;
      });
    });
  }

  completeJob(input: CompleteJobInput): Promise<JobAttemptRecord> {
    return this.#execute(async () => {
      assertLeaseMutationInput(input);
      assertTimestamp(input.completedAt, "completedAt");
      return await this.#queries.transaction(async () => {
        const result = await this.#queries.query(
          `UPDATE job_attempts
              SET status = 'succeeded', leased_by = NULL,
                  lease_expires_at = NULL, completed_at = $1,
                  retryable = FALSE, retry_scheduled_at = NULL,
                  updated_at = $1
            WHERE id = $2 AND status = 'running' AND leased_by = $3
              AND lease_generation = $4 AND lease_expires_at > $1`,
          [input.completedAt, input.jobId, input.ownerId, input.leaseGeneration],
        );
        assertOneLeaseMutation(result.rowCount);
        const job = await this.#findRequiredJob(input.jobId);
        await this.#queries.query(
          `UPDATE run_stages
              SET status = 'succeeded', progress = 100, completed_at = $1,
                  last_error_json = NULL, updated_at = $1
            WHERE id = $2`,
          [input.completedAt, job.stageId],
        );
        await this.#refreshAnalysisRunStatus(job.runId, input.completedAt);
        return job;
      });
    });
  }

  failJob(input: FailJobInput): Promise<JobAttemptRecord> {
    return this.#execute(async () => {
      assertLeaseMutationInput(input);
      assertTimestamp(input.failedAt, "failedAt");
      if (input.retryAt !== null) assertTimestamp(input.retryAt, "retryAt");
      const attemptStatus = input.attemptStatus ?? "failed";
      const stageStatus = input.stageStatus ?? (input.retryable ? "queued" : "failed");
      if (
        input.retryable !== (stageStatus === "queued") ||
        (input.retryable && attemptStatus !== "failed")
      ) {
        throw new TypeError("Retryable jobs must return their stage to queued");
      }
      return await this.#queries.transaction(async () => {
        const availableAt = input.retryable
          ? (input.retryAt ?? input.failedAt)
          : input.failedAt;
        const result = await this.#queries.query(
          `UPDATE job_attempts
              SET status = $1, available_at = $2, leased_by = NULL,
                  lease_expires_at = NULL, retryable = $3,
                  retry_scheduled_at = NULL, completed_at = $4,
                  error_json = $5::jsonb, updated_at = $4
            WHERE id = $6 AND status = 'running' AND leased_by = $7
              AND lease_generation = $8 AND lease_expires_at > $4`,
          [
            attemptStatus,
            availableAt,
            input.retryable,
            input.failedAt,
            JSON.stringify(input.error),
            input.jobId,
            input.ownerId,
            input.leaseGeneration,
          ],
        );
        assertOneLeaseMutation(result.rowCount);
        const job = await this.#findRequiredJob(input.jobId);
        const completedAt =
          stageStatus === "queued" || stageStatus === "waiting-input"
            ? null
            : input.failedAt;
        await this.#queries.query(
          `UPDATE run_stages
              SET status = $1, completed_at = $2,
                  last_error_json = $3::jsonb, updated_at = $4
            WHERE id = $5`,
          [
            stageStatus,
            completedAt,
            JSON.stringify(input.error),
            input.failedAt,
            job.stageId,
          ],
        );
        await this.#refreshAnalysisRunStatus(job.runId, input.failedAt);
        return job;
      });
    });
  }

  listJobAttempts(stageId: string): Promise<JobAttemptRecord[]> {
    return this.#execute(async () => {
      assertIdentifier(stageId, "stage ID");
      const result = await this.#queries.query<JobRow>(
        `SELECT ja.*, rs.run_id, rs.stage
           FROM job_attempts ja
           JOIN run_stages rs ON rs.id = ja.stage_id
          WHERE ja.stage_id = $1
          ORDER BY ja.attempt_number`,
        [stageId],
      );
      return result.rows.map(mapJob);
    });
  }

  async #markStageRunning(
    stageId: string,
    attemptNumber: number,
    updatedAt: string,
  ) {
    const stage = await this.#queries.query<{ run_id: string }>(
      `UPDATE run_stages
          SET status = 'running', attempt_count = $1,
              started_at = COALESCE(started_at, $2), updated_at = $2
        WHERE id = $3
        RETURNING run_id`,
      [attemptNumber, updatedAt, stageId],
    );
    if (!stage.rows[0]) throw new PostgresJobStoreConflictError();
    await this.#refreshAnalysisRunStatus(stage.rows[0].run_id, updatedAt);
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

  async #findRequiredJob(id: string) {
    const result = await this.#queries.query<JobRow>(
      `SELECT ja.*, rs.run_id, rs.stage
         FROM job_attempts ja
         JOIN run_stages rs ON rs.id = ja.stage_id
        WHERE ja.id = $1`,
      [id],
    );
    if (!result.rows[0]) throw new PostgresJobStoreConflictError();
    return mapJob(result.rows[0]);
  }

  async #execute<Result>(operation: () => Promise<Result>): Promise<Result> {
    try {
      return await operation();
    } catch (error) {
      if (
        error instanceof JobLeaseLostError ||
        error instanceof PostgresJobStoreError ||
        error instanceof TypeError
      ) {
        throw error;
      }
      const code = postgresErrorCode(error);
      if (code === "23503" || code === "23505") {
        throw new PostgresJobStoreConflictError();
      }
      throw new PostgresJobStoreError();
    }
  }
}

function mapJob(row: JobRow): JobAttemptRecord {
  return {
    id: row.id,
    stageId: row.stage_id,
    runId: row.run_id,
    stage: row.stage,
    attemptNumber: row.attempt_number,
    maxAttempts: row.max_attempts,
    retryCycleStartAttempt: row.retry_cycle_start_attempt,
    logicalExecutionCycleId: createHash("sha256")
      .update(`${row.stage_id}:${row.retry_cycle_start_attempt}`)
      .digest("hex"),
    reportPublicationCycle: 1,
    reportPublicationAttemptCount: 0,
    reportPublicationMaxAttempts: null,
    reportPublicationInitialDelayMs: null,
    reportPublicationMaxDelayMs: null,
    reportPublicationRetryAt: null,
    status: row.status,
    availableAt: mapTimestamp(row.available_at),
    leasedBy: row.leased_by,
    leaseExpiresAt:
      row.lease_expires_at === null ? null : mapTimestamp(row.lease_expires_at),
    leaseGeneration: row.lease_generation,
    retryable: row.retryable,
    startedAt: row.started_at === null ? null : mapTimestamp(row.started_at),
    completedAt:
      row.completed_at === null ? null : mapTimestamp(row.completed_at),
    error: row.error_json,
    createdAt: mapTimestamp(row.created_at),
    updatedAt: mapTimestamp(row.updated_at),
  };
}

function assertLeaseMutationInput(input: {
  jobId: string;
  ownerId: string;
  leaseGeneration: number;
}) {
  assertIdentifier(input.jobId, "job ID");
  assertIdentifier(input.ownerId, "lease owner");
  assertPositiveInteger(input.leaseGeneration, "lease generation");
}

function assertIdentifier(value: string, label: string) {
  if (typeof value !== "string" || value.length < 1 || value.length > 200) {
    throw new TypeError(`Invalid ${label}`);
  }
}

function assertPositiveInteger(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`Invalid ${label}`);
  }
}

function assertTimestamp(value: string, label: string) {
  if (
    typeof value !== "string" ||
    !Number.isFinite(new Date(value).getTime()) ||
    new Date(value).toISOString() !== value
  ) {
    throw new TypeError(`Invalid job timestamp for ${label}`);
  }
}

function addMilliseconds(timestamp: string, durationMs: number) {
  return new Date(new Date(timestamp).getTime() + durationMs).toISOString();
}

function mapTimestamp(value: Date | string) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new PostgresJobStoreError();
  return date.toISOString();
}

function assertOneLeaseMutation(rowCount: number | null) {
  if (rowCount !== 1) throw new JobLeaseLostError();
}

function isStage(value: string): value is RunStageRecord["stage"] {
  return ["traffic-analysis", "voc-positioning", "product-definition"].includes(
    value,
  );
}

function deriveRunStatus(
  stages: readonly RunStageRecord["status"][],
  runningJobs: number,
  queuedJobs: number,
) {
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

function postgresErrorCode(error: unknown) {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}
