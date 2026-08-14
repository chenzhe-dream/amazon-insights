import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";

import {
  AgentRunAttemptSchema,
  AgentRunAuditSchema,
  AsinSchema,
  DateTimeSchema,
  EntityIdSchema,
  MarketplaceSchema,
  type AgentRunAudit,
} from "../../shared/agent-contracts";
import {
  VocDataSnapshotRecordSchema,
  assertVocDataSnapshotRecordIntegrity,
  assertVocSnapshotCandidateIntegrity,
  canonicalizeVocSnapshotCandidate,
  deepFreeze,
  type VocDataSnapshotRecord,
} from "../data/voc-data-snapshot";
import { SkillManifestSchema } from "../skills/manifest";
import { BudgetExceededError, type BudgetScope } from "../runtime/budget-policy";
import {
  DataSnapshotConflictError,
  DataSnapshotDataError,
  DataSnapshotSubjectNotFoundError,
  type CreateDataSnapshotForRunInput,
  type CreateDataSnapshotForRunResult,
  type DataSnapshotSubjectInput,
  type DataSnapshotRepository,
  type FindDataSnapshotByIdInput,
  type ListDataSnapshotsByRunInput,
} from "./data-snapshot-repository";
import {
  AgentRunConflictError,
  AgentRunClaimLostError,
  AgentRunDataError,
  AgentRunLeaseLostError,
  AgentRunSubjectNotFoundError,
  SkillVersionConflictError,
  type AgentRunRepository,
  type AgentRunUsageSummary,
  type AssertAgentRunClaimInput,
  type BeginAgentRunInput,
  type BeginAgentRunResult,
  type FinalizeAgentRunInput,
  type FinalizeAgentRunResult,
  type JobAttemptModelUsage,
  type JobAttemptModelUsageInput,
  type ListAgentRunsInput,
  type RegisterSkillVersionInput,
  type SkillVersionRecord,
} from "./agent-run-repository";
import {
  ModelBudgetDataError,
  ModelBudgetExecutionAuthorityLostError,
  ModelBudgetReservationConflictError,
  ModelBudgetReservationNotFoundError,
  ModelBudgetStateConflictError,
  ModelBudgetSubjectNotFoundError,
  type GetModelBudgetUsageInput,
  type ModelBudgetAmount,
  type ModelBudgetExecutionAuthority,
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
  nowProvider?: () => Date;
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
const agentRunSelect = `
  SELECT ar.*, rs.stage AS stage, sv.skill_id AS skill_id,
         sv.version AS skill_version, sv.content_hash AS skill_content_hash,
         p.organization_id AS organization_id
  FROM agent_runs ar
  JOIN run_stages rs ON rs.id = ar.stage_id
  JOIN skill_versions sv ON sv.id = ar.skill_version_id
  JOIN analysis_runs r ON r.id = ar.run_id
  JOIN projects p ON p.id = r.project_id`;

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
  implements
    AgentRepository,
    ModelBudgetLedgerRepository,
    AgentRunRepository,
    DataSnapshotRepository
{
  readonly #database: DatabaseSync;
  readonly #path: string;
  readonly #nowProvider: () => Date;
  readonly #transactionContext = new AsyncLocalStorage<boolean>();

  constructor(options: SqliteRepositoryOptions) {
    mkdirSync(dirname(options.path), { recursive: true });
    this.#path = options.path;
    this.#nowProvider = options.nowProvider ?? (() => new Date());
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

  #agentRunTransaction<T>(operation: () => T): Promise<T> {
    return this.#transactionContext.getStore()
      ? this.#serialize(operation)
      : this.#serialize(() => this.#withImmediateTransaction(operation));
  }

  async registerSkillVersion(
    input: RegisterSkillVersionInput,
  ): Promise<SkillVersionRecord> {
    const validated = validateSkillVersionInput(input);
    return this.#agentRunTransaction(() => {
        const existing = this.#database
          .prepare(
            `SELECT id, skill_id, version, content_hash, manifest_json, created_at
             FROM skill_versions WHERE skill_id = ? AND version = ?`,
          )
          .get(validated.skillId, validated.version) as SqliteRow | undefined;
        if (existing) {
          const record = mapSkillVersion(existing);
          if (sameSkillVersion(record, validated)) return record;
          throw new SkillVersionConflictError();
        }

        const contentOwner = this.#database
          .prepare(
            `SELECT 1 FROM skill_versions
             WHERE skill_id = ? AND content_hash = ?`,
          )
          .get(validated.skillId, validated.contentHash);
        if (contentOwner) throw new SkillVersionConflictError();

        this.#database
          .prepare(
            `INSERT INTO skill_versions
             (id, skill_id, version, content_hash, manifest_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            validated.id,
            validated.skillId,
            validated.version,
            validated.contentHash,
            JSON.stringify(validated.manifest),
            validated.createdAt,
          );
        return validated;
    });
  }

  async beginAgentRun(input: BeginAgentRunInput): Promise<BeginAgentRunResult> {
    const validated = validateBeginAgentRunInput(input);
    return this.#agentRunTransaction(() => {
        const subject = this.#database
          .prepare(
            `SELECT ja.id, ja.status, ja.leased_by, ja.lease_expires_at,
                    ja.lease_generation, ja.stage_id, rs.run_id,
                    p.organization_id, r.data_cutoff_at
             FROM job_attempts ja
             JOIN run_stages rs ON rs.id = ja.stage_id
             JOIN analysis_runs r ON r.id = rs.run_id
             JOIN projects p ON p.id = r.project_id
             WHERE ja.id = ? AND ja.stage_id = ? AND rs.run_id = ?
               AND p.organization_id = ?`,
          )
          .get(
            validated.jobAttemptId,
            validated.stageId,
            validated.runId,
            validated.organizationId,
        ) as SqliteRow | undefined;
        if (!subject) throw new AgentRunSubjectNotFoundError();
        const storedDataCutoffAt = String(subject.data_cutoff_at);
        const cutoffMatchesRun = sameDateTimeInstant(
          storedDataCutoffAt,
          validated.dataCutoffAt,
        );
        if (
          subject.status !== "running" ||
          subject.leased_by !== validated.leaseOwnerId ||
          Number(subject.lease_generation) !== validated.leaseGeneration ||
          typeof subject.lease_expires_at !== "string" ||
          subject.lease_expires_at <= validated.claimAcquiredAt
        ) {
          throw new AgentRunLeaseLostError();
        }

        const skill = this.#database
          .prepare(
            `SELECT id FROM skill_versions WHERE id = ?`,
          )
          .get(validated.skillVersionId);
        if (!skill) throw new AgentRunSubjectNotFoundError();

        const placeholders = validated.snapshotIds.map(() => "?").join(", ");
        const snapshots = this.#database
          .prepare(
            `SELECT id, run_id, data_cutoff_at FROM data_snapshots
             WHERE id IN (${placeholders})`,
          )
          .all(...validated.snapshotIds) as SqliteRow[];
        if (
          snapshots.length !== validated.snapshotIds.length ||
          snapshots.some((snapshot) => snapshot.run_id !== validated.runId)
        ) {
          throw new AgentRunSubjectNotFoundError();
        }
        const cutoffMatchesSnapshots = snapshots.every(
          (snapshot) => sameDateTimeInstant(
            String(snapshot.data_cutoff_at),
            validated.dataCutoffAt,
          ),
        );

        const existing = this.#database
          .prepare(
            `${agentRunSelect}
             WHERE ar.job_attempt_id = ?
               AND ar.schema_version = '1.1.0'
               AND ar.execution_fingerprint IS NOT NULL
               AND ar.output_schema_digest IS NOT NULL`,
          )
          .get(validated.jobAttemptId) as SqliteRow | undefined;
        if (existing) {
          const record = mapAgentRun(this.#database, existing);
          if (
            sameAgentRunBeginIdentity(
              record,
              validated,
              String(existing.skill_version_id),
            )
          ) {
            if (record.validationStatus !== "pending") {
              return { record, created: false, claimStatus: "terminal" };
            }
            const storedClaimToken = String(existing.execution_claim_token);
            if (storedClaimToken === validated.claimToken) {
              return { record, created: false, claimStatus: "acquired" };
            }
            const claimBelongsToSameLease =
              existing.execution_claim_owner_id === validated.leaseOwnerId &&
              Number(existing.execution_claim_generation) === validated.leaseGeneration;
            if (claimBelongsToSameLease) {
              return { record, created: false, claimStatus: "observing" };
            }
            const rotated = this.#database
              .prepare(
                `UPDATE agent_runs
                 SET execution_claim_token = ?, execution_claim_owner_id = ?,
                     execution_claim_generation = ?, execution_claim_acquired_at = ?,
                     execution_claim_expires_at = ?
                 WHERE id = ? AND validation_status = 'pending'
                   AND execution_claim_token = ?`,
              )
              .run(
                validated.claimToken,
                validated.leaseOwnerId,
                validated.leaseGeneration,
                validated.claimAcquiredAt,
                validated.claimExpiresAt,
                record.id,
                storedClaimToken,
              );
            if (Number(rotated.changes) !== 1) throw new AgentRunClaimLostError();
            const claimed = this.#database
              .prepare(`${agentRunSelect} WHERE ar.id = ?`)
              .get(record.id) as SqliteRow | undefined;
            if (!claimed) throw new AgentRunDataError();
            return {
              record: mapAgentRun(this.#database, claimed),
              created: false,
              claimStatus: "acquired",
            };
          }
          throw new AgentRunConflictError();
        }
        if (!cutoffMatchesRun || !cutoffMatchesSnapshots) {
          throw new AgentRunSubjectNotFoundError();
        }

        this.#database
          .prepare(
            `INSERT INTO agent_runs (
               id, run_id, stage_id, job_attempt_id, skill_version_id,
               schema_version, snapshot_ids_json, provider, model, response_id,
               input_summary_json, output_schema_version, output_json,
               validation_status, input_tokens, output_tokens, duration_ms,
               estimated_cost_micros, error_json, data_cutoff_at, started_at,
               completed_at, execution_fingerprint, output_schema_digest,
               terminal_status, usage_completeness, attempt_count, attempts_json,
               execution_claim_token, execution_claim_owner_id,
               execution_claim_generation, execution_claim_acquired_at,
               execution_claim_expires_at
             ) VALUES (
               ?, ?, ?, ?, ?, '1.1.0', ?, ?, ?, NULL, ?, ?, NULL,
               'pending', NULL, NULL, NULL, NULL, NULL, ?, ?, NULL,
               ?, ?, NULL, NULL, NULL, '[]', ?, ?, ?, ?, ?
             )`,
          )
          .run(
            validated.id,
            validated.runId,
            validated.stageId,
            validated.jobAttemptId,
            validated.skillVersionId,
            JSON.stringify(validated.snapshotIds),
            validated.provider,
            validated.model,
            JSON.stringify(validated.inputSummary),
            validated.outputSchemaVersion,
            storedDataCutoffAt,
            validated.startedAt,
            validated.executionFingerprint,
            validated.outputSchemaDigest,
            validated.claimToken,
            validated.leaseOwnerId,
            validated.leaseGeneration,
            validated.claimAcquiredAt,
            validated.claimExpiresAt,
          );
        const insertLink = this.#database.prepare(
          `INSERT INTO agent_run_snapshots (agent_run_id, snapshot_id, ordinal)
           VALUES (?, ?, ?)`,
        );
        validated.snapshotIds.forEach((snapshotId, ordinal) => {
          insertLink.run(validated.id, snapshotId, ordinal);
        });
        const created = this.#database
          .prepare(`${agentRunSelect} WHERE ar.id = ?`)
          .get(validated.id) as SqliteRow | undefined;
        if (!created) throw new AgentRunDataError();
        return {
          record: mapAgentRun(this.#database, created),
          created: true,
          claimStatus: "acquired",
        };
    });
  }

  async assertAgentRunClaim(input: AssertAgentRunClaimInput): Promise<void> {
    validateAssertAgentRunClaimInput(input);
    return this.#serialize(() => {
      const row = this.#database
        .prepare(
          `SELECT ar.validation_status, ar.execution_claim_token,
                  ja.status, ja.leased_by, ja.lease_generation, ja.lease_expires_at
           FROM agent_runs ar
           JOIN job_attempts ja ON ja.id = ar.job_attempt_id
           JOIN run_stages rs ON rs.id = ja.stage_id
           JOIN analysis_runs r ON r.id = rs.run_id
           JOIN projects p ON p.id = r.project_id
           WHERE ar.id = ? AND ar.job_attempt_id = ? AND p.organization_id = ?`,
        )
        .get(input.agentRunId, input.jobAttemptId, input.organizationId) as
        | SqliteRow
        | undefined;
      if (!row) throw new AgentRunSubjectNotFoundError();
      if (
        row.validation_status !== "pending" ||
        row.execution_claim_token !== input.claimToken
      ) {
        throw new AgentRunClaimLostError();
      }
      if (
        row.status !== "running" ||
        row.leased_by !== input.leaseOwnerId ||
        Number(row.lease_generation) !== input.leaseGeneration ||
        typeof row.lease_expires_at !== "string" ||
        row.lease_expires_at <= input.asOf
      ) {
        throw new AgentRunLeaseLostError();
      }
    });
  }

  async finalizeAgentRun(
    input: FinalizeAgentRunInput,
  ): Promise<FinalizeAgentRunResult> {
    validateFinalizeAgentRunInput(input);
    return this.#agentRunTransaction(() => {
        const currentRow = this.#database
          .prepare(
            `${agentRunSelect}
             WHERE ar.id = ? AND p.organization_id = ?`,
          )
          .get(input.agentRunId, input.organizationId) as SqliteRow | undefined;
        if (!currentRow) throw new AgentRunSubjectNotFoundError();
        const current = mapAgentRun(this.#database, currentRow);
        const candidate = finalizedAgentRun(current, input);

        if (current.validationStatus !== "pending") {
          if (isDeepStrictEqual(current, candidate)) {
            return { record: current, transitioned: false };
          }
          throw new AgentRunConflictError();
        }

        const outcome = input.outcome;
        const update = this.#database
          .prepare(
            `UPDATE agent_runs
             SET terminal_status = ?, response_id = ?, output_json = ?,
                 validation_status = ?, input_tokens = ?, output_tokens = ?,
                 duration_ms = ?, estimated_cost_micros = ?, error_json = ?,
                 completed_at = ?, usage_completeness = ?, attempt_count = ?,
                 attempts_json = ?, terminal_metadata_json = ?
             WHERE id = ? AND validation_status = 'pending'
               AND execution_claim_token = ?
               AND EXISTS (
                 SELECT 1 FROM job_attempts ja
                 WHERE ja.id = agent_runs.job_attempt_id
                   AND ja.status = 'running'
                   AND ja.leased_by = ?
                   AND ja.lease_generation = ?
                   AND ja.lease_expires_at > ?
               )`,
          )
          .run(
            outcome.terminalStatus,
            outcome.responseId,
            outcome.output === null ? null : JSON.stringify(outcome.output),
            outcome.validationStatus,
            outcome.inputTokens,
            outcome.outputTokens,
            outcome.durationMs,
            outcome.estimatedCostMicros,
            outcome.error === null ? null : JSON.stringify(outcome.error),
            input.completedAt,
            outcome.usageCompleteness,
            outcome.attemptCount,
            JSON.stringify(outcome.attempts),
            JSON.stringify(outcome.terminalMetadata),
            input.agentRunId,
            input.claimToken,
            input.leaseOwnerId,
            input.leaseGeneration,
            input.completedAt,
          );
        if (Number(update.changes) !== 1) {
          const raced = this.#database
            .prepare(`${agentRunSelect} WHERE ar.id = ?`)
            .get(input.agentRunId) as SqliteRow | undefined;
          if (raced) {
            const record = mapAgentRun(this.#database, raced);
            if (
              record.validationStatus !== "pending" &&
              isDeepStrictEqual(record, candidate)
            ) {
              return { record, transitioned: false };
            }
            if (record.validationStatus !== "pending") {
              throw new AgentRunConflictError();
            }
          }
          if (
            raced &&
            raced.validation_status === "pending" &&
            raced.execution_claim_token !== input.claimToken
          ) {
            throw new AgentRunClaimLostError();
          }
          throw new AgentRunLeaseLostError();
        }
        const completed = this.#database
          .prepare(`${agentRunSelect} WHERE ar.id = ?`)
          .get(input.agentRunId) as SqliteRow | undefined;
        if (!completed) throw new AgentRunDataError();
        return {
          record: mapAgentRun(this.#database, completed),
          transitioned: true,
        };
    });
  }

  listAgentRuns(input: ListAgentRunsInput): Promise<AgentRunAudit[]> {
    validateListAgentRunsInput(input);
    return this.#serialize(() =>
      (
        this.#database
          .prepare(
            `${agentRunSelect}
             WHERE ar.run_id = ? AND p.organization_id = ?
               AND ar.schema_version = '1.1.0'
               AND ar.execution_fingerprint IS NOT NULL
               AND ar.output_schema_digest IS NOT NULL
             ORDER BY ar.started_at, ar.id`,
          )
          .all(input.runId, input.organizationId) as SqliteRow[]
      ).map((row) => mapAgentRun(this.#database, row)),
    );
  }

  async getAgentRunUsage(
    input: ListAgentRunsInput,
  ): Promise<AgentRunUsageSummary> {
    const records = await this.listAgentRuns(input);
    const known = records.filter(
      (record) =>
        record.inputTokens !== null &&
        record.outputTokens !== null &&
        record.estimatedCostMicros !== null,
    );
    const usageCompleteness =
      known.length === 0
        ? "unavailable"
        : known.length === records.length &&
            records.every((record) => record.usageCompleteness === "complete")
          ? "complete"
          : "partial";
    return {
      usageCompleteness,
      inputTokens: sumNullableSafeIntegers(known.map((record) => record.inputTokens)),
      outputTokens: sumNullableSafeIntegers(known.map((record) => record.outputTokens)),
      estimatedCostMicros: sumNullableSafeIntegers(
        known.map((record) => record.estimatedCostMicros),
      ),
      durationMs: sumNullableSafeIntegers(
        records.map((record) => record.durationMs),
      ),
      attemptCount: sumNullableSafeIntegers(
        records.map((record) => record.attemptCount),
      ),
      agentRunCount: records.length,
    };
  }

  getJobAttemptModelUsage(
    input: JobAttemptModelUsageInput,
  ): Promise<JobAttemptModelUsage> {
    validateJobAttemptModelUsageInput(input);
    return this.#serialize(() => {
      const rows = this.#database
        .prepare(
          `SELECT mbr.state, mbr.projected_input_tokens,
                  mbr.projected_output_tokens, mbr.projected_cost_micros,
                  mbr.actual_input_tokens, mbr.actual_output_tokens,
                  mbr.actual_cost_micros, mbr.request_ordinal,
                  mbr.attempt_kind, mbr.transient_retry_count,
                  mbr.format_repair, mbr.response_id
           FROM model_budget_reservations mbr
           JOIN job_attempts ja ON ja.id = mbr.job_attempt_id
           JOIN run_stages rs ON rs.id = ja.stage_id
           JOIN analysis_runs r ON r.id = rs.run_id
           JOIN projects p ON p.id = r.project_id
           WHERE mbr.job_attempt_id = ? AND mbr.run_id = ?
             AND p.organization_id = ?
             AND mbr.state IN ('dispatched', 'settled')
           ORDER BY mbr.request_ordinal`,
        )
        .all(input.jobAttemptId, input.runId, input.organizationId) as SqliteRow[];
      if (rows.length === 0) {
        return {
          usageCompleteness: "unavailable",
          inputTokens: null,
          outputTokens: null,
          estimatedCostMicros: null,
          responseId: null,
          attempts: [],
        };
      }
      let inputTokens = BigInt(0);
      let outputTokens = BigInt(0);
      let estimatedCostMicros = BigInt(0);
      const attempts = rows.map((row, index) => {
        const settled = row.state === "settled";
        const inputValue = settled
          ? row.actual_input_tokens
          : row.projected_input_tokens;
        const outputValue = settled
          ? row.actual_output_tokens
          : row.projected_output_tokens;
        const costValue = settled
          ? row.actual_cost_micros
          : row.projected_cost_micros;
        const ordinal = Number(row.request_ordinal);
        if (
          ordinal !== index ||
          !isSafeStoredInteger(inputValue) ||
          !isSafeStoredInteger(outputValue) ||
          !isSafeStoredInteger(costValue)
        ) {
          throw new AgentRunDataError();
        }
        inputTokens += BigInt(inputValue);
        outputTokens += BigInt(outputValue);
        estimatedCostMicros += BigInt(costValue);
        return AgentRunAttemptSchema.parse({
          ordinal,
          kind: String(row.attempt_kind) as
            | "initial"
            | "transient-retry"
            | "format-repair",
          transientRetryCount: Number(row.transient_retry_count),
          formatRepair: row.format_repair === 1,
          accounting: settled ? ("settled" as const) : ("projected" as const),
          errorClassification: "unavailable" as const,
        });
      });
      if (
        inputTokens > BigInt(Number.MAX_SAFE_INTEGER) ||
        outputTokens > BigInt(Number.MAX_SAFE_INTEGER) ||
        estimatedCostMicros > BigInt(Number.MAX_SAFE_INTEGER)
      ) {
        throw new AgentRunDataError();
      }
      return {
        usageCompleteness: rows.every((row) => row.state === "settled")
          ? "complete"
          : "partial",
        inputTokens: Number(inputTokens),
        outputTokens: Number(outputTokens),
        estimatedCostMicros: Number(estimatedCostMicros),
        responseId: rows.reduce<string | null>((latest, row) => {
          if (row.response_id === null) return latest;
          const value = String(row.response_id);
          if (value.trim().length === 0 || value.length > 500) {
            throw new AgentRunDataError();
          }
          return value;
        }, null),
        attempts,
      };
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

    const normalizedRun = {
      ...run,
      dataCutoffAt: canonicalizeDateTime(run.dataCutoffAt, "analysisRun.dataCutoffAt"),
    };
    this.#database
      .prepare(
        `INSERT INTO analysis_runs (
           id, project_id, mode, status, created_by, data_cutoff_at,
           idempotency_scope, idempotency_key, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        normalizedRun.id,
        normalizedRun.projectId,
        normalizedRun.mode,
        normalizedRun.status,
        normalizedRun.createdBy,
        normalizedRun.dataCutoffAt,
        normalizedRun.idempotencyScope,
        normalizedRun.idempotencyKey,
        normalizedRun.createdAt,
        normalizedRun.updatedAt,
      );
    this.#database
      .prepare(
        "UPDATE projects SET current_run_id = ?, updated_at = ? WHERE id = ?",
      )
      .run(normalizedRun.id, normalizedRun.updatedAt, normalizedRun.projectId);
    return { run: normalizedRun, created: true };
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

  createDataSnapshotForRun(
    input: CreateDataSnapshotForRunInput,
  ): Promise<CreateDataSnapshotForRunResult> {
    const validated = validateCreateDataSnapshotInput(input);
    const operation = () => this.#createDataSnapshotForRun(validated);
    return this.#transactionContext.getStore()
      ? this.#serialize(operation)
      : this.#serialize(() => this.#withImmediateTransaction(operation));
  }

  revalidateDataSnapshotSubject(
    input: DataSnapshotSubjectInput,
  ): Promise<void> {
    const validated = validateDataSnapshotSubjectInput(input);
    const operation = () => {
      this.#requireDataSnapshotSubject(validated);
    };
    return this.#transactionContext.getStore()
      ? this.#serialize(operation)
      : this.#serialize(() => this.#withImmediateTransaction(operation));
  }

  #createDataSnapshotForRun(
    input: CreateDataSnapshotForRunInput,
  ): CreateDataSnapshotForRunResult {
    const { trustedSubject, storedRunCutoffAt } =
      this.#requireDataSnapshotSubject(input);
    if (
      input.candidate.marketplace !== input.expectedMarketplace ||
      !isDeepStrictEqual(input.candidate.asins, input.expectedAsins) ||
      input.candidate.dataCutoffAt > storedRunCutoffAt
    ) {
      throw new DataSnapshotSubjectNotFoundError();
    }

    try {
      assertVocSnapshotCandidateIntegrity(input.candidate);
    } catch {
      throw new DataSnapshotDataError();
    }
    const runId = String(trustedSubject.run_id);
    const asinsJson = JSON.stringify(input.candidate.asins);
    const existing = this.#database
      .prepare(
        `SELECT * FROM data_snapshots
         WHERE snapshot_kind = 'voc'
           AND run_id = ? AND schema_version = ? AND marketplace = ?
           AND asins_json = ? AND data_cutoff_at = ?`,
      )
      .get(
        runId,
        input.candidate.schemaVersion,
        input.candidate.marketplace,
        asinsJson,
        input.candidate.dataCutoffAt,
      ) as SqliteRow | undefined;
    if (existing) {
      const snapshot = mapDataSnapshot(existing);
      if (snapshot.contentHash !== input.candidate.contentHash) {
        throw new DataSnapshotConflictError();
      }
      return { snapshot, created: false };
    }

    this.#database
      .prepare(
        `INSERT INTO data_snapshots (
           id, run_id, snapshot_kind, schema_version, marketplace, asins_json,
           data_cutoff_at, sources_json, payload_json, content_hash, created_at
         ) VALUES (?, ?, 'voc', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.candidateId,
        runId,
        input.candidate.schemaVersion,
        input.candidate.marketplace,
        asinsJson,
        input.candidate.dataCutoffAt,
        JSON.stringify(input.candidate.sources),
        JSON.stringify(input.candidate.payload),
        input.candidate.contentHash,
        input.createdAt,
      );
    const created = this.#database
      .prepare("SELECT * FROM data_snapshots WHERE id = ? AND snapshot_kind = 'voc'")
      .get(input.candidateId) as SqliteRow | undefined;
    if (!created) throw new DataSnapshotDataError();
    return { snapshot: mapDataSnapshot(created), created: true };
  }

  #requireDataSnapshotSubject(input: DataSnapshotSubjectInput) {
    const trustedSubject = this.#database
      .prepare(
        `SELECT r.id AS run_id, r.project_id, r.data_cutoff_at,
                p.organization_id, p.marketplace, p.asins_json,
                u.id AS actor_id, u.organization_id AS actor_organization_id,
                u.status AS actor_status
         FROM analysis_runs r
         JOIN projects p ON p.id = r.project_id
         JOIN users u ON u.id = ?
         WHERE r.id = ?`,
      )
      .get(input.actorId, input.runId) as SqliteRow | undefined;
    const storedAsins = parseStoredTextList(trustedSubject?.asins_json);
    const storedRunCutoffAt = canonicalStoredDateTime(
      trustedSubject?.data_cutoff_at,
    );
    if (
      !trustedSubject ||
      trustedSubject.actor_id !== input.actorId ||
      trustedSubject.actor_status !== "active" ||
      trustedSubject.actor_organization_id !== input.actorOrganizationId ||
      trustedSubject.organization_id !== input.actorOrganizationId ||
      trustedSubject.project_id !== input.expectedProjectId ||
      trustedSubject.marketplace !== input.expectedMarketplace ||
      !isDeepStrictEqual(storedAsins, input.expectedAsins) ||
      storedRunCutoffAt === null ||
      storedRunCutoffAt !== input.expectedRunCutoffAt
    ) {
      throw new DataSnapshotSubjectNotFoundError();
    }
    return { trustedSubject, storedRunCutoffAt };
  }

  findDataSnapshotById(
    input: FindDataSnapshotByIdInput,
  ): Promise<VocDataSnapshotRecord | null> {
    const actorOrganizationId = EntityIdSchema.parse(input.actorOrganizationId);
    const snapshotId = EntityIdSchema.parse(input.snapshotId);
    return this.#serialize(() => {
      const row = this.#database
        .prepare(
          `SELECT ds.*
           FROM data_snapshots ds
           JOIN analysis_runs r ON r.id = ds.run_id
           JOIN projects p ON p.id = r.project_id
           WHERE ds.id = ? AND ds.snapshot_kind = 'voc'
             AND p.organization_id = ?`,
        )
        .get(snapshotId, actorOrganizationId) as SqliteRow | undefined;
      return row ? mapDataSnapshot(row) : null;
    });
  }

  listDataSnapshotsByRun(
    input: ListDataSnapshotsByRunInput,
  ): Promise<VocDataSnapshotRecord[]> {
    const actorOrganizationId = EntityIdSchema.parse(input.actorOrganizationId);
    const runId = EntityIdSchema.parse(input.runId);
    return this.#serialize(() => {
      const rows = this.#database
        .prepare(
          `SELECT ds.*
           FROM data_snapshots ds
           JOIN analysis_runs r ON r.id = ds.run_id
           JOIN projects p ON p.id = r.project_id
           WHERE ds.run_id = ? AND ds.snapshot_kind = 'voc'
             AND p.organization_id = ?
           ORDER BY ds.created_at, ds.id`,
        )
        .all(runId, actorOrganizationId) as SqliteRow[];
      return rows.map(mapDataSnapshot);
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
      return this.#withImmediateTransaction(() => {
        const freshNow = this.#modelBudgetTransactionNow();
        return this.#reserveModelBudget(input, freshNow);
      });
    });
  }

  #reserveModelBudget(
    input: ReserveModelBudgetInput,
    freshNow: string,
  ): ReserveModelBudgetResult {
    this.#assertModelBudgetExecutionAuthority(
      input.executionAuthority,
      freshNow,
      { runId: input.runId, jobAttemptId: input.jobAttemptId },
    );
    const subject = this.#resolveModelBudgetSubject(input.runId, input.projectId);
    this.#releaseExpiredModelBudgetReservations(freshNow);
    const existing = this.#database
      .prepare(
        `SELECT * FROM model_budget_reservations
         WHERE run_id = ? AND idempotency_key = ?`,
      )
      .get(input.runId, input.idempotencyKey) as SqliteRow | undefined;
    if (existing) {
      const reservation = mapModelBudgetReservation(existing);
      if (!sameReservationParameters(reservation, existing, input)) {
        throw new ModelBudgetReservationConflictError();
      }
      return { reservation, created: false };
    }

    if (input.leaseExpiresAt <= freshNow) {
      throw new TypeError("Model budget reservation lease expired before admission");
    }

    const utcDay = utcDayFromCanonicalTimestamp(freshNow);
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
           dispatched_at, settled_at, released_at, job_attempt_id,
           request_ordinal, attempt_kind, transient_retry_count, format_repair
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?, NULL, NULL, NULL,
                   ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?)`,
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
        input.jobAttemptId ?? null,
        input.requestOrdinal ?? null,
        input.attemptKind ?? null,
        input.transientRetryCount ?? null,
        input.formatRepair === undefined ? null : Number(input.formatRepair),
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
        const freshNow = this.#modelBudgetTransactionNow();
        this.#assertModelBudgetExecutionAuthority(
          input.executionAuthority,
          freshNow,
          { reservationId: input.reservationId },
        );
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
            freshNow,
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
            freshNow,
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
        const freshNow = this.#modelBudgetTransactionNow();
        this.#assertModelBudgetExecutionAuthority(
          input.executionAuthority,
          freshNow,
          { reservationId: input.reservationId },
        );
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
      if (
        input.responseId !== undefined &&
        (typeof input.responseId !== "string" ||
          input.responseId.trim().length === 0 ||
          input.responseId.length > 500)
      ) {
        throw new TypeError("Invalid model response ID");
      }
      return this.#withImmediateTransaction(() => {
        const freshNow = this.#modelBudgetTransactionNow();
        this.#assertModelBudgetExecutionAuthority(
          input.executionAuthority,
          freshNow,
          { reservationId: input.reservationId },
        );
        this.#releaseExpiredModelBudgetReservations(freshNow);
        const result = this.#database
          .prepare(
            `UPDATE model_budget_reservations
             SET state = 'settled', actual_input_tokens = ?,
                 actual_output_tokens = ?, actual_cost_micros = ?,
                 response_id = ?,
                 lease_expires_at = NULL, settled_at = ?, updated_at = ?
             WHERE id = ? AND state IN ('reserved', 'dispatched')`,
          )
          .run(
            input.actual.inputTokens,
            input.actual.outputTokens,
            input.actual.costMicros,
            input.responseId ?? null,
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
          const stored = this.#database
            .prepare(
              "SELECT response_id FROM model_budget_reservations WHERE id = ?",
            )
            .get(input.reservationId) as SqliteRow;
          if (
            sameModelBudgetAmount(current.actual, input.actual) &&
            nullableString(stored.response_id) === (input.responseId ?? null)
          ) {
            return { reservation: current, transitioned: false };
          }
          throw new ModelBudgetReservationConflictError();
        }
        throw new ModelBudgetStateConflictError();
      });
    });
  }

  #assertModelBudgetExecutionAuthority(
    authority: ModelBudgetExecutionAuthority | undefined,
    asOf: string,
    subject: {
      runId?: string;
      jobAttemptId?: string;
      reservationId?: string;
    },
  ) {
    if (authority === undefined) return;
    const active = this.#database
      .prepare(
        `SELECT 1
         FROM agent_runs ar
         JOIN job_attempts ja ON ja.id = ar.job_attempt_id
         JOIN run_stages rs ON rs.id = ja.stage_id
         JOIN analysis_runs r ON r.id = rs.run_id
         JOIN projects p ON p.id = r.project_id
         WHERE ar.id = ? AND ar.job_attempt_id = ?
           AND p.organization_id = ? AND ar.validation_status = 'pending'
           AND ar.execution_claim_token = ?
           AND ar.execution_claim_owner_id = ?
           AND ar.execution_claim_generation = ?
           AND ja.status = 'running' AND ja.leased_by = ?
           AND ja.lease_generation = ? AND ja.lease_expires_at > ?`,
      )
      .get(
        authority.agentRunId,
        authority.jobAttemptId,
        authority.organizationId,
        authority.claimToken,
        authority.leaseOwnerId,
        authority.leaseGeneration,
        authority.leaseOwnerId,
        authority.leaseGeneration,
        asOf,
      );
    if (!active) throw new ModelBudgetExecutionAuthorityLostError();
    if (
      (subject.runId !== undefined &&
        this.#database
          .prepare(
            `SELECT 1 FROM agent_runs
             WHERE id = ? AND run_id = ? AND job_attempt_id = ?`,
          )
          .get(authority.agentRunId, subject.runId, authority.jobAttemptId) ===
          undefined) ||
      (subject.reservationId !== undefined &&
        this.#database
          .prepare(
            `SELECT 1 FROM model_budget_reservations
             WHERE id = ? AND job_attempt_id = ?`,
          )
          .get(subject.reservationId, authority.jobAttemptId) === undefined)
    ) {
      throw new ModelBudgetExecutionAuthorityLostError();
    }
  }

  #modelBudgetTransactionNow() {
    const value = this.#nowProvider();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new TypeError("Invalid SQLite repository clock");
    }
    return new Date(value.getTime()).toISOString();
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

const canonicalEntityIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sha256Pattern = /^[0-9a-f]{64}$/;

function assertCanonicalEntityId(value: string, label: string) {
  if (!canonicalEntityIdPattern.test(value)) {
    throw new TypeError(`Invalid agent run value for ${label}`);
  }
}

function assertNonEmptyAuditString(value: string, label: string) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 500) {
    throw new TypeError(`Invalid agent run value for ${label}`);
  }
}

function validateSkillVersionInput(
  input: RegisterSkillVersionInput,
): RegisterSkillVersionInput {
  assertCanonicalEntityId(input.id, "skillVersionId");
  assertTimestamp(input.createdAt, "skillVersion.createdAt");
  const manifest = SkillManifestSchema.parse(input.manifest);
  if (
    input.skillId !== manifest.id ||
    input.version !== manifest.version ||
    input.contentHash !== manifest.contentHash ||
    !sha256Pattern.test(input.contentHash)
  ) {
    throw new TypeError("Invalid Skill version provenance");
  }
  return { ...input, manifest };
}

function validateBeginAgentRunInput(input: BeginAgentRunInput): BeginAgentRunInput {
  for (const [label, value] of [
    ["id", input.id],
    ["runId", input.runId],
    ["stageId", input.stageId],
    ["jobAttemptId", input.jobAttemptId],
    ["skillVersionId", input.skillVersionId],
  ] as const) {
    assertCanonicalEntityId(value, label);
  }
  assertNonEmptyAuditString(input.organizationId, "organizationId");
  assertNonEmptyAuditString(input.leaseOwnerId, "leaseOwnerId");
  assertNonEmptyAuditString(input.claimToken, "claimToken");
  assertNonEmptyAuditString(input.provider, "provider");
  assertNonEmptyAuditString(input.model, "model");
  if (
    !sha256Pattern.test(input.executionFingerprint) ||
    !sha256Pattern.test(input.outputSchemaDigest) ||
    !sha256Pattern.test(input.inputSummary.contentHash) ||
    !Number.isSafeInteger(input.inputSummary.recordCount) ||
    input.inputSummary.recordCount < 0 ||
    !/^\d+\.\d+\.\d+$/.test(input.outputSchemaVersion) ||
    !Number.isSafeInteger(input.leaseGeneration) ||
    input.leaseGeneration <= 0
  ) {
    throw new TypeError("Invalid agent run audit identity");
  }
  assertDateTime(input.dataCutoffAt, "agentRun.dataCutoffAt");
  assertTimestamp(input.startedAt, "agentRun.startedAt");
  assertTimestamp(input.claimAcquiredAt, "agentRun.claimAcquiredAt");
  assertTimestamp(input.claimExpiresAt, "agentRun.claimExpiresAt");
  if (
    input.claimExpiresAt <= input.claimAcquiredAt ||
    input.claimToken.length > 200
  ) {
    throw new TypeError("Invalid agent run execution claim");
  }
  if (
    input.snapshotIds.length === 0 ||
    new Set(input.snapshotIds).size !== input.snapshotIds.length
  ) {
    throw new TypeError("Invalid agent run snapshot provenance");
  }
  input.snapshotIds.forEach((id) => assertCanonicalEntityId(id, "snapshotId"));
  return {
    ...input,
    snapshotIds: [...input.snapshotIds],
    inputSummary: { ...input.inputSummary },
  };
}

