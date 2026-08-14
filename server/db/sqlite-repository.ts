import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  AgentRepository,
  AnalysisRunRecord,
  ClaimJobInput,
  CompleteJobInput,
  CreateProjectInput,
  EnqueueJobInput,
  FailJobInput,
  JobAttemptRecord,
  ProjectRecord,
  RenewJobLeaseInput,
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

export class SqliteAgentRepository implements AgentRepository {
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

  createAnalysisRun(run: AnalysisRunRecord): Promise<AnalysisRunRecord> {
    if (this.#transactionContext.getStore()) {
      return this.#serialize(() => this.#createAnalysisRun(run));
    }

    return this.#serialize(() =>
      this.#withImmediateTransaction(() => this.#createAnalysisRun(run)),
    );
  }

  #createAnalysisRun(run: AnalysisRunRecord): AnalysisRunRecord {
    const existing = this.#database
      .prepare(
        `SELECT id, project_id, mode, status, created_by, data_cutoff_at,
                idempotency_scope, idempotency_key, created_at, updated_at
         FROM analysis_runs
         WHERE idempotency_scope = ? AND idempotency_key = ?`,
      )
      .get(run.idempotencyScope, run.idempotencyKey) as SqliteRow | undefined;
    if (existing) return mapAnalysisRun(existing);

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
    return run;
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

  enqueueJob(job: EnqueueJobInput): Promise<JobAttemptRecord> {
    return this.#serialize(() => {
      this.#database
        .prepare(
          `INSERT INTO job_attempts (
             id, stage_id, attempt_number, max_attempts, status, available_at,
             leased_by, lease_expires_at, lease_generation, retryable,
             retry_scheduled_at, started_at, completed_at, error_json,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, 'queued', ?, NULL, NULL, 0, 0, NULL, NULL,
                     NULL, NULL, ?, ?)`,
        )
        .run(
          job.id,
          job.stageId,
          job.attemptNumber,
          job.maxAttempts,
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
           id, stage_id, attempt_number, max_attempts, status, available_at,
           leased_by, lease_expires_at, lease_generation, retryable,
           retry_scheduled_at, started_at, completed_at, error_json,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, 0, NULL, ?, NULL, NULL, ?, ?)`,
      )
      .run(
        nextId,
        current.stageId,
        nextAttempt,
        current.maxAttempts,
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
        return job;
      };
      return this.#transactionContext.getStore()
        ? operation()
        : this.#withImmediateTransaction(operation);
    });
  }

  #assertLeaseMutation(changes: number | bigint) {
    if (Number(changes) !== 1) {
      throw new Error(
        "Job lease owner or generation does not match the active lease",
      );
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

export function openSqliteAgentRepository(options: SqliteRepositoryOptions) {
  return new SqliteAgentRepository(options);
}
