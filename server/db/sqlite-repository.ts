import { AsyncLocalStorage } from "node:async_hooks";
import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";

import {
  AgentRunAttemptSchema,
  AgentRunAuditSchema,
  AgentRunTerminalMetadataSchema,
  AnalysisReportSchema,
  AsinSchema,
  DateTimeSchema,
  EntityIdSchema,
  MarketplaceSchema,
  ModelProvenanceSchema,
  Sha256Schema,
  SkillProvenanceSchema,
  UserSchema,
  type AgentRunAudit,
  type AgentRunTerminalMetadata,
  type AnalysisReport,
} from "../../shared/agent-contracts";
import {
  VocDataSnapshotRecordSchema,
  assertVocDataSnapshotRecordIntegrity,
  assertVocSnapshotCandidateIntegrity,
  canonicalizeVocSnapshotCandidate,
  deepFreeze,
  type VocDataSnapshotRecord,
} from "../data/voc-data-snapshot";
import {
  TrafficDataSnapshotRecordSchema,
  TrafficSnapshotCandidateSchema,
  type TrafficDataSnapshotRecord,
} from "../data/traffic-data-snapshot";
import {
  KeywordAnalysisSnapshotCandidateSchema,
  KeywordAnalysisSnapshotRecordSchema,
  type KeywordAnalysisSnapshotRecord,
} from "../data/keyword-analysis-snapshot";
import { SkillManifestSchema } from "../skills/manifest";
import { preprocessVocSnapshot } from "../domain/voc/preprocess-voc-snapshot";
import {
  VocPositioningOutputShapeSchema,
  createVocPositioningOutputSchema,
  type VocPositioningOutput,
} from "../domain/voc/voc-positioning-contracts";
import {
  TrafficAnalysisOutputSchema,
  assertTrafficCapabilityLanguage,
  canonicalizeTrafficAnalysisOutput,
  type TrafficAnalysisOutput,
} from "../domain/traffic/traffic-analysis-contracts";
import {
  ProductDefinitionOutputShapeSchema,
  assertProductDefinitionCapabilityLanguage,
  buildProductDefinitionInput,
  createProductDefinitionOutputSchema,
  type ProductDefinitionOutput,
} from "../domain/product/product-definition-contracts";
import {
  AnalysisAgentModuleModeEventSchema,
  AnalysisAgentEvaluationControlSubjectNotFoundError,
  createAnalysisAgentHumanRating,
  createAnalysisAgentModuleModeEvent,
  type AnalysisAgentEvaluationControlRepository,
  type AnalysisAgentHumanRating,
  type AnalysisAgentModule,
  type AnalysisAgentModuleModeEvent,
} from "../evaluation/analysis-agent-human-review";
import {
  AnalysisAgentReleaseDecisionNotApprovedError,
  AnalysisAgentReleaseEvidenceNotFoundError,
  createAnalysisAgentReleaseDecision,
  createAnalysisAgentReleaseSubmission,
  evaluateAnalysisAgentReleaseEvidence,
  type AnalysisAgentReleaseDecision,
  type AnalysisAgentReleaseDecisionRepository,
  type AnalysisAgentReleaseSubmission,
} from "../evaluation/analysis-agent-release-gate";
import { BudgetExceededError, type BudgetScope } from "../runtime/budget-policy";
import {
  AnalysisReportConflictError,
  AnalysisReportDataError,
  AnalysisReportLeaseLostError,
  AnalysisReportSubjectNotFoundError,
  type AnalysisReportRepository,
  type FindAnalysisReportByIdInput,
  type ListAnalysisReportsInput,
  type PublishVocPositioningReportInput,
  type PublishVocPositioningReportResult,
  type PublishTrafficAnalysisReportInput,
  type PublishTrafficAnalysisReportResult,
  type PublishProductDefinitionReportInput,
  type PublishProductDefinitionReportResult,
} from "./analysis-report-repository";
import {
  DataSnapshotConflictError,
  DataSnapshotCutoffConflictError,
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
  TrafficDataSnapshotConflictError,
  TrafficDataSnapshotDataError,
  type CreateTrafficDataSnapshotForRunInput,
  type TrafficDataSnapshotRepository,
} from "./traffic-data-snapshot-repository";
import {
  KeywordAnalysisSnapshotConflictError,
  KeywordAnalysisSnapshotDataError,
  type CreateKeywordAnalysisSnapshotForRunInput,
  type KeywordAnalysisSnapshotRepository,
} from "./keyword-analysis-snapshot-repository";
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
import {
  ConnectorCredentialAuthorizationError,
  ConnectorCredentialConflictError,
  JobLeaseLostError,
} from "./repository";
import type {
  AgentRepository,
  ActiveSessionPrincipalRecord,
  AnalysisRunRecord,
  AuthenticationUserRecord,
  CancelAnalysisRunInput,
  ClaimJobInput,
  CompleteJobInput,
  ConnectorStatusError,
  ConnectorStatusRecord,
  ConnectorStatusRepository,
  ConnectorCredentialRecord,
  ConnectorCredentialRepository,
  CreateUserFeedbackInput,
  CreateLocalUserResult,
  CreateAnalysisRunResult,
  CreateProjectInput,
  EnqueueJobInput,
  FailJobInput,
  FeedbackAttachmentMetadata,
  FeedbackAttachmentRecord,
  FeedbackAttachmentWrite,
  FeedbackDetailRecord,
  FeedbackListRecord,
  FeedbackStatus,
  FeedbackStatusEventRecord,
  JobAttemptRecord,
  InitialAdminInput,
  LocalUserInput,
  ProjectRecord,
  RevokeConnectorCredentialInput,
  RevokeConnectorCredentialResult,
  ReleaseJobLeaseInput,
  RenewJobLeaseInput,
  RetryFailedRunStageInput,
  RetryFailedRunStageResult,
  ResumeWaitingInputRunStageInput,
  ResumeWaitingInputRunStageResult,
  RunStageRecord,
  RotateConnectorCredentialInput,
  SessionRecord,
  UserRecord,
  UserFeedbackRecord,
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

export function registerVocSnapshotIntegrityFunction(database: DatabaseSync) {
  database.function(
    "voc_snapshot_integrity",
    { deterministic: true },
    (
      schemaVersion,
      marketplace,
      asinsJson,
      dataCutoffAt,
      sourcesJson,
      payloadJson,
      contentHash,
    ) => {
      if (
        schemaVersion !== "1.0.0" ||
        typeof marketplace !== "string" ||
        typeof asinsJson !== "string" ||
        typeof dataCutoffAt !== "string" ||
        typeof sourcesJson !== "string" ||
        typeof payloadJson !== "string" ||
        typeof contentHash !== "string"
      ) {
        return 0;
      }
      try {
        assertVocSnapshotCandidateIntegrity({
          schemaVersion,
          marketplace,
          asins: JSON.parse(asinsJson),
          dataCutoffAt,
          sources: JSON.parse(sourcesJson),
          payload: JSON.parse(payloadJson),
          contentHash,
        });
        return 1;
      } catch {
        return 0;
      }
    },
  );
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

type SqliteRow = Record<string, string | number | bigint | Uint8Array | null>;

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
const analysisReportSelect = `
  SELECT report.*, sv.skill_id, sv.version AS skill_version,
         sv.content_hash AS skill_content_hash,
         ar.provider, ar.model, ar.response_id,
         p.organization_id AS organization_id
  FROM analysis_reports report
  JOIN agent_runs ar ON ar.id = report.agent_run_id
  JOIN skill_versions sv ON sv.id = ar.skill_version_id
  JOIN analysis_runs r ON r.id = report.run_id
  JOIN projects p ON p.id = r.project_id`;
const userFeedbackListSelect = `
  SELECT feedback.*, workflow.status, workflow.version AS workflow_version,
         workflow.admin_seen_at,
         (SELECT COUNT(*) FROM user_feedback_attachments attachment
           WHERE attachment.feedback_id = feedback.id
             AND attachment.organization_id = feedback.organization_id) AS attachment_count
    FROM user_feedback feedback
    JOIN user_feedback_workflow workflow
      ON workflow.feedback_id = feedback.id
     AND workflow.organization_id = feedback.organization_id`;

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
    ConnectorStatusRepository,
    ConnectorCredentialRepository,
    ModelBudgetLedgerRepository,
    AgentRunRepository,
    DataSnapshotRepository,
    TrafficDataSnapshotRepository,
    KeywordAnalysisSnapshotRepository,
    AnalysisReportRepository,
    AnalysisAgentEvaluationControlRepository,
    AnalysisAgentReleaseDecisionRepository
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
      registerVocSnapshotIntegrityFunction(this.#database);
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
                    ja.logical_execution_cycle_id,
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
        if (
          validated.logicalExecutionLineage &&
          subject.logical_execution_cycle_id !==
            validated.logicalExecutionCycleId
        ) {
          throw new AgentRunConflictError();
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

        if (validated.logicalExecutionLineage) {
          const predecessor = this.#database
            .prepare(
              `${agentRunSelect}
               WHERE ar.stage_id = ?
                 AND ar.logical_execution_cycle_id = ?
                 AND ar.schema_version = '1.1.0'
                 AND ar.execution_fingerprint IS NOT NULL
                 AND ar.output_schema_digest IS NOT NULL`,
            )
            .get(
              validated.stageId,
              validated.logicalExecutionCycleId!,
            ) as SqliteRow | undefined;
          if (predecessor) {
            const record = mapAgentRun(this.#database, predecessor);
            if (
              !sameAgentRunLogicalIdentity(
                record,
                validated,
                String(predecessor.skill_version_id),
                nullableString(predecessor.logical_execution_lineage),
                nullableString(predecessor.logical_execution_cycle_id),
              )
            ) {
              throw new AgentRunConflictError();
            }
            if (record.jobAttemptId !== validated.jobAttemptId) {
              if (record.validationStatus === "pending") {
                return this.#recoverPendingAgentRun(
                  predecessor,
                  record,
                  validated,
                );
              }
              if (
                record.validationStatus !== "passed" ||
                record.status !== "succeeded"
              ) {
                throw new AgentRunConflictError();
              }
              return { record, created: false, claimStatus: "terminal" };
            }
          }
          if (!predecessor) {
            const lineageOwner = this.#database
              .prepare(
                `SELECT id FROM agent_runs
                 WHERE logical_execution_lineage = ?`,
              )
              .get(validated.logicalExecutionLineage) as
              | SqliteRow
              | undefined;
            if (lineageOwner) throw new AgentRunConflictError();
          }
        }

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
              nullableString(existing.logical_execution_lineage),
              nullableString(existing.logical_execution_cycle_id),
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
               logical_execution_lineage, logical_execution_cycle_id,
               active_job_attempt_id,
               terminal_status, usage_completeness, attempt_count, attempts_json,
               execution_claim_token, execution_claim_owner_id,
               execution_claim_generation, execution_claim_acquired_at,
               execution_claim_expires_at
             ) VALUES (
               ?, ?, ?, ?, ?, '1.1.0', ?, ?, ?, NULL, ?, ?, NULL,
               'pending', NULL, NULL, NULL, NULL, NULL, ?, ?, NULL,
               ?, ?, ?, ?, ?, NULL, NULL, NULL, '[]', ?, ?, ?, ?, ?
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
            validated.logicalExecutionLineage ?? null,
            validated.logicalExecutionCycleId ?? null,
            validated.logicalExecutionLineage
              ? validated.jobAttemptId
              : null,
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

  #recoverPendingAgentRun(
    predecessor: SqliteRow,
    record: AgentRunAudit,
    validated: BeginAgentRunInput,
  ): BeginAgentRunResult {
    const activeJobAttemptId = nullableString(
      predecessor.active_job_attempt_id,
    );
    const storedClaimToken = String(predecessor.execution_claim_token);
    if (
      activeJobAttemptId === validated.jobAttemptId &&
      storedClaimToken === validated.claimToken
    ) {
      return { record, created: false, claimStatus: "acquired" };
    }
    if (
      activeJobAttemptId === validated.jobAttemptId &&
      predecessor.execution_claim_owner_id === validated.leaseOwnerId &&
      Number(predecessor.execution_claim_generation) ===
        validated.leaseGeneration
    ) {
      return { record, created: false, claimStatus: "observing" };
    }
    const rotated = this.#database
      .prepare(
        `UPDATE agent_runs
         SET active_job_attempt_id = ?, execution_claim_token = ?,
             execution_claim_owner_id = ?, execution_claim_generation = ?,
             execution_claim_acquired_at = ?, execution_claim_expires_at = ?
         WHERE id = ? AND validation_status = 'pending'
           AND execution_claim_token = ?`,
      )
      .run(
        validated.jobAttemptId,
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

  async assertAgentRunClaim(input: AssertAgentRunClaimInput): Promise<void> {
    validateAssertAgentRunClaimInput(input);
    return this.#serialize(() => {
      const row = this.#database
        .prepare(
          `SELECT ar.validation_status, ar.execution_claim_token,
                  ja.status, ja.leased_by, ja.lease_generation, ja.lease_expires_at
           FROM agent_runs ar
           JOIN job_attempts ja
             ON ja.id = COALESCE(ar.active_job_attempt_id, ar.job_attempt_id)
           JOIN run_stages rs ON rs.id = ja.stage_id
           JOIN analysis_runs r ON r.id = rs.run_id
           JOIN projects p ON p.id = r.project_id
           WHERE ar.id = ?
             AND COALESCE(ar.active_job_attempt_id, ar.job_attempt_id) = ?
             AND p.organization_id = ?`,
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
                 WHERE ja.id = COALESCE(
                   agent_runs.active_job_attempt_id,
                   agent_runs.job_attempt_id
                 )
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

  async publishVocPositioningReport(
    input: PublishVocPositioningReportInput,
  ): Promise<PublishVocPositioningReportResult> {
    const validated = validatePublishVocPositioningReportInput(input);
    return this.#agentRunTransaction(() => {
      const transactionNow = this.#transactionNow();
      const subject = this.#database
        .prepare(
          `SELECT u.organization_id AS actor_organization_id,
                  u.status AS actor_status,
                  p.organization_id AS project_organization_id,
                  p.marketplace, p.asins_json, r.project_id,
                  r.data_cutoff_at AS run_data_cutoff_at,
                  rs.run_id AS stage_run_id, rs.stage,
                  ja.stage_id AS job_stage_id, ja.status AS job_status,
                  ja.leased_by, ja.lease_generation, ja.lease_expires_at,
                  ja.logical_execution_cycle_id AS job_logical_execution_cycle_id,
                  ar.run_id AS agent_run_run_id,
                  ar.stage_id AS agent_run_stage_id,
                  ar.job_attempt_id AS agent_run_job_attempt_id,
                  ar.snapshot_ids_json, ar.provider, ar.model, ar.response_id,
                  ar.output_schema_version, ar.output_json,
                  ar.validation_status, ar.terminal_status,
                  ar.logical_execution_lineage,
                  ar.logical_execution_cycle_id,
                  ar.execution_claim_token, ar.execution_claim_owner_id,
                  ar.execution_claim_generation,
                  sv.skill_id, sv.version AS skill_version,
                  sv.content_hash AS skill_content_hash
           FROM users u
           JOIN projects p ON p.id = ?
           JOIN analysis_runs r ON r.id = ?
           JOIN run_stages rs ON rs.id = ?
           JOIN job_attempts ja ON ja.id = ?
           JOIN agent_runs ar ON ar.id = ?
           JOIN skill_versions sv ON sv.id = ar.skill_version_id
           WHERE u.id = ?`,
        )
        .get(
          validated.expectedProjectId,
          validated.runId,
          validated.stageId,
          validated.jobAttemptId,
          validated.agentRunId,
          validated.actorId,
        ) as SqliteRow | undefined;
      if (!subject) throw new AnalysisReportSubjectNotFoundError();
      if (
        subject.actor_status !== "active" ||
        subject.actor_organization_id !== validated.actorOrganizationId ||
        subject.project_organization_id !== validated.actorOrganizationId ||
        subject.project_id !== validated.expectedProjectId ||
        subject.stage_run_id !== validated.runId ||
        subject.stage !== "voc-positioning" ||
        subject.job_stage_id !== validated.stageId ||
        subject.agent_run_run_id !== validated.runId ||
        subject.agent_run_stage_id !== validated.stageId
      ) {
        throw new AnalysisReportSubjectNotFoundError();
      }
      if (
        subject.job_status !== "running" ||
        subject.leased_by !== validated.leaseOwnerId ||
        Number(subject.lease_generation) !== validated.leaseGeneration ||
        typeof subject.lease_expires_at !== "string" ||
        subject.lease_expires_at <= transactionNow
      ) {
        throw new AnalysisReportLeaseLostError();
      }
      if (
        subject.validation_status !== "passed" ||
        subject.terminal_status !== "succeeded" ||
        subject.logical_execution_lineage !== validated.logicalExecutionLineage ||
        subject.logical_execution_cycle_id !==
          subject.job_logical_execution_cycle_id ||
        subject.output_schema_version !== "1.0.0" ||
        subject.output_json === null
      ) {
        throw new AnalysisReportConflictError();
      }

      const storedSkill = SkillProvenanceSchema.parse({
        id: String(subject.skill_id),
        version: String(subject.skill_version),
        contentHash: String(subject.skill_content_hash),
      });
      const storedModel = ModelProvenanceSchema.parse({
        provider: String(subject.provider),
        model: String(subject.model),
        ...(subject.response_id === null
          ? {}
          : { responseId: String(subject.response_id) }),
      });
      if (
        !isDeepStrictEqual(storedSkill, validated.skill) ||
        !isDeepStrictEqual(storedModel, validated.model)
      ) {
        throw new AnalysisReportConflictError();
      }
      let storedSnapshotIds: unknown;
      let storedOutput: unknown;
      try {
        storedSnapshotIds = JSON.parse(String(subject.snapshot_ids_json));
        storedOutput = JSON.parse(String(subject.output_json));
      } catch {
        throw new AnalysisReportDataError();
      }
      if (
        !isDeepStrictEqual(storedSnapshotIds, [validated.snapshotId]) ||
        !isDeepStrictEqual(storedOutput, validated.result)
      ) {
        throw new AnalysisReportConflictError();
      }

      const snapshotRow = this.#database
        .prepare(
          `SELECT ds.* FROM data_snapshots ds
           WHERE ds.id = ? AND ds.run_id = ? AND ds.snapshot_kind = 'voc'`,
        )
        .get(validated.snapshotId, validated.runId) as SqliteRow | undefined;
      if (!snapshotRow) throw new AnalysisReportSubjectNotFoundError();
      const snapshot = mapDataSnapshot(snapshotRow);
      const facts = preprocessVocSnapshot(snapshot);
      if (
        facts.factsDigest !== validated.factsDigest ||
        facts.snapshot.contentHash !== validated.result.identity.contentHash ||
        !sameDateTimeInstant(
          String(subject.run_data_cutoff_at),
          validated.result.identity.dataCutoffAt,
        ) ||
        subject.marketplace !== facts.snapshot.marketplace ||
        !isDeepStrictEqual(parseStoredTextList(subject.asins_json), facts.snapshot.asins)
      ) {
        throw new AnalysisReportConflictError();
      }
      const result = createVocPositioningOutputSchema(facts).safeParse(
        validated.result,
      );
      if (!result.success) throw new AnalysisReportConflictError();

      const existingRow = this.#database
        .prepare(`${analysisReportSelect} WHERE report.agent_run_id = ?`)
        .get(validated.agentRunId) as SqliteRow | undefined;
      if (existingRow) {
        const existing = mapAnalysisReport(existingRow);
        if (
          samePublishedReport(existing as AnalysisReport<VocPositioningOutput>, {
            ...validated,
            result: result.data,
            skill: storedSkill,
            model: storedModel,
          })
        ) {
          this.#reconcileProductDefinitionStage(validated.runId, validated.publishedAt);
          return { report: existing as Readonly<AnalysisReport<VocPositioningOutput>>, created: false };
        }
        throw new AnalysisReportConflictError();
      }

      const nextVersionRow = this.#database
        .prepare(
          `SELECT COALESCE(MAX(version), 0) + 1 AS version
           FROM analysis_reports WHERE run_id = ? AND stage = 'voc-positioning'`,
        )
        .get(validated.runId) as SqliteRow;
      const version = Number(nextVersionRow.version);
      if (!Number.isSafeInteger(version) || version <= 0) {
        throw new AnalysisReportDataError();
      }
      const evidence = analysisReportEvidence(result.data, facts);
      this.#database
        .prepare(
          `INSERT INTO analysis_reports
           (id, run_id, agent_run_id, version, stage, schema_version, status,
            snapshot_ids_json, evidence_json, result_json, data_cutoff_at,
            created_at)
           VALUES (?, ?, ?, ?, 'voc-positioning', '1.0.0', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          validated.id,
          validated.runId,
          validated.agentRunId,
          version,
          result.data.status,
          JSON.stringify([validated.snapshotId]),
          JSON.stringify(evidence),
          JSON.stringify(result.data),
          result.data.identity.dataCutoffAt,
          validated.publishedAt,
        );
      const createdRow = this.#database
        .prepare(`${analysisReportSelect} WHERE report.id = ?`)
        .get(validated.id) as SqliteRow | undefined;
      if (!createdRow) throw new AnalysisReportDataError();
      this.#reconcileProductDefinitionStage(validated.runId, validated.publishedAt);
      return { report: mapAnalysisReport(createdRow) as Readonly<AnalysisReport<VocPositioningOutput>>, created: true };
    });
  }

  async publishTrafficAnalysisReport(
    input: PublishTrafficAnalysisReportInput,
  ): Promise<PublishTrafficAnalysisReportResult> {
    const validated = validatePublishTrafficAnalysisReportInput(input);
    return this.#agentRunTransaction(() => {
      const transactionNow = this.#transactionNow();
      const subject = this.#database
        .prepare(
          `SELECT u.organization_id AS actor_organization_id, u.status AS actor_status,
                  p.organization_id AS project_organization_id, r.project_id,
                  r.data_cutoff_at AS run_data_cutoff_at, rs.run_id AS stage_run_id,
                  rs.stage, ja.stage_id AS job_stage_id, ja.status AS job_status,
                  ja.leased_by, ja.lease_generation, ja.lease_expires_at,
                  ja.logical_execution_cycle_id AS job_logical_execution_cycle_id,
                  ar.run_id AS agent_run_run_id, ar.stage_id AS agent_run_stage_id,
                  ar.snapshot_ids_json, ar.provider, ar.model, ar.response_id,
                  ar.output_schema_version, ar.output_json, ar.validation_status,
                  ar.terminal_status, ar.logical_execution_lineage,
                  ar.logical_execution_cycle_id, sv.skill_id, sv.version AS skill_version,
                  sv.content_hash AS skill_content_hash
           FROM users u
           JOIN projects p ON p.id = ?
           JOIN analysis_runs r ON r.id = ?
           JOIN run_stages rs ON rs.id = ?
           JOIN job_attempts ja ON ja.id = ?
           JOIN agent_runs ar ON ar.id = ?
           JOIN skill_versions sv ON sv.id = ar.skill_version_id
           WHERE u.id = ?`,
        )
        .get(
          validated.expectedProjectId, validated.runId, validated.stageId,
          validated.jobAttemptId, validated.agentRunId, validated.actorId,
        ) as SqliteRow | undefined;
      if (!subject ||
        subject.actor_status !== "active" ||
        subject.actor_organization_id !== validated.actorOrganizationId ||
        subject.project_organization_id !== validated.actorOrganizationId ||
        subject.project_id !== validated.expectedProjectId ||
        subject.stage_run_id !== validated.runId ||
        subject.stage !== "traffic-analysis" ||
        subject.job_stage_id !== validated.stageId ||
        subject.agent_run_run_id !== validated.runId ||
        subject.agent_run_stage_id !== validated.stageId
      ) throw new AnalysisReportSubjectNotFoundError();
      if (subject.job_status !== "running" || subject.leased_by !== validated.leaseOwnerId ||
        Number(subject.lease_generation) !== validated.leaseGeneration ||
        typeof subject.lease_expires_at !== "string" || subject.lease_expires_at <= transactionNow
      ) throw new AnalysisReportLeaseLostError();
      if (subject.validation_status !== "passed" || subject.terminal_status !== "succeeded" ||
        subject.logical_execution_lineage !== validated.logicalExecutionLineage ||
        subject.logical_execution_cycle_id !== subject.job_logical_execution_cycle_id ||
        subject.output_schema_version !== "1.0.0" || subject.output_json === null
      ) throw new AnalysisReportConflictError();
      const storedSkill = SkillProvenanceSchema.parse({
        id: String(subject.skill_id), version: String(subject.skill_version), contentHash: String(subject.skill_content_hash),
      });
      const storedModel = ModelProvenanceSchema.parse({
        provider: String(subject.provider), model: String(subject.model),
        ...(subject.response_id === null ? {} : { responseId: String(subject.response_id) }),
      });
      if (!isDeepStrictEqual(storedSkill, validated.skill) || !isDeepStrictEqual(storedModel, validated.model)) {
        throw new AnalysisReportConflictError();
      }
      let storedSnapshotIds: unknown;
      let storedOutput: unknown;
      try {
        storedSnapshotIds = JSON.parse(String(subject.snapshot_ids_json));
        storedOutput = JSON.parse(String(subject.output_json));
      } catch {
        throw new AnalysisReportDataError();
      }
      if (!isDeepStrictEqual(storedSnapshotIds, [validated.snapshotId]) || !isDeepStrictEqual(storedOutput, validated.result)) {
        throw new AnalysisReportConflictError();
      }
      const snapshotRow = this.#database.prepare(
        `SELECT * FROM data_snapshots
         WHERE id = ? AND run_id = ? AND data_cutoff_at = ?
           AND artifact_kind = 'traffic' AND schema_version = '1.0.0'`,
      ).get(
        validated.snapshotId,
        validated.runId,
        subject.run_data_cutoff_at,
      ) as SqliteRow | undefined;
      if (!snapshotRow) throw new AnalysisReportSubjectNotFoundError();
      const snapshot = mapTrafficDataSnapshot(snapshotRow);
      let result: TrafficAnalysisOutput;
      try {
        result = canonicalizeTrafficAnalysisOutput(
          validated.result,
          snapshot.payload.input,
        );
      } catch {
        throw new AnalysisReportConflictError();
      }
      if (!isDeepStrictEqual(result, validated.result)) {
        throw new AnalysisReportConflictError();
      }
      assertTrafficCapabilityLanguage(result);

      const existingRow = this.#database.prepare(
        `${analysisReportSelect} WHERE report.agent_run_id = ?`,
      ).get(validated.agentRunId) as SqliteRow | undefined;
      if (existingRow) {
        const existing = mapAnalysisReport(existingRow);
        if (samePublishedTrafficReport(existing, { ...validated, result, skill: storedSkill, model: storedModel })) {
          return { report: existing as Readonly<AnalysisReport<TrafficAnalysisOutput>>, created: false };
        }
        throw new AnalysisReportConflictError();
      }
      const versionRow = this.#database.prepare(
        "SELECT COALESCE(MAX(version), 0) + 1 AS version FROM analysis_reports WHERE run_id = ? AND stage = 'traffic-analysis'",
      ).get(validated.runId) as SqliteRow;
      const version = Number(versionRow.version);
      if (!Number.isSafeInteger(version) || version <= 0) throw new AnalysisReportDataError();
      const evidence = [{
        id: snapshot.id,
        type: "snapshot" as const,
        sourceId: "traffic-data-snapshot",
        capturedAt: snapshot.createdAt,
      }];
      this.#database.prepare(
        `INSERT INTO analysis_reports
         (id, run_id, agent_run_id, version, stage, schema_version, status,
          snapshot_ids_json, evidence_json, result_json, data_cutoff_at, created_at)
         VALUES (?, ?, ?, ?, 'traffic-analysis', '1.0.0', ?, ?, ?, ?, ?, ?)`,
      ).run(
        validated.id, validated.runId, validated.agentRunId, version, result.status,
        JSON.stringify([validated.snapshotId]), JSON.stringify(evidence), JSON.stringify(result),
        result.identity.dataCutoffAt, validated.publishedAt,
      );
      const created = this.#database.prepare(
        `${analysisReportSelect} WHERE report.id = ?`,
      ).get(validated.id) as SqliteRow | undefined;
      if (!created) throw new AnalysisReportDataError();
      return { report: mapAnalysisReport(created) as Readonly<AnalysisReport<TrafficAnalysisOutput>>, created: true };
    });
  }

  async publishProductDefinitionReport(
    input: PublishProductDefinitionReportInput,
  ): Promise<PublishProductDefinitionReportResult> {
    const validated = validatePublishProductDefinitionReportInput(input);
    return this.#agentRunTransaction(() => {
      const transactionNow = this.#transactionNow();
      const subject = this.#database.prepare(
        `SELECT u.organization_id AS actor_organization_id, u.status AS actor_status,
                p.organization_id AS project_organization_id, p.marketplace,
                p.asins_json, r.project_id, r.data_cutoff_at AS run_data_cutoff_at,
                rs.run_id AS stage_run_id, rs.stage, ja.stage_id AS job_stage_id,
                ja.status AS job_status, ja.leased_by, ja.lease_generation,
                ja.lease_expires_at,
                ja.logical_execution_cycle_id AS job_logical_execution_cycle_id,
                ar.run_id AS agent_run_run_id, ar.stage_id AS agent_run_stage_id,
                ar.snapshot_ids_json, ar.provider, ar.model, ar.response_id,
                ar.output_schema_version, ar.output_json, ar.validation_status,
                ar.terminal_status, ar.logical_execution_lineage,
                ar.logical_execution_cycle_id, sv.skill_id,
                sv.version AS skill_version, sv.content_hash AS skill_content_hash
         FROM users u
         JOIN projects p ON p.id = ?
         JOIN analysis_runs r ON r.id = ?
         JOIN run_stages rs ON rs.id = ?
         JOIN job_attempts ja ON ja.id = ?
         JOIN agent_runs ar ON ar.id = ?
         JOIN skill_versions sv ON sv.id = ar.skill_version_id
         WHERE u.id = ?`,
      ).get(
        validated.expectedProjectId, validated.runId, validated.stageId,
        validated.jobAttemptId, validated.agentRunId, validated.actorId,
      ) as SqliteRow | undefined;
      if (!subject ||
        subject.actor_status !== "active" ||
        subject.actor_organization_id !== validated.actorOrganizationId ||
        subject.project_organization_id !== validated.actorOrganizationId ||
        subject.project_id !== validated.expectedProjectId ||
        subject.stage_run_id !== validated.runId ||
        subject.stage !== "product-definition" ||
        subject.job_stage_id !== validated.stageId ||
        subject.agent_run_run_id !== validated.runId ||
        subject.agent_run_stage_id !== validated.stageId
      ) throw new AnalysisReportSubjectNotFoundError();
      if (subject.job_status !== "running" || subject.leased_by !== validated.leaseOwnerId ||
        Number(subject.lease_generation) !== validated.leaseGeneration ||
        typeof subject.lease_expires_at !== "string" || subject.lease_expires_at <= transactionNow
      ) throw new AnalysisReportLeaseLostError();
      if (subject.validation_status !== "passed" || subject.terminal_status !== "succeeded" ||
        subject.logical_execution_lineage !== validated.logicalExecutionLineage ||
        subject.logical_execution_cycle_id !== subject.job_logical_execution_cycle_id ||
        subject.output_schema_version !== "1.0.0" || subject.output_json === null
      ) throw new AnalysisReportConflictError();
      const storedSkill = SkillProvenanceSchema.parse({
        id: String(subject.skill_id), version: String(subject.skill_version), contentHash: String(subject.skill_content_hash),
      });
      const storedModel = ModelProvenanceSchema.parse({
        provider: String(subject.provider), model: String(subject.model),
        ...(subject.response_id === null ? {} : { responseId: String(subject.response_id) }),
      });
      if (!isDeepStrictEqual(storedSkill, validated.skill) || !isDeepStrictEqual(storedModel, validated.model)) {
        throw new AnalysisReportConflictError();
      }
      let agentSnapshotIds: unknown;
      let storedOutput: unknown;
      try {
        agentSnapshotIds = JSON.parse(String(subject.snapshot_ids_json));
        storedOutput = JSON.parse(String(subject.output_json));
      } catch {
        throw new AnalysisReportDataError();
      }
      if (!Array.isArray(agentSnapshotIds) || agentSnapshotIds.length < 1 ||
        !isDeepStrictEqual(storedOutput, validated.result)) {
        throw new AnalysisReportConflictError();
      }
      const vocRow = this.#database.prepare(
        `${analysisReportSelect} WHERE report.id = ? AND report.run_id = ?
          AND report.stage = 'voc-positioning' AND report.status IN ('complete', 'partial')`,
      ).get(validated.vocReportId, validated.runId) as SqliteRow | undefined;
      const keywordRow = this.#database.prepare(
        "SELECT * FROM keyword_analysis_snapshots WHERE id = ? AND run_id = ?",
      ).get(validated.keywordSnapshotId, validated.runId) as SqliteRow | undefined;
      if (!vocRow || !keywordRow) throw new AnalysisReportSubjectNotFoundError();
      const vocReport = mapAnalysisReport(vocRow) as AnalysisReport<VocPositioningOutput>;
      const keywordSnapshot = mapKeywordAnalysisSnapshot(keywordRow);
      if (!isDeepStrictEqual(agentSnapshotIds, vocReport.snapshotIds) ||
        keywordSnapshot.marketplace !== "US" ||
        subject.marketplace !== keywordSnapshot.marketplace ||
        !isDeepStrictEqual(parseStoredTextList(subject.asins_json), keywordSnapshot.asins) ||
        !sameDateTimeInstant(String(subject.run_data_cutoff_at), keywordSnapshot.dataCutoffAt)
      ) throw new AnalysisReportConflictError();
      const productInput = buildProductDefinitionInput({
        marketplace: "US",
        asins: keywordSnapshot.asins,
        dataCutoffAt: keywordSnapshot.dataCutoffAt,
        vocReport,
        keywordSnapshot,
      });
      const parsed = createProductDefinitionOutputSchema(productInput).safeParse(validated.result);
      if (!parsed.success) throw new AnalysisReportConflictError();
      assertProductDefinitionCapabilityLanguage(parsed.data);

      const existingRow = this.#database.prepare(
        `${analysisReportSelect} WHERE report.agent_run_id = ?`,
      ).get(validated.agentRunId) as SqliteRow | undefined;
      if (existingRow) {
        const existing = mapAnalysisReport(existingRow);
        if (samePublishedProductReport(existing, { ...validated, result: parsed.data, skill: storedSkill, model: storedModel }, vocReport.snapshotIds)) {
          return { report: existing as Readonly<AnalysisReport<ProductDefinitionOutput>>, created: false };
        }
        throw new AnalysisReportConflictError();
      }
      const versionRow = this.#database.prepare(
        "SELECT COALESCE(MAX(version), 0) + 1 AS version FROM analysis_reports WHERE run_id = ? AND stage = 'product-definition'",
      ).get(validated.runId) as SqliteRow;
      const version = Number(versionRow.version);
      if (!Number.isSafeInteger(version) || version <= 0) throw new AnalysisReportDataError();
      const snapshotIds = [...vocReport.snapshotIds, keywordSnapshot.id];
      const evidence = [
        { id: vocReport.id, type: "report" as const, sourceId: "voc-positioning-report", capturedAt: vocReport.createdAt },
        { id: keywordSnapshot.id, type: "snapshot" as const, sourceId: "keyword-analysis-snapshot", capturedAt: keywordSnapshot.createdAt },
      ];
      this.#database.prepare(
        `INSERT INTO analysis_reports
         (id, run_id, agent_run_id, version, stage, schema_version, status,
          snapshot_ids_json, evidence_json, result_json, data_cutoff_at, created_at)
         VALUES (?, ?, ?, ?, 'product-definition', '1.0.0', ?, ?, ?, ?, ?, ?)`,
      ).run(
        validated.id, validated.runId, validated.agentRunId, version, parsed.data.status,
        JSON.stringify(snapshotIds), JSON.stringify(evidence), JSON.stringify(parsed.data),
        parsed.data.identity.dataCutoffAt, validated.publishedAt,
      );
      const created = this.#database.prepare(
        `${analysisReportSelect} WHERE report.id = ?`,
      ).get(validated.id) as SqliteRow | undefined;
      if (!created) throw new AnalysisReportDataError();
      return { report: mapAnalysisReport(created) as Readonly<AnalysisReport<ProductDefinitionOutput>>, created: true };
    });
  }

  listAnalysisReports(
    input: ListAnalysisReportsInput,
  ): Promise<ReadonlyArray<Readonly<AnalysisReport<VocPositioningOutput | TrafficAnalysisOutput | ProductDefinitionOutput>>>> {
    const actorOrganizationId = EntityIdSchema.parse(input.actorOrganizationId);
    const runId = EntityIdSchema.parse(input.runId);
    if (input.stage !== "voc-positioning" && input.stage !== "traffic-analysis" && input.stage !== "product-definition") {
      throw new TypeError("Invalid analysis report stage");
    }
    const stage = input.stage;
    return this.#serialize(() =>
      (this.#database
        .prepare(
          `${analysisReportSelect}
           WHERE report.run_id = ? AND report.stage = ?
             AND p.organization_id = ?
           ORDER BY report.version, report.id`,
        )
        .all(runId, stage, actorOrganizationId) as SqliteRow[]).map(
        mapAnalysisReport,
      ),
    );
  }

  findAnalysisReportById(
    input: FindAnalysisReportByIdInput,
  ): Promise<Readonly<AnalysisReport<VocPositioningOutput | TrafficAnalysisOutput | ProductDefinitionOutput>> | null> {
    const actorOrganizationId = EntityIdSchema.parse(input.actorOrganizationId);
    const reportId = EntityIdSchema.parse(input.reportId);
    return this.#serialize(() => {
      const row = this.#database
        .prepare(
          `${analysisReportSelect}
           WHERE report.id = ? AND p.organization_id = ?`,
        )
        .get(reportId, actorOrganizationId) as SqliteRow | undefined;
      return row ? mapAnalysisReport(row) : null;
    });
  }

  appendAnalysisAgentHumanRating(
    rating: AnalysisAgentHumanRating,
  ): Promise<AnalysisAgentHumanRating> {
    const validated = createAnalysisAgentHumanRating(rating);
    const metadata = {
      evalSetVersion: validated.evalSetVersion,
      caseId: validated.caseId,
      skill: validated.skill,
      model: validated.model,
      reportId: validated.reportId,
      scores: validated.scores,
      ...(validated.comment ? { comment: validated.comment } : {}),
    };
    return this.#serialize(() => {
      this.#appendAnalysisAgentEvaluationEvent({
        id: validated.id,
        organizationId: validated.organizationId,
        actorUserId: validated.actorUserId,
        action: "analysis-agent.human-rating-recorded",
        module: validated.module,
        metadata,
        createdAt: validated.createdAt,
      });
      return validated;
    });
  }

  listAnalysisAgentHumanRatings(input: Readonly<{
    organizationId: string;
    module: AnalysisAgentModule;
  }>): Promise<readonly AnalysisAgentHumanRating[]> {
    const organizationId = EntityIdSchema.parse(input.organizationId);
    const analysisModule = AnalysisAgentModuleModeEventSchema.shape.module.parse(input.module);
    return this.#serialize(() =>
      (this.#database.prepare(
        `SELECT id, organization_id, actor_user_id, target_id, metadata_json,
                created_at
         FROM audit_events
         WHERE organization_id = ?
           AND action = 'analysis-agent.human-rating-recorded'
           AND target_type = 'analysis-module' AND target_id = ?
         ORDER BY created_at, rowid`,
      ).all(organizationId, analysisModule) as SqliteRow[]).map((row) => {
        const metadata = JSON.parse(String(row.metadata_json)) as Record<string, unknown>;
        return createAnalysisAgentHumanRating({
          id: row.id,
          organizationId: row.organization_id,
          actorUserId: row.actor_user_id,
          module: row.target_id,
          ...metadata,
          createdAt: row.created_at,
        });
      }),
    );
  }

  appendAnalysisAgentModuleMode(
    event: AnalysisAgentModuleModeEvent,
  ): Promise<AnalysisAgentModuleModeEvent> {
    const validated = createAnalysisAgentModuleModeEvent(event);
    const operation = () => {
      if (validated.mode === "agent-primary") {
        const decision = this.#findAnalysisAgentReleaseDecision(
          validated.organizationId,
          validated.releaseDecisionId!,
        );
        if (
          !decision ||
          decision.status !== "approved" ||
          decision.module !== validated.module ||
          decision.candidateDigest !== validated.candidateDigest
        ) {
          throw new AnalysisAgentReleaseDecisionNotApprovedError();
        }
      }
      this.#appendAnalysisAgentEvaluationEvent({
        id: validated.id,
        organizationId: validated.organizationId,
        actorUserId: validated.actorUserId,
        action: "analysis-agent.module-mode-set",
        module: validated.module,
        metadata: {
          mode: validated.mode,
          reason: validated.reason,
          ...(validated.mode === "agent-primary"
            ? {
                releaseDecisionId: validated.releaseDecisionId,
                candidateDigest: validated.candidateDigest,
              }
            : {}),
        },
        createdAt: validated.createdAt,
      });
      return validated;
    };
    return this.#transactionContext.getStore()
      ? this.#serialize(operation)
      : this.#serialize(() => this.#withImmediateTransaction(operation));
  }

  #appendAnalysisAgentEvaluationEvent(input: Readonly<{
    id: string;
    organizationId: string;
    actorUserId: string;
    action:
      | "analysis-agent.human-rating-recorded"
      | "analysis-agent.module-mode-set"
      | "analysis-agent.release-decision-recorded";
    module: AnalysisAgentModule;
    metadata: Readonly<Record<string, unknown>>;
    createdAt: string;
  }>) {
    const result = this.#database.prepare(
      `INSERT INTO audit_events
       (id, organization_id, actor_user_id, action, target_type, target_id,
        metadata_json, created_at)
       SELECT ?, ?, ?, ?, 'analysis-module', ?, ?, ?
       FROM users actor
       WHERE actor.id = ? AND actor.organization_id = ?
         AND actor.status = 'active'`,
    ).run(
      input.id,
      input.organizationId,
      input.actorUserId,
      input.action,
      input.module,
      JSON.stringify(input.metadata),
      input.createdAt,
      input.actorUserId,
      input.organizationId,
    );
    if (Number(result.changes) !== 1) {
      throw new AnalysisAgentEvaluationControlSubjectNotFoundError();
    }
  }

  evaluateAndAppendAnalysisAgentReleaseDecision(
    submission: AnalysisAgentReleaseSubmission,
  ): Promise<AnalysisAgentReleaseDecision> {
    const validated = createAnalysisAgentReleaseSubmission(submission);
    const operation = () => {
      const humanRatings = validated.ratingIds.map((ratingId) => {
        const rating = this.#findAnalysisAgentHumanRating(
          validated.candidate.organizationId,
          ratingId,
        );
        if (!rating) throw new AnalysisAgentReleaseEvidenceNotFoundError();
        return rating;
      });
      const decision = evaluateAnalysisAgentReleaseEvidence({
        submission: validated,
        humanRatings,
      });
      const metadata = {
        schemaVersion: decision.schemaVersion,
        status: decision.status,
        candidate: decision.candidate,
        candidateDigest: decision.candidateDigest,
        autoResultsDigest: decision.autoResultsDigest,
        humanRatingsDigest: decision.humanRatingsDigest,
        ratingIds: decision.ratingIds,
        failureCodes: decision.failureCodes,
      };
      this.#appendAnalysisAgentEvaluationEvent({
        id: decision.id,
        organizationId: decision.organizationId,
        actorUserId: decision.actorUserId,
        action: "analysis-agent.release-decision-recorded",
        module: decision.module,
        metadata,
        createdAt: decision.createdAt,
      });
      return decision;
    };
    return this.#transactionContext.getStore()
      ? this.#serialize(operation)
      : this.#serialize(() => this.#withImmediateTransaction(operation));
  }

  #findAnalysisAgentHumanRating(
    organizationId: string,
    ratingId: string,
  ): AnalysisAgentHumanRating | null {
    const row = this.#database.prepare(
      `SELECT id, organization_id, actor_user_id, target_id, metadata_json,
              created_at
       FROM audit_events
       WHERE id = ? AND organization_id = ?
         AND action = 'analysis-agent.human-rating-recorded'
         AND target_type = 'analysis-module'
       LIMIT 1`,
    ).get(ratingId, organizationId) as SqliteRow | undefined;
    if (!row) return null;
    try {
      const metadata = JSON.parse(String(row.metadata_json)) as Record<string, unknown>;
      return createAnalysisAgentHumanRating({
        id: row.id,
        organizationId: row.organization_id,
        actorUserId: row.actor_user_id,
        module: row.target_id,
        ...metadata,
        createdAt: row.created_at,
      });
    } catch {
      return null;
    }
  }

  findAnalysisAgentReleaseDecision(input: Readonly<{
    organizationId: string;
    decisionId: string;
  }>): Promise<AnalysisAgentReleaseDecision | null> {
    const organizationId = EntityIdSchema.parse(input.organizationId);
    const decisionId = EntityIdSchema.parse(input.decisionId);
    return this.#serialize(() =>
      this.#findAnalysisAgentReleaseDecision(organizationId, decisionId),
    );
  }

  #findAnalysisAgentReleaseDecision(
    organizationId: string,
    decisionId: string,
  ): AnalysisAgentReleaseDecision | null {
    const row = this.#database.prepare(
      `SELECT id, organization_id, actor_user_id, target_id, metadata_json,
              created_at
       FROM audit_events
       WHERE id = ? AND organization_id = ?
         AND action = 'analysis-agent.release-decision-recorded'
         AND target_type = 'analysis-module'
       LIMIT 1`,
    ).get(decisionId, organizationId) as SqliteRow | undefined;
    if (!row) return null;
    try {
      const metadata = JSON.parse(String(row.metadata_json)) as Record<string, unknown>;
      return createAnalysisAgentReleaseDecision({
        id: row.id,
        organizationId: row.organization_id,
        actorUserId: row.actor_user_id,
        module: row.target_id,
        ...metadata,
        createdAt: row.created_at,
      });
    } catch {
      return null;
    }
  }

  findLatestAnalysisAgentModuleMode(input: Readonly<{
    organizationId: string;
    module: AnalysisAgentModule;
  }>): Promise<AnalysisAgentModuleModeEvent | null> {
    const organizationId = EntityIdSchema.parse(input.organizationId);
    const analysisModule = AnalysisAgentModuleModeEventSchema.shape.module.parse(input.module);
    return this.#serialize(() => {
      const row = this.#database.prepare(
        `SELECT id, organization_id, actor_user_id, target_id, metadata_json,
                created_at
         FROM audit_events
         WHERE organization_id = ?
           AND action = 'analysis-agent.module-mode-set'
           AND target_type = 'analysis-module' AND target_id = ?
         ORDER BY rowid DESC
         LIMIT 1`,
      ).get(organizationId, analysisModule) as SqliteRow | undefined;
      if (!row) return null;
      try {
        const metadata = JSON.parse(String(row.metadata_json)) as Record<string, unknown>;
        return createAnalysisAgentModuleModeEvent({
          id: row.id,
          organizationId: row.organization_id,
          actorUserId: row.actor_user_id,
          module: row.target_id,
          ...metadata,
          createdAt: row.created_at,
        });
      } catch {
        return null;
      }
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
           WHERE mbr.job_attempt_id IN (
             SELECT cycle_jobs.id
             FROM job_attempts cycle_jobs
             WHERE cycle_jobs.logical_execution_cycle_id = (
               SELECT current_job.logical_execution_cycle_id
               FROM job_attempts current_job
               WHERE current_job.id = ?
             )
           ) AND mbr.run_id = ?
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
      !isDeepStrictEqual(input.candidate.asins, input.expectedAsins)
    ) {
      throw new DataSnapshotSubjectNotFoundError();
    }
    if (!sameDateTimeInstant(input.candidate.dataCutoffAt, storedRunCutoffAt)) {
      throw new DataSnapshotCutoffConflictError();
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
           id, run_id, snapshot_kind, artifact_kind, schema_version, marketplace, asins_json,
           data_cutoff_at, sources_json, payload_json, content_hash, created_at
         ) VALUES (?, ?, 'voc', 'voc', ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        const freshNow = this.#transactionNow();
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
        const freshNow = this.#transactionNow();
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
        const freshNow = this.#transactionNow();
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
        const freshNow = this.#transactionNow();
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

  #transactionNow() {
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
             WHERE id = ? AND run_id = ?
               AND status IN ('failed', 'succeeded')`,
          )
          .get(input.stageId, input.runId) as SqliteRow | undefined;
        if (!current) return null;

        const latestJobRow = this.#database
          .prepare(
            `SELECT job_attempts.*, run_stages.run_id AS run_id,
                    run_stages.stage AS stage
             FROM job_attempts
             JOIN run_stages ON run_stages.id = job_attempts.stage_id
             WHERE job_attempts.stage_id = ?
             ORDER BY job_attempts.attempt_number DESC
             LIMIT 1`,
          )
          .get(input.stageId) as SqliteRow | undefined;
        const latestJob = latestJobRow ? mapJob(latestJobRow) : null;
        const durable = latestJob
          ? this.#durableCycleDisposition(latestJob)
          : null;
        const publicationRecovery =
          current.status === "failed" &&
          latestJob !== null &&
          latestJob.status === "failed" &&
          latestJob.reportPublicationAttemptCount > 0 &&
          durable?.kind === "recover" &&
          (durable.mode === "report-only" ||
            durable.mode === "completion-only");

        if (publicationRecovery) {
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
          const reset = this.#database
            .prepare(
              `UPDATE job_attempts
               SET status = 'queued', available_at = ?, leased_by = NULL,
                   lease_expires_at = NULL, retryable = 0,
                   retry_scheduled_at = NULL, completed_at = NULL,
                   error_json = NULL,
                   report_publication_cycle = report_publication_cycle + 1,
                   report_publication_attempt_count = 0,
                   report_publication_max_attempts = NULL,
                   report_publication_initial_delay_ms = NULL,
                   report_publication_max_delay_ms = NULL,
                   report_publication_retry_at = NULL, updated_at = ?
               WHERE id = ? AND status = 'failed'`,
            )
            .run(input.retriedAt, input.retriedAt, latestJob.id);
          if (Number(reset.changes) !== 1) throw new JobLeaseLostError();
          this.#refreshAnalysisRunStatus(input.runId, input.retriedAt);
          return {
            stage: mapRunStage(
              this.#database
                .prepare("SELECT * FROM run_stages WHERE id = ?")
                .get(input.stageId) as SqliteRow,
            ),
            attempt: this.#findJob(latestJob.id)!,
          };
        }

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
             WHERE id = ? AND run_id = ?
               AND status IN ('failed', 'succeeded')`,
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
               retry_cycle_start_attempt, logical_execution_cycle_id,
               status, available_at,
               leased_by, lease_expires_at, lease_generation, retryable,
               retry_scheduled_at, started_at, completed_at, error_json,
               created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, NULL, NULL, 0, 0, NULL, NULL,
                       NULL, NULL, ?, ?)`,
          )
          .run(
            input.jobId,
            input.stageId,
            attemptNumber,
            attemptNumber + input.maxAutomaticAttempts - 1,
            attemptNumber,
            createLogicalExecutionCycleId(),
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
             retry_cycle_start_attempt, logical_execution_cycle_id,
             status, available_at,
             leased_by, lease_expires_at, lease_generation, retryable,
             retry_scheduled_at, started_at, completed_at, error_json,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, NULL, NULL, 0, 0, NULL, NULL,
                     NULL, NULL, ?, ?)`,
        )
        .run(
          job.id,
          job.stageId,
          job.attemptNumber,
          job.maxAttempts,
          job.attemptNumber,
          createLogicalExecutionCycleId(),
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
    if (
      input.stage !== undefined &&
      input.stage !== "traffic-analysis" &&
      input.stage !== "voc-positioning" &&
      input.stage !== "product-definition"
    ) {
      throw new TypeError("Invalid job claim stage filter");
    }

    const candidate = this.#database
      .prepare(
        `SELECT job_attempts.*, run_stages.run_id AS run_id,
                run_stages.stage AS stage
         FROM job_attempts
         JOIN run_stages ON run_stages.id = job_attempts.stage_id
         WHERE (
           (job_attempts.status = 'queued' AND job_attempts.available_at <= ?)
           OR (
             job_attempts.status = 'failed' AND job_attempts.retryable = 1
             AND job_attempts.retry_scheduled_at IS NULL
             AND (
               job_attempts.report_publication_retry_at IS NULL
               OR job_attempts.report_publication_retry_at <= ?
             )
             AND job_attempts.available_at <= ?
           )
           OR (
             job_attempts.status = 'running' AND job_attempts.lease_expires_at <= ?
           )
         ) AND (? IS NULL OR run_stages.stage = ?)
         ORDER BY
           CASE job_attempts.status
             WHEN 'running' THEN job_attempts.lease_expires_at
             ELSE job_attempts.available_at
           END,
           job_attempts.created_at, job_attempts.id
         LIMIT 1`,
      )
      .get(
        input.claimedAt,
        input.claimedAt,
        input.claimedAt,
        input.claimedAt,
        input.stage ?? null,
        input.stage ?? null,
      ) as
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

    const disposition = this.#durableCycleDisposition(current);
    if (disposition.kind === "settle") {
      this.#settleClaimCandidate(current, disposition, input.claimedAt);
      return null;
    }

    if (
      disposition.kind === "recover" &&
      (disposition.mode === "report-only" ||
        disposition.mode === "completion-only") &&
      current.status === "failed"
    ) {
      return this.#reclaimRecoveryLease(current, input);
    }

    if (current.attemptNumber >= current.maxAttempts) {
      if (
        disposition.kind === "recover" &&
        disposition.mode !== "unstarted"
      ) {
        return this.#reclaimRecoveryLease(current, input);
      }
      const terminalError =
        disposition.kind === "recover"
          ? leaseExpiredError
          : disposition.error;
      this.#settleClaimCandidate(
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

    this.#database
      .prepare(
        `UPDATE job_attempts
         SET status = 'failed', retryable = 1, retry_scheduled_at = ?,
             leased_by = NULL, lease_expires_at = NULL,
             completed_at = COALESCE(completed_at, ?),
             error_json = ?,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(
        input.claimedAt,
        input.claimedAt,
        JSON.stringify(predecessorError),
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
           retry_cycle_start_attempt, logical_execution_cycle_id,
           status, available_at,
           leased_by, lease_expires_at, lease_generation, retryable,
           retry_scheduled_at, started_at, completed_at, error_json,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, 0, NULL, ?, NULL, NULL, ?, ?)`,
      )
      .run(
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
        leaseExpiresAt,
        current.leaseGeneration + 1,
        input.claimedAt,
        input.claimedAt,
        input.claimedAt,
      );
    this.#markStageRunning(current.stageId, nextAttempt, input.claimedAt);
    return this.#findJob(nextId)!;
  }

  resumeWaitingInputRunStage(
    input: ResumeWaitingInputRunStageInput,
  ): Promise<ResumeWaitingInputRunStageResult | null> {
    return this.#serialize(() => {
      const operation = () => {
        const stageRow = this.#database
          .prepare(
            `SELECT * FROM run_stages
             WHERE id = ? AND run_id = ? AND stage = 'voc-positioning'
               AND status = 'waiting-input'`,
          )
          .get(input.stageId, input.runId) as SqliteRow | undefined;
        if (!stageRow) return null;

        const jobRow = this.#database
          .prepare(
            `SELECT job_attempts.*, run_stages.run_id AS run_id,
                    run_stages.stage AS stage
             FROM job_attempts
             JOIN run_stages ON run_stages.id = job_attempts.stage_id
             WHERE job_attempts.stage_id = ?
               AND job_attempts.status = 'failed'
               AND job_attempts.retryable = 0
             ORDER BY job_attempts.attempt_number DESC
             LIMIT 1`,
          )
          .get(input.stageId) as SqliteRow | undefined;
        if (!jobRow) return null;
        const job = mapJob(jobRow);

        const stageUpdate = this.#database
          .prepare(
            `UPDATE run_stages
             SET status = 'queued', progress = 0, completed_at = NULL,
                 last_error_json = NULL, updated_at = ?
             WHERE id = ? AND run_id = ? AND status = 'waiting-input'`,
          )
          .run(input.resumedAt, input.stageId, input.runId);
        if (Number(stageUpdate.changes) !== 1) return null;

        const jobUpdate = this.#database
          .prepare(
            `UPDATE job_attempts
             SET status = 'queued', available_at = ?, leased_by = NULL,
                 lease_expires_at = NULL, retryable = 0,
                 retry_scheduled_at = NULL, completed_at = NULL,
                 error_json = NULL, updated_at = ?
             WHERE id = ? AND status = 'failed' AND retryable = 0`,
          )
          .run(input.resumedAt, input.resumedAt, job.id);
        if (Number(jobUpdate.changes) !== 1) {
          throw new JobLeaseLostError();
        }
        this.#refreshAnalysisRunStatus(input.runId, input.resumedAt);
        return {
          stage: mapRunStage(
            this.#database
              .prepare("SELECT * FROM run_stages WHERE id = ?")
              .get(input.stageId) as SqliteRow,
          ),
          attempt: this.#findJob(job.id)!,
        };
      };
      return this.#transactionContext.getStore()
        ? operation()
        : this.#withImmediateTransaction(operation);
    });
  }

  upsertConnectorStatus(
    status: ConnectorStatusRecord,
  ): Promise<ConnectorStatusRecord> {
    return this.#serialize(() => {
      this.#database
        .prepare(
          `INSERT INTO connector_status (
             id, organization_id, connector, configured, health,
             last_checked_at, last_error_json, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (organization_id, connector) DO UPDATE SET
             configured = excluded.configured,
             health = excluded.health,
             last_checked_at = excluded.last_checked_at,
             last_error_json = excluded.last_error_json,
             updated_at = excluded.updated_at`,
        )
        .run(
          status.id,
          status.organizationId,
          status.connector,
          status.configured ? 1 : 0,
          status.health,
          status.lastCheckedAt,
          status.lastError === null ? null : JSON.stringify(status.lastError),
          status.updatedAt,
        );
      const stored = this.#database
        .prepare(
          `SELECT id, organization_id, connector, configured, health,
                  last_checked_at, last_error_json, updated_at
           FROM connector_status
           WHERE organization_id = ? AND connector = ?`,
        )
        .get(status.organizationId, status.connector) as SqliteRow | undefined;
      if (!stored) throw new Error("Stored connector status is unavailable");
      return mapConnectorStatus(stored);
    });
  }

  findConnectorStatus(
    organizationId: string,
    connector: ConnectorStatusRecord["connector"],
  ): Promise<ConnectorStatusRecord | null> {
    return this.#serialize(() => {
      const row = this.#database
        .prepare(
          `SELECT id, organization_id, connector, configured, health,
                  last_checked_at, last_error_json, updated_at
           FROM connector_status
           WHERE organization_id = ? AND connector = ?`,
        )
        .get(organizationId, connector) as SqliteRow | undefined;
      return row ? mapConnectorStatus(row) : null;
    });
  }

  listConnectorStatuses(
    organizationId: string,
  ): Promise<ConnectorStatusRecord[]> {
    return this.#serialize(() =>
      (this.#database
        .prepare(
          `SELECT id, organization_id, connector, configured, health,
                  last_checked_at, last_error_json, updated_at
           FROM connector_status
           WHERE organization_id = ?
           ORDER BY connector`,
        )
        .all(organizationId) as SqliteRow[]).map(mapConnectorStatus),
    );
  }

  findLatestConnectorCredential(
    organizationId: string,
    connector: ConnectorCredentialRecord["connector"],
  ): Promise<ConnectorCredentialRecord | null> {
    const parsed = validateConnectorCredentialIdentity(organizationId, connector);
    if (!parsed) return Promise.resolve(null);
    return this.#serialize(() => {
      const row = this.#database.prepare(
        `SELECT * FROM connector_credentials
         WHERE organization_id = ? AND connector = ?
         ORDER BY version DESC
         LIMIT 1`,
      ).get(parsed.organizationId, parsed.connector) as SqliteRow | undefined;
      return row ? mapConnectorCredential(row) : null;
    });
  }

  rotateConnectorCredential(
    input: RotateConnectorCredentialInput,
  ): Promise<ConnectorCredentialRecord> {
    const validated = validateRotateConnectorCredentialInput(input);
    return this.#credentialTransaction(() => {
      this.#requireActiveConnectorAdmin(
        validated.organizationId,
        validated.actorUserId,
      );
      const latest = this.#latestConnectorCredentialRow(
        validated.organizationId,
        validated.connector,
      );
      const latestVersion = latest ? Number(latest.version) : null;
      if (
        latestVersion !== validated.expectedLatestVersion ||
        validated.version !== (latestVersion ?? 0) + 1
      ) {
        throw new ConnectorCredentialConflictError();
      }
      if (latest && String(latest.status) === "active") {
        this.#database.prepare(
          `UPDATE connector_credentials
           SET status = 'revoked', revoked_by = ?, revoked_at = ?
           WHERE id = ? AND status = 'active'`,
        ).run(validated.actorUserId, validated.rotatedAt, String(latest.id));
      }
      this.#database.prepare(
        `INSERT INTO connector_credentials (
           id, organization_id, connector, version, status, ciphertext, nonce,
           auth_tag, key_id, created_by, created_at, revoked_by, revoked_at
         ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, NULL, NULL)`,
      ).run(
        validated.id,
        validated.organizationId,
        validated.connector,
        validated.version,
        validated.ciphertext,
        validated.nonce,
        validated.authTag,
        validated.keyId,
        validated.actorUserId,
        validated.rotatedAt,
      );
      this.#writeConnectorCredentialStatus({
        id: validated.statusId,
        organizationId: validated.organizationId,
        connector: validated.connector,
        configured: true,
        updatedAt: validated.rotatedAt,
      });
      this.#appendConnectorCredentialAudit({
        id: validated.auditEventId,
        organizationId: validated.organizationId,
        actorUserId: validated.actorUserId,
        action: "connector.credential-rotated",
        connector: validated.connector,
        version: validated.version,
        createdAt: validated.rotatedAt,
      });
      return mapConnectorCredential(
        this.#database.prepare("SELECT * FROM connector_credentials WHERE id = ?")
          .get(validated.id) as SqliteRow,
      );
    });
  }

  revokeConnectorCredential(
    input: RevokeConnectorCredentialInput,
  ): Promise<RevokeConnectorCredentialResult> {
    const validated = validateRevokeConnectorCredentialInput(input);
    return this.#credentialTransaction(() => {
      this.#requireActiveConnectorAdmin(
        validated.organizationId,
        validated.actorUserId,
      );
      const latest = this.#latestConnectorCredentialRow(
        validated.organizationId,
        validated.connector,
      );
      const latestVersion = latest ? Number(latest.version) : null;
      if (latestVersion !== validated.expectedLatestVersion) {
        throw new ConnectorCredentialConflictError();
      }
      let changed = false;
      let credential: ConnectorCredentialRecord;
      if (!latest) {
        changed = true;
        this.#database.prepare(
          `INSERT INTO connector_credentials (
             id, organization_id, connector, version, status, ciphertext, nonce,
             auth_tag, key_id, created_by, created_at, revoked_by, revoked_at
           ) VALUES (?, ?, ?, 1, 'revoked', ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          validated.tombstoneId,
          validated.organizationId,
          validated.connector,
          validated.ciphertext,
          validated.nonce,
          validated.authTag,
          validated.keyId,
          validated.actorUserId,
          validated.revokedAt,
          validated.actorUserId,
          validated.revokedAt,
        );
        credential = mapConnectorCredential(
          this.#database.prepare("SELECT * FROM connector_credentials WHERE id = ?")
            .get(validated.tombstoneId) as SqliteRow,
        );
      } else if (String(latest.status) === "active") {
        changed = true;
        this.#database.prepare(
          `UPDATE connector_credentials
           SET status = 'revoked', revoked_by = ?, revoked_at = ?
           WHERE id = ? AND status = 'active'`,
        ).run(validated.actorUserId, validated.revokedAt, String(latest.id));
        credential = mapConnectorCredential(
          this.#database.prepare("SELECT * FROM connector_credentials WHERE id = ?")
            .get(String(latest.id)) as SqliteRow,
        );
      } else {
        credential = mapConnectorCredential(latest);
      }
      this.#writeConnectorCredentialStatus({
        id: validated.statusId,
        organizationId: validated.organizationId,
        connector: validated.connector,
        configured: false,
        updatedAt: validated.revokedAt,
      });
      if (changed) {
        this.#appendConnectorCredentialAudit({
          id: validated.auditEventId,
          organizationId: validated.organizationId,
          actorUserId: validated.actorUserId,
          action: "connector.credential-revoked",
          connector: validated.connector,
          version: credential.version,
          createdAt: validated.revokedAt,
        });
      }
      return Object.freeze({ credential, changed });
    });
  }

  #credentialTransaction<T>(operation: () => T): Promise<T> {
    return this.#transactionContext.getStore()
      ? this.#serialize(operation)
      : this.#serialize(() => this.#withImmediateTransaction(operation));
  }

  #requireActiveConnectorAdmin(organizationId: string, actorUserId: string) {
    const row = this.#database.prepare(
      `SELECT 1 FROM users
       WHERE id = ? AND organization_id = ? AND role = 'admin' AND status = 'active'`,
    ).get(actorUserId, organizationId);
    if (!row) throw new ConnectorCredentialAuthorizationError();
  }

  #latestConnectorCredentialRow(
    organizationId: string,
    connector: ConnectorCredentialRecord["connector"],
  ): SqliteRow | undefined {
    return this.#database.prepare(
      `SELECT * FROM connector_credentials
       WHERE organization_id = ? AND connector = ?
       ORDER BY version DESC
       LIMIT 1`,
    ).get(organizationId, connector) as SqliteRow | undefined;
  }

  #writeConnectorCredentialStatus(input: {
    id: string;
    organizationId: string;
    connector: ConnectorCredentialRecord["connector"];
    configured: boolean;
    updatedAt: string;
  }) {
    this.#database.prepare(
      `INSERT INTO connector_status (
         id, organization_id, connector, configured, health,
         last_checked_at, last_error_json, updated_at
       ) VALUES (?, ?, ?, ?, 'unknown', NULL, NULL, ?)
       ON CONFLICT (organization_id, connector) DO UPDATE SET
         configured = excluded.configured,
         health = 'unknown',
         last_checked_at = NULL,
         last_error_json = NULL,
         updated_at = excluded.updated_at`,
    ).run(
      input.id,
      input.organizationId,
      input.connector,
      input.configured ? 1 : 0,
      input.updatedAt,
    );
  }

  #appendConnectorCredentialAudit(input: {
    id: string;
    organizationId: string;
    actorUserId: string;
    action: "connector.credential-rotated" | "connector.credential-revoked";
    connector: ConnectorCredentialRecord["connector"];
    version: number;
    createdAt: string;
  }) {
    this.#database.prepare(
      `INSERT INTO audit_events (
         id, organization_id, actor_user_id, action, target_type,
         target_id, metadata_json, created_at
       ) VALUES (?, ?, ?, ?, 'connector', ?, ?, ?)`,
    ).run(
      input.id,
      input.organizationId,
      input.actorUserId,
      input.action,
      input.connector,
      JSON.stringify({ connector: input.connector, version: input.version }),
      input.createdAt,
    );
  }

  createTrafficDataSnapshotForRun(
    input: CreateTrafficDataSnapshotForRunInput,
  ): Promise<{ snapshot: TrafficDataSnapshotRecord; created: boolean }> {
    const validated = validateCreateTrafficDataSnapshotInput(input);
    const operation = () => {
      const { trustedSubject, storedRunCutoffAt } =
        this.#requireDataSnapshotSubject(validated);
      if (
        validated.candidate.marketplace !== validated.expectedMarketplace ||
        !isDeepStrictEqual(validated.candidate.asins, validated.expectedAsins) ||
        validated.candidate.dataCutoffAt !== storedRunCutoffAt
      ) {
        throw new DataSnapshotSubjectNotFoundError();
      }
      const runId = String(trustedSubject.run_id);
      const asinsJson = JSON.stringify(validated.candidate.asins);
      const existing = this.#database.prepare(
        `SELECT * FROM data_snapshots
         WHERE artifact_kind = 'traffic' AND schema_version = '1.0.0'
           AND run_id = ? AND marketplace = ? AND asins_json = ?
           AND data_cutoff_at = ?`,
      ).get(
        runId,
        validated.candidate.marketplace,
        asinsJson,
        validated.candidate.dataCutoffAt,
      ) as SqliteRow | undefined;
      if (existing) {
        const snapshot = mapTrafficDataSnapshot(existing);
        if (snapshot.contentHash !== validated.candidate.contentHash) {
          throw new TrafficDataSnapshotConflictError();
        }
        return { snapshot, created: false };
      }
      this.#database.prepare(
        `INSERT INTO data_snapshots (
           id, run_id, snapshot_kind, artifact_kind, schema_version, marketplace,
           asins_json, data_cutoff_at, sources_json, payload_json, content_hash,
           created_at
         ) VALUES (?, ?, NULL, 'traffic', '1.0.0', ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        validated.candidateId,
        runId,
        validated.candidate.marketplace,
        asinsJson,
        validated.candidate.dataCutoffAt,
        JSON.stringify(validated.candidate.sources),
        JSON.stringify(validated.candidate.payload),
        validated.candidate.contentHash,
        validated.createdAt,
      );
      const created = this.#database.prepare(
        "SELECT * FROM data_snapshots WHERE id = ? AND artifact_kind = 'traffic' AND schema_version = '1.0.0'",
      ).get(validated.candidateId) as SqliteRow | undefined;
      if (!created) throw new TrafficDataSnapshotDataError();
      return { snapshot: mapTrafficDataSnapshot(created), created: true };
    };
    return this.#transactionContext.getStore()
      ? this.#serialize(operation)
      : this.#serialize(() => this.#withImmediateTransaction(operation));
  }

  findTrafficDataSnapshotById(input: {
    actorOrganizationId: string;
    snapshotId: string;
  }): Promise<TrafficDataSnapshotRecord | null> {
    const actorOrganizationId = EntityIdSchema.parse(input.actorOrganizationId);
    const snapshotId = EntityIdSchema.parse(input.snapshotId);
    return this.#serialize(() => {
      const row = this.#database.prepare(
        `SELECT ds.* FROM data_snapshots ds
         JOIN analysis_runs r ON r.id = ds.run_id
         JOIN projects p ON p.id = r.project_id
         WHERE ds.id = ? AND ds.artifact_kind = 'traffic'
           AND ds.schema_version = '1.0.0' AND p.organization_id = ?`,
      ).get(snapshotId, actorOrganizationId) as SqliteRow | undefined;
      return row ? mapTrafficDataSnapshot(row) : null;
    });
  }

  listTrafficDataSnapshotsByRun(input: {
    actorOrganizationId: string;
    runId: string;
  }): Promise<TrafficDataSnapshotRecord[]> {
    const actorOrganizationId = EntityIdSchema.parse(input.actorOrganizationId);
    const runId = EntityIdSchema.parse(input.runId);
    return this.#serialize(() => {
      const rows = this.#database.prepare(
        `SELECT ds.* FROM data_snapshots ds
         JOIN analysis_runs r ON r.id = ds.run_id
         JOIN projects p ON p.id = r.project_id
         WHERE ds.run_id = ? AND ds.artifact_kind = 'traffic'
           AND ds.schema_version = '1.0.0' AND p.organization_id = ?
         ORDER BY ds.created_at, ds.id`,
      ).all(runId, actorOrganizationId) as SqliteRow[];
      return rows.map(mapTrafficDataSnapshot);
    });
  }

  createKeywordAnalysisSnapshotForRun(
    input: CreateKeywordAnalysisSnapshotForRunInput,
  ): Promise<{ snapshot: KeywordAnalysisSnapshotRecord; created: boolean }> {
    const validated = validateCreateKeywordAnalysisSnapshotInput(input);
    const operation = () => {
      const { trustedSubject, storedRunCutoffAt } =
        this.#requireDataSnapshotSubject(validated);
      if (
        validated.candidate.marketplace !== validated.expectedMarketplace ||
        !isDeepStrictEqual(validated.candidate.asins, validated.expectedAsins) ||
        validated.candidate.dataCutoffAt !== storedRunCutoffAt
      ) {
        throw new DataSnapshotSubjectNotFoundError();
      }
      const runId = String(trustedSubject.run_id);
      const asinsJson = JSON.stringify(validated.candidate.asins);
      const existing = this.#database.prepare(
        `SELECT * FROM keyword_analysis_snapshots
         WHERE run_id = ? AND schema_version = '1.0.0'
           AND marketplace = ? AND asins_json = ? AND data_cutoff_at = ?`,
      ).get(
        runId,
        validated.candidate.marketplace,
        asinsJson,
        validated.candidate.dataCutoffAt,
      ) as SqliteRow | undefined;
      if (existing) {
        const snapshot = mapKeywordAnalysisSnapshot(existing);
        if (snapshot.contentHash !== validated.candidate.contentHash) {
          throw new KeywordAnalysisSnapshotConflictError();
        }
        this.#reconcileProductDefinitionStage(runId, validated.createdAt);
        return { snapshot, created: false };
      }
      this.#database.prepare(
        `INSERT INTO keyword_analysis_snapshots (
           id, run_id, schema_version, marketplace, asins_json, data_cutoff_at,
           sources_json, payload_json, content_hash, created_at
         ) VALUES (?, ?, '1.0.0', ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        validated.candidateId,
        runId,
        validated.candidate.marketplace,
        asinsJson,
        validated.candidate.dataCutoffAt,
        JSON.stringify(validated.candidate.sources),
        JSON.stringify(validated.candidate.payload),
        validated.candidate.contentHash,
        validated.createdAt,
      );
      const created = this.#database.prepare(
        "SELECT * FROM keyword_analysis_snapshots WHERE id = ?",
      ).get(validated.candidateId) as SqliteRow | undefined;
      if (!created) throw new KeywordAnalysisSnapshotDataError();
      this.#reconcileProductDefinitionStage(runId, validated.createdAt);
      return { snapshot: mapKeywordAnalysisSnapshot(created), created: true };
    };
    return this.#transactionContext.getStore()
      ? this.#serialize(operation)
      : this.#serialize(() => this.#withImmediateTransaction(operation));
  }

  findKeywordAnalysisSnapshotById(input: {
    actorOrganizationId: string;
    snapshotId: string;
  }): Promise<KeywordAnalysisSnapshotRecord | null> {
    const actorOrganizationId = EntityIdSchema.parse(input.actorOrganizationId);
    const snapshotId = EntityIdSchema.parse(input.snapshotId);
    return this.#serialize(() => {
      const row = this.#database.prepare(
        `SELECT snapshot.* FROM keyword_analysis_snapshots snapshot
         JOIN analysis_runs run ON run.id = snapshot.run_id
         JOIN projects project ON project.id = run.project_id
         WHERE snapshot.id = ? AND project.organization_id = ?`,
      ).get(snapshotId, actorOrganizationId) as SqliteRow | undefined;
      return row ? mapKeywordAnalysisSnapshot(row) : null;
    });
  }

  listKeywordAnalysisSnapshotsByRun(input: {
    actorOrganizationId: string;
    runId: string;
  }): Promise<KeywordAnalysisSnapshotRecord[]> {
    const actorOrganizationId = EntityIdSchema.parse(input.actorOrganizationId);
    const runId = EntityIdSchema.parse(input.runId);
    return this.#serialize(() => {
      const rows = this.#database.prepare(
        `SELECT snapshot.* FROM keyword_analysis_snapshots snapshot
         JOIN analysis_runs run ON run.id = snapshot.run_id
         JOIN projects project ON project.id = run.project_id
         WHERE snapshot.run_id = ? AND project.organization_id = ?
         ORDER BY snapshot.created_at, snapshot.id`,
      ).all(runId, actorOrganizationId) as SqliteRow[];
      return rows.map(mapKeywordAnalysisSnapshot);
    });
  }

  getKeywordAnalysisArtifact(runId: string) {
    const validatedRunId = EntityIdSchema.parse(runId);
    return this.#serialize(() => {
      const row = this.#database.prepare(
        `SELECT content_hash FROM keyword_analysis_snapshots
         WHERE run_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
      ).get(validatedRunId) as SqliteRow | undefined;
      return row
        ? Object.freeze({ available: true as const, version: String(row.content_hash) })
        : Object.freeze({ available: false as const, version: null });
    });
  }

  #reconcileProductDefinitionStage(runId: string, updatedAt: string) {
    const stage = this.#database.prepare(
      "SELECT * FROM run_stages WHERE run_id = ? AND stage = 'product-definition'",
    ).get(runId) as SqliteRow | undefined;
    if (!stage || !["queued", "waiting-input"].includes(String(stage.status))) {
      return;
    }
    const vocReady = Boolean(this.#database.prepare(
      `SELECT 1 FROM analysis_reports report
       WHERE report.run_id = ? AND report.stage = 'voc-positioning'
         AND report.status IN ('complete', 'partial') LIMIT 1`,
    ).get(runId));
    const keywordReady = Boolean(this.#database.prepare(
      "SELECT 1 FROM keyword_analysis_snapshots WHERE run_id = ? LIMIT 1",
    ).get(runId));
    const missing: Array<{ path: string; message: string }> = [];
    if (!vocReady) missing.push({ path: "dependencies.voc-positioning-report", message: "Validated VOC positioning report is required" });
    if (!keywordReady) missing.push({ path: "dependencies.keyword-analysis-snapshot", message: "Keyword analysis snapshot is required" });
    if (missing.length > 0) {
      this.#database.prepare(
        `UPDATE run_stages SET status = 'waiting-input', progress = 0,
           completed_at = NULL, last_error_json = ?, updated_at = ?
         WHERE id = ? AND status IN ('queued', 'waiting-input')`,
      ).run(JSON.stringify({
        code: "DATA_QUALITY_ERROR",
        message: "Product definition dependencies are not satisfied",
        requestId: `product-dependencies:${runId}`,
        details: missing,
        retryable: false,
      }), updatedAt, String(stage.id));
      this.#refreshAnalysisRunStatus(runId, updatedAt);
      return;
    }
    const existingJob = this.#database.prepare(
      "SELECT 1 FROM job_attempts WHERE stage_id = ? LIMIT 1",
    ).get(String(stage.id));
    if (existingJob) return;
    this.#database.prepare(
      `UPDATE run_stages SET status = 'queued', progress = 0,
         completed_at = NULL, last_error_json = NULL, updated_at = ?
       WHERE id = ? AND status IN ('queued', 'waiting-input')`,
    ).run(updatedAt, String(stage.id));
    const jobId = randomUUID();
    this.#database.prepare(
      `INSERT INTO job_attempts (
         id, stage_id, attempt_number, max_attempts,
         retry_cycle_start_attempt, logical_execution_cycle_id,
         status, available_at, leased_by, lease_expires_at, lease_generation,
         retryable, retry_scheduled_at, started_at, completed_at, error_json,
         created_at, updated_at
       ) VALUES (?, ?, 1, 3, 1, ?, 'queued', ?, NULL, NULL, 0, 0, NULL, NULL,
                 NULL, NULL, ?, ?)`,
    ).run(jobId, String(stage.id), createLogicalExecutionCycleId(), updatedAt, updatedAt, updatedAt);
    this.#refreshAnalysisRunStatus(runId, updatedAt);
  }

  #durableCycleDisposition(
    current: JobAttemptRecord,
  ): DurableCycleDisposition {
    const rows = this.#database
      .prepare(
        `SELECT ar.validation_status, ar.terminal_status,
                ar.terminal_metadata_json,
                EXISTS (
                  SELECT 1 FROM analysis_reports report
                  WHERE report.agent_run_id = ar.id
                ) AS report_exists
         FROM agent_runs ar
         WHERE ar.stage_id = ? AND ar.logical_execution_cycle_id = ?`,
      )
      .all(current.stageId, current.logicalExecutionCycleId) as SqliteRow[];
    if (rows.length > 1) throw new AgentRunDataError();
    const row = rows[0];
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
        row.terminal_metadata_json === null
          ? null
          : JSON.parse(String(row.terminal_metadata_json)),
      );
    } catch {
      throw new AgentRunDataError();
    }
    if (
      row.validation_status === "passed" &&
      row.terminal_status === "succeeded" &&
      metadata.kind === "succeeded"
    ) {
      return {
        kind: "recover",
        mode: Number(row.report_exists) === 1 ? "completion-only" : "report-only",
      };
    }
    if (row.validation_status !== "failed") throw new AgentRunDataError();
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
    if (metadata.kind !== "failed") throw new AgentRunDataError();
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

  #reclaimRecoveryLease(
    current: JobAttemptRecord,
    input: ClaimJobInput,
  ): JobAttemptRecord {
    const leaseExpiresAt = addMilliseconds(
      input.claimedAt,
      input.leaseDurationMs,
    );
    const update = this.#database
      .prepare(
        `UPDATE job_attempts
         SET status = 'running', available_at = ?, leased_by = ?,
             lease_expires_at = ?, lease_generation = lease_generation + 1,
             retryable = 0, retry_scheduled_at = NULL, completed_at = NULL,
             report_publication_retry_at = NULL,
             error_json = NULL, started_at = COALESCE(started_at, ?),
             updated_at = ?
         WHERE id = ?`,
      )
      .run(
        input.claimedAt,
        input.ownerId,
        leaseExpiresAt,
        input.claimedAt,
        input.claimedAt,
        current.id,
      );
    if (Number(update.changes) !== 1) throw new JobLeaseLostError();
    this.#markStageRunning(
      current.stageId,
      current.attemptNumber,
      input.claimedAt,
    );
    return this.#findJob(current.id)!;
  }

  #settleClaimCandidate(
    current: JobAttemptRecord,
    disposition: Extract<DurableCycleDisposition, { kind: "settle" }>,
    settledAt: string,
  ) {
    this.#database
      .prepare(
        `UPDATE job_attempts
         SET status = ?, retryable = 0, leased_by = NULL,
             lease_expires_at = NULL, completed_at = COALESCE(completed_at, ?),
             error_json = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        disposition.attemptStatus,
        settledAt,
        JSON.stringify(disposition.error),
        settledAt,
        current.id,
      );
    this.#database
      .prepare(
        `UPDATE run_stages
         SET status = ?, completed_at = ?, last_error_json = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        disposition.stageStatus,
        settledAt,
        JSON.stringify(disposition.error),
        settledAt,
        current.stageId,
      );
    this.#refreshAnalysisRunStatus(current.runId, settledAt);
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
        // Retry eligibility is a durable repository decision. A delayed worker
        // timestamp must not schedule an already-expired publication retry.
        const transactionNow = this.#transactionNow();
        const current = this.#findJob(input.jobId);
        const disposition = current
          ? this.#durableCycleDisposition(current)
          : null;
        const reportOnlyRecovery =
          disposition?.kind === "recover" &&
          (disposition.mode === "report-only" ||
            disposition.mode === "completion-only") &&
          (input.error.classification === "upstream-temporary" ||
            input.error.classification === "rate-limit");
        const publication = reportOnlyRecovery
          ? nextReportPublicationFailure(current!, input, transactionNow)
          : null;
        const retryable = publication?.retryable ?? input.retryable;
        const availableAt = retryable
          ? (publication?.retryAt ?? input.retryAt ?? input.failedAt)
          : input.failedAt;
        const attemptStatus = reportOnlyRecovery
          ? "failed"
          : (input.attemptStatus ?? "failed");
        const stageStatus =
          reportOnlyRecovery
            ? retryable
              ? "queued"
              : "failed"
            : (input.stageStatus ?? (retryable ? "queued" : "failed"));
        const persistedError = publication?.error ?? input.error;
        if (
          retryable !== (stageStatus === "queued") ||
          (retryable && attemptStatus !== "failed")
        ) {
          throw new Error("Retryable jobs must return their stage to queued");
        }
        const result = this.#database
          .prepare(
            `UPDATE job_attempts
             SET status = ?, available_at = ?, leased_by = NULL,
                 lease_expires_at = NULL, retryable = ?, retry_scheduled_at = NULL,
                 completed_at = ?, error_json = ?, updated_at = ?,
                 report_publication_attempt_count = ?,
                 report_publication_max_attempts = ?,
                 report_publication_initial_delay_ms = ?,
                 report_publication_max_delay_ms = ?,
                 report_publication_retry_at = ?
             WHERE id = ? AND status = 'running' AND leased_by = ?
               AND lease_generation = ?
               AND lease_expires_at > ?`,
          )
          .run(
            attemptStatus,
            availableAt,
            retryable ? 1 : 0,
            reportOnlyRecovery ? transactionNow : input.failedAt,
            JSON.stringify(persistedError),
            reportOnlyRecovery ? transactionNow : input.failedAt,
            publication?.attemptCount ?? current!.reportPublicationAttemptCount,
            publication?.policy.maxAttempts ?? current!.reportPublicationMaxAttempts,
            publication?.policy.initialDelayMs ??
              current!.reportPublicationInitialDelayMs,
            publication?.policy.maxDelayMs ??
              current!.reportPublicationMaxDelayMs,
            publication?.retryAt ?? null,
            input.jobId,
            input.ownerId,
            input.leaseGeneration,
            reportOnlyRecovery ? transactionNow : input.failedAt,
          );
        this.#assertLeaseMutation(result.changes);
        const job = this.#findJob(input.jobId)!;
        const completedAt =
          stageStatus === "queued" || stageStatus === "waiting-input"
            ? null
            : (reportOnlyRecovery ? transactionNow : input.failedAt);
        this.#database
          .prepare(
            `UPDATE run_stages
             SET status = ?, completed_at = ?, last_error_json = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(
            stageStatus,
            completedAt,
            JSON.stringify(persistedError),
            reportOnlyRecovery ? transactionNow : input.failedAt,
            job.stageId,
          );
        this.#refreshAnalysisRunStatus(
          job.runId,
          reportOnlyRecovery ? transactionNow : input.failedAt,
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

  #authTransaction<T>(operation: () => T): Promise<T> {
    return this.#transactionContext.getStore()
      ? this.#serialize(operation)
      : this.#serialize(() => this.#withImmediateTransaction(operation));
  }

  async createInitialAdmin(
    input: InitialAdminInput,
  ): Promise<UserRecord | null> {
    const admin = validateInitialAdminInput(input);
    return this.#authTransaction(() => {
      const result = this.#database
        .prepare(
          `INSERT INTO users (
             id, organization_id, email, display_name, password_hash,
             role, status, created_at, updated_at
           )
           SELECT ?, ?, ?, ?, ?, 'admin', 'active', ?, ?
           WHERE NOT EXISTS (SELECT 1 FROM users)`,
        )
        .run(
          admin.id,
          admin.organizationId,
          admin.email,
          admin.displayName,
          admin.passwordHash,
          admin.createdAt,
          admin.createdAt,
        );

      if (Number(result.changes) !== 1) return null;

      this.#database
        .prepare(
          `INSERT INTO audit_events (
             id, organization_id, actor_user_id, action, target_type,
             target_id, metadata_json, created_at
           ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(),
          admin.organizationId,
          "auth.first-admin-initialized",
          "user",
          admin.id,
          JSON.stringify({ role: "admin" }),
          admin.createdAt,
        );

      const row = this.#database
        .prepare(
          `SELECT id, organization_id, email, display_name, role, status,
                  created_at, updated_at
           FROM users WHERE id = ?`,
        )
        .get(admin.id) as SqliteRow | undefined;
      if (!row) throw new Error("Initial admin insert was not readable");
      return mapUser(row);
    });
  }

  async createLocalUser(input: LocalUserInput): Promise<CreateLocalUserResult> {
    const { passwordHash, ...candidate } = input;
    const user = UserSchema.parse(candidate);
    if (typeof passwordHash !== "string" || passwordHash.trim().length === 0 || passwordHash.length > 1_000) {
      throw new TypeError("Invalid local user password hash");
    }
    return this.#authTransaction(() => {
      const result = this.#database.prepare(
        `INSERT INTO users (
           id, organization_id, email, display_name, password_hash,
           role, status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(email) DO NOTHING`,
      ).run(user.id, user.organizationId, user.email, user.displayName, passwordHash,
        user.role, user.status, user.createdAt, user.updatedAt);
      if (Number(result.changes) === 1) {
        this.#database.prepare(
          `INSERT INTO audit_events (
             id, organization_id, actor_user_id, action, target_type,
             target_id, metadata_json, created_at
           ) VALUES (?, ?, NULL, 'auth.local-user-created', 'user', ?, ?, ?)`,
        ).run(randomUUID(), user.organizationId, user.id, JSON.stringify({ role: user.role }), user.createdAt);
        return Object.freeze({ user, created: true });
      }
      const existing = this.#database.prepare(
        `SELECT id, organization_id, email, display_name, role, status,
                created_at, updated_at FROM users WHERE email = ? COLLATE NOCASE`,
      ).get(user.email) as SqliteRow | undefined;
      if (!existing) throw new Error("Local user conflict");
      const existingUser = mapUser(existing);
      if (existingUser.organizationId !== user.organizationId || existingUser.role !== user.role) {
        throw new Error("Local user conflict");
      }
      return Object.freeze({ user: existingUser, created: false });
    });
  }

  findAuthenticationUserByEmail(
    email: string,
  ): Promise<AuthenticationUserRecord | null> {
    return this.#serialize(() => {
      if (typeof email !== "string") return null;
      const normalizedEmail = email.trim();
      if (normalizedEmail.length === 0) return null;
      const row = this.#database
        .prepare(
          `SELECT id, organization_id, email, display_name, password_hash,
                  role, status, created_at, updated_at
           FROM users WHERE email = ? COLLATE NOCASE`,
        )
        .get(normalizedEmail) as SqliteRow | undefined;
      if (!row) return null;
      return {
        user: mapUser(row),
        passwordHash:
          row.password_hash === null ? null : String(row.password_hash),
      };
    });
  }

  findAuthenticationUserById(userId: string): Promise<AuthenticationUserRecord | null> {
    const parsed = parseEntityIdOrNull(userId);
    if (!parsed) return Promise.resolve(null);
    return this.#serialize(() => {
      const row = this.#database.prepare(
        `SELECT id, organization_id, email, display_name, password_hash,
                role, status, created_at, updated_at
           FROM users WHERE id = ?`,
      ).get(parsed) as SqliteRow | undefined;
      return row ? { user: mapUser(row), passwordHash: row.password_hash === null ? null : String(row.password_hash) } : null;
    });
  }

  async createSession(session: SessionRecord): Promise<SessionRecord> {
    const validated = validateSessionRecord(session);
    return this.#serialize(() => {
      this.#database
        .prepare(
          `INSERT INTO sessions (
             id, user_id, token_hash, expires_at, revoked_at, created_at,
             last_seen_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          validated.id,
          validated.userId,
          validated.tokenHash,
          validated.expiresAt,
          validated.revokedAt,
          validated.createdAt,
          validated.lastSeenAt,
        );
      return validated;
    });
  }

  findActiveSessionPrincipalByTokenHash(input: {
    tokenHash: string;
    asOf: string;
  }): Promise<ActiveSessionPrincipalRecord | null> {
    const tokenHash = parseTokenHash(input.tokenHash);
    const asOf = parseDateTimeOrNull(input.asOf);
    if (!tokenHash || !asOf) return Promise.resolve(null);

    return this.#serialize(() => {
      const row = this.#database
        .prepare(
          `SELECT s.id AS session_id, s.expires_at, s.created_at,
                  s.last_seen_at, u.id AS user_id, u.organization_id, u.role
           FROM sessions s
           JOIN users u ON u.id = s.user_id
           WHERE s.token_hash = ?
             AND s.revoked_at IS NULL
             AND u.status = 'active'`,
        )
        .get(tokenHash) as SqliteRow | undefined;
      if (!row || !isCanonicalFutureInstant(String(row.expires_at), asOf)) {
        return null;
      }
      return mapActiveSessionPrincipal(row);
    }).catch(() => null);
  }

  revokeSessionByTokenHash(input: {
    tokenHash: string;
    revokedAt: string;
  }): Promise<boolean> {
    const tokenHash = parseTokenHash(input.tokenHash);
    const revokedAt = parseDateTimeOrNull(input.revokedAt);
    if (!tokenHash || !revokedAt) return Promise.resolve(false);

    return this.#serialize(() => {
      const result = this.#database
        .prepare(
          `UPDATE sessions
           SET revoked_at = ?
           WHERE token_hash = ? AND revoked_at IS NULL`,
        )
        .run(revokedAt, tokenHash);
      return Number(result.changes) > 0;
    });
  }

  revokeUserSessions(input: {
    userId: string;
    revokedAt: string;
  }): Promise<number> {
    const userId = parseEntityIdOrNull(input.userId);
    const revokedAt = parseDateTimeOrNull(input.revokedAt);
    if (!userId || !revokedAt) return Promise.resolve(0);

    return this.#serialize(() => {
      const rows = this.#database
        .prepare(
          `SELECT id, expires_at
           FROM sessions
           WHERE user_id = ? AND revoked_at IS NULL`,
        )
        .all(userId) as SqliteRow[];
      const activeSessionIds = rows
        .filter((row) =>
          isCanonicalFutureInstant(String(row.expires_at), revokedAt),
        )
        .map((row) => String(row.id));
      if (activeSessionIds.length === 0) return 0;

      const placeholders = activeSessionIds.map(() => "?").join(", ");
      const result = this.#database
        .prepare(
          `UPDATE sessions
           SET revoked_at = ?
           WHERE id IN (${placeholders})`,
        )
        .run(revokedAt, ...activeSessionIds);
      return Number(result.changes);
    });
  }

  changeUserPassword(input: {
    userId: string;
    currentSessionId: string;
    expectedPasswordHash: string;
    passwordHash: string;
    changedAt: string;
    auditEventId: string;
  }): Promise<boolean> {
    const userId = parseEntityIdOrNull(input.userId);
    const currentSessionId = parseEntityIdOrNull(input.currentSessionId);
    const changedAt = parseDateTimeOrNull(input.changedAt);
    const auditEventId = parseEntityIdOrNull(input.auditEventId);
    if (!userId || !currentSessionId || !changedAt || !auditEventId ||
      typeof input.expectedPasswordHash !== "string" || input.expectedPasswordHash.trim().length === 0 || input.expectedPasswordHash.length > 1_000 ||
      typeof input.passwordHash !== "string" || input.passwordHash.trim().length === 0 || input.passwordHash.length > 1_000) {
      return Promise.resolve(false);
    }
    return this.#authTransaction(() => {
      const user = this.#database.prepare(
        "SELECT organization_id FROM users WHERE id = ? AND status = 'active'",
      ).get(userId) as SqliteRow | undefined;
      if (!user) return false;
      const updated = this.#database.prepare(
        `UPDATE users SET password_hash = ?, updated_at = ?
          WHERE id = ? AND status = 'active' AND password_hash = ?`,
      ).run(input.passwordHash, changedAt, userId, input.expectedPasswordHash);
      if (Number(updated.changes) !== 1) return false;
      this.#database.prepare(
        `UPDATE sessions SET revoked_at = ?
          WHERE user_id = ? AND id <> ? AND revoked_at IS NULL`,
      ).run(changedAt, userId, currentSessionId);
      this.#database.prepare(
        `INSERT INTO audit_events (
           id, organization_id, actor_user_id, action, target_type, target_id,
           metadata_json, created_at
         ) VALUES (?, ?, ?, 'auth.password-changed', 'user', ?, '{}', ?)`,
      ).run(auditEventId, String(user.organization_id), userId, userId, changedAt);
      return true;
    });
  }

  createUserFeedback(input: CreateUserFeedbackInput): Promise<UserFeedbackRecord | null> {
    const feedback = validateUserFeedback(input);
    const initialEventId = EntityIdSchema.parse(input.initialEventId ?? feedback.id);
    const attachments = validateFeedbackAttachments(input.attachments ?? []);
    return this.#agentRunTransaction(() => {
      const row = this.#database.prepare(
        `INSERT INTO user_feedback (
           id, organization_id, actor_user_id, category, title, description,
           page_path, app_version, created_at
         )
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
           FROM users
          WHERE id = ? AND organization_id = ? AND status = 'active'
         RETURNING *`,
      ).get(feedback.id, feedback.organizationId, feedback.actorUserId,
        feedback.category, feedback.title, feedback.description,
        feedback.pagePath, feedback.appVersion, feedback.createdAt,
        feedback.actorUserId, feedback.organizationId) as SqliteRow | undefined;
      if (!row) return null;
      this.#database.prepare(
        `INSERT INTO user_feedback_workflow
           (feedback_id, organization_id, status, admin_seen_at, version, updated_at)
         VALUES (?, ?, 'new', NULL, 1, ?)`,
      ).run(feedback.id, feedback.organizationId, feedback.createdAt);
      this.#database.prepare(
        `INSERT INTO user_feedback_events
           (id, feedback_id, organization_id, actor_user_id,
            event_type, from_status, to_status, created_at)
         VALUES (?, ?, ?, ?, 'created', NULL, 'new', ?)`,
      ).run(initialEventId, feedback.id, feedback.organizationId, feedback.actorUserId, feedback.createdAt);
      const insertAttachment = this.#database.prepare(
        `INSERT INTO user_feedback_attachments
           (id, feedback_id, organization_id, created_by_user_id, file_name,
            media_type, byte_size, sha256, image_content, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const attachment of attachments) {
        insertAttachment.run(
          attachment.id, feedback.id, feedback.organizationId, feedback.actorUserId,
          attachment.fileName, attachment.mediaType, attachment.byteSize,
          attachment.sha256, attachment.imageContent, attachment.createdAt,
        );
      }
      return mapUserFeedback(row);
    });
  }

  listOwnFeedback(input: { organizationId: string; actorUserId: string }): Promise<readonly FeedbackListRecord[]> {
    const organizationId = EntityIdSchema.parse(input.organizationId);
    const actorUserId = EntityIdSchema.parse(input.actorUserId);
    return this.#serialize(() => (this.#database.prepare(
      `${userFeedbackListSelect}
       WHERE feedback.organization_id = ? AND feedback.actor_user_id = ?
       ORDER BY feedback.created_at DESC, feedback.id`,
    ).all(organizationId, actorUserId) as SqliteRow[]).map(mapFeedbackList));
  }

  getOwnFeedbackDetail(input: { organizationId: string; actorUserId: string; feedbackId: string }): Promise<FeedbackDetailRecord | null> {
    return this.#feedbackDetail(input.organizationId, input.feedbackId, input.actorUserId);
  }

  listOrganizationFeedback(input: { organizationId: string; status: FeedbackStatus | null }): Promise<readonly FeedbackListRecord[]> {
    const organizationId = EntityIdSchema.parse(input.organizationId);
    const status = input.status === null ? null : validateFeedbackStatus(input.status);
    return this.#serialize(() => {
      const rows = status === null
        ? this.#database.prepare(`${userFeedbackListSelect} WHERE feedback.organization_id = ? ORDER BY feedback.created_at DESC, feedback.id`).all(organizationId)
        : this.#database.prepare(`${userFeedbackListSelect} WHERE feedback.organization_id = ? AND workflow.status = ? ORDER BY feedback.created_at DESC, feedback.id`).all(organizationId, status);
      return (rows as SqliteRow[]).map(mapFeedbackList);
    });
  }

  getOrganizationFeedbackDetail(input: { organizationId: string; feedbackId: string }): Promise<FeedbackDetailRecord | null> {
    return this.#feedbackDetail(input.organizationId, input.feedbackId, null);
  }

  #feedbackDetail(organizationIdInput: string, feedbackIdInput: string, actorUserIdInput: string | null): Promise<FeedbackDetailRecord | null> {
    const organizationId = EntityIdSchema.parse(organizationIdInput);
    const feedbackId = EntityIdSchema.parse(feedbackIdInput);
    const actorUserId = actorUserIdInput === null ? null : EntityIdSchema.parse(actorUserIdInput);
    return this.#serialize(() => {
      const row = actorUserId === null
        ? this.#database.prepare(`${userFeedbackListSelect} WHERE feedback.organization_id = ? AND feedback.id = ?`).get(organizationId, feedbackId)
        : this.#database.prepare(`${userFeedbackListSelect} WHERE feedback.organization_id = ? AND feedback.actor_user_id = ? AND feedback.id = ?`).get(organizationId, actorUserId, feedbackId);
      if (!row) return null;
      const attachments = (this.#database.prepare(
        `SELECT id, feedback_id, file_name, media_type, byte_size, sha256, created_at
           FROM user_feedback_attachments
          WHERE organization_id = ? AND feedback_id = ?
          ORDER BY created_at, id`,
      ).all(organizationId, feedbackId) as SqliteRow[]).map(mapFeedbackAttachmentMetadata);
      const events = (this.#database.prepare(
        `SELECT id, feedback_id, actor_user_id, event_type, from_status, to_status, created_at
           FROM user_feedback_events
          WHERE organization_id = ? AND feedback_id = ?
          ORDER BY created_at, id`,
      ).all(organizationId, feedbackId) as SqliteRow[]).map(mapFeedbackEvent);
      return Object.freeze({ ...mapFeedbackList(row as SqliteRow), attachments, events });
    });
  }

  readOwnFeedbackAttachment(input: { organizationId: string; actorUserId: string; feedbackId: string; attachmentId: string }): Promise<FeedbackAttachmentRecord | null> {
    return this.#readFeedbackAttachment(input.organizationId, input.feedbackId, input.attachmentId, input.actorUserId);
  }

  readOrganizationFeedbackAttachment(input: { organizationId: string; feedbackId: string; attachmentId: string }): Promise<FeedbackAttachmentRecord | null> {
    return this.#readFeedbackAttachment(input.organizationId, input.feedbackId, input.attachmentId, null);
  }

  #readFeedbackAttachment(organizationIdInput: string, feedbackIdInput: string, attachmentIdInput: string, actorUserIdInput: string | null): Promise<FeedbackAttachmentRecord | null> {
    const organizationId = EntityIdSchema.parse(organizationIdInput);
    const feedbackId = EntityIdSchema.parse(feedbackIdInput);
    const attachmentId = EntityIdSchema.parse(attachmentIdInput);
    const actorUserId = actorUserIdInput === null ? null : EntityIdSchema.parse(actorUserIdInput);
    return this.#serialize(() => {
      const sql = `SELECT attachment.id, attachment.feedback_id, attachment.file_name,
                          attachment.media_type, attachment.byte_size, attachment.sha256,
                          attachment.image_content, attachment.created_at
                     FROM user_feedback_attachments attachment
                     JOIN user_feedback feedback ON feedback.id = attachment.feedback_id
                    WHERE attachment.organization_id = ? AND attachment.feedback_id = ?
                      AND attachment.id = ?${actorUserId === null ? "" : " AND feedback.actor_user_id = ?"}`;
      const row = this.#database.prepare(sql).get(...(actorUserId === null
        ? [organizationId, feedbackId, attachmentId]
        : [organizationId, feedbackId, attachmentId, actorUserId])) as SqliteRow | undefined;
      return row ? Object.freeze({ ...mapFeedbackAttachmentMetadata(row), imageContent: Buffer.from(row.image_content as Uint8Array) }) : null;
    });
  }

  countUnreadOrganizationFeedback(organizationIdInput: string): Promise<number> {
    const organizationId = EntityIdSchema.parse(organizationIdInput);
    return this.#serialize(() => Number((this.#database.prepare(
      "SELECT COUNT(*) AS count FROM user_feedback_workflow WHERE organization_id = ? AND admin_seen_at IS NULL",
    ).get(organizationId) as SqliteRow).count));
  }

  markOrganizationFeedbackSeen(input: { organizationId: string; feedbackId: string; seenAt: string }): Promise<"changed" | "unchanged" | null> {
    const organizationId = EntityIdSchema.parse(input.organizationId);
    const feedbackId = EntityIdSchema.parse(input.feedbackId);
    const seenAt = DateTimeSchema.parse(input.seenAt);
    return this.#agentRunTransaction(() => {
      const updated = this.#database.prepare(
        `UPDATE user_feedback_workflow SET admin_seen_at = ?, updated_at = ?
          WHERE organization_id = ? AND feedback_id = ? AND admin_seen_at IS NULL`,
      ).run(seenAt, seenAt, organizationId, feedbackId);
      if (Number(updated.changes) === 1) return "changed";
      return this.#database.prepare(
        "SELECT 1 FROM user_feedback_workflow WHERE organization_id = ? AND feedback_id = ?",
      ).get(organizationId, feedbackId) ? "unchanged" : null;
    });
  }

  changeOrganizationFeedbackStatus(input: { organizationId: string; feedbackId: string; actorUserId: string; expectedVersion: number; status: FeedbackStatus; eventId: string; changedAt: string }): Promise<FeedbackListRecord | null> {
    const organizationId = EntityIdSchema.parse(input.organizationId);
    const feedbackId = EntityIdSchema.parse(input.feedbackId);
    const actorUserId = EntityIdSchema.parse(input.actorUserId);
    const eventId = EntityIdSchema.parse(input.eventId);
    const status = validateFeedbackStatus(input.status);
    const changedAt = DateTimeSchema.parse(input.changedAt);
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) throw new TypeError("Invalid feedback workflow version");
    return this.#agentRunTransaction(() => {
      const current = this.#database.prepare(
        `SELECT workflow.status, workflow.version
           FROM user_feedback_workflow workflow
           JOIN users actor ON actor.id = ? AND actor.organization_id = workflow.organization_id AND actor.status = 'active'
          WHERE workflow.organization_id = ? AND workflow.feedback_id = ? AND workflow.version = ?`,
      ).get(actorUserId, organizationId, feedbackId, input.expectedVersion) as SqliteRow | undefined;
      if (!current) return null;
      if (String(current.status) === status) {
        const row = this.#database.prepare(`${userFeedbackListSelect} WHERE feedback.organization_id = ? AND feedback.id = ?`).get(organizationId, feedbackId) as SqliteRow;
        return mapFeedbackList(row);
      }
      const updated = this.#database.prepare(
        `UPDATE user_feedback_workflow
            SET status = ?, version = version + 1, updated_at = ?
          WHERE organization_id = ? AND feedback_id = ? AND version = ?`,
      ).run(status, changedAt, organizationId, feedbackId, input.expectedVersion);
      if (Number(updated.changes) !== 1) return null;
      this.#database.prepare(
        `INSERT INTO user_feedback_events
           (id, feedback_id, organization_id, actor_user_id,
            event_type, from_status, to_status, created_at)
         VALUES (?, ?, ?, ?, 'status_changed', ?, ?, ?)`,
      ).run(eventId, feedbackId, organizationId, actorUserId, String(current.status), status, changedAt);
      const row = this.#database.prepare(`${userFeedbackListSelect} WHERE feedback.organization_id = ? AND feedback.id = ?`).get(organizationId, feedbackId) as SqliteRow;
      return mapFeedbackList(row);
    });
  }

  close() {
    this.#database.close();
  }
}

const canonicalEntityIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sha256Pattern = /^[0-9a-f]{64}$/;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseEntityIdOrNull(value: string) {
  const parsed = EntityIdSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseDateTimeOrNull(value: string) {
  const parsed = DateTimeSchema.safeParse(value);
  return parsed.success ? new Date(parsed.data).toISOString() : null;
}

function parseCanonicalStoredDateTimeOrNull(value: string) {
  const canonical = parseDateTimeOrNull(value);
  return canonical === value ? canonical : null;
}

function isCanonicalFutureInstant(expiresAt: string, asOf: string) {
  const canonicalExpiresAt = parseCanonicalStoredDateTimeOrNull(expiresAt);
  if (!canonicalExpiresAt) return false;
  return new Date(canonicalExpiresAt).getTime() > new Date(asOf).getTime();
}

function parseTokenHash(value: string) {
  const parsed = Sha256Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

const connectorCredentialConnectors = new Set([
  "sif",
  "sorftime",
  "sellerSprite",
]);
const connectorCredentialKeyIdPattern = /^sha256:[a-f0-9]{64}$/;

function validateConnectorCredentialIdentity(
  organizationId: string,
  connector: ConnectorCredentialRecord["connector"],
) {
  const organization = EntityIdSchema.safeParse(organizationId);
  if (!organization.success || !connectorCredentialConnectors.has(connector)) {
    return null;
  }
  return { organizationId: organization.data, connector };
}

function validateEncryptedConnectorCredential(input: {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  authTag: Uint8Array;
  keyId: string;
}) {
  const ciphertext = Buffer.from(input.ciphertext);
  const nonce = Buffer.from(input.nonce);
  const authTag = Buffer.from(input.authTag);
  if (
    ciphertext.byteLength < 1 ||
    ciphertext.byteLength > 8_192 ||
    nonce.byteLength !== 12 ||
    authTag.byteLength !== 16 ||
    !connectorCredentialKeyIdPattern.test(input.keyId)
  ) {
    throw new TypeError("Invalid encrypted connector credential");
  }
  return { ciphertext, nonce, authTag, keyId: input.keyId };
}

function validateExpectedConnectorCredentialVersion(value: number | null) {
  if (
    value !== null &&
    (!Number.isSafeInteger(value) || value < 1)
  ) {
    throw new TypeError("Invalid connector credential version");
  }
  return value;
}

function validateRotateConnectorCredentialInput(
  input: RotateConnectorCredentialInput,
): RotateConnectorCredentialInput {
  const identity = validateConnectorCredentialIdentity(
    input.organizationId,
    input.connector,
  );
  if (!identity || !Number.isSafeInteger(input.version) || input.version < 1) {
    throw new TypeError("Invalid connector credential rotation");
  }
  return Object.freeze({
    ...identity,
    id: EntityIdSchema.parse(input.id),
    version: input.version,
    expectedLatestVersion: validateExpectedConnectorCredentialVersion(
      input.expectedLatestVersion,
    ),
    ...validateEncryptedConnectorCredential(input),
    actorUserId: EntityIdSchema.parse(input.actorUserId),
    rotatedAt: DateTimeSchema.parse(input.rotatedAt),
    statusId: EntityIdSchema.parse(input.statusId),
    auditEventId: EntityIdSchema.parse(input.auditEventId),
  });
}

function validateRevokeConnectorCredentialInput(
  input: RevokeConnectorCredentialInput,
): RevokeConnectorCredentialInput {
  const identity = validateConnectorCredentialIdentity(
    input.organizationId,
    input.connector,
  );
  if (!identity) throw new TypeError("Invalid connector credential revocation");
  return Object.freeze({
    ...identity,
    expectedLatestVersion: validateExpectedConnectorCredentialVersion(
      input.expectedLatestVersion,
    ),
    actorUserId: EntityIdSchema.parse(input.actorUserId),
    revokedAt: DateTimeSchema.parse(input.revokedAt),
    tombstoneId: EntityIdSchema.parse(input.tombstoneId),
    ...validateEncryptedConnectorCredential(input),
    statusId: EntityIdSchema.parse(input.statusId),
    auditEventId: EntityIdSchema.parse(input.auditEventId),
  });
}

function validateInitialAdminInput(input: InitialAdminInput): InitialAdminInput {
  const id = EntityIdSchema.parse(input.id);
  const organizationId = EntityIdSchema.parse(input.organizationId);
  const email = input.email.trim();
  if (!emailPattern.test(email) || email.length > 320) {
    throw new TypeError("Invalid initial admin email");
  }
  const displayName = input.displayName.trim();
  if (displayName.length === 0 || displayName.length > 200) {
    throw new TypeError("Invalid initial admin display name");
  }
  if (
    typeof input.passwordHash !== "string" ||
    input.passwordHash.trim().length === 0 ||
    input.passwordHash.length > 1000
  ) {
    throw new TypeError("Invalid initial admin password hash");
  }
  const createdAt = DateTimeSchema.parse(input.createdAt);
  return {
    id,
    organizationId,
    email,
    displayName,
    passwordHash: input.passwordHash,
    createdAt: new Date(createdAt).toISOString(),
  };
}

function validateSessionRecord(session: SessionRecord): SessionRecord {
  const id = parseEntityIdOrNull(session.id);
  const userId = parseEntityIdOrNull(session.userId);
  const tokenHash = parseTokenHash(session.tokenHash);
  const expiresAt = parseDateTimeOrNull(session.expiresAt);
  const createdAt = parseDateTimeOrNull(session.createdAt);
  const revokedAt =
    session.revokedAt === null ? null : parseDateTimeOrNull(session.revokedAt);
  const lastSeenAt =
    session.lastSeenAt === null
      ? null
      : parseDateTimeOrNull(session.lastSeenAt);
  if (
    !id ||
    !userId ||
    !tokenHash ||
    !expiresAt ||
    !createdAt ||
    (session.revokedAt !== null && !revokedAt) ||
    (session.lastSeenAt !== null && !lastSeenAt)
  ) {
    throw new TypeError("Invalid session record");
  }
  return {
    id,
    userId,
    tokenHash,
    expiresAt,
    revokedAt,
    createdAt,
    lastSeenAt,
  };
}

function validateUserFeedback(input: UserFeedbackRecord): UserFeedbackRecord {
  const id = EntityIdSchema.parse(input.id);
  const organizationId = EntityIdSchema.parse(input.organizationId);
  const actorUserId = EntityIdSchema.parse(input.actorUserId);
  const category = ["bug", "suggestion", "other"].includes(input.category) ? input.category : null;
  const title = input.title.trim();
  const description = input.description.trim();
  const pagePath = input.pagePath.trim();
  const appVersion = input.appVersion?.trim() ?? null;
  if (!category || title.length < 1 || title.length > 200 ||
    description.length < 1 || description.length > 4_000 ||
    pagePath.length < 1 || pagePath.length > 1_000 || !pagePath.startsWith("/") || /[?#]/.test(pagePath) ||
    (appVersion !== null && (appVersion.length < 1 || appVersion.length > 100))) {
    throw new TypeError("Invalid user feedback");
  }
  return { id, organizationId, actorUserId, category, title, description, pagePath,
    appVersion, createdAt: DateTimeSchema.parse(input.createdAt) };
}

function validateFeedbackStatus(value: string): FeedbackStatus {
  if (value === "new" || value === "processing" || value === "resolved" || value === "closed") return value;
  throw new TypeError("Invalid feedback status");
}

function validateFeedbackAttachments(input: readonly FeedbackAttachmentWrite[]) {
  if (input.length > 3) throw new TypeError("Invalid feedback attachments");
  return input.map((attachment) => {
    const id = EntityIdSchema.parse(attachment.id);
    const fileName = attachment.fileName.trim();
    const mediaType = attachment.mediaType;
    const imageContent = Buffer.from(attachment.imageContent);
    const createdAt = DateTimeSchema.parse(attachment.createdAt);
    if (
      fileName.length < 1 || fileName.length > 255 || /[\\/\u0000-\u001f\u007f]/.test(fileName) ||
      !["image/png", "image/jpeg", "image/webp"].includes(mediaType) ||
      !Number.isSafeInteger(attachment.byteSize) || attachment.byteSize < 1 || attachment.byteSize > 5 * 1024 * 1024 ||
      imageContent.byteLength !== attachment.byteSize || !/^[0-9a-f]{64}$/.test(attachment.sha256)
    ) throw new TypeError("Invalid feedback attachment");
    return Object.freeze({ ...attachment, id, fileName, mediaType, imageContent, createdAt });
  });
}

function mapUserFeedback(row: SqliteRow): UserFeedbackRecord {
  return validateUserFeedback({
    id: String(row.id),
    organizationId: String(row.organization_id),
    actorUserId: String(row.actor_user_id),
    category: String(row.category) as UserFeedbackRecord["category"],
    title: String(row.title),
    description: String(row.description),
    pagePath: String(row.page_path),
    appVersion: row.app_version === null ? null : String(row.app_version),
    createdAt: String(row.created_at),
  });
}

function mapFeedbackList(row: SqliteRow): FeedbackListRecord {
  return Object.freeze({
    ...mapUserFeedback(row),
    status: validateFeedbackStatus(String(row.status)),
    workflowVersion: Number(row.workflow_version),
    adminSeenAt: row.admin_seen_at === null ? null : DateTimeSchema.parse(String(row.admin_seen_at)),
    attachmentCount: Number(row.attachment_count),
  });
}

function mapFeedbackAttachmentMetadata(row: SqliteRow): FeedbackAttachmentMetadata {
  return Object.freeze({
    id: EntityIdSchema.parse(row.id),
    feedbackId: EntityIdSchema.parse(row.feedback_id),
    fileName: String(row.file_name),
    mediaType: String(row.media_type) as FeedbackAttachmentMetadata["mediaType"],
    byteSize: Number(row.byte_size),
    sha256: String(row.sha256),
    createdAt: DateTimeSchema.parse(row.created_at),
  });
}

function mapFeedbackEvent(row: SqliteRow): FeedbackStatusEventRecord {
  return Object.freeze({
    id: EntityIdSchema.parse(row.id),
    feedbackId: EntityIdSchema.parse(row.feedback_id),
    actorUserId: EntityIdSchema.parse(row.actor_user_id),
    eventType: String(row.event_type) as FeedbackStatusEventRecord["eventType"],
    fromStatus: row.from_status === null ? null : validateFeedbackStatus(String(row.from_status)),
    toStatus: validateFeedbackStatus(String(row.to_status)),
    createdAt: DateTimeSchema.parse(row.created_at),
  });
}

function mapActiveSessionPrincipal(
  row: SqliteRow,
): ActiveSessionPrincipalRecord | null {
  const sessionId = parseEntityIdOrNull(String(row.session_id));
  const userId = parseEntityIdOrNull(String(row.user_id));
  const organizationId = parseEntityIdOrNull(String(row.organization_id));
  const expiresAt = parseCanonicalStoredDateTimeOrNull(String(row.expires_at));
  const createdAt = parseCanonicalStoredDateTimeOrNull(String(row.created_at));
  const lastSeenAt =
    row.last_seen_at === null
      ? null
      : parseCanonicalStoredDateTimeOrNull(String(row.last_seen_at));
  const role = String(row.role);
  if (
    !sessionId ||
    !userId ||
    !organizationId ||
    !expiresAt ||
    !createdAt ||
    (row.last_seen_at !== null && !lastSeenAt) ||
    (role !== "admin" && role !== "member")
  ) {
    return null;
  }
  return {
    sessionId,
    userId,
    organizationId,
    role,
  };
}

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
    (input.logicalExecutionLineage !== undefined &&
      !sha256Pattern.test(input.logicalExecutionLineage)) ||
    (input.logicalExecutionCycleId !== undefined &&
      !sha256Pattern.test(input.logicalExecutionCycleId)) ||
    ((input.logicalExecutionLineage === undefined) !==
      (input.logicalExecutionCycleId === undefined)) ||
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

function validatePublishVocPositioningReportInput(
  input: PublishVocPositioningReportInput,
): PublishVocPositioningReportInput {
  const ids = {
    id: EntityIdSchema.parse(input.id),
    actorId: EntityIdSchema.parse(input.actorId),
    actorOrganizationId: EntityIdSchema.parse(input.actorOrganizationId),
    expectedProjectId: EntityIdSchema.parse(input.expectedProjectId),
    runId: EntityIdSchema.parse(input.runId),
    stageId: EntityIdSchema.parse(input.stageId),
    jobAttemptId: EntityIdSchema.parse(input.jobAttemptId),
    agentRunId: EntityIdSchema.parse(input.agentRunId),
    snapshotId: EntityIdSchema.parse(input.snapshotId),
  };
  const publishedAt = canonicalizeDateTime(
    input.publishedAt,
    "analysisReport.publishedAt",
  );
  assertNonEmptyAuditString(input.leaseOwnerId, "analysisReport.leaseOwnerId");
  if (!Number.isSafeInteger(input.leaseGeneration) || input.leaseGeneration <= 0) {
    throw new TypeError("Invalid analysis report lease generation");
  }
  return {
    ...input,
    ...ids,
    factsDigest: Sha256Schema.parse(input.factsDigest),
    logicalExecutionLineage: Sha256Schema.parse(input.logicalExecutionLineage),
    skill: SkillProvenanceSchema.parse(input.skill),
    model: ModelProvenanceSchema.parse(input.model),
    publishedAt,
    result: VocPositioningOutputShapeSchema.parse(input.result),
  };
}

function validatePublishTrafficAnalysisReportInput(
  input: PublishTrafficAnalysisReportInput,
): PublishTrafficAnalysisReportInput {
  const ids = {
    id: EntityIdSchema.parse(input.id),
    actorId: EntityIdSchema.parse(input.actorId),
    actorOrganizationId: EntityIdSchema.parse(input.actorOrganizationId),
    expectedProjectId: EntityIdSchema.parse(input.expectedProjectId),
    runId: EntityIdSchema.parse(input.runId),
    stageId: EntityIdSchema.parse(input.stageId),
    jobAttemptId: EntityIdSchema.parse(input.jobAttemptId),
    agentRunId: EntityIdSchema.parse(input.agentRunId),
    snapshotId: EntityIdSchema.parse(input.snapshotId),
  };
  const publishedAt = canonicalizeDateTime(input.publishedAt, "analysisReport.publishedAt");
  assertNonEmptyAuditString(input.leaseOwnerId, "analysisReport.leaseOwnerId");
  if (!Number.isSafeInteger(input.leaseGeneration) || input.leaseGeneration <= 0) {
    throw new TypeError("Invalid analysis report lease generation");
  }
  const result = TrafficAnalysisOutputSchema.parse(input.result);
  assertTrafficCapabilityLanguage(result);
  return {
    ...input,
    ...ids,
    logicalExecutionLineage: Sha256Schema.parse(input.logicalExecutionLineage),
    skill: SkillProvenanceSchema.parse(input.skill),
    model: ModelProvenanceSchema.parse(input.model),
    publishedAt,
    result,
  };
}

function validatePublishProductDefinitionReportInput(
  input: PublishProductDefinitionReportInput,
): PublishProductDefinitionReportInput {
  const ids = {
    id: EntityIdSchema.parse(input.id),
    actorId: EntityIdSchema.parse(input.actorId),
    actorOrganizationId: EntityIdSchema.parse(input.actorOrganizationId),
    expectedProjectId: EntityIdSchema.parse(input.expectedProjectId),
    runId: EntityIdSchema.parse(input.runId),
    stageId: EntityIdSchema.parse(input.stageId),
    jobAttemptId: EntityIdSchema.parse(input.jobAttemptId),
    agentRunId: EntityIdSchema.parse(input.agentRunId),
    vocReportId: EntityIdSchema.parse(input.vocReportId),
    keywordSnapshotId: EntityIdSchema.parse(input.keywordSnapshotId),
  };
  assertNonEmptyAuditString(input.leaseOwnerId, "analysisReport.leaseOwnerId");
  if (!Number.isSafeInteger(input.leaseGeneration) || input.leaseGeneration <= 0) {
    throw new TypeError("Invalid analysis report lease generation");
  }
  const result = ProductDefinitionOutputShapeSchema.parse(input.result);
  assertProductDefinitionCapabilityLanguage(result);
  return {
    ...input,
    ...ids,
    logicalExecutionLineage: Sha256Schema.parse(input.logicalExecutionLineage),
    skill: SkillProvenanceSchema.parse(input.skill),
    model: ModelProvenanceSchema.parse(input.model),
    publishedAt: canonicalizeDateTime(input.publishedAt, "analysisReport.publishedAt"),
    result,
  };
}

function samePublishedReport(
  report: AnalysisReport<VocPositioningOutput>,
  input: PublishVocPositioningReportInput,
) {
  return (
    report.runId === input.runId &&
    report.agentRunId === input.agentRunId &&
    report.stage === "voc-positioning" &&
    report.status === input.result.status &&
    isDeepStrictEqual(report.skill, input.skill) &&
    isDeepStrictEqual(report.snapshotIds, [input.snapshotId]) &&
    isDeepStrictEqual(report.model, input.model) &&
    sameDateTimeInstant(report.dataCutoffAt, input.result.identity.dataCutoffAt) &&
    isDeepStrictEqual(report.result, input.result)
  );
}

function samePublishedTrafficReport(
  report: AnalysisReport<VocPositioningOutput | TrafficAnalysisOutput | ProductDefinitionOutput>,
  input: PublishTrafficAnalysisReportInput,
) {
  return (
    report.runId === input.runId &&
    report.agentRunId === input.agentRunId &&
    report.stage === "traffic-analysis" &&
    report.status === input.result.status &&
    isDeepStrictEqual(report.skill, input.skill) &&
    isDeepStrictEqual(report.snapshotIds, [input.snapshotId]) &&
    isDeepStrictEqual(report.model, input.model) &&
    sameDateTimeInstant(report.dataCutoffAt, input.result.identity.dataCutoffAt) &&
    isDeepStrictEqual(report.result, input.result)
  );
}

function samePublishedProductReport(
  report: AnalysisReport<VocPositioningOutput | TrafficAnalysisOutput | ProductDefinitionOutput>,
  input: PublishProductDefinitionReportInput,
  vocSnapshotIds: readonly string[],
) {
  return (
    report.runId === input.runId &&
    report.agentRunId === input.agentRunId &&
    report.stage === "product-definition" &&
    report.status === input.result.status &&
    isDeepStrictEqual(report.skill, input.skill) &&
    isDeepStrictEqual(report.snapshotIds, [...vocSnapshotIds, input.keywordSnapshotId]) &&
    isDeepStrictEqual(report.model, input.model) &&
    sameDateTimeInstant(report.dataCutoffAt, input.result.identity.dataCutoffAt) &&
    isDeepStrictEqual(report.result, input.result)
  );
}

function analysisReportEvidence(
  result: VocPositioningOutput,
  facts: ReturnType<typeof preprocessVocSnapshot>,
) {
  const ids = new Set<string>();
  const add = (values: readonly string[]) => values.forEach((id) => ids.add(id));
  add(result.coreConclusion.evidenceIds);
  result.positioning.forEach((item) => add(item.evidenceIds));
  result.themeJudgments.forEach((item) => add(item.evidenceIds));
  result.actions.forEach((item) => add(item.evidenceIds));
  Object.values(result.checklists).forEach((list) =>
    list.forEach((item) => add(item.evidenceIds)),
  );
  result.nextValidations.forEach((item) => add(item.evidenceIds));
  const byId = new Map(facts.evidenceIndex.map((item) => [item.id, item]));
  return [...ids]
    .sort()
    .map((id) => {
      const evidence = byId.get(id);
      if (!evidence) throw new AnalysisReportConflictError();
      return {
        id,
        type: "theme" as const,
        sourceId: evidence.sourceId,
        capturedAt: evidence.capturedAt,
      };
    });
}

function mapAnalysisReport(
  row: SqliteRow,
): Readonly<AnalysisReport<VocPositioningOutput | TrafficAnalysisOutput | ProductDefinitionOutput>> {
  try {
    const resultJson = JSON.parse(String(row.result_json));
    const result = row.stage === "traffic-analysis"
      ? TrafficAnalysisOutputSchema.parse(resultJson)
      : row.stage === "product-definition"
        ? ProductDefinitionOutputShapeSchema.parse(resultJson)
        : VocPositioningOutputShapeSchema.parse(resultJson);
    if (row.stage === "traffic-analysis") assertTrafficCapabilityLanguage(result);
    if (row.stage === "product-definition") assertProductDefinitionCapabilityLanguage(result);
    const report = AnalysisReportSchema.parse({
      schemaVersion: String(row.schema_version),
      id: String(row.id),
      runId: String(row.run_id),
      agentRunId: String(row.agent_run_id),
      version: Number(row.version),
      stage: String(row.stage),
      status: String(row.status),
      skill: {
        id: String(row.skill_id),
        version: String(row.skill_version),
        contentHash: String(row.skill_content_hash),
      },
      snapshotIds: JSON.parse(String(row.snapshot_ids_json)),
      model: {
        provider: String(row.provider),
        model: String(row.model),
        ...(row.response_id === null
          ? {}
          : { responseId: String(row.response_id) }),
      },
      dataCutoffAt: String(row.data_cutoff_at),
      evidence: JSON.parse(String(row.evidence_json)),
      result,
      createdAt: String(row.created_at),
    });
    return deepFreeze({ ...report, result });
  } catch (error) {
    if (error instanceof AnalysisReportDataError) throw error;
    throw new AnalysisReportDataError();
  }
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
  storedLogicalExecutionLineage: string | null,
  storedLogicalExecutionCycleId: string | null,
) {
  return (
    record.runId === input.runId &&
    record.stageId === input.stageId &&
    record.jobAttemptId === input.jobAttemptId &&
    storedLogicalExecutionLineage === (input.logicalExecutionLineage ?? null) &&
    storedLogicalExecutionCycleId ===
      (input.logicalExecutionCycleId ?? null) &&
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

function sameAgentRunLogicalIdentity(
  record: AgentRunAudit,
  input: BeginAgentRunInput,
  storedSkillVersionId: string,
  storedLogicalExecutionLineage: string | null,
  storedLogicalExecutionCycleId: string | null,
) {
  return (
    record.runId === input.runId &&
    record.stageId === input.stageId &&
    storedLogicalExecutionLineage ===
      (input.logicalExecutionLineage ?? null) &&
    storedLogicalExecutionCycleId ===
      (input.logicalExecutionCycleId ?? null) &&
    storedSkillVersionId === input.skillVersionId &&
    record.outputSchemaDigest === input.outputSchemaDigest &&
    isDeepStrictEqual(record.snapshotIds, input.snapshotIds) &&
    record.model.provider === input.provider &&
    record.model.model === input.model &&
    isDeepStrictEqual(record.inputSummary, input.inputSummary) &&
    record.outputSchemaVersion === input.outputSchemaVersion &&
    sameDateTimeInstant(record.dataCutoffAt, input.dataCutoffAt)
  );
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

function validateCreateTrafficDataSnapshotInput(
  input: CreateTrafficDataSnapshotForRunInput,
): CreateTrafficDataSnapshotForRunInput {
  return {
    ...validateDataSnapshotSubjectInput(input),
    candidateId: EntityIdSchema.parse(input.candidateId),
    createdAt: canonicalizeDateTime(input.createdAt, "trafficSnapshot.createdAt"),
    candidate: TrafficSnapshotCandidateSchema.parse(input.candidate),
  };
}

function validateCreateKeywordAnalysisSnapshotInput(
  input: CreateKeywordAnalysisSnapshotForRunInput,
): CreateKeywordAnalysisSnapshotForRunInput {
  return {
    ...validateDataSnapshotSubjectInput(input),
    candidateId: EntityIdSchema.parse(input.candidateId),
    createdAt: canonicalizeDateTime(input.createdAt, "keywordSnapshot.createdAt"),
    candidate: KeywordAnalysisSnapshotCandidateSchema.parse(input.candidate),
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

function mapTrafficDataSnapshot(row: SqliteRow): TrafficDataSnapshotRecord {
  try {
    return deepFreeze(TrafficDataSnapshotRecordSchema.parse({
      kind: "traffic",
      schemaVersion: String(row.schema_version),
      id: String(row.id),
      runId: String(row.run_id),
      marketplace: String(row.marketplace),
      asins: JSON.parse(String(row.asins_json)),
      dataCutoffAt: String(row.data_cutoff_at),
      sources: JSON.parse(String(row.sources_json)),
      payload: JSON.parse(String(row.payload_json)),
      contentHash: String(row.content_hash),
      createdAt: String(row.created_at),
    }));
  } catch {
    throw new TrafficDataSnapshotDataError();
  }
}

function mapKeywordAnalysisSnapshot(row: SqliteRow): KeywordAnalysisSnapshotRecord {
  try {
    return deepFreeze(KeywordAnalysisSnapshotRecordSchema.parse({
      kind: "keyword-analysis",
      schemaVersion: String(row.schema_version),
      id: String(row.id),
      runId: String(row.run_id),
      marketplace: String(row.marketplace),
      asins: JSON.parse(String(row.asins_json)),
      dataCutoffAt: String(row.data_cutoff_at),
      sources: JSON.parse(String(row.sources_json)),
      payload: JSON.parse(String(row.payload_json)),
      contentHash: String(row.content_hash),
      createdAt: String(row.created_at),
    }));
  } catch {
    throw new KeywordAnalysisSnapshotDataError();
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
    logicalExecutionCycleId: Sha256Schema.parse(
      row.logical_execution_cycle_id,
    ),
    reportPublicationCycle: Number(row.report_publication_cycle),
    reportPublicationAttemptCount: Number(
      row.report_publication_attempt_count,
    ),
    reportPublicationMaxAttempts:
      row.report_publication_max_attempts === null
        ? null
        : Number(row.report_publication_max_attempts),
    reportPublicationInitialDelayMs:
      row.report_publication_initial_delay_ms === null
        ? null
        : Number(row.report_publication_initial_delay_ms),
    reportPublicationMaxDelayMs:
      row.report_publication_max_delay_ms === null
        ? null
        : Number(row.report_publication_max_delay_ms),
    reportPublicationRetryAt:
      row.report_publication_retry_at === null
        ? null
        : String(row.report_publication_retry_at),
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

function mapConnectorStatus(row: SqliteRow): ConnectorStatusRecord {
  const connector = String(row.connector);
  const health = String(row.health);
  const configured = Number(row.configured);
  let lastError: ConnectorStatusError | null = null;
  if (row.last_error_json !== null) {
    try {
      const parsed = JSON.parse(String(row.last_error_json)) as unknown;
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed) ||
        (parsed as Record<string, unknown>).code !== "probe-failed" ||
        typeof (parsed as Record<string, unknown>).message !== "string"
      ) {
        throw new Error("invalid connector status error");
      }
      lastError = {
        code: "probe-failed",
        message: (parsed as Record<string, string>).message,
      };
    } catch {
      throw new Error("Stored connector status is invalid");
    }
  }
  if (
    !["sif", "sorftime", "sellerSprite"].includes(connector) ||
    !["unknown", "available", "unavailable"].includes(health) ||
    ![0, 1].includes(configured) ||
    (row.last_checked_at !== null &&
      canonicalStoredDateTime(row.last_checked_at) === null) ||
    canonicalStoredDateTime(row.updated_at) === null
  ) {
    throw new Error("Stored connector status is invalid");
  }
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    connector: connector as ConnectorStatusRecord["connector"],
    configured: configured === 1,
    health: health as ConnectorStatusRecord["health"],
    lastCheckedAt:
      row.last_checked_at === null ? null : String(row.last_checked_at),
    lastError,
    updatedAt: String(row.updated_at),
  };
}

function mapConnectorCredential(row: SqliteRow): ConnectorCredentialRecord {
  const identity = validateConnectorCredentialIdentity(
    String(row.organization_id),
    String(row.connector) as ConnectorCredentialRecord["connector"],
  );
  const version = Number(row.version);
  const status = String(row.status);
  if (
    !identity ||
    !Number.isSafeInteger(version) ||
    version < 1 ||
    (status !== "active" && status !== "revoked") ||
    !(row.ciphertext instanceof Uint8Array) ||
    !(row.nonce instanceof Uint8Array) ||
    !(row.auth_tag instanceof Uint8Array)
  ) {
    throw new Error("Stored connector credential is invalid");
  }
  const encrypted = validateEncryptedConnectorCredential({
    ciphertext: row.ciphertext,
    nonce: row.nonce,
    authTag: row.auth_tag,
    keyId: String(row.key_id),
  });
  return Object.freeze({
    id: EntityIdSchema.parse(row.id),
    ...identity,
    version,
    status,
    ...encrypted,
    createdBy: EntityIdSchema.parse(row.created_by),
    createdAt: DateTimeSchema.parse(row.created_at),
    revokedBy:
      row.revoked_by === null ? null : EntityIdSchema.parse(row.revoked_by),
    revokedAt:
      row.revoked_at === null ? null : DateTimeSchema.parse(row.revoked_at),
  });
}

function createLogicalExecutionCycleId(): string {
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
  const hasSucceeded = statuses.has("succeeded");
  if (statuses.has("waiting-input")) return hasSucceeded ? "partial" : "waiting-input";
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
