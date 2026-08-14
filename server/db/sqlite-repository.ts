import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { BudgetExceededError, type BudgetScope } from "../runtime/budget-policy";
import {
  ModelBudgetDataError,
  ModelBudgetReservationConflictError,
  ModelBudgetReservationNotFoundError,
  ModelBudgetStateConflictError,
  ModelBudgetSubjectNotFoundError,
  type GetModelBudgetUsageInput,
  type ModelBudgetAmount,
  type ModelBudgetLedgerRepository,
  type ModelBudgetLimit,
  type ModelBudgetReservationRecord,
  type ModelBudgetSubject,
  type ModelBudgetTransitionResult,
  type ModelBudgetUsage,
  type ModelBudgetUsageSnapshot,
  type ReserveModelBudgetInput,
  type ReserveModelBudgetResult,
  type ResolveModelBudgetSubjectInput,
  type SettleModelBudgetInput,
  type TransitionModelBudgetInput,
} from "./model-budget-repository";
import { JobLeaseLostError } from "./repository";
import type {
  AgentRepository,
  AnalysisRunRecord,
  CancelAnalysisRunInput,
  ClaimJobInput,
  CompleteJobInput,
  CreateAnalysisRunResult,
  CreateProjectInput,
  EnqueueJobInput,
  FailJobInput,
  JobAttemptRecord,
  ProjectRecord,
  ReleaseJobLeaseInput,
  RenewJobLeaseInput,
  RetryFailedRunStageInput,
  RetryFailedRunStageResult,
  RunStageRecord,
  UserRecord,
} from "./repository";

export interface SqliteRepositoryOptions {
  path: string;
  busyTimeoutMs: number;
}

export interface SqliteConnectionDiagnostics {
  foreignKeys: boolean;
  journalMode: string;
  busyTimeoutMs: number;
}

export interface AppliedSqliteMigration {
  version: number;
  name: string;
  checksum: string;
}

interface MigrationFile {
  version: number;
  name: string;
  checksum: string;
  sql: string;
}

type SqliteRow = Record<string, string | number | bigint | null>;

const migrationsUrl = new URL("./migrations/", import.meta.url);
const databaseOperationTails = new Map<string, Promise<void>>();
const busyRetrySignal = new Int32Array(
  new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
);

function firstValue(row: SqliteRow | undefined) {
  return row ? Object.values(row)[0] : undefined;
}

function migrationFiles(): MigrationFile[] {
  return readdirSync(migrationsUrl)
    .map((filename) => {
      const match = /^(\d+)_([a-z0-9_]+)\.sql$/i.exec(filename);
      if (!match) return null;

      const sql = readFileSync(new URL(filename, migrationsUrl), "utf8");
      return {
        version: Number.parseInt(match[1], 10),
        name: match[2],
        checksum: createHash("sha256").update(sql).digest("hex"),
        sql,
      };
    })
    .filter((migration): migration is MigrationFile => migration !== null)
    .sort((left, right) => left.version - right.version);
}

function enableWriteAheadLogging(
  database: DatabaseSync,
  busyTimeoutMs: number,
) {
  const deadline = Date.now() + busyTimeoutMs;
  while (true) {
    try {
      database.exec("PRAGMA journal_mode = WAL");
      return;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("errcode" in error) ||
        error.errcode !== 5 ||
        Date.now() >= deadline
      ) {
        throw error;
      }
      Atomics.wait(busyRetrySignal, 0, 0, Math.min(10, deadline - Date.now()));
    }
  }
}

function migrationTableExists(database: DatabaseSync) {
  return Boolean(
    database
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
      )
      .get(),
  );
}

function appliedMigrations(database: DatabaseSync): AppliedSqliteMigration[] {
  if (!migrationTableExists(database)) return [];

  return (database
    .prepare(
      "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
    )
    .all() as SqliteRow[]).map((row) => ({
      version: Number(row.version),
      name: String(row.name),
      checksum: String(row.checksum),
    }));
}