function validateFinalizeAgentRunInput(input: FinalizeAgentRunInput) {
  assertCanonicalEntityId(input.agentRunId, "agentRunId");
  assertNonEmptyAuditString(input.organizationId, "organizationId");
  assertNonEmptyAuditString(input.leaseOwnerId, "leaseOwnerId");
  assertNonEmptyAuditString(input.claimToken, "claimToken");
  assertTimestamp(input.completedAt, "agentRun.completedAt");
  if (!Number.isSafeInteger(input.leaseGeneration) || input.leaseGeneration <= 0) {
    throw new TypeError("Invalid agent run lease generation");
  }
}

function validateAssertAgentRunClaimInput(input: AssertAgentRunClaimInput) {
  assertCanonicalEntityId(input.agentRunId, "agentRunId");
  assertCanonicalEntityId(input.jobAttemptId, "jobAttemptId");
  assertNonEmptyAuditString(input.organizationId, "organizationId");
  assertNonEmptyAuditString(input.leaseOwnerId, "leaseOwnerId");
  assertNonEmptyAuditString(input.claimToken, "claimToken");
  assertTimestamp(input.asOf, "agentRun.claimAsOf");
  if (!Number.isSafeInteger(input.leaseGeneration) || input.leaseGeneration <= 0) {
    throw new TypeError("Invalid agent run lease generation");
  }
}

