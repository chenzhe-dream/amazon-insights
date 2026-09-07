import { createHash, randomUUID } from "node:crypto";

import type { QueryResultRow } from "pg";

import {
  AgentRunTerminalMetadataSchema,
  Sha256Schema,
  type AgentRunTerminalMetadata,
} from "../../../shared/agent-contracts";
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
import { normalizationRecoveryDisposition, normalizationRecoveryQueries, normalizationSettlementQueries, type NormalizationTerminalRepair } from "../../domain/voc/alexa-voc-recovery";

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
      normalizationTerminals?: readonly NormalizationTerminalRepair[];
      error: Record<string, unknown>;
    }>;

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
                AND (
                  ja.report_publication_retry_at IS NULL
                  OR ja.report_publication_retry_at <= $1
                )
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
        const current = mapJob(candidate);

        if (current.status === "queued") {
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
              current.id,
            ],
          );
          assertOneLeaseMutation(claimed.rowCount);
          await this.#markStageRunning(
            current.stageId,
            current.attemptNumber,
            input.claimedAt,
          );
          return await this.#findRequiredJob(current.id);
        }

        const expired = current.status === "running";
        const leaseExpiredError = {
          classification: "infrastructure",
          code: "INFRASTRUCTURE_ERROR",
          message: "Job lease expired before completion",
        };
        const disposition = await this.#durableCycleDisposition(current);
        if (disposition.kind === "settle") {
          await this.#settleClaimCandidate(current, disposition, input.claimedAt);
          return null;
        }

        if (
          disposition.kind === "recover" &&
          (disposition.mode === "report-only" ||
            disposition.mode === "completion-only") &&
          current.status === "failed"
        ) {
          return await this.#reclaimRecoveryLease(current, input);
        }

        if (current.attemptNumber >= current.maxAttempts) {
          if (
            disposition.kind === "recover" &&
            disposition.mode !== "unstarted"
          ) {
            return await this.#reclaimRecoveryLease(current, input);
          }
          const terminalError =
            disposition.kind === "recover"
              ? leaseExpiredError
              : disposition.error;
          await this.#settleClaimCandidate(
            current,
            {
              kind: "settle",
              attemptStatus: "failed",
              stageStatus: "failed",
              error: terminalError,
            },
            input.claimedAt,
          );
          return null;
        }

        const predecessorError =
          disposition.kind === "retry-new-cycle"
            ? disposition.error
            : expired
              ? leaseExpiredError
              : (current.error ?? leaseExpiredError);
        await this.#queries.query(
          `UPDATE job_attempts
              SET status = 'failed', retryable = TRUE,
                  retry_scheduled_at = $1, leased_by = NULL,
                  lease_expires_at = NULL,
                  completed_at = COALESCE(completed_at, $1),
                  error_json = $2::jsonb, updated_at = $1
            WHERE id = $3`,
          [input.claimedAt, JSON.stringify(predecessorError), current.id],
        );
        const nextId = randomUUID();
        const nextAttempt = current.attemptNumber + 1;
        await this.#queries.query(
          `INSERT INTO job_attempts (
             id, stage_id, attempt_number, max_attempts,
             retry_cycle_start_attempt, logical_execution_cycle_id,
             status, available_at, leased_by, lease_expires_at,
             lease_generation, retryable, retry_scheduled_at,
             started_at, completed_at, error_json, created_at, updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, 'running', $7, $8, $9, $10,
                     FALSE, NULL, $7, NULL, NULL, $7, $7)`,
          [
            nextId,
            current.stageId,
            nextAttempt,
            current.maxAttempts,
            current.retryCycleStartAttempt,
            disposition.kind === "recover"
              ? current.logicalExecutionCycleId
              : createLogicalExecutionCycleId(),
            input.claimedAt,
            input.ownerId,
            addMilliseconds(input.claimedAt, input.leaseDurationMs),
            current.leaseGeneration + 1,
          ],
        );
        await this.#markStageRunning(
          current.stageId,
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
      return await this.#queries.transaction(async () => {
        const transactionNow = await this.#transactionNow();
        const current = await this.#findRequiredJob(input.jobId, true);
        const disposition = await this.#durableCycleDisposition(current);
        const reportOnlyRecovery =
          disposition.kind === "recover" &&
          (disposition.mode === "report-only" ||
            disposition.mode === "completion-only") &&
          (input.error.classification === "upstream-temporary" ||
            input.error.classification === "rate-limit");
        const publication = reportOnlyRecovery
          ? nextReportPublicationFailure(current, input, transactionNow)
          : null;
        const terminalSettlement = current.stage === "alexa-voc-normalization" && disposition.kind === "settle" ? disposition : null;
        if (terminalSettlement) {
          for (const query of normalizationSettlementQueries(current, terminalSettlement.normalizationTerminals, transactionNow)) {
            let index = 0;
            await this.#queries.query(query.sql.replace(/\?/g, () => `$${++index}`), query.values);
          }
        }
        const retryable = terminalSettlement ? false : publication?.retryable ?? input.retryable;
        const availableAt = retryable
          ? (publication?.retryAt ?? input.retryAt ?? input.failedAt)
          : input.failedAt;
        const attemptStatus = reportOnlyRecovery
          ? "failed"
          : (terminalSettlement?.attemptStatus ?? input.attemptStatus ?? "failed");
        const stageStatus = reportOnlyRecovery
          ? retryable
            ? "queued"
            : "failed"
          : (terminalSettlement?.stageStatus ?? input.stageStatus ?? (retryable ? "queued" : "failed"));
        const persistedError = terminalSettlement?.error ?? publication?.error ?? input.error;
        if (
          retryable !== (stageStatus === "queued") ||
          (retryable && attemptStatus !== "failed")
        ) {
          throw new TypeError("Retryable jobs must return their stage to queued");
        }
        const mutationAt = reportOnlyRecovery ? transactionNow : input.failedAt;
        const result = await this.#queries.query(
          `UPDATE job_attempts
              SET status = $1, available_at = $2, leased_by = NULL,
                  lease_expires_at = NULL, retryable = $3,
                  retry_scheduled_at = NULL, completed_at = $4,
                  error_json = $5::jsonb, updated_at = $4,
                  report_publication_attempt_count = $6,
                  report_publication_max_attempts = $7,
                  report_publication_initial_delay_ms = $8,
                  report_publication_max_delay_ms = $9,
                  report_publication_retry_at = $10
            WHERE id = $11 AND status = 'running' AND leased_by = $12
              AND lease_generation = $13 AND lease_expires_at > $14`,
          [
            attemptStatus,
            availableAt,
            retryable,
            mutationAt,
            JSON.stringify(persistedError),
            publication?.attemptCount ?? current.reportPublicationAttemptCount,
            publication?.policy.maxAttempts ?? current.reportPublicationMaxAttempts,
            publication?.policy.initialDelayMs ??
              current.reportPublicationInitialDelayMs,
            publication?.policy.maxDelayMs ??
              current.reportPublicationMaxDelayMs,
            publication?.retryAt ?? null,
            input.jobId,
            input.ownerId,
            input.leaseGeneration,
            mutationAt,
          ],
        );
        assertOneLeaseMutation(result.rowCount);
        const job = await this.#findRequiredJob(input.jobId);
        const completedAt =
          stageStatus === "queued" || stageStatus === "waiting-input"
            ? null
            : mutationAt;
        await this.#queries.query(
          `UPDATE run_stages
              SET status = $1, completed_at = $2,
                  last_error_json = $3::jsonb, updated_at = $4
            WHERE id = $5`,
          [
            stageStatus,
            completedAt,
            JSON.stringify(persistedError),
            mutationAt,
            job.stageId,
          ],
        );
        await this.#refreshAnalysisRunStatus(job.runId, mutationAt);
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

  async #durableCycleDisposition(
    current: JobAttemptRecord,
  ): Promise<DurableCycleDisposition> {
    if (current.stage === "alexa-voc-normalization") {
      const records = [];
      for (const query of normalizationRecoveryQueries(current)) {
        let index = 0;
        records.push((await this.#queries.query(query.sql.replace(/\?/g, () => `$${++index}`), query.values)).rows);
      }
      return normalizationRecoveryDisposition(current, records);
    }
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
    if (result.rows.length > 1) throw new PostgresJobStoreError();
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
      throw new PostgresJobStoreError();
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
      throw new PostgresJobStoreError();
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
    if (metadata.kind !== "failed") throw new PostgresJobStoreError();
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

  async #reclaimRecoveryLease(
    current: JobAttemptRecord,
    input: ClaimJobInput,
  ) {
    const result = await this.#queries.query(
      `UPDATE job_attempts
          SET status = 'running', available_at = $1, leased_by = $2,
              lease_expires_at = $3, lease_generation = lease_generation + 1,
              retryable = FALSE, retry_scheduled_at = NULL,
              completed_at = NULL, report_publication_retry_at = NULL,
              error_json = NULL, started_at = COALESCE(started_at, $1),
              updated_at = $1
        WHERE id = $4`,
      [
        input.claimedAt,
        input.ownerId,
        addMilliseconds(input.claimedAt, input.leaseDurationMs),
        current.id,
      ],
    );
    assertOneLeaseMutation(result.rowCount);
    await this.#markStageRunning(
      current.stageId,
      current.attemptNumber,
      input.claimedAt,
    );
    return await this.#findRequiredJob(current.id);
  }

  async #settleClaimCandidate(
    current: JobAttemptRecord,
    disposition: Extract<DurableCycleDisposition, { kind: "settle" }>,
    settledAt: string,
  ) {
    if (current.stage === "alexa-voc-normalization") {
      for (const query of normalizationSettlementQueries(current, disposition.normalizationTerminals, settledAt)) {
        let index = 0;
        await this.#queries.query(query.sql.replace(/\?/g, () => `$${++index}`), query.values);
      }
    }
    await this.#queries.query(
      `UPDATE job_attempts
          SET status = $1, retryable = FALSE, leased_by = NULL,
              lease_expires_at = NULL,
              completed_at = COALESCE(completed_at, $2),
              error_json = $3::jsonb, updated_at = $2
        WHERE id = $4`,
      [
        disposition.attemptStatus,
        settledAt,
        JSON.stringify(disposition.error),
        current.id,
      ],
    );
    await this.#queries.query(
      `UPDATE run_stages
          SET status = $1, completed_at = $2,
              last_error_json = $3::jsonb, updated_at = $2
        WHERE id = $4`,
      [
        disposition.stageStatus,
        settledAt,
        JSON.stringify(disposition.error),
        current.stageId,
      ],
    );
    await this.#refreshAnalysisRunStatus(current.runId, settledAt);
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

  async #findRequiredJob(id: string, forUpdate = false) {
    const result = await this.#queries.query<JobRow>(
      `SELECT ja.*, rs.run_id, rs.stage
         FROM job_attempts ja
         JOIN run_stages rs ON rs.id = ja.stage_id
        WHERE ja.id = $1
        ${forUpdate ? "FOR UPDATE OF ja" : ""}`,
      [id],
    );
    if (!result.rows[0]) throw new PostgresJobStoreConflictError();
    return mapJob(result.rows[0]);
  }

  async #transactionNow() {
    const result = await this.#queries.query<
      QueryResultRow & { now: Date | string }
    >("SELECT clock_timestamp() AS now");
    if (!result.rows[0]) throw new PostgresJobStoreError();
    return mapTimestamp(result.rows[0].now);
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
  const logicalExecutionCycleId = Sha256Schema.safeParse(
    row.logical_execution_cycle_id,
  );
  if (!logicalExecutionCycleId.success) throw new PostgresJobStoreError();
  const reportPublicationCycle = storedInteger(
    row.report_publication_cycle,
    true,
  );
  const reportPublicationAttemptCount = storedInteger(
    row.report_publication_attempt_count,
    false,
  );
  const reportPublicationMaxAttempts = nullableStoredPositiveInteger(
    row.report_publication_max_attempts,
  );
  const reportPublicationInitialDelayMs = nullableStoredPositiveInteger(
    row.report_publication_initial_delay_ms,
  );
  const reportPublicationMaxDelayMs = nullableStoredPositiveInteger(
    row.report_publication_max_delay_ms,
  );
  const reportPublicationRetryAt =
    row.report_publication_retry_at === null
      ? null
      : mapTimestamp(row.report_publication_retry_at);
  const policyValues = [
    reportPublicationMaxAttempts,
    reportPublicationInitialDelayMs,
    reportPublicationMaxDelayMs,
  ];
  const hasPolicy = policyValues.every((value) => value !== null);
  if (
    (!hasPolicy && policyValues.some((value) => value !== null)) ||
    (!hasPolicy &&
      (reportPublicationAttemptCount !== 0 ||
        reportPublicationRetryAt !== null)) ||
    (hasPolicy &&
      (reportPublicationAttemptCount > reportPublicationMaxAttempts! ||
        reportPublicationInitialDelayMs! > reportPublicationMaxDelayMs!))
  ) {
    throw new PostgresJobStoreError();
  }
  if (hasPolicy) {
    const retryPending =
      row.status === "failed" &&
      row.retryable &&
      reportPublicationAttemptCount < reportPublicationMaxAttempts!;
    if (
      (retryPending && reportPublicationRetryAt === null) ||
      (!retryPending && (row.retryable || reportPublicationRetryAt !== null)) ||
      (row.status === "failed" &&
        !retryPending &&
        reportPublicationAttemptCount !== reportPublicationMaxAttempts)
    ) {
      throw new PostgresJobStoreError();
    }
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
    reportPublicationCycle,
    reportPublicationAttemptCount,
    reportPublicationMaxAttempts,
    reportPublicationInitialDelayMs,
    reportPublicationMaxDelayMs,
    reportPublicationRetryAt,
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

function createLogicalExecutionCycleId() {
  return createHash("sha256").update(randomUUID()).digest("hex");
}

function nextReportPublicationFailure(
  current: JobAttemptRecord,
  input: FailJobInput,
  transactionNow: string,
) {
  const supplied = input.reportPublicationRetryPolicy;
  const stored =
    current.reportPublicationMaxAttempts === null
      ? null
      : {
          maxAttempts: current.reportPublicationMaxAttempts,
          initialDelayMs: current.reportPublicationInitialDelayMs!,
          maxDelayMs: current.reportPublicationMaxDelayMs!,
        };
  const policy = stored ?? supplied;
  if (!policy) {
    throw new TypeError("Report publication retry policy is required");
  }
  for (const [name, value] of Object.entries(policy)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`Invalid report publication retry policy ${name}`);
    }
  }
  if (policy.initialDelayMs > policy.maxDelayMs) {
    throw new TypeError(
      "Report publication initial delay must not exceed maximum delay",
    );
  }
  const attemptCount = current.reportPublicationAttemptCount + 1;
  const retryable = attemptCount < policy.maxAttempts;
  const delay = Math.min(
    policy.maxDelayMs,
    policy.initialDelayMs * 2 ** Math.max(0, attemptCount - 1),
  );
  const retryAt = retryable
    ? addMilliseconds(transactionNow, delay)
    : null;
  return {
    policy,
    attemptCount,
    retryable,
    retryAt,
    error: retryable
      ? input.error
      : {
          classification: "upstream-temporary",
          code: "REPORT_PUBLICATION_RETRY_EXHAUSTED",
          message: "Analysis report publication retry budget was exhausted",
        },
  } as const;
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

function storedInteger(value: unknown, positive: boolean) {
  if (
    !Number.isSafeInteger(value) ||
    (positive ? Number(value) <= 0 : Number(value) < 0)
  ) {
    throw new PostgresJobStoreError();
  }
  return Number(value);
}

function nullableStoredPositiveInteger(value: unknown) {
  return value === null ? null : storedInteger(value, true);
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
  return [
    "traffic-analysis",
    "alexa-voc-normalization",
    "voc-positioning",
    "product-definition",
  ].includes(value);
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