function runMigrations(database: DatabaseSync) {
  for (const migration of migrationFiles()) {
    database.exec("BEGIN IMMEDIATE");
    try {
      const existing = appliedMigrations(database).find(
        (applied) => applied.version === migration.version,
      );
      if (existing) {
        if (
          existing.name !== migration.name ||
          existing.checksum !== migration.checksum
        ) {
          throw new Error(
            `Applied migration ${migration.version} does not match its source file`,
          );
        }
        database.exec("COMMIT");
        continue;
      }

      database.exec(migration.sql);
      database
        .prepare(
          `INSERT INTO schema_migrations (version, name, checksum, applied_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(
          migration.version,
          migration.name,
          migration.checksum,
          new Date().toISOString(),
        );
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
}

export class SqliteAgentRepository
  implements AgentRepository, ModelBudgetLedgerRepository
{
  readonly #database: DatabaseSync;
  readonly #path: string;
  readonly #transactionContext = new AsyncLocalStorage<boolean>();

  constructor(options: SqliteRepositoryOptions) {
    mkdirSync(dirname(options.path), { recursive: true });
    this.#path = options.path;
    this.#database = new DatabaseSync(options.path);
    try {
      this.#database.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs}`);
      this.#database.exec("PRAGMA foreign_keys = ON");
      enableWriteAheadLogging(this.#database, options.busyTimeoutMs);
      this.#database.exec("PRAGMA synchronous = NORMAL");
      runMigrations(this.#database);
    } catch (error) {
      this.#database.close();
      throw error;
    }
  }

  getConnectionDiagnostics(): SqliteConnectionDiagnostics {
    const foreignKeys = firstValue(
      this.#database.prepare("PRAGMA foreign_keys").get() as SqliteRow,
    );
    const journalMode = firstValue(
      this.#database.prepare("PRAGMA journal_mode").get() as SqliteRow,
    );
    const busyTimeoutMs = firstValue(
      this.#database.prepare("PRAGMA busy_timeout").get() as SqliteRow,
    );

    return {
      foreignKeys: foreignKeys === 1,
      journalMode: String(journalMode),
      busyTimeoutMs: Number(busyTimeoutMs),
    };
  }

  listAppliedMigrations() {
    return appliedMigrations(this.#database);
  }

  #serialize<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.#transactionContext.getStore()) {
      try {
        return Promise.resolve(operation());
      } catch (error) {
        return Promise.reject(error);
      }
    }

    const tail = databaseOperationTails.get(this.#path) ?? Promise.resolve();
    const result = tail.then(operation, operation);
    databaseOperationTails.set(
      this.#path,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    return result;
  }

  #withImmediateTransaction<T>(operation: () => T): T {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  transaction<T>(
    operation: (repository: AgentRepository) => Promise<T>,
  ): Promise<T> {
    if (this.#transactionContext.getStore()) return operation(this);

    return this.#serialize(async () => {
      this.#database.exec("BEGIN IMMEDIATE");
      try {
        const result = await this.#transactionContext.run(true, () =>
          operation(this),
        );
        this.#database.exec("COMMIT");
        return result;
      } catch (error) {
        this.#database.exec("ROLLBACK");
        throw error;
      }
    });
  }

  createUser(user: UserRecord): Promise<UserRecord> {
    return this.#serialize(() => {
      this.#database
        .prepare(
          `INSERT INTO users (
             id, organization_id, email, display_name, password_hash,
             role, status, created_at, updated_at
           ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
        )
        .run(
          user.id,
          user.organizationId,
          user.email,
          user.displayName,
          user.role,
          user.status,
          user.createdAt,
          user.updatedAt,
        );
      return user;
    });
  }

  findUserById(id: string): Promise<UserRecord | null> {
    return this.#serialize(() => {
      const row = this.#database
        .prepare(
          `SELECT id, organization_id, email, display_name, role, status,
                  created_at, updated_at
           FROM users WHERE id = ?`,
        )
        .get(id) as SqliteRow | undefined;
      return row ? mapUser(row) : null;
    });
  }

  createProject(project: CreateProjectInput): Promise<ProjectRecord> {
    return this.#serialize(() => {
      this.#database
        .prepare(
          `INSERT INTO projects (
             id, organization_id, name, marketplace, asins_json, created_by,
             current_run_id, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        )
        .run(
          project.id,
          project.organizationId,
          project.name,
          project.marketplace,
          JSON.stringify(project.asins),
          project.createdBy,
          project.createdAt,
          project.updatedAt,
        );
      return { ...project, currentRunId: null };
    });
  }

  findProjectById(id: string): Promise<ProjectRecord | null> {
    return this.#serialize(() => {
      const row = this.#database
        .prepare(
          `SELECT id, organization_id, name, marketplace, asins_json,
                  created_by, current_run_id, created_at, updated_at
           FROM projects WHERE id = ?`,
        )
        .get(id) as SqliteRow | undefined;
      return row ? mapProject(row) : null;
    });
  }

  createAnalysisRun(run: AnalysisRunRecord): Promise<AnalysisRunRecord> {
    return this.createAnalysisRunOnce(run).then((result) => result.run);
  }

  createAnalysisRunOnce(
    run: AnalysisRunRecord,
  ): Promise<CreateAnalysisRunResult> {
    if (this.#transactionContext.getStore()) {
      return this.#serialize(() => this.#createAnalysisRun(run));
    }

    return this.#serialize(() =>
      this.#withImmediateTransaction(() => this.#createAnalysisRun(run)),
    );
  }

  #createAnalysisRun(run: AnalysisRunRecord): CreateAnalysisRunResult {
    const existing = this.#database
      .prepare(
        `SELECT id, project_id, mode, status, created_by, data_cutoff_at,
                idempotency_scope, idempotency_key, created_at, updated_at
         FROM analysis_runs
         WHERE idempotency_scope = ? AND idempotency_key = ?`,
      )
      .get(run.idempotencyScope, run.idempotencyKey) as SqliteRow | undefined;
    if (existing) {
      return { run: mapAnalysisRun(existing), created: false };
    }

    this.#database
      .prepare(
        `INSERT INTO analysis_runs (
           id, project_id, mode, status, created_by, data_cutoff_at,
           idempotency_scope, idempotency_key, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        run.projectId,
        run.mode,
        run.status,
        run.createdBy,
        run.dataCutoffAt,
        run.idempotencyScope,
        run.idempotencyKey,
        run.createdAt,
        run.updatedAt,
      );
    this.#database
      .prepare(
        "UPDATE projects SET current_run_id = ?, updated_at = ? WHERE id = ?",
      )
      .run(run.id, run.updatedAt, run.projectId);
    return { run, created: true };
  }

  findAnalysisRun(id: string): Promise<AnalysisRunRecord | null> {
    return this.#serialize(() => {
      const row = this.#database
        .prepare(
          `SELECT id, project_id, mode, status, created_by, data_cutoff_at,
                  idempotency_scope, idempotency_key, created_at, updated_at
           FROM analysis_runs WHERE id = ?`,
        )
        .get(id) as SqliteRow | undefined;
      return row ? mapAnalysisRun(row) : null;
    });
  }

  resolveModelBudgetSubject(
    input: ResolveModelBudgetSubjectInput,
  ): Promise<ModelBudgetSubject> {
    assertModelBudgetSubjectInput(input.runId, input.projectId);
    return this.#serialize(() =>
      this.#resolveModelBudgetSubject(input.runId, input.projectId),
    );
  }

  reserveModelBudget(
    input: ReserveModelBudgetInput,
  ): Promise<ReserveModelBudgetResult> {
    return this.#serialize(() => {
      assertReserveModelBudgetInput(input);
      return this.#withImmediateTransaction(() =>
        this.#reserveModelBudget(input),
      );
    });
  }

  #reserveModelBudget(
    input: ReserveModelBudgetInput,
  ): ReserveModelBudgetResult {
    const subject = this.#resolveModelBudgetSubject(input.runId, input.projectId);
    this.#releaseExpiredModelBudgetReservations(input.reservedAt);
    const existing = this.#database
      .prepare(
        `SELECT * FROM model_budget_reservations
         WHERE run_id = ? AND idempotency_key = ?`,
      )
      .get(input.runId, input.idempotencyKey) as SqliteRow | undefined;
    if (existing) {
      const reservation = mapModelBudgetReservation(existing);
      if (!sameReservationParameters(reservation, input)) {
        throw new ModelBudgetReservationConflictError();
      }
      return { reservation, created: false };
    }

    const utcDay = utcDayFromCanonicalTimestamp(input.reservedAt);
    const usage = this.#getModelBudgetUsage(
      input.runId,
      subject.organizationId,
      utcDay,
    );
    const projected = modelBudgetUsage(input.projected);
    assertIntegerBudgetAvailable(
      "call",
      { tokens: 0, costMicros: 0 },
      projected,
      input.limits.call,
    );
    assertIntegerBudgetAvailable(
      "run",
      usage.run,
      projected,
      input.limits.run,
    );
    assertIntegerBudgetAvailable(
      "daily",
      usage.organizationUtcDay,
      projected,
      input.limits.organizationUtcDay,
    );

    this.#database
      .prepare(
        `INSERT INTO model_budget_reservations (
           id, idempotency_key, request_fingerprint, run_id, project_id,
           organization_id, utc_day,
           state, projected_input_tokens, projected_output_tokens,
           projected_cost_micros, actual_input_tokens, actual_output_tokens,
           actual_cost_micros, lease_expires_at, created_at, updated_at,
           dispatched_at, settled_at, released_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?, NULL, NULL, NULL,
                   ?, ?, ?, NULL, NULL, NULL)`,
      )
      .run(
        input.id,
        input.idempotencyKey,
        input.requestFingerprint,
        input.runId,
        input.projectId,
        subject.organizationId,
        utcDay,
        input.projected.inputTokens,
        input.projected.outputTokens,
        input.projected.costMicros,
        input.leaseExpiresAt,
        input.reservedAt,
        input.reservedAt,
      );
    const row = this.#database
      .prepare("SELECT * FROM model_budget_reservations WHERE id = ?")
      .get(input.id) as SqliteRow;
    return { reservation: mapModelBudgetReservation(row), created: true };
  }

  getModelBudgetUsage(
    input: GetModelBudgetUsageInput,
  ): Promise<ModelBudgetUsageSnapshot> {
    return this.#serialize(() => {
      assertTimestamp(input.asOf, "asOf");
      return this.#withImmediateTransaction(() => {
        const subject = this.#resolveModelBudgetSubject(
          input.runId,
          input.projectId,
        );
        this.#releaseExpiredModelBudgetReservations(input.asOf);
        const utcDay = utcDayFromCanonicalTimestamp(input.asOf);
        return this.#getModelBudgetUsage(
          input.runId,
          subject.organizationId,
          utcDay,
        );
      });
    });
  }

  dispatchModelBudget(
    input: TransitionModelBudgetInput,
  ): Promise<ModelBudgetTransitionResult> {
    return this.#serialize(() => {
      assertBudgetTransitionInput(input);
      return this.#withImmediateTransaction(() => {
        const result = this.#database
          .prepare(
            `UPDATE model_budget_reservations
             SET state = 'dispatched', lease_expires_at = NULL,
                 dispatched_at = ?, updated_at = ?
             WHERE id = ? AND state = 'reserved' AND lease_expires_at > ?`,
          )
          .run(
            input.transitionedAt,
            input.transitionedAt,
            input.reservationId,
            input.transitionedAt,
          );
        if (Number(result.changes) === 1) {
          return {
            reservation: this.#findModelBudgetReservation(input.reservationId)!,
            transitioned: true,
          };
        }
        const expired = this.#database
          .prepare(
            `UPDATE model_budget_reservations
             SET state = 'released', lease_expires_at = NULL,
                 released_at = ?, updated_at = ?
             WHERE id = ? AND state = 'reserved' AND lease_expires_at <= ?`,
          )
          .run(
            input.transitionedAt,
            input.transitionedAt,
            input.reservationId,
            input.transitionedAt,
          );
        if (Number(expired.changes) === 1) {
          return {
            reservation: this.#findModelBudgetReservation(input.reservationId)!,
            transitioned: false,
          };
        }
        const current = this.#requireModelBudgetReservation(
          input.reservationId,
        );
        if (current.state === "dispatched") {
          return { reservation: current, transitioned: false };
        }
        throw new ModelBudgetStateConflictError();
      });
    });
  }

  releaseModelBudget(
    input: TransitionModelBudgetInput,
  ): Promise<ModelBudgetTransitionResult> {
    return this.#serialize(() => {
      assertBudgetTransitionInput(input);
      return this.#withImmediateTransaction(() => {
        const result = this.#database
          .prepare(
            `UPDATE model_budget_reservations
             SET state = 'released', lease_expires_at = NULL,
                 released_at = ?, updated_at = ?
             WHERE id = ? AND state = 'reserved'`,
          )
          .run(input.transitionedAt, input.transitionedAt, input.reservationId);
        if (Number(result.changes) === 1) {
          return {
            reservation: this.#findModelBudgetReservation(input.reservationId)!,
            transitioned: true,
          };
        }
        const current = this.#requireModelBudgetReservation(
          input.reservationId,
        );
        if (current.state === "released") {
          return { reservation: current, transitioned: false };
        }
        throw new ModelBudgetStateConflictError();
      });
    });
  }

  settleModelBudget(
    input: SettleModelBudgetInput,
  ): Promise<ModelBudgetTransitionResult> {
    return this.#serialize(() => {
      assertBudgetTransitionInput(input);
      assertBudgetAmount(input.actual, "actual");
      return this.#withImmediateTransaction(() => {
        const result = this.#database
          .prepare(
            `UPDATE model_budget_reservations
             SET state = 'settled', actual_input_tokens = ?,
                 actual_output_tokens = ?, actual_cost_micros = ?,
                 lease_expires_at = NULL, settled_at = ?, updated_at = ?
             WHERE id = ? AND state IN ('reserved', 'dispatched')`,
          )
          .run(
            input.actual.inputTokens,
            input.actual.outputTokens,
            input.actual.costMicros,
            input.transitionedAt,
            input.transitionedAt,
            input.reservationId,
          );
        if (Number(result.changes) === 1) {
          return {
            reservation: this.#findModelBudgetReservation(input.reservationId)!,
            transitioned: true,
          };
        }
        const current = this.#requireModelBudgetReservation(
          input.reservationId,
        );
        if (current.state === "settled") {
          if (sameModelBudgetAmount(current.actual, input.actual)) {
            return { reservation: current, transitioned: false };
          }
          throw new ModelBudgetReservationConflictError();
        }
        throw new ModelBudgetStateConflictError();
      });
    });
  }

  #resolveModelBudgetSubject(runId: string, projectId: string) {
    const row = this.#database
      .prepare(
        `SELECT projects.organization_id
         FROM analysis_runs
         JOIN projects ON projects.id = analysis_runs.project_id
         WHERE analysis_runs.id = ? AND projects.id = ?`,
      )
      .get(runId, projectId) as SqliteRow | undefined;
    if (!row) throw new ModelBudgetSubjectNotFoundError();
    return { runId, projectId, organizationId: String(row.organization_id) };
  }

  #releaseExpiredModelBudgetReservations(asOf: string) {
    this.#database
      .prepare(
        `UPDATE model_budget_reservations
         SET state = 'released', lease_expires_at = NULL,
             released_at = ?, updated_at = ?
         WHERE state = 'reserved' AND lease_expires_at <= ?`,
      )
      .run(asOf, asOf, asOf);
  }

  #getModelBudgetUsage(
    runId: string,
    organizationId: string,
    utcDay: string,
  ): ModelBudgetUsageSnapshot {
    const runRows = this.#database
      .prepare(
        `SELECT state, projected_input_tokens, projected_output_tokens,
                projected_cost_micros, actual_input_tokens,
                actual_output_tokens, actual_cost_micros
         FROM model_budget_reservations
         WHERE run_id = ? AND state <> 'released'`,
      )
      .all(runId) as SqliteRow[];
    const organizationRows = this.#database
      .prepare(
        `SELECT state, projected_input_tokens, projected_output_tokens,
                projected_cost_micros, actual_input_tokens,
                actual_output_tokens, actual_cost_micros
         FROM model_budget_reservations
         WHERE organization_id = ? AND utc_day = ? AND state <> 'released'`,
      )
      .all(organizationId, utcDay) as SqliteRow[];
    return {
      run: sumModelBudgetRows(runRows),
      organizationUtcDay: sumModelBudgetRows(organizationRows),
    };
  }

  #findModelBudgetReservation(id: string) {
    const row = this.#database
      .prepare("SELECT * FROM model_budget_reservations WHERE id = ?")
      .get(id) as SqliteRow | undefined;
    return row ? mapModelBudgetReservation(row) : null;
  }

  #requireModelBudgetReservation(id: string) {
    const reservation = this.#findModelBudgetReservation(id);
    if (!reservation) throw new ModelBudgetReservationNotFoundError();
    return reservation;
  }

  listAnalysisRuns(projectId: string): Promise<AnalysisRunRecord[]> {
    return this.#serialize(() => {
      const rows = this.#database
        .prepare(
          `SELECT id, project_id, mode, status, created_by, data_cutoff_at,
                  idempotency_scope, idempotency_key, created_at, updated_at
           FROM analysis_runs WHERE project_id = ? ORDER BY created_at, id`,
        )
        .all(projectId) as SqliteRow[];
      return rows.map(mapAnalysisRun);
    });
  }

  createRunStage(stage: RunStageRecord): Promise<RunStageRecord> {
    return this.#serialize(() => {
      this.#database
        .prepare(
          `INSERT INTO run_stages (
             id, run_id, stage, status, progress, attempt_count, started_at,
             completed_at, last_error_json, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          stage.id,
          stage.runId,
          stage.stage,
          stage.status,
          stage.progress,
          stage.attemptCount,
          stage.startedAt,
          stage.completedAt,
          stage.lastError === null ? null : JSON.stringify(stage.lastError),
          stage.createdAt,
          stage.updatedAt,
        );
      return stage;
    });
  }

  findRunStage(id: string): Promise<RunStageRecord | null> {
    return this.#serialize(() => {
      const row = this.#database
        .prepare("SELECT * FROM run_stages WHERE id = ?")
        .get(id) as SqliteRow | undefined;
      return row ? mapRunStage(row) : null;
    });
  }

  cancelAnalysisRun(
    input: CancelAnalysisRunInput,
  ): Promise<AnalysisRunRecord | null> {
    return this.#serialize(() => {
      const operation = () => {
        const run = this.#findAnalysisRun(input.runId);
        if (!run || run.status === "cancelled") return run;

        const errorJson = JSON.stringify(input.error);
        this.#database
          .prepare(
            `UPDATE job_attempts
             SET status = 'cancelled', leased_by = NULL,
                 lease_expires_at = NULL,
                 lease_generation = lease_generation + 1,
                 retryable = 0, retry_scheduled_at = NULL,
                 completed_at = COALESCE(completed_at, ?),
                 error_json = ?, updated_at = ?
             WHERE stage_id IN (
               SELECT id FROM run_stages WHERE run_id = ?
             ) AND status IN ('queued', 'running')`,
          )
          .run(
            input.cancelledAt,
            errorJson,
            input.cancelledAt,
            input.runId,
          );
        this.#database
          .prepare(
            `UPDATE run_stages
             SET status = 'cancelled',
                 completed_at = COALESCE(completed_at, ?),
                 last_error_json = ?, updated_at = ?
             WHERE run_id = ? AND status <> 'succeeded'`,
          )
          .run(
            input.cancelledAt,
            errorJson,
            input.cancelledAt,
            input.runId,
          );
        this.#database
          .prepare(
            `UPDATE analysis_runs
             SET status = 'cancelled', updated_at = ?
             WHERE id = ?`,
          )
          .run(input.cancelledAt, input.runId);
        return this.#findAnalysisRun(input.runId);
      };
      return this.#transactionContext.getStore()
        ? operation()
        : this.#withImmediateTransaction(operation);
    });
  }

  retryFailedRunStage(
    input: RetryFailedRunStageInput,
  ): Promise<RetryFailedRunStageResult | null> {
    return this.#serialize(() => {
      const operation = () => {
        if (input.maxAutomaticAttempts <= 0) {
          throw new Error("maxAutomaticAttempts must be positive");
        }
        const current = this.#database
          .prepare(
            `SELECT * FROM run_stages
             WHERE id = ? AND run_id = ? AND status = 'failed'`,
          )
          .get(input.stageId, input.runId) as SqliteRow | undefined;
        if (!current) return null;

        const latest = this.#database
          .prepare(
            `SELECT COALESCE(MAX(attempt_number), 0) AS attempt_number
             FROM job_attempts WHERE stage_id = ?`,
          )
          .get(input.stageId) as SqliteRow;
        const attemptNumber = Number(latest.attempt_number) + 1;
        const stageUpdate = this.#database
          .prepare(
            `UPDATE run_stages
             SET status = 'queued', progress = 0, completed_at = NULL,
                 last_error_json = NULL, updated_at = ?
             WHERE id = ? AND run_id = ? AND status = 'failed'`,
          )
          .run(input.retriedAt, input.stageId, input.runId);
        if (Number(stageUpdate.changes) !== 1) return null;

        for (const stageId of new Set(input.staleStageIds)) {
          this.#database
            .prepare(
              `UPDATE run_stages
               SET status = 'stale', updated_at = ?
               WHERE id = ? AND run_id = ? AND status = 'succeeded'`,
            )
            .run(input.retriedAt, stageId, input.runId);
        }
        this.#database
          .prepare(
            `INSERT INTO job_attempts (
               id, stage_id, attempt_number, max_attempts,
               retry_cycle_start_attempt, status, available_at,
               leased_by, lease_expires_at, lease_generation, retryable,
               retry_scheduled_at, started_at, completed_at, error_json,
               created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, 'queued', ?, NULL, NULL, 0, 0, NULL, NULL,
                       NULL, NULL, ?, ?)`,
          )
          .run(
            input.jobId,
            input.stageId,
            attemptNumber,
            attemptNumber + input.maxAutomaticAttempts - 1,
            attemptNumber,
            input.retriedAt,
            input.retriedAt,
            input.retriedAt,
          );
        this.#refreshAnalysisRunStatus(input.runId, input.retriedAt);
        return {
          stage: mapRunStage(
            this.#database
              .prepare("SELECT * FROM run_stages WHERE id = ?")
              .get(input.stageId) as SqliteRow,
          ),
          attempt: this.#findJob(input.jobId)!,
        };
      };
      return this.#transactionContext.getStore()
        ? operation()
        : this.#withImmediateTransaction(operation);
    });
  }

  #findAnalysisRun(id: string): AnalysisRunRecord | null {
    const row = this.#database
      .prepare(
        `SELECT id, project_id, mode, status, created_by, data_cutoff_at,
                idempotency_scope, idempotency_key, created_at, updated_at
         FROM analysis_runs WHERE id = ?`,
      )
      .get(id) as SqliteRow | undefined;
    return row ? mapAnalysisRun(row) : null;
  }

  listRunStages(runId: string): Promise<RunStageRecord[]> {
    return this.#serialize(() => {
      const rows = this.#database
        .prepare(
          `SELECT * FROM run_stages
           WHERE run_id = ?
           ORDER BY CASE stage
             WHEN 'traffic-analysis' THEN 1
             WHEN 'voc-positioning' THEN 2
             WHEN 'product-definition' THEN 3
           END`,
        )
        .all(runId) as SqliteRow[];
      return rows.map(mapRunStage);
    });
  }

  enqueueJob(job: EnqueueJobInput): Promise<JobAttemptRecord> {
    return this.#serialize(() => {
      this.#database
        .prepare(
          `INSERT INTO job_attempts (
             id, stage_id, attempt_number, max_attempts,
             retry_cycle_start_attempt, status, available_at,
             leased_by, lease_expires_at, lease_generation, retryable,
             retry_scheduled_at, started_at, completed_at, error_json,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, 'queued', ?, NULL, NULL, 0, 0, NULL, NULL,
                     NULL, NULL, ?, ?)`,
        )
        .run(
          job.id,
          job.stageId,
          job.attemptNumber,
          job.maxAttempts,
          job.attemptNumber,
          job.availableAt,
          job.createdAt,
          job.createdAt,
        );
      return this.#findJob(job.id)!;
    });
  }

  claimNextJob(input: ClaimJobInput): Promise<JobAttemptRecord | null> {
    return this.#serialize(() =>
      this.#withImmediateTransaction(() => this.#claimNextJob(input)),
    );
  }

  #claimNextJob(input: ClaimJobInput): JobAttemptRecord | null {
    if (input.leaseDurationMs <= 0) {
      throw new Error("Lease duration must be positive");
    }

    const candidate = this.#database
      .prepare(
        `SELECT job_attempts.*, run_stages.run_id AS run_id,
                run_stages.stage AS stage
         FROM job_attempts
         JOIN run_stages ON run_stages.id = job_attempts.stage_id
         WHERE
           (job_attempts.status = 'queued' AND job_attempts.available_at <= ?)
           OR (
             job_attempts.status = 'failed' AND job_attempts.retryable = 1
             AND job_attempts.retry_scheduled_at IS NULL
             AND job_attempts.available_at <= ?
           )
           OR (
             job_attempts.status = 'running' AND job_attempts.lease_expires_at <= ?
           )
         ORDER BY
           CASE job_attempts.status
             WHEN 'running' THEN job_attempts.lease_expires_at
             ELSE job_attempts.available_at
           END,
           job_attempts.created_at, job_attempts.id
         LIMIT 1`,
      )
      .get(input.claimedAt, input.claimedAt, input.claimedAt) as
      | SqliteRow
      | undefined;
    if (!candidate) return null;

    const current = mapJob(candidate);
    if (current.status === "queued") {
      const leaseExpiresAt = addMilliseconds(
        input.claimedAt,
        input.leaseDurationMs,
      );
      this.#database
        .prepare(
          `UPDATE job_attempts
           SET status = 'running', leased_by = ?, lease_expires_at = ?,
               lease_generation = lease_generation + 1,
               started_at = COALESCE(started_at, ?), updated_at = ?
           WHERE id = ? AND status = 'queued'`,
        )
        .run(
          input.ownerId,
          leaseExpiresAt,
          input.claimedAt,
          input.claimedAt,
          current.id,
        );
      this.#markStageRunning(
        current.stageId,
        current.attemptNumber,
        input.claimedAt,
      );
      return this.#findJob(current.id)!;
    }

    const expired = current.status === "running";
    const leaseExpiredError = {
      classification: "infrastructure",
      code: "INFRASTRUCTURE_ERROR",
      message: "Job lease expired before completion",
    };

    if (current.attemptNumber >= current.maxAttempts) {
      const terminalError = expired
        ? leaseExpiredError
        : (current.error ?? {
            classification: "infrastructure",
            code: "INFRASTRUCTURE_ERROR",
            message: "Job attempt limit was exhausted",
          });
      this.#database
        .prepare(
          `UPDATE job_attempts
           SET status = 'failed', retryable = 0, leased_by = NULL,
               lease_expires_at = NULL, completed_at = COALESCE(completed_at, ?),
               error_json = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          input.claimedAt,
          JSON.stringify(terminalError),
          input.claimedAt,
          current.id,
        );
      this.#database
        .prepare(
          `UPDATE run_stages
           SET status = 'failed', completed_at = ?, last_error_json = ?,
               updated_at = ?
           WHERE id = ?`,
        )
        .run(
          input.claimedAt,
          JSON.stringify(terminalError),
          input.claimedAt,
          current.stageId,
        );
      this.#refreshAnalysisRunStatus(current.runId, input.claimedAt);
      return null;
    }

    this.#database
      .prepare(
        `UPDATE job_attempts
         SET status = 'failed', retryable = 1, retry_scheduled_at = ?,
             leased_by = NULL, lease_expires_at = NULL,
             completed_at = COALESCE(completed_at, ?),
             error_json = CASE WHEN ? = 1 THEN ? ELSE error_json END,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(
        input.claimedAt,
        input.claimedAt,
        expired ? 1 : 0,
        JSON.stringify(leaseExpiredError),
        input.claimedAt,
        current.id,
      );

    const nextId = randomUUID();
    const nextAttempt = current.attemptNumber + 1;
    const leaseExpiresAt = addMilliseconds(
      input.claimedAt,
      input.leaseDurationMs,
    );
    this.#database
      .prepare(
        `INSERT INTO job_attempts (
           id, stage_id, attempt_number, max_attempts,
           retry_cycle_start_attempt, status, available_at,
           leased_by, lease_expires_at, lease_generation, retryable,
           retry_scheduled_at, started_at, completed_at, error_json,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, 0, NULL, ?, NULL, NULL, ?, ?)`,
      )
      .run(
        nextId,
        current.stageId,
        nextAttempt,
        current.maxAttempts,
        current.retryCycleStartAttempt,
        input.claimedAt,
        input.ownerId,
        leaseExpiresAt,
        current.leaseGeneration + 1,
        input.claimedAt,
        input.claimedAt,
        input.claimedAt,
      );
    this.#markStageRunning(current.stageId, nextAttempt, input.claimedAt);
    return this.#findJob(nextId)!;
  }

  #markStageRunning(stageId: string, attemptNumber: number, now: string) {
    this.#database
      .prepare(
        `UPDATE run_stages
         SET status = 'running', attempt_count = ?,
             started_at = COALESCE(started_at, ?), updated_at = ?
         WHERE id = ?`,
      )
      .run(attemptNumber, now, now, stageId);
    const stage = this.#database
      .prepare("SELECT run_id FROM run_stages WHERE id = ?")
      .get(stageId) as SqliteRow;
    this.#refreshAnalysisRunStatus(String(stage.run_id), now);
  }

  renewJobLease(input: RenewJobLeaseInput): Promise<JobAttemptRecord> {
    return this.#serialize(() => {
      if (input.leaseDurationMs <= 0) {
        throw new Error("Lease duration must be positive");
      }
      const result = this.#database
        .prepare(
          `UPDATE job_attempts
           SET lease_expires_at = ?, updated_at = ?
           WHERE id = ? AND status = 'running' AND leased_by = ?
             AND lease_generation = ?
             AND lease_expires_at > ?`,
        )
        .run(
          addMilliseconds(input.renewedAt, input.leaseDurationMs),
          input.renewedAt,
          input.jobId,
          input.ownerId,
          input.leaseGeneration,
          input.renewedAt,
        );
      this.#assertLeaseMutation(result.changes);
      return this.#findJob(input.jobId)!;
    });
  }

  releaseJobLease(input: ReleaseJobLeaseInput): Promise<JobAttemptRecord> {
    return this.#serialize(() => {
      const operation = () => {
        const result = this.#database
          .prepare(
            `UPDATE job_attempts
             SET status = 'queued', available_at = ?, leased_by = NULL,
                 lease_expires_at = NULL, retryable = 0,
                 retry_scheduled_at = NULL, completed_at = NULL,
                 error_json = NULL, updated_at = ?
             WHERE id = ? AND status = 'running' AND leased_by = ?
               AND lease_generation = ?
               AND lease_expires_at > ?`,
          )
          .run(
            input.releasedAt,
            input.releasedAt,
            input.jobId,
            input.ownerId,
            input.leaseGeneration,
            input.releasedAt,
          );
        this.#assertLeaseMutation(result.changes);
        const job = this.#findJob(input.jobId)!;
        const stageResult = this.#database
          .prepare(
            `UPDATE run_stages
             SET status = 'queued', completed_at = NULL, updated_at = ?
             WHERE id = ? AND status = 'running'`,
          )
          .run(input.releasedAt, job.stageId);
        this.#assertLeaseMutation(stageResult.changes);
        this.#refreshAnalysisRunStatus(job.runId, input.releasedAt);
        return job;
      };
      return this.#transactionContext.getStore()
        ? operation()
        : this.#withImmediateTransaction(operation);
    });
  }

  completeJob(input: CompleteJobInput): Promise<JobAttemptRecord> {
    return this.#serialize(() => {
      const operation = () => {
        const result = this.#database
          .prepare(
            `UPDATE job_attempts
             SET status = 'succeeded', leased_by = NULL, lease_expires_at = NULL,
                 completed_at = ?, retryable = 0, updated_at = ?
             WHERE id = ? AND status = 'running' AND leased_by = ?
               AND lease_generation = ?
               AND lease_expires_at > ?`,
          )
          .run(
            input.completedAt,
            input.completedAt,
            input.jobId,
            input.ownerId,
            input.leaseGeneration,
            input.completedAt,
          );
        this.#assertLeaseMutation(result.changes);
        const job = this.#findJob(input.jobId)!;
        this.#database
          .prepare(
            `UPDATE run_stages
             SET status = 'succeeded', progress = 100, completed_at = ?,
                 last_error_json = NULL, updated_at = ?
             WHERE id = ?`,
          )
          .run(input.completedAt, input.completedAt, job.stageId);
        this.#refreshAnalysisRunStatus(job.runId, input.completedAt);
        return job;
      };
      return this.#transactionContext.getStore()
        ? operation()
        : this.#withImmediateTransaction(operation);
    });
  }

  failJob(input: FailJobInput): Promise<JobAttemptRecord> {
    return this.#serialize(() => {
      const operation = () => {
        const availableAt = input.retryable
          ? (input.retryAt ?? input.failedAt)
          : input.failedAt;
        const attemptStatus = input.attemptStatus ?? "failed";
        const stageStatus =
          input.stageStatus ?? (input.retryable ? "queued" : "failed");
        if (
          input.retryable !== (stageStatus === "queued") ||
          (input.retryable && attemptStatus !== "failed")
        ) {
          throw new Error("Retryable jobs must return their stage to queued");
        }
        const result = this.#database
          .prepare(
            `UPDATE job_attempts
             SET status = ?, available_at = ?, leased_by = NULL,
                 lease_expires_at = NULL, retryable = ?, retry_scheduled_at = NULL,
                 completed_at = ?, error_json = ?, updated_at = ?
             WHERE id = ? AND status = 'running' AND leased_by = ?
               AND lease_generation = ?
               AND lease_expires_at > ?`,
          )
          .run(
            attemptStatus,
            availableAt,
            input.retryable ? 1 : 0,
            input.failedAt,
            JSON.stringify(input.error),
            input.failedAt,
            input.jobId,
            input.ownerId,
            input.leaseGeneration,
            input.failedAt,
          );
        this.#assertLeaseMutation(result.changes);
        const job = this.#findJob(input.jobId)!;
        const completedAt =
          stageStatus === "queued" || stageStatus === "waiting-input"
            ? null
            : input.failedAt;
        this.#database
          .prepare(
            `UPDATE run_stages
             SET status = ?, completed_at = ?, last_error_json = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(
            stageStatus,
            completedAt,
            JSON.stringify(input.error),
            input.failedAt,
            job.stageId,
          );
        this.#refreshAnalysisRunStatus(job.runId, input.failedAt);
        return job;
      };
      return this.#transactionContext.getStore()
        ? operation()
        : this.#withImmediateTransaction(operation);
    });
  }

  #assertLeaseMutation(changes: number | bigint) {
    if (Number(changes) !== 1) {
      throw new JobLeaseLostError();
    }
  }

  listJobAttempts(stageId: string): Promise<JobAttemptRecord[]> {
    return this.#serialize(() =>
      (
        this.#database
          .prepare(
            `SELECT job_attempts.*, run_stages.run_id AS run_id,
                    run_stages.stage AS stage
             FROM job_attempts
             JOIN run_stages ON run_stages.id = job_attempts.stage_id
             WHERE job_attempts.stage_id = ?
             ORDER BY job_attempts.attempt_number`,
          )
          .all(stageId) as SqliteRow[]
      ).map(mapJob),
    );
  }

  #refreshAnalysisRunStatus(runId: string, updatedAt: string) {
    const run = this.#findAnalysisRun(runId);
    if (!run || run.status === "cancelled") return;
    const stages = (
      this.#database
        .prepare("SELECT * FROM run_stages WHERE run_id = ?")
        .all(runId) as SqliteRow[]
    ).map(mapRunStage);
    const activeJobs = this.#database
      .prepare(
        `SELECT
           SUM(CASE WHEN job_attempts.status = 'running' THEN 1 ELSE 0 END) AS running,
           SUM(CASE WHEN job_attempts.status = 'queued' THEN 1 ELSE 0 END) AS queued
         FROM job_attempts
         JOIN run_stages ON run_stages.id = job_attempts.stage_id
         WHERE run_stages.run_id = ?`,
      )
      .get(runId) as SqliteRow;
    const status = deriveRunStatus(
      stages,
      Number(activeJobs.running ?? 0),
      Number(activeJobs.queued ?? 0),
    );
    this.#database
      .prepare("UPDATE analysis_runs SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, updatedAt, runId);
  }

  #findJob(id: string) {
    const row = this.#database
      .prepare(
        `SELECT job_attempts.*, run_stages.run_id AS run_id,
                run_stages.stage AS stage
         FROM job_attempts
         JOIN run_stages ON run_stages.id = job_attempts.stage_id
         WHERE job_attempts.id = ?`,
      )
      .get(id) as SqliteRow | undefined;
    return row ? mapJob(row) : null;
  }

  close() {
    this.#database.close();
  }
}

function assertBudgetInteger(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`Invalid budget value for ${label}`);
  }
}

function assertTimestamp(value: string, label: string) {
  if (
    typeof value !== "string" ||
    !value ||
    !Number.isFinite(new Date(value).getTime()) ||
    new Date(value).toISOString() !== value
  ) {
    throw new TypeError(`Invalid budget timestamp for ${label}`);
  }
}

function assertBudgetTransitionInput(input: TransitionModelBudgetInput) {
  if (!input.reservationId || input.reservationId.length > 200) {
    throw new ModelBudgetReservationNotFoundError();
  }
  assertTimestamp(input.transitionedAt, "transitionedAt");
}

function assertUtcDay(value: string) {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value
  ) {
    throw new TypeError("Invalid budget UTC day");
  }
}

function assertBudgetAmount(amount: ModelBudgetAmount, label: string) {
  assertBudgetInteger(amount.inputTokens, `${label}.inputTokens`);
  assertBudgetInteger(amount.outputTokens, `${label}.outputTokens`);
  assertBudgetInteger(amount.costMicros, `${label}.costMicros`);
  const total = amount.inputTokens + amount.outputTokens;
  if (!Number.isSafeInteger(total)) {
    throw new TypeError(`Invalid budget value for ${label}.tokens`);
  }
  if (label === "projected" && total === 0) {
    throw new TypeError("Invalid budget value for projected.tokens");
  }
}

function assertBudgetLimit(limit: ModelBudgetLimit, label: string) {
  assertBudgetInteger(limit.maxTokens, `${label}.maxTokens`);
  assertBudgetInteger(limit.maxCostMicros, `${label}.maxCostMicros`);
}

function assertReserveModelBudgetInput(input: ReserveModelBudgetInput) {
  if (!input.id || input.id.length > 200) {
    throw new TypeError("Invalid budget reservation ID");
  }
  if (!input.idempotencyKey || input.idempotencyKey.length > 200) {
    throw new TypeError("Invalid budget idempotency key");
  }
  if (!/^[0-9a-f]{64}$/.test(input.requestFingerprint)) {
    throw new TypeError("Invalid model request fingerprint");
  }
  assertModelBudgetSubjectInput(input.runId, input.projectId);
  assertTimestamp(input.reservedAt, "reservedAt");
  assertTimestamp(input.leaseExpiresAt, "leaseExpiresAt");
  if (input.leaseExpiresAt <= input.reservedAt) {
    throw new TypeError("Invalid budget reservation lease");
  }
  assertBudgetAmount(input.projected, "projected");
  assertBudgetLimit(input.limits.call, "call");
  assertBudgetLimit(input.limits.run, "run");
  assertBudgetLimit(
    input.limits.organizationUtcDay,
    "organizationUtcDay",
  );
}

function assertModelBudgetSubjectInput(runId: string, projectId: string) {
  if (!runId || !projectId || runId.length > 200 || projectId.length > 200) {
    throw new ModelBudgetSubjectNotFoundError();
  }
}

function utcDayFromCanonicalTimestamp(value: string) {
  return value.slice(0, 10);
}

function modelBudgetUsage(amount: ModelBudgetAmount): ModelBudgetUsage {
  return {
    tokens: amount.inputTokens + amount.outputTokens,
    costMicros: amount.costMicros,
  };
}

function assertIntegerBudgetAvailable(
  scope: BudgetScope,
  usage: ModelBudgetUsage,
  projected: ModelBudgetUsage,
  limit: ModelBudgetLimit,
) {
  if (BigInt(usage.tokens) + BigInt(projected.tokens) > BigInt(limit.maxTokens)) {
    throw new BudgetExceededError(
      scope,
      "tokens",
      usage.tokens,
      projected.tokens,
      limit.maxTokens,
    );
  }
  if (
    BigInt(usage.costMicros) + BigInt(projected.costMicros) >
    BigInt(limit.maxCostMicros)
  ) {
    throw new BudgetExceededError(
      scope,
      "costMicros",
      usage.costMicros,
      projected.costMicros,
      limit.maxCostMicros,
    );
  }
}

function sumModelBudgetRows(rows: readonly SqliteRow[]): ModelBudgetUsage {
  let tokens = BigInt(0);
  let costMicros = BigInt(0);
  for (const row of rows) {
    const settled = row.state === "settled";
    const inputTokens = settled
      ? row.actual_input_tokens
      : row.projected_input_tokens;
    const outputTokens = settled
      ? row.actual_output_tokens
      : row.projected_output_tokens;
    const cost = settled ? row.actual_cost_micros : row.projected_cost_micros;
    if (
      typeof inputTokens !== "number" ||
      typeof outputTokens !== "number" ||
      typeof cost !== "number" ||
      !Number.isSafeInteger(inputTokens) ||
      !Number.isSafeInteger(outputTokens) ||
      !Number.isSafeInteger(cost) ||
      inputTokens < 0 ||
      outputTokens < 0 ||
      cost < 0
    ) {
      throw new ModelBudgetDataError();
    }
    tokens += BigInt(inputTokens) + BigInt(outputTokens);
    costMicros += BigInt(cost);
  }
  if (
    tokens > BigInt(Number.MAX_SAFE_INTEGER) ||
    costMicros > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new ModelBudgetDataError();
  }
  return { tokens: Number(tokens), costMicros: Number(costMicros) };
}

function sameReservationParameters(
  reservation: ModelBudgetReservationRecord,
  input: ReserveModelBudgetInput,
) {
  return (
    reservation.runId === input.runId &&
    reservation.projectId === input.projectId &&
    reservation.requestFingerprint === input.requestFingerprint &&
    reservation.projected.inputTokens === input.projected.inputTokens &&
    reservation.projected.outputTokens === input.projected.outputTokens &&
    reservation.projected.costMicros === input.projected.costMicros
  );
}

function sameModelBudgetAmount(
  left: ModelBudgetAmount | null,
  right: ModelBudgetAmount,
) {
  return (
    left !== null &&
    left.inputTokens === right.inputTokens &&
    left.outputTokens === right.outputTokens &&
    left.costMicros === right.costMicros
  );
}

function mapModelBudgetReservation(row: SqliteRow): ModelBudgetReservationRecord {
  const actual =
    row.actual_input_tokens === null ||
    row.actual_output_tokens === null ||
    row.actual_cost_micros === null
      ? null
      : {
          inputTokens: Number(row.actual_input_tokens),
          outputTokens: Number(row.actual_output_tokens),
          costMicros: Number(row.actual_cost_micros),
        };
  const reservation: ModelBudgetReservationRecord = {
    id: String(row.id),
    idempotencyKey: String(row.idempotency_key),
    requestFingerprint: String(row.request_fingerprint),
    runId: String(row.run_id),
    projectId: String(row.project_id),
    organizationId: String(row.organization_id),
    utcDay: String(row.utc_day),
    state: String(row.state) as ModelBudgetReservationRecord["state"],
    projected: {
      inputTokens: Number(row.projected_input_tokens),
      outputTokens: Number(row.projected_output_tokens),
      costMicros: Number(row.projected_cost_micros),
    },
    actual,
    leaseExpiresAt:
      row.lease_expires_at === null ? null : String(row.lease_expires_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    dispatchedAt:
      row.dispatched_at === null ? null : String(row.dispatched_at),
    settledAt: row.settled_at === null ? null : String(row.settled_at),
    releasedAt: row.released_at === null ? null : String(row.released_at),
  };
  try {
    assertBudgetAmount(reservation.projected, "stored projected");
    if (reservation.actual) assertBudgetAmount(reservation.actual, "stored actual");
    if (!/^[0-9a-f]{64}$/.test(reservation.requestFingerprint)) {
      throw new TypeError("Invalid stored model request fingerprint");
    }
    assertUtcDay(reservation.utcDay);
    assertTimestamp(reservation.createdAt, "stored createdAt");
    assertTimestamp(reservation.updatedAt, "stored updatedAt");
    if (reservation.leaseExpiresAt) {
      assertTimestamp(reservation.leaseExpiresAt, "stored leaseExpiresAt");
    }
    if (reservation.dispatchedAt) {
      assertTimestamp(reservation.dispatchedAt, "stored dispatchedAt");
    }
    if (reservation.settledAt) {
      assertTimestamp(reservation.settledAt, "stored settledAt");
    }
    if (reservation.releasedAt) {
      assertTimestamp(reservation.releasedAt, "stored releasedAt");
    }
    if (reservation.utcDay !== utcDayFromCanonicalTimestamp(reservation.createdAt)) {
      throw new TypeError("Invalid stored model budget UTC day");
    }
  } catch {
    throw new ModelBudgetDataError();
  }
  return reservation;
}

function mapUser(row: SqliteRow): UserRecord {
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    email: String(row.email),
    displayName: String(row.display_name),
    role: String(row.role) as UserRecord["role"],
    status: String(row.status) as UserRecord["status"],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapAnalysisRun(row: SqliteRow): AnalysisRunRecord {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    mode: String(row.mode) as AnalysisRunRecord["mode"],
    status: String(row.status) as AnalysisRunRecord["status"],
    createdBy: String(row.created_by),
    dataCutoffAt: String(row.data_cutoff_at),
    idempotencyScope: String(row.idempotency_scope),
    idempotencyKey: String(row.idempotency_key),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapProject(row: SqliteRow): ProjectRecord {
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    name: String(row.name),
    marketplace: String(row.marketplace),
    asins: JSON.parse(String(row.asins_json)) as string[],
    createdBy: String(row.created_by),
    currentRunId:
      row.current_run_id === null ? null : String(row.current_run_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapRunStage(row: SqliteRow): RunStageRecord {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    stage: String(row.stage) as RunStageRecord["stage"],
    status: String(row.status) as RunStageRecord["status"],
    progress: Number(row.progress),
    attemptCount: Number(row.attempt_count),
    startedAt: row.started_at === null ? null : String(row.started_at),
    completedAt: row.completed_at === null ? null : String(row.completed_at),
    lastError:
      row.last_error_json === null
        ? null
        : (JSON.parse(String(row.last_error_json)) as Record<string, unknown>),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapJob(row: SqliteRow): JobAttemptRecord {
  return {
    id: String(row.id),
    stageId: String(row.stage_id),
    runId: String(row.run_id),
    stage: String(row.stage) as JobAttemptRecord["stage"],
    attemptNumber: Number(row.attempt_number),
    maxAttempts: Number(row.max_attempts),
    retryCycleStartAttempt: Number(row.retry_cycle_start_attempt),
    status: String(row.status) as JobAttemptRecord["status"],
    availableAt: String(row.available_at),
    leasedBy: row.leased_by === null ? null : String(row.leased_by),
    leaseExpiresAt:
      row.lease_expires_at === null ? null : String(row.lease_expires_at),
    leaseGeneration: Number(row.lease_generation),
    retryable: row.retryable === 1,
    startedAt: row.started_at === null ? null : String(row.started_at),
    completedAt: row.completed_at === null ? null : String(row.completed_at),
    error:
      row.error_json === null
        ? null
        : (JSON.parse(String(row.error_json)) as Record<string, unknown>),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function addMilliseconds(timestamp: string, durationMs: number) {
  return new Date(new Date(timestamp).getTime() + durationMs).toISOString();
}

function deriveRunStatus(
  stages: readonly RunStageRecord[],
  runningJobs: number,
  queuedJobs: number,
): AnalysisRunRecord["status"] {
  const statuses = new Set(stages.map((stage) => stage.status));
  if (runningJobs > 0 || statuses.has("running")) return "running";
  if (queuedJobs > 0) {
    return statuses.has("succeeded") || statuses.has("failed")
      ? "running"
      : "queued";
  }
  if (statuses.has("waiting-input")) return "waiting-input";
  const hasSucceeded = statuses.has("succeeded");
  if (statuses.has("budget-exceeded")) {
    return hasSucceeded ? "partial" : "budget-exceeded";
  }
  if (statuses.has("failed")) return hasSucceeded ? "partial" : "failed";
  if (statuses.has("stale") || statuses.has("skipped")) return "partial";
  if (statuses.size === 1 && statuses.has("succeeded")) return "succeeded";
  if (statuses.size === 1 && statuses.has("cancelled")) return "cancelled";
  if (statuses.has("queued")) return hasSucceeded ? "partial" : "queued";
  return hasSucceeded ? "partial" : "failed";
}

export function openSqliteAgentRepository(options: SqliteRepositoryOptions) {
  return new SqliteAgentRepository(options);
}