function validateListAgentRunsInput(input: ListAgentRunsInput) {
  assertCanonicalEntityId(input.runId, "runId");
  assertNonEmptyAuditString(input.organizationId, "organizationId");
}

function validateJobAttemptModelUsageInput(input: JobAttemptModelUsageInput) {
  validateListAgentRunsInput(input);
  assertCanonicalEntityId(input.jobAttemptId, "jobAttemptId");
}

function mapSkillVersion(row: SqliteRow): SkillVersionRecord {
  try {
    const manifest = SkillManifestSchema.parse(JSON.parse(String(row.manifest_json)));
    return validateSkillVersionInput({
      id: String(row.id),
      skillId: String(row.skill_id),
      version: String(row.version),
      contentHash: String(row.content_hash),
      manifest,
      createdAt: String(row.created_at),
    });
  } catch (error) {
    if (error instanceof SkillVersionConflictError) throw error;
    throw new AgentRunDataError();
  }
}

function sameSkillVersion(
  stored: SkillVersionRecord,
  input: RegisterSkillVersionInput,
) {
  return (
    stored.skillId === input.skillId &&
    stored.version === input.version &&
    stored.contentHash === input.contentHash &&
    isDeepStrictEqual(stored.manifest, input.manifest)
  );
}

function mapAgentRun(database: DatabaseSync, row: SqliteRow): AgentRunAudit {
  try {
    const snapshotIds = JSON.parse(String(row.snapshot_ids_json)) as unknown;
    const links = database
      .prepare(
        `SELECT snapshot_id FROM agent_run_snapshots
         WHERE agent_run_id = ? ORDER BY ordinal`,
      )
      .all(String(row.id)) as SqliteRow[];
    const linkedSnapshotIds = links.map((link) => String(link.snapshot_id));
    if (!isDeepStrictEqual(snapshotIds, linkedSnapshotIds)) {
      throw new AgentRunDataError();
    }
    const model =
      row.response_id === null
        ? { provider: String(row.provider), model: String(row.model) }
        : {
            provider: String(row.provider),
            model: String(row.model),
            responseId: String(row.response_id),
          };
    const record = AgentRunAuditSchema.parse({
      schemaVersion: String(row.schema_version),
      id: String(row.id),
      runId: String(row.run_id),
      stageId: String(row.stage_id),
      jobAttemptId: String(row.job_attempt_id),
      executionFingerprint: String(row.execution_fingerprint),
      outputSchemaDigest: String(row.output_schema_digest),
      stage: String(row.stage),
      status: row.validation_status === "pending" ? "running" : String(row.terminal_status),
      skill: {
        id: String(row.skill_id),
        version: String(row.skill_version),
        contentHash: String(row.skill_content_hash),
      },
      snapshotIds,
      model,
      inputSummary: JSON.parse(String(row.input_summary_json)),
      outputSchemaVersion: String(row.output_schema_version),
      output: row.output_json === null ? null : JSON.parse(String(row.output_json)),
      validationStatus: String(row.validation_status),
      error: row.error_json === null ? null : JSON.parse(String(row.error_json)),
      dataCutoffAt: String(row.data_cutoff_at),
      inputTokens: nullableStoredInteger(row.input_tokens),
      outputTokens: nullableStoredInteger(row.output_tokens),
      estimatedCostMicros: nullableStoredInteger(row.estimated_cost_micros),
      durationMs: nullableStoredInteger(row.duration_ms),
      attemptCount: nullableStoredInteger(row.attempt_count),
      usageCompleteness:
        row.usage_completeness === null ? null : String(row.usage_completeness),
      attempts: JSON.parse(String(row.attempts_json)),
      terminalMetadata:
        row.terminal_metadata_json === null
          ? null
          : JSON.parse(String(row.terminal_metadata_json)),
      startedAt: String(row.started_at),
      completedAt: row.completed_at === null ? null : String(row.completed_at),
    });
    return record;
  } catch (error) {
    if (error instanceof AgentRunDataError) throw error;
    throw new AgentRunDataError();
  }
}

function sameAgentRunBeginIdentity(
  record: AgentRunAudit,
  input: BeginAgentRunInput,
  storedSkillVersionId: string,
) {
  return (
    record.runId === input.runId &&
    record.stageId === input.stageId &&
    record.jobAttemptId === input.jobAttemptId &&
    storedSkillVersionId === input.skillVersionId &&
    record.executionFingerprint === input.executionFingerprint &&
    record.outputSchemaDigest === input.outputSchemaDigest &&
    isDeepStrictEqual(record.snapshotIds, input.snapshotIds) &&
    record.model.provider === input.provider &&
    record.model.model === input.model &&
    isDeepStrictEqual(record.inputSummary, input.inputSummary) &&
    record.outputSchemaVersion === input.outputSchemaVersion &&
    sameDateTimeInstant(record.dataCutoffAt, input.dataCutoffAt)
  );
}

function finalizedAgentRun(
  current: AgentRunAudit,
  input: FinalizeAgentRunInput,
): AgentRunAudit {
  const outcome = input.outcome;
  return AgentRunAuditSchema.parse({
    ...current,
    status: outcome.terminalStatus,
    model:
      outcome.responseId === null
        ? { provider: current.model.provider, model: current.model.model }
        : {
            provider: current.model.provider,
            model: current.model.model,
            responseId: outcome.responseId,
          },
    output: outcome.output,
    validationStatus: outcome.validationStatus,
    error: outcome.error,
    inputTokens: outcome.inputTokens,
    outputTokens: outcome.outputTokens,
    estimatedCostMicros: outcome.estimatedCostMicros,
    durationMs: outcome.durationMs,
    attemptCount: outcome.attemptCount,
    usageCompleteness: outcome.usageCompleteness,
    attempts: outcome.attempts.map((attempt) => ({ ...attempt })),
    terminalMetadata: { ...outcome.terminalMetadata },
    completedAt: input.completedAt,
  });
}

function nullableStoredInteger(value: SqliteRow[string]): number | null {
  if (value === null) return null;
  if (!isSafeStoredInteger(value)) throw new AgentRunDataError();
  return value;
}

function isSafeStoredInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function sumNullableSafeIntegers(
  values: readonly (number | null)[],
): number | null {
  if (values.length === 0 || values.some((value) => value === null)) return null;
  let sum = BigInt(0);
  for (const value of values) {
    if (!isSafeStoredInteger(value)) throw new AgentRunDataError();
    sum += BigInt(value);
  }
  if (sum > BigInt(Number.MAX_SAFE_INTEGER)) throw new AgentRunDataError();
  return Number(sum);
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
  assertModelBudgetExecutionAuthority(input.executionAuthority);
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
  assertModelBudgetAttemptProvenance(input);
  assertModelBudgetExecutionAuthority(
    input.executionAuthority,
    input.jobAttemptId,
  );
}

function assertModelBudgetExecutionAuthority(
  authority: ModelBudgetExecutionAuthority | undefined,
  jobAttemptId?: string,
) {
  if (authority === undefined) return;
  assertCanonicalEntityId(authority.agentRunId, "budgetAuthority.agentRunId");
  assertCanonicalEntityId(authority.jobAttemptId, "budgetAuthority.jobAttemptId");
  assertNonEmptyAuditString(authority.organizationId, "budgetAuthority.organizationId");
  assertNonEmptyAuditString(authority.leaseOwnerId, "budgetAuthority.leaseOwnerId");
  assertNonEmptyAuditString(authority.claimToken, "budgetAuthority.claimToken");
  if (
    !Number.isSafeInteger(authority.leaseGeneration) ||
    authority.leaseGeneration <= 0 ||
    authority.claimToken.length > 200 ||
    (jobAttemptId !== undefined && authority.jobAttemptId !== jobAttemptId)
  ) {
    throw new TypeError("Invalid model budget execution authority");
  }
}

function assertDateTime(value: string, label: string) {
  if (!DateTimeSchema.safeParse(value).success) {
    throw new TypeError(`Invalid DateTime for ${label}`);
  }
}

function canonicalizeDateTime(value: string, label: string) {
  assertDateTime(value, label);
  return new Date(value).toISOString();
}

function sameDateTimeInstant(left: string, right: string) {
  return (
    DateTimeSchema.safeParse(left).success &&
    DateTimeSchema.safeParse(right).success &&
    new Date(left).getTime() === new Date(right).getTime()
  );
}

function assertModelBudgetAttemptProvenance(input: ReserveModelBudgetInput) {
  const values = [
    input.jobAttemptId,
    input.requestOrdinal,
    input.attemptKind,
    input.transientRetryCount,
    input.formatRepair,
  ];
  if (values.every((value) => value === undefined)) return;
  if (values.some((value) => value === undefined)) {
    throw new TypeError("Incomplete model request attempt provenance");
  }
  if (!canonicalEntityIdPattern.test(input.jobAttemptId as string)) {
    throw new TypeError("Invalid model request job attempt ID");
  }
  const ordinal = input.requestOrdinal as number;
  const transientRetryCount = input.transientRetryCount as number;
  const attemptKind = input.attemptKind;
  const formatRepair = input.formatRepair;
  if (
    !Number.isSafeInteger(ordinal) ||
    ordinal < 0 ||
    ordinal > 3 ||
    !Number.isSafeInteger(transientRetryCount) ||
    transientRetryCount < 0 ||
    transientRetryCount > 2 ||
    typeof formatRepair !== "boolean"
  ) {
    throw new TypeError("Invalid model request attempt identity");
  }
  const identityIsConsistent =
    (attemptKind === "initial" &&
      ordinal === 0 &&
      transientRetryCount === 0 &&
      !formatRepair) ||
    (attemptKind === "format-repair" && formatRepair) ||
    (attemptKind === "transient-retry" && transientRetryCount > 0);
  if (!identityIsConsistent) {
    throw new TypeError("Invalid model request attempt identity");
  }
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
  row: SqliteRow,
  input: ReserveModelBudgetInput,
) {
  return (
    reservation.runId === input.runId &&
    reservation.projectId === input.projectId &&
    reservation.requestFingerprint === input.requestFingerprint &&
    reservation.projected.inputTokens === input.projected.inputTokens &&
    reservation.projected.outputTokens === input.projected.outputTokens &&
    reservation.projected.costMicros === input.projected.costMicros &&
    nullableString(row.job_attempt_id) === (input.jobAttemptId ?? null) &&
    nullableNumber(row.request_ordinal) === (input.requestOrdinal ?? null) &&
    nullableString(row.attempt_kind) === (input.attemptKind ?? null) &&
    nullableNumber(row.transient_retry_count) ===
      (input.transientRetryCount ?? null) &&
    nullableBooleanInteger(row.format_repair) === (input.formatRepair ?? null)
  );
}

function nullableString(value: SqliteRow[string]) {
  return value === null ? null : String(value);
}

function nullableNumber(value: SqliteRow[string]) {
  return value === null ? null : Number(value);
}

function nullableBooleanInteger(value: SqliteRow[string]) {
  return value === null ? null : value === 1;
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
  } catch {
    throw new ModelBudgetDataError();
  }
  return reservation;
}

function validateCreateDataSnapshotInput(
  input: CreateDataSnapshotForRunInput,
): CreateDataSnapshotForRunInput {
  return {
    ...validateDataSnapshotSubjectInput(input),
    candidateId: EntityIdSchema.parse(input.candidateId),
    createdAt: canonicalizeDateTime(input.createdAt, "snapshot.createdAt"),
    candidate: canonicalizeVocSnapshotCandidate(input.candidate),
  };
}

function validateDataSnapshotSubjectInput(
  input: DataSnapshotSubjectInput,
): DataSnapshotSubjectInput {
  const expectedAsins = input.expectedAsins.map((asin) => AsinSchema.parse(asin));
  if (
    expectedAsins.length < 3 ||
    expectedAsins.length > 10 ||
    new Set(expectedAsins).size !== expectedAsins.length
  ) {
    throw new TypeError("Invalid expected VOC snapshot ASIN identity");
  }
  return {
    actorId: EntityIdSchema.parse(input.actorId),
    actorOrganizationId: EntityIdSchema.parse(input.actorOrganizationId),
    runId: EntityIdSchema.parse(input.runId),
    expectedProjectId: EntityIdSchema.parse(input.expectedProjectId),
    expectedMarketplace: MarketplaceSchema.parse(input.expectedMarketplace),
    expectedAsins,
    expectedRunCutoffAt: canonicalizeDateTime(
      input.expectedRunCutoffAt,
      "snapshot.expectedRunCutoffAt",
    ),
  };
}

function mapDataSnapshot(row: SqliteRow): VocDataSnapshotRecord {
  try {
    const record = VocDataSnapshotRecordSchema.parse({
      schemaVersion: String(row.schema_version),
      id: String(row.id),
      runId: String(row.run_id),
      marketplace: String(row.marketplace),
      asins: JSON.parse(String(row.asins_json)),
      dataCutoffAt: String(row.data_cutoff_at),
      sources: JSON.parse(String(row.sources_json)),
      contentHash: String(row.content_hash),
      createdAt: String(row.created_at),
      payload: JSON.parse(String(row.payload_json)),
    });
    assertVocDataSnapshotRecordIntegrity(record);
    return deepFreeze(record);
  } catch {
    throw new DataSnapshotDataError();
  }
}

function parseStoredTextList(value: SqliteRow[string] | undefined) {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string")
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function canonicalStoredDateTime(value: SqliteRow[string] | undefined) {
  if (typeof value !== "string" || !DateTimeSchema.safeParse(value).success) {
    return null;
  }
  return new Date(value).toISOString();
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
