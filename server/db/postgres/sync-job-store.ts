import type { QueryResultRow } from "pg";
import { z } from "zod";

import type { PostgresQueryContext } from "./query-context";
import {
  SyncJobDataError,
  SyncJobLeaseLostError,
  SyncJobRunConflictError,
  type AdmitSyncJobInput,
  type ProjectableSyncStage,
  type StageOutputDraft,
  type StageOutputProjection,
  type SyncJobModuleRecord,
  type SyncJobRecord,
  type SyncJobRepository,
  type SyncJobStageRecord,
} from "../sync-job-repository";
import {
  SYNC_PROVIDER_DIAGNOSTICS_VERSION,
  legacyRepairCandidates,
  legacyRepairVersion,
  repairableJob,
} from "../../services/sync-legacy-status-repair-service";
import type {
  ExactSyncJobScope,
  PersistedReadinessRepairInput,
  RepairRepositoryResult,
} from "../../services/sync-persisted-readiness-reconciliation-service";

const claimLockId = "731553996872021105";
const maxQueuedJobsPerActor = 2;
const maxOrganizationBacklog = 100;
const syncJobModuleStatusSchema = z.enum([
  "ready",
  "upstream-empty",
  "timeout",
  "connector-failed",
  "pending",
  "manual",
]);
const syncJobStageSchema = z.strictObject({
  id: z.string().min(1),
  label: z.string().min(1),
  kind: z.enum(["auto", "manual"]),
  status: z.string().min(1),
  estimatedSeconds: z.number().finite().nonnegative(),
  detail: z.string().optional(),
  manualNote: z.string().optional(),
  startedAt: z.iso.datetime({ offset: true }).nullable().optional(),
  completedAt: z.iso.datetime({ offset: true }).nullable().optional(),
});
const syncJobProgressEntrySchema = z.strictObject({
  status: syncJobModuleStatusSchema,
  reason: z.string().trim().min(1).max(240).nullable(),
  updatedAt: z.iso.datetime({ offset: true }),
});
const syncJobProgressSchema = z.record(
  z.string().regex(/^[A-Z0-9]{10}$/),
  z.record(z.string().min(1).max(100), syncJobProgressEntrySchema),
);
const syncJobAsinsSchema = z
  .array(z.string().regex(/^[A-Z0-9]{10}$/))
  .min(1)
  .max(10);

interface SyncJobRow extends QueryResultRow {
  readonly job_id: string;
  readonly organization_id: string;
  readonly project_id: string | null;
  readonly run_id: string | null;
  readonly actor_id: string | null;
  readonly fingerprint: string;
  readonly marketplace: "US";
  readonly asins: unknown;
  readonly status: "queued" | "running" | "completed" | "failed";
  readonly message: string;
  readonly current_stage_id: string;
  readonly stages: unknown;
  readonly asin_progress: unknown;
  readonly leased_by: string | null;
  readonly lease_generation: number;
  readonly job_version: number;
  readonly lease_expires_at: Date | string | null;
  readonly policy_version: string;
  readonly error: unknown;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
  readonly completed_at: Date | string | null;
}

interface SyncJobModuleRow extends QueryResultRow {
  readonly asin: string;
  readonly module: string;
  readonly status: SyncJobModuleRecord["status"];
  readonly reason: string | null;
  readonly updated_at: Date | string;
}

interface SyncJobStageOutputRow extends QueryResultRow {
  readonly job_id: string;
  readonly organization_id: string;
  readonly project_id: string;
  readonly run_id: string;
  readonly stage_id: ProjectableSyncStage;
  readonly stage_status: "done" | "partial" | "failed";
  readonly output_version: number;
  readonly job_version: number;
  readonly content_hash: string;
  readonly data_json: unknown;
  readonly gap_json: unknown;
  readonly updated_at: Date | string;
}

const jobColumns = `
  job_id,
  organization_id,
  project_id,
  run_id,
  actor_id,
  fingerprint,
  marketplace,
  asins,
  status,
  message,
  current_stage_id,
  stages,
  asin_progress,
  leased_by,
  lease_generation,
  job_version,
  lease_expires_at,
  policy_version,
  error,
  created_at,
  updated_at,
  completed_at
`;

export class PostgresSyncJobStore implements SyncJobRepository {
  constructor(private readonly queries: PostgresQueryContext) {}

  async admit(input: AdmitSyncJobInput) {
    const normalized = normalizeAdmissionInput(input);
    return await retrySerializable(async () =>
      this.queries.transaction(async () => {
        await this.queries.query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
        const existing = await this.findActiveByFingerprint(
          normalized.organizationId,
          normalized.fingerprint,
        );
        if (existing) {
          assertCompatibleActiveRun(normalized, existing);
          await this.recordSubmission(
            { ...normalized, runId: existing.runId },
            existing.jobId,
            "deduplicated",
          );
          return { job: existing, disposition: "deduplicated" as const };
        }

        if (normalized.actorId) {
          const actorQueued = await this.queries.query<{ count: number }>(
            `SELECT count(*)::integer AS count
             FROM sync_jobs
             WHERE organization_id = $1
               AND actor_id = $2
               AND status = 'queued'`,
            [normalized.organizationId, normalized.actorId],
          );
          if ((actorQueued.rows[0]?.count ?? 0) >= maxQueuedJobsPerActor) {
            throw new Error("User queued sync job limit reached");
          }
        }

        const organizationBacklog = await this.queries.query<{ count: number }>(
          `SELECT count(*)::integer AS count
           FROM sync_jobs
           WHERE organization_id = $1
             AND status IN ('queued', 'running')`,
          [normalized.organizationId],
        );
        if ((organizationBacklog.rows[0]?.count ?? 0) >= maxOrganizationBacklog) {
          throw new Error("Organization sync job backlog limit reached");
        }

        const inserted = await this.queries.query<SyncJobRow>(
          `INSERT INTO sync_jobs (
             job_id, organization_id, project_id, run_id, actor_id, fingerprint,
             marketplace, asins, status, message, current_stage_id, stages,
             error, policy_version, created_at, updated_at
           )
           VALUES (
             $1, $2, $3, $4, $5, $6,
             $7, $8::jsonb, 'queued', $9, $10, $11::jsonb, $12::jsonb,
             (
               SELECT policy_version
               FROM concurrency_policy_current
               WHERE organization_id IN ($2, '*')
               ORDER BY CASE WHEN organization_id = $2 THEN 0 ELSE 1 END
               LIMIT 1
             ),
             $13, $13
           )
           ON CONFLICT DO NOTHING
           RETURNING ${jobColumns}`,
          [
            normalized.jobId,
            normalized.organizationId,
            normalized.projectId,
            normalized.runId,
            normalized.actorId,
            normalized.fingerprint,
            normalized.marketplace,
            JSON.stringify(normalized.asins),
            normalized.message,
            normalized.currentStageId,
            JSON.stringify(normalized.stages),
            JSON.stringify({ diagnosticsVersion: SYNC_PROVIDER_DIAGNOSTICS_VERSION }),
            normalized.createdAt,
          ],
        );
        const insertedRow = inserted.rows[0];
        if (insertedRow) {
          if (normalized.canonicalRun) {
            await this.createCanonicalSyncRun(normalized);
          }
          await this.recordSubmission(normalized, normalized.jobId, "created");
          return {
            job: await this.mapJobRow(insertedRow),
            disposition: "created" as const,
          };
        }

        const deduplicated = await this.findActiveByFingerprint(
          normalized.organizationId,
          normalized.fingerprint,
        );
        if (!deduplicated) throw new Error("Sync job admission conflict could not be resolved");
        assertCompatibleActiveRun(normalized, deduplicated);
        await this.recordSubmission(
          { ...normalized, runId: deduplicated.runId },
          deduplicated.jobId,
          "deduplicated",
        );
        return { job: deduplicated, disposition: "deduplicated" as const };
      }),
    );
  }

  private async createCanonicalSyncRun(input: AdmitSyncJobInput): Promise<void> {
    const canonical = input.canonicalRun;
    if (!canonical || !input.projectId || !input.actorId || input.runId !== canonical.runId) {
      throw new Error("Canonical sync run scope is invalid");
    }
    const inserted = await this.queries.query(
      `INSERT INTO analysis_runs (
         id, project_id, mode, status, created_by, data_cutoff_at,
         idempotency_scope, idempotency_key, created_at, updated_at
       )
       SELECT $1, project.id, 'existing-data', 'queued', actor.id, $2,
              $3, $4, $5, $5
         FROM projects project
         JOIN users actor
           ON actor.id = $6
          AND actor.organization_id = project.organization_id
          AND actor.status = 'active'
        WHERE project.id = $7
          AND project.organization_id = $8
          AND upper(project.marketplace) = $9
          AND project.asins_json @> $10::jsonb
          AND project.asins_json <@ $10::jsonb
       RETURNING id`,
      [
        canonical.runId,
        canonical.dataCutoffAt,
        `sync:${input.organizationId}:${input.projectId}`,
        input.jobId,
        input.createdAt,
        input.actorId,
        input.projectId,
        input.organizationId,
        input.marketplace,
        JSON.stringify(input.asins),
      ],
    );
    if (inserted.rowCount !== 1) {
      throw new Error("Canonical sync run scope is not authorized");
    }
    await this.queries.query(
      `INSERT INTO run_stages (
         id, run_id, stage, status, progress, attempt_count, created_at, updated_at
       ) VALUES ($1, $2, 'traffic-analysis', 'queued', 0, 0, $3, $3)`,
      [canonical.stageId, canonical.runId, input.createdAt],
    );
    await this.queries.query(
      `UPDATE projects
          SET current_run_id = $1, updated_at = $2
        WHERE id = $3 AND organization_id = $4`,
      [canonical.runId, input.createdAt, input.projectId, input.organizationId],
    );
  }

  async findById(jobId: string): Promise<SyncJobRecord | null> {
    const result = await this.queries.query<SyncJobRow>(
      `SELECT ${jobColumns} FROM sync_jobs WHERE job_id = $1`,
      [jobId],
    );
    const row = result.rows[0];
    return row ? await this.mapJobRow(row) : null;
  }

  async readStageOutput(input: {
    organizationId: string;
    projectId: string;
    runId: string;
    jobId: string;
    stage: ProjectableSyncStage;
  }): Promise<StageOutputProjection | null> {
    const result = await this.queries.query<SyncJobStageOutputRow>(
      `SELECT output.*, job.job_version
       FROM sync_job_stage_outputs output
       JOIN sync_jobs job ON job.job_id = output.job_id
       WHERE output.organization_id = $1
         AND output.project_id = $2
         AND output.run_id = $3
         AND output.job_id = $4
         AND output.stage_id = $5`,
      [input.organizationId, input.projectId, input.runId, input.jobId, input.stage],
    );
    const row = result.rows[0];
    return row ? parseStageOutput(row) : null;
  }

  async ownsCanonicalTrafficRun(input: {
    jobId: string;
    runId: string;
    actorId: string;
  }): Promise<boolean> {
    const result = await this.queries.query<{ owned: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM sync_jobs job
           JOIN analysis_runs run ON run.id = job.run_id
          WHERE job.job_id = $1
            AND job.run_id = $2
            AND job.actor_id = $3
            AND job.status = 'running'
            AND run.project_id = job.project_id
            AND run.created_by = job.actor_id
            AND run.idempotency_scope = 'sync:' || job.organization_id || ':' || job.project_id
            AND run.idempotency_key = job.job_id
            AND (SELECT count(*) FROM run_stages owned_stage WHERE owned_stage.run_id = run.id) = 1
            AND EXISTS (
              SELECT 1 FROM run_stages traffic_stage
               WHERE traffic_stage.run_id = run.id
                 AND traffic_stage.stage = 'traffic-analysis'
            )
       ) AS owned`,
      [input.jobId, input.runId, input.actorId],
    );
    return result.rows[0]?.owned === true;
  }

  async beginCanonicalTrafficRun(input: {
    jobId: string;
    runId: string;
    actorId: string;
    leaseGeneration: number;
    workerId: string;
    maxAttempts: number;
    startedAt: string;
  }): Promise<"started" | "exhausted" | false> {
    assertPositiveInteger(input.leaseGeneration, "leaseGeneration");
    assertPositiveInteger(input.maxAttempts, "maxAttempts");
    return await this.queries.transaction(async () => {
      const lifecycle = await this.queries.query<{
        stage_id: string;
        attempt_count: number;
      }>(
        `SELECT stage.id AS stage_id, stage.attempt_count
           FROM sync_jobs job
           JOIN analysis_runs run ON run.id = job.run_id
           JOIN run_stages stage ON stage.run_id = run.id
          WHERE job.job_id = $1
            AND job.run_id = $2
            AND job.actor_id = $3
            AND job.lease_generation = $4
            AND job.leased_by = $5
            AND job.status = 'running'
            AND run.created_by = job.actor_id
            AND run.project_id = job.project_id
            AND run.idempotency_scope = 'sync:' || job.organization_id || ':' || job.project_id
            AND run.idempotency_key = job.job_id
            AND (SELECT count(*) FROM run_stages owned_stage WHERE owned_stage.run_id = run.id) = 1
            AND stage.stage = 'traffic-analysis'
            AND stage.status IN ('queued', 'running')
            AND run.status IN ('queued', 'running')
          FOR UPDATE OF job, run, stage`,
        [
          input.jobId,
          input.runId,
          input.actorId,
          input.leaseGeneration,
          input.workerId,
        ],
      );
      const owned = lifecycle.rows[0];
      if (!owned) return false;
      if (owned.attempt_count >= input.maxAttempts) {
        const current = await this.lockFencedJob(
          input.jobId,
          input.leaseGeneration,
          input.workerId,
        );
        const message = "同步任务重试次数已耗尽";
        const error = { ...current.error, code: "SYNC_JOB_ATTEMPTS_EXHAUSTED" };
        const stages = settleTerminalStages(
          current.stages,
          "failed",
          input.startedAt,
          message,
        );
        const stage = await this.queries.query(
          `UPDATE run_stages
              SET status = 'failed', completed_at = $2,
                  last_error_json = $3::jsonb, updated_at = $2
            WHERE id = $1
              AND status IN ('queued', 'running')`,
          [owned.stage_id, input.startedAt, JSON.stringify(error)],
        );
        const run = await this.queries.query(
          `UPDATE analysis_runs
              SET status = 'failed', updated_at = $2
            WHERE id = $1
              AND status IN ('queued', 'running')`,
          [input.runId, input.startedAt],
        );
        const job = await this.queries.query(
          `UPDATE sync_jobs
              SET status = 'failed', message = $4, stages = $5::jsonb,
                  leased_by = NULL, lease_expires_at = NULL,
                  failed_at = $6, updated_at = $6, error = $7::jsonb
            WHERE job_id = $1
              AND lease_generation = $2
              AND leased_by = $3
              AND status = 'running'`,
          [
            input.jobId,
            input.leaseGeneration,
            input.workerId,
            message,
            JSON.stringify(stages),
            input.startedAt,
            JSON.stringify(error),
          ],
        );
        if (stage.rowCount !== 1 || run.rowCount !== 1 || job.rowCount !== 1) {
          throw new Error("Canonical sync attempt exhaustion could not be settled");
        }
        return "exhausted";
      }
      const stage = await this.queries.query(
        `UPDATE run_stages
            SET status = 'running', attempt_count = attempt_count + 1,
                started_at = COALESCE(started_at, $2), updated_at = $2
          WHERE id = $1
            AND status IN ('queued', 'running')`,
        [owned.stage_id, input.startedAt],
      );
      if (stage.rowCount !== 1) return false;
      const run = await this.queries.query(
        `UPDATE analysis_runs run
            SET status = 'running', updated_at = $4
           FROM sync_jobs job
          WHERE job.job_id = $1
            AND job.run_id = $2
            AND job.actor_id = $3
            AND job.status = 'running'
            AND run.id = job.run_id
            AND run.created_by = job.actor_id
            AND run.project_id = job.project_id
            AND run.idempotency_scope = 'sync:' || job.organization_id || ':' || job.project_id
            AND run.idempotency_key = job.job_id
            AND (SELECT count(*) FROM run_stages owned_stage WHERE owned_stage.run_id = run.id) = 1
            AND run.status IN ('queued', 'running')`,
        [input.jobId, input.runId, input.actorId, input.startedAt],
      );
      if (run.rowCount !== 1) {
        throw new Error("Canonical sync run could not be started");
      }
      return "started";
    });
  }

  async settleCanonicalTrafficRun(input: {
    jobId: string;
    runId: string;
    outcome: "succeeded" | "partial" | "failed" | "cancelled";
    settledAt: string;
    error: Record<string, unknown> | null;
  }): Promise<boolean> {
    return await this.queries.transaction(async () => {
      const stage = await this.queries.query(
        `UPDATE run_stages stage
            SET status = $3, progress = CASE WHEN $3 = 'succeeded' THEN 100 ELSE progress END,
                completed_at = $4, last_error_json = $5::jsonb, updated_at = $4
           FROM sync_jobs job, analysis_runs run
          WHERE job.job_id = $1
            AND job.run_id = $2
            AND job.status = 'running'
            AND run.id = job.run_id
            AND run.project_id = job.project_id
            AND run.created_by = job.actor_id
            AND run.idempotency_scope = 'sync:' || job.organization_id || ':' || job.project_id
            AND run.idempotency_key = job.job_id
            AND (SELECT count(*) FROM run_stages owned_stage WHERE owned_stage.run_id = run.id) = 1
            AND stage.run_id = job.run_id
            AND stage.stage = 'traffic-analysis'
            AND stage.status IN ('queued', 'running')`,
        [
          input.jobId,
          input.runId,
          input.outcome,
          input.settledAt,
          input.error === null ? null : JSON.stringify(input.error),
        ],
      );
      if (stage.rowCount !== 1) return false;
      const run = await this.queries.query(
        `UPDATE analysis_runs run
            SET status = $3, updated_at = $4
           FROM sync_jobs job
          WHERE job.job_id = $1
            AND job.run_id = $2
            AND job.status = 'running'
            AND run.id = job.run_id
            AND run.project_id = job.project_id
            AND run.created_by = job.actor_id
            AND run.idempotency_scope = 'sync:' || job.organization_id || ':' || job.project_id
            AND run.idempotency_key = job.job_id
            AND (SELECT count(*) FROM run_stages owned_stage WHERE owned_stage.run_id = run.id) = 1
            AND run.status IN ('queued', 'running')`,
        [input.jobId, input.runId, input.outcome, input.settledAt],
      );
      if (run.rowCount !== 1) {
        throw new Error("Canonical sync run could not be settled");
      }
      return true;
    });
  }

  async applyLegacyStatusRepair(input: {
    jobId: string;
    organizationId: string;
    version: string;
    appliedAt: string;
  }) {
    return await this.queries.transaction(async () => {
      const targetResult = await this.queries.query<SyncJobRow>(
        `SELECT ${jobColumns}
         FROM sync_jobs
         WHERE job_id = $1
           AND organization_id = $2
         FOR UPDATE`,
        [input.jobId, input.organizationId],
      );
      const targetRow = targetResult.rows[0];
      if (!targetRow) return null;
      const target = await this.mapMaintenanceJobRow(targetRow);
      if (!repairableJob(target, input.organizationId)) return null;
      if (legacyRepairVersion(target.updatedAt) !== input.version) {
        return { disposition: "conflict" as const };
      }
      const candidates = legacyRepairCandidates(target);
      if (candidates.length === 0) {
        return { disposition: "applied" as const, job: target, candidates };
      }
      for (const candidate of candidates) {
        await this.queries.query(
          `UPDATE sync_job_modules
           SET status = 'pending',
               reason = 'LEGACY_UNVERIFIED',
               updated_at = $4
           WHERE job_id = $1
             AND asin = $2
             AND module = $3
             AND status = 'upstream-empty'`,
          [input.jobId, candidate.asin, candidate.module, input.appliedAt],
        );
      }
      const progress = mergeProgress(
        target.asinProgress,
        candidates.map((candidate) => ({
          asin: candidate.asin,
          module: candidate.module,
          status: "pending" as const,
          reason: "LEGACY_UNVERIFIED",
          updatedAt: input.appliedAt,
        })),
      );
      const updated = await this.queries.query<SyncJobRow>(
        `UPDATE sync_jobs
         SET asin_progress = $3::jsonb,
             updated_at = $4
         WHERE job_id = $1
           AND organization_id = $2
         RETURNING ${jobColumns}`,
        [input.jobId, input.organizationId, JSON.stringify(progress), input.appliedAt],
      );
      const row = updated.rows[0];
      if (!row) return { disposition: "conflict" as const };
      return {
        disposition: "applied" as const,
        job: await this.mapMaintenanceJobRow(row),
        candidates,
      };
    });
  }

  async applyPersistedReadinessRepair(
    input: PersistedReadinessRepairInput,
  ): Promise<RepairRepositoryResult | null> {
    try {
      return await this.queries.transaction(async () => {
      const targetResult = await this.queries.query<SyncJobRow>(
        `SELECT ${jobColumns}
         FROM sync_jobs
         WHERE job_id = $1
           AND organization_id = $2
         FOR UPDATE`,
        [input.scope.jobId, input.scope.organizationId],
      );
      const targetRow = targetResult.rows[0];
      if (!targetRow) return null;
      const target = await this.mapMaintenanceJobRow(targetRow);
      if (!matchesPersistedRepairScope(target, input.scope)) return null;
      if (target.status !== "completed"
        || target.leasedBy !== null || target.leaseExpiresAt !== null) {
        return { disposition: "conflict" as const };
      }

      const marker = persistedReadinessRepairMarker(target.error);
      if (marker?.token === input.token) {
        if (marker.evidenceDigest !== input.evidenceDigest
          || marker.mirrorBeforeDigest !== input.mirrorBeforeDigest
          || marker.mirrorAfterDigest !== input.mirrorAfterDigest
          || marker.module !== input.module
          || !["mirror-pending", "applied"].includes(String(marker.state))) {
          return { disposition: "conflict" as const };
        }
        return {
          disposition: marker.state === "applied" ? "applied" as const : "mirror-pending" as const,
          job: target,
        };
      }
      if (target.updatedAt !== input.expectedUpdatedAt || input.module !== "listing") {
        return { disposition: "conflict" as const };
      }
      if (input.scope.asins.some((asin) => target.asinProgress[asin]?.listing?.status !== "connector-failed")) {
        return { disposition: "conflict" as const };
      }

      for (const asin of input.scope.asins) {
        const updatedModule = await this.queries.query(
          `UPDATE sync_job_modules
           SET status = 'ready',
               reason = NULL,
               updated_at = $4
           WHERE job_id = $1
             AND asin = $2
             AND module = $3
             AND status = 'connector-failed'`,
          [input.scope.jobId, asin, input.module, input.appliedAt],
        );
        if (updatedModule.rowCount !== 1) throw new PersistedReadinessWriteConflict();
      }

      const progress = mergeProgress(target.asinProgress, input.scope.asins.map((asin) => ({
        asin,
        module: "listing",
        status: "ready" as const,
        reason: null,
        updatedAt: input.appliedAt,
      })));
      const stages = target.stages.map((stage) => {
        if (stage.id !== "listing") return stage;
        const remaining = { ...stage };
        delete remaining.detail;
        return { ...remaining, status: "done", completedAt: stage.completedAt ?? input.appliedAt };
      });
      const currentError = target.error ?? {};
      const resumeStages = Array.isArray(currentError.resumeStages)
        ? currentError.resumeStages.filter((stage) => stage !== "listing")
        : currentError.resumeStages;
      const error = {
        ...currentError,
        ...(Array.isArray(resumeStages) ? { resumeStages } : {}),
        persistedReadinessRepair: {
          token: input.token,
          state: "mirror-pending",
          evidenceDigest: input.evidenceDigest,
          mirrorBeforeDigest: input.mirrorBeforeDigest,
          mirrorAfterDigest: input.mirrorAfterDigest,
          module: input.module,
          appliedAt: input.appliedAt,
        },
      };
      const updated = await this.queries.query<SyncJobRow>(
        `UPDATE sync_jobs
         SET asin_progress = $3::jsonb,
             stages = $4::jsonb,
             error = $5::jsonb,
             updated_at = $6
         WHERE job_id = $1
           AND organization_id = $2
         RETURNING ${jobColumns}`,
        [
          input.scope.jobId,
          input.scope.organizationId,
          JSON.stringify(progress),
          JSON.stringify(stages),
          JSON.stringify(error),
          input.appliedAt,
        ],
      );
      if (!updated.rows[0]) throw new PersistedReadinessWriteConflict();
      return {
        disposition: "mirror-pending" as const,
        job: await this.mapMaintenanceJobRow(updated.rows[0]),
      };
      });
    } catch (error) {
      if (error instanceof PersistedReadinessWriteConflict) {
        return { disposition: "conflict" as const };
      }
      throw error;
    }
  }

  async finalizePersistedReadinessRepair(input: {
    readonly scope: ExactSyncJobScope;
    readonly token: string;
    readonly finalizedAt: string;
  }): Promise<RepairRepositoryResult | null> {
    return await this.queries.transaction(async () => {
      const targetResult = await this.queries.query<SyncJobRow>(
        `SELECT ${jobColumns}
         FROM sync_jobs
         WHERE job_id = $1
           AND organization_id = $2
         FOR UPDATE`,
        [input.scope.jobId, input.scope.organizationId],
      );
      const targetRow = targetResult.rows[0];
      if (!targetRow) return null;
      const target = await this.mapMaintenanceJobRow(targetRow);
      if (!matchesPersistedRepairScope(target, input.scope)) return null;
      if (target.status !== "completed"
        || target.leasedBy !== null
        || target.leaseExpiresAt !== null) {
        return { disposition: "conflict" as const };
      }
      const marker = persistedReadinessRepairMarker(target.error);
      if (marker?.token !== input.token) return { disposition: "conflict" as const };
      if (marker.state === "applied") return { disposition: "applied" as const, job: target };
      if (marker.state !== "mirror-pending") return { disposition: "conflict" as const };
      const error = {
        ...(target.error ?? {}),
        persistedReadinessRepair: { ...marker, state: "applied", finalizedAt: input.finalizedAt },
      };
      const updated = await this.queries.query<SyncJobRow>(
        `UPDATE sync_jobs
         SET error = $3::jsonb,
             updated_at = $4
         WHERE job_id = $1
           AND organization_id = $2
           AND status = 'completed'
           AND leased_by IS NULL
           AND lease_expires_at IS NULL
           AND error -> 'persistedReadinessRepair' ->> 'token' = $5
           AND error -> 'persistedReadinessRepair' ->> 'state' = 'mirror-pending'
         RETURNING ${jobColumns}`,
        [
          input.scope.jobId,
          input.scope.organizationId,
          JSON.stringify(error),
          input.finalizedAt,
          input.token,
        ],
      );
      if (!updated.rows[0]) return { disposition: "conflict" as const };
      return { disposition: "applied" as const, job: await this.mapMaintenanceJobRow(updated.rows[0]) };
    });
  }

  async resume(input: {
    jobId: string;
    organizationId: string;
    actorId: string | null;
    resumedAt: string;
  }) {
    return await retrySerializable(async () =>
      this.queries.transaction(async () => {
        await this.queries.query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
        const targetResult = await this.queries.query<SyncJobRow>(
          `SELECT ${jobColumns}
           FROM sync_jobs
           WHERE job_id = $1
             AND organization_id = $2
           FOR UPDATE`,
          [input.jobId, input.organizationId],
        );
        const targetRow = targetResult.rows[0];
        if (!targetRow) return null;
        if (persistedReadinessRepairMarker(parseNullableRecord(targetRow.error))?.state === "mirror-pending") {
          throw new SyncJobRunConflictError();
        }
        const target = await this.mapJobRow(targetRow);
        if (target.status === "queued" || target.status === "running") {
          return {
            job: target,
            disposition: "deduplicated" as const,
            resumedStages: repairStageIds(target),
          };
        }

        const activeResult = await this.queries.query<SyncJobRow>(
          `SELECT ${jobColumns}
           FROM sync_jobs
           WHERE organization_id = $1
             AND fingerprint = $2
             AND status IN ('queued', 'running')
           ORDER BY created_at ASC, job_id ASC
           LIMIT 1
           FOR UPDATE`,
          [target.organizationId, target.fingerprint],
        );
        const activeRow = activeResult.rows[0];
        if (activeRow) {
          const active = await this.mapJobRow(activeRow);
          return {
            job: active,
            disposition: "deduplicated" as const,
            resumedStages: repairStageIds(active),
          };
        }

        const fileResumableStages = failedOrUnfinishedStageIds(target.stages);
        let canonicalTrafficResumable = false;
        const canonicalRun = await this.queries.query<{ status: string }>(
          `SELECT run.status
             FROM sync_jobs job
             JOIN analysis_runs run ON run.id = job.run_id
            WHERE job.job_id = $1
              AND job.organization_id = $2
              AND run.project_id = job.project_id
              AND run.created_by = job.actor_id
              AND run.idempotency_scope = 'sync:' || job.organization_id || ':' || job.project_id
              AND run.idempotency_key = job.job_id
            FOR UPDATE OF run`,
          [input.jobId, input.organizationId],
        );
        if (target.runId !== null && canonicalRun.rowCount !== 1) {
          throw new Error("Canonical sync lifecycle is not eligible for in-place resume");
        }
        if (canonicalRun.rowCount === 1) {
          const trafficStages = await this.queries.query<{
            id: string;
            stage: string;
            status: string;
          }>(
            `SELECT id, stage, status
               FROM run_stages
              WHERE run_id = $1
              ORDER BY id
              FOR UPDATE`,
            [target.runId],
          );
          const snapshot = await this.queries.query<{ exists: boolean }>(
            `SELECT EXISTS (
               SELECT 1 FROM data_snapshots WHERE run_id = $1
             ) AS exists`,
            [target.runId],
          );
          const trafficStage = trafficStages.rows[0];
          const terminalCanonicalLifecycle =
            (canonicalRun.rows[0]?.status === "partial" || canonicalRun.rows[0]?.status === "failed") &&
            trafficStages.rowCount === 1 &&
            trafficStage?.stage === "traffic-analysis" &&
            (trafficStage.status === "partial" || trafficStage.status === "failed") &&
            snapshot.rows[0]?.exists === false;
          const strandedExhaustedLifecycle =
            target.status === "failed" &&
            target.error?.code === "SYNC_JOB_ATTEMPTS_EXHAUSTED" &&
            target.leasedBy === null &&
            target.leaseExpiresAt === null &&
            canonicalRun.rows[0]?.status === "queued" &&
            trafficStages.rowCount === 1 &&
            trafficStage?.stage === "traffic-analysis" &&
            trafficStage.status === "queued" &&
            snapshot.rows[0]?.exists === false;
          const resumableCanonicalLifecycle =
            terminalCanonicalLifecycle || strandedExhaustedLifecycle;
          if (!resumableCanonicalLifecycle) {
            throw new Error("Canonical sync lifecycle is not eligible for in-place resume");
          }
          canonicalTrafficResumable = true;
          const stageReset = await this.queries.query(
            `UPDATE run_stages
                SET status = 'queued', progress = 0,
                    attempt_count = 0,
                    started_at = NULL, completed_at = NULL,
                    last_error_json = NULL, updated_at = $2
              WHERE id = $1
                AND status IN ('partial', 'failed', 'queued')`,
            [trafficStage.id, input.resumedAt],
          );
          const runReset = await this.queries.query(
            `UPDATE analysis_runs
                SET status = 'queued', updated_at = $2
              WHERE id = $1
                AND status IN ('partial', 'failed', 'queued')`,
            [target.runId, input.resumedAt],
          );
          if (stageReset.rowCount !== 1 || runReset.rowCount !== 1) {
            throw new Error("Canonical sync lifecycle resume conflict could not be resolved");
          }
        }
        const resumedStages = fileResumableStages.length > 0
          ? fileResumableStages
          : canonicalTrafficResumable
            ? ["traffic"]
            : [];
        if (resumedStages.length === 0) {
          throw new Error("Sync job has no failed or unfinished stages to resume");
        }
        const selected = new Set(resumedStages);
        const stages = target.stages.map((stage) => selected.has(stage.id)
          ? {
              ...stage,
              status: "pending",
              startedAt: null,
              completedAt: null,
            }
          : stage);
        const updated = await this.queries.query<SyncJobRow>(
          `UPDATE sync_jobs
           SET status = 'queued',
               message = 'Failed stages queued for explicit resume',
               current_stage_id = $3,
               stages = $4::jsonb,
               leased_by = NULL,
               lease_expires_at = NULL,
               completed_at = NULL,
               failed_at = NULL,
               error = $5::jsonb,
               updated_at = $6
           WHERE job_id = $1
             AND organization_id = $2
             AND status IN ('completed', 'failed')
           RETURNING ${jobColumns}`,
          [
            input.jobId,
            input.organizationId,
            resumedStages[0],
            JSON.stringify(stages),
            JSON.stringify({
              ...target.error,
              code: "SYNC_JOB_EXPLICIT_RESUME",
              resumeStages: resumedStages,
            }),
            input.resumedAt,
          ],
        );
        const row = updated.rows[0];
        if (!row) throw new Error("Sync job resume conflict could not be resolved");
        return {
          job: await this.mapJobRow(row),
          disposition: "resumed" as const,
          resumedStages,
        };
      }),
    );
  }

  async claimNext(input: {
    workerId: string;
    leaseMs: number;
    wholeJobLimit: number;
    claimedAt?: string;
  }) {
    assertPositiveInteger(input.leaseMs, "leaseMs");
    assertPositiveInteger(input.wholeJobLimit, "wholeJobLimit");
    const claimedAt = input.claimedAt ?? new Date().toISOString();
    return await this.queries.transaction(async () => {
      await this.queries.query("SELECT pg_advisory_xact_lock($1::bigint)", [
        claimLockId,
      ]);
      const result = await this.queries.query<SyncJobRow>(
        `WITH running_capacity AS (
         SELECT count(*)::integer AS active_running_count
         FROM sync_jobs
         WHERE status = 'running'
           AND lease_expires_at > $1
       ),
       candidate AS (
         SELECT candidate_job.job_id
         FROM sync_jobs candidate_job
         CROSS JOIN running_capacity
         WHERE (
           candidate_job.status = 'queued'
           OR (candidate_job.status = 'running' AND candidate_job.lease_expires_at <= $1)
         )
         AND COALESCE(
           candidate_job.error -> 'persistedReadinessRepair' ->> 'state',
           ''
         ) <> 'mirror-pending'
         AND running_capacity.active_running_count < $2
         AND NOT EXISTS (
           SELECT 1
           FROM sync_jobs running_actor_job
           WHERE candidate_job.actor_id IS NOT NULL
             AND running_actor_job.actor_id = candidate_job.actor_id
             AND running_actor_job.status = 'running'
             AND running_actor_job.lease_expires_at > $1
         )
         ORDER BY
           CASE
             WHEN candidate_job.status = 'running' AND candidate_job.lease_expires_at <= $1 THEN 0
             ELSE 1
           END,
           candidate_job.created_at ASC,
           candidate_job.job_id ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE sync_jobs
       SET status = 'running',
           leased_by = $3,
           lease_generation = lease_generation + 1,
           lease_expires_at = $1::timestamptz + ($4::text || ' milliseconds')::interval,
           started_at = COALESCE(started_at, $1),
           updated_at = $1,
           message = 'Running'
       WHERE job_id = (SELECT job_id FROM candidate)
       RETURNING ${jobColumns}`,
        [
          claimedAt,
          input.wholeJobLimit,
          input.workerId,
          input.leaseMs,
        ],
      );
      const row = result.rows[0];
      if (!row) return null;
      const job = await this.mapJobRow(row);
      return { job, leaseGeneration: job.leaseGeneration };
    });
  }

  async heartbeat(input: {
    jobId: string;
    leaseGeneration: number;
    workerId: string;
    heartbeatAt: string;
    leaseMs: number;
  }): Promise<SyncJobRecord> {
    assertPositiveInteger(input.leaseGeneration, "leaseGeneration");
    assertPositiveInteger(input.leaseMs, "leaseMs");
    const result = await this.queries.query<SyncJobRow>(
      `UPDATE sync_jobs
       SET lease_expires_at = $4::timestamptz + ($5::text || ' milliseconds')::interval,
           updated_at = $4
       WHERE job_id = $1
         AND lease_generation = $2
         AND leased_by = $3
         AND status = 'running'
       RETURNING ${jobColumns}`,
      [
        input.jobId,
        input.leaseGeneration,
        input.workerId,
        input.heartbeatAt,
        input.leaseMs,
      ],
    );
    return await this.requireFencedRow(result.rows[0]);
  }

  async recordProgress(input: {
    jobId: string;
    leaseGeneration: number;
    workerId?: string;
    recordedAt: string;
    currentStageId?: string;
    stage?: Partial<SyncJobStageRecord> & Pick<SyncJobStageRecord, "id">;
    stages?: readonly (Partial<SyncJobStageRecord> & Pick<SyncJobStageRecord, "id">)[];
    modules?: readonly SyncJobModuleRecord[];
    outputs?: readonly StageOutputDraft[];
    message?: string;
  }): Promise<SyncJobRecord> {
    assertPositiveInteger(input.leaseGeneration, "leaseGeneration");
    return await this.queries.transaction(async () => {
      const current = await this.lockFencedJob(
        input.jobId,
        input.leaseGeneration,
        input.workerId,
      );
      const stages = mergeStages(current.stages, [
        ...(input.stage ? [input.stage] : []),
        ...(input.stages ?? []),
      ]);
      const terminalOutputs = (input.outputs ?? []).filter((output) =>
        validScopedStageOutput(output, current, stages)
      );
      let outputChanged = false;
      for (const output of terminalOutputs) {
        const upserted = await this.queries.query<{ output_version: number }>(
          `INSERT INTO sync_job_stage_outputs (
             job_id, organization_id, project_id, run_id, stage_id, stage_status,
             content_hash, data_json, gap_json, updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10)
           ON CONFLICT (job_id, stage_id) DO UPDATE SET
             stage_status = EXCLUDED.stage_status,
             content_hash = EXCLUDED.content_hash,
             data_json = EXCLUDED.data_json,
             gap_json = EXCLUDED.gap_json,
             updated_at = EXCLUDED.updated_at,
             output_version = sync_job_stage_outputs.output_version + 1
           WHERE sync_job_stage_outputs.stage_status IS DISTINCT FROM EXCLUDED.stage_status
              OR sync_job_stage_outputs.content_hash IS DISTINCT FROM EXCLUDED.content_hash
              OR sync_job_stage_outputs.data_json IS DISTINCT FROM EXCLUDED.data_json
              OR sync_job_stage_outputs.gap_json IS DISTINCT FROM EXCLUDED.gap_json
           RETURNING output_version`,
          [
            input.jobId, output.organizationId, output.projectId, output.runId,
            output.stage, output.stageStatus, output.contentHash,
            output.data ? JSON.stringify(output.data) : null,
            output.gap ? JSON.stringify(output.gap) : null,
            output.updatedAt,
          ],
        );
        outputChanged ||= Boolean(upserted.rows[0]);
      }
      for (const progressModule of input.modules ?? []) {
        await this.queries.query(
          `INSERT INTO sync_job_modules (
             job_id, asin, module, status, reason, updated_at
           )
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (job_id, asin, module)
           DO UPDATE SET
             status = EXCLUDED.status,
             reason = EXCLUDED.reason,
             updated_at = EXCLUDED.updated_at`,
          [
            input.jobId,
            progressModule.asin,
            progressModule.module,
            progressModule.status,
            progressModule.reason,
            progressModule.updatedAt,
          ],
        );
      }
      const progress = mergeProgress(current.asinProgress, input.modules ?? []);
      const updated = await this.queries.query<SyncJobRow>(
        `UPDATE sync_jobs
         SET current_stage_id = COALESCE($3, current_stage_id),
             stages = $4::jsonb,
             asin_progress = $5::jsonb,
             message = COALESCE($6, message),
             updated_at = $7,
             job_version = job_version + $8
         WHERE job_id = $1
           AND lease_generation = $2
           AND status = 'running'
         RETURNING ${jobColumns}`,
        [
          input.jobId,
          input.leaseGeneration,
          input.currentStageId ?? null,
          JSON.stringify(stages),
          JSON.stringify(progress),
          input.message ?? null,
          input.recordedAt,
          outputChanged ? 1 : 0,
        ],
      );
      return await this.requireFencedRow(updated.rows[0]);
    });
  }

  async complete(input: {
    jobId: string;
    leaseGeneration: number;
    workerId?: string;
    completedAt: string;
    message: string;
  }): Promise<SyncJobRecord> {
    assertPositiveInteger(input.leaseGeneration, "leaseGeneration");
    return await this.queries.transaction(async () => {
      const current = await this.lockFencedJob(
        input.jobId,
        input.leaseGeneration,
        input.workerId,
      );
      const stages = settleTerminalStages(
        current.stages,
        "completed",
        input.completedAt,
        input.message,
      );
      const result = await this.queries.query<SyncJobRow>(
        `UPDATE sync_jobs
         SET status = 'completed',
             message = $3,
             stages = $5::jsonb,
             leased_by = NULL,
             lease_expires_at = NULL,
             completed_at = $4,
             updated_at = $4
         WHERE job_id = $1
           AND lease_generation = $2
           AND status = 'running'
         RETURNING ${jobColumns}`,
        [
          input.jobId,
          input.leaseGeneration,
          input.message,
          input.completedAt,
          JSON.stringify(stages),
        ],
      );
      return await this.requireFencedRow(result.rows[0]);
    });
  }

  async fail(input: {
    jobId: string;
    leaseGeneration: number;
    workerId?: string;
    failedAt: string;
    message: string;
    error: Record<string, unknown>;
  }): Promise<SyncJobRecord> {
    assertPositiveInteger(input.leaseGeneration, "leaseGeneration");
    return await this.queries.transaction(async () => {
      const current = await this.lockFencedJob(
        input.jobId,
        input.leaseGeneration,
        input.workerId,
      );
      const stages = settleTerminalStages(
        current.stages,
        "failed",
        input.failedAt,
        input.message,
      );
      const result = await this.queries.query<SyncJobRow>(
        `UPDATE sync_jobs
         SET status = 'failed',
             message = $3,
             stages = $6::jsonb,
             leased_by = NULL,
             lease_expires_at = NULL,
             failed_at = $4,
             updated_at = $4,
             error = $5::jsonb
         WHERE job_id = $1
           AND lease_generation = $2
           AND status = 'running'
         RETURNING ${jobColumns}`,
        [
          input.jobId,
          input.leaseGeneration,
          input.message,
          input.failedAt,
          JSON.stringify({ ...current.error, ...input.error }),
          JSON.stringify(stages),
        ],
      );
      return await this.requireFencedRow(result.rows[0]);
    });
  }

  private async findActiveByFingerprint(
    organizationId: string,
    fingerprint: string,
  ): Promise<SyncJobRecord | null> {
    const result = await this.queries.query<SyncJobRow>(
      `SELECT ${jobColumns}
       FROM sync_jobs
       WHERE organization_id = $1
         AND fingerprint = $2
         AND status IN ('queued', 'running')
       ORDER BY created_at ASC, job_id ASC
       LIMIT 1`,
      [organizationId, fingerprint],
    );
    const row = result.rows[0];
    return row ? await this.mapJobRow(row) : null;
  }

  private async recordSubmission(
    input: AdmitSyncJobInput,
    jobId: string,
    disposition: "created" | "deduplicated",
  ): Promise<void> {
    await this.queries.query(
      `INSERT INTO sync_job_submissions (
         job_id, organization_id, project_id, run_id, actor_id, fingerprint,
         asins, marketplace, disposition, submitted_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)`,
      [
        jobId,
        input.organizationId,
        input.projectId,
        input.runId,
        input.actorId,
        input.fingerprint,
        JSON.stringify(input.asins),
        input.marketplace,
        disposition,
        input.createdAt,
      ],
    );
  }

  private async lockFencedJob(
    jobId: string,
    leaseGeneration: number,
    workerId?: string,
  ): Promise<SyncJobRecord> {
    const result = await this.queries.query<SyncJobRow>(
      `SELECT ${jobColumns}
       FROM sync_jobs
       WHERE job_id = $1
         AND lease_generation = $2
         AND ($3::text IS NULL OR leased_by = $3)
         AND status = 'running'
       FOR UPDATE`,
      [jobId, leaseGeneration, workerId ?? null],
    );
    return await this.requireFencedRow(result.rows[0]);
  }

  private async requireFencedRow(
    row: SyncJobRow | undefined,
  ): Promise<SyncJobRecord> {
    if (!row) throw new SyncJobLeaseLostError();
    return await this.mapJobRow(row);
  }

  private async mapMaintenanceJobRow(row: SyncJobRow): Promise<SyncJobRecord> {
    const modules = await this.queries.query<SyncJobModuleRow>(
      `SELECT asin, module, status, reason, updated_at
       FROM sync_job_modules
       WHERE job_id = $1
       ORDER BY asin ASC, module ASC`,
      [row.job_id],
    );
    const asinProgress = mergeProgress(
      parseObjectProgress(row.asin_progress),
      modules.rows.map((module) => ({
        asin: module.asin,
        module: module.module,
        status: module.status,
        reason: module.reason,
        updatedAt: iso(module.updated_at),
      })),
    );
    const asins = parseAsins(row.asins);
    return {
      jobId: row.job_id,
      organizationId: row.organization_id,
      projectId: row.project_id,
      runId: row.run_id,
      actorId: row.actor_id,
      fingerprint: row.fingerprint,
      asins,
      marketplace: row.marketplace,
      status: row.status,
      message: row.message,
      currentStageId: row.current_stage_id,
      stages: parseStages(row.stages),
      asinProgress,
      leasedBy: row.leased_by,
      leaseGeneration: row.lease_generation,
      jobVersion: Number(row.job_version),
      leaseExpiresAt: row.lease_expires_at ? iso(row.lease_expires_at) : null,
      policyVersion: row.policy_version,
      error: parseNullableRecord(row.error),
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
      ...(row.completed_at ? { completedAt: iso(row.completed_at) } : {}),
      scope: {
        organizationId: row.organization_id,
        projectId: row.project_id,
        runId: row.run_id,
        marketplace: row.marketplace,
        asins,
      },
    };
  }

  private async mapJobRow(row: SyncJobRow): Promise<SyncJobRecord> {
    const modules = await this.queries.query<SyncJobModuleRow>(
      `SELECT asin, module, status, reason, updated_at
       FROM sync_job_modules
       WHERE job_id = $1
       ORDER BY asin ASC, module ASC`,
      [row.job_id],
    );
    const asinProgress = mergeProgress(
      parseObjectProgress(row.asin_progress),
      modules.rows.map((module) => ({
        asin: module.asin,
        module: module.module,
        status: module.status,
        reason: module.reason,
        updatedAt: iso(module.updated_at),
      })),
    );
    const asins = parseAsins(row.asins);
    const stages = parseStages(row.stages);
    const dynamicSnapshot = row.run_id
      ? await this.dynamicTrafficSnapshotState(row.run_id)
      : undefined;
    const resumableStages = await this.resumableStageIds(row, stages);
    return Object.freeze({
      jobId: row.job_id,
      organizationId: row.organization_id,
      projectId: row.project_id,
      runId: row.run_id,
      actorId: row.actor_id,
      fingerprint: row.fingerprint,
      asins,
      marketplace: row.marketplace,
      status: row.status,
      message: row.message,
      currentStageId: row.current_stage_id,
      stages,
      asinProgress,
      leasedBy: row.leased_by,
      leaseGeneration: row.lease_generation,
      jobVersion: Number(row.job_version),
      leaseExpiresAt: row.lease_expires_at ? iso(row.lease_expires_at) : null,
      policyVersion: row.policy_version,
      error: parseNullableRecord(row.error),
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
      ...(dynamicSnapshot ? { dynamicSnapshot } : {}),
      ...(resumableStages.length > 0 ? { resumableStages } : {}),
      ...(row.completed_at ? { completedAt: iso(row.completed_at) } : {}),
      queuePosition: await this.queuePosition(row),
      scope: {
        organizationId: row.organization_id,
        projectId: row.project_id,
        runId: row.run_id,
        marketplace: row.marketplace,
        asins,
      },
    });
  }

  private async resumableStageIds(
    row: SyncJobRow,
    stages: readonly SyncJobStageRecord[],
  ): Promise<readonly string[]> {
    if (row.status !== "completed" && row.status !== "failed") return [];
    const fileStages = failedOrUnfinishedStageIds(stages);
    if (!row.run_id) return fileStages;
    const result = await this.queries.query<{ eligible: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM sync_jobs job
           JOIN analysis_runs run ON run.id = job.run_id
          WHERE job.job_id = $1
            AND job.organization_id = $2
            AND job.project_id IS NOT NULL
            AND job.actor_id IS NOT NULL
            AND run.project_id = job.project_id
            AND run.created_by = job.actor_id
            AND run.idempotency_scope = 'sync:' || job.organization_id || ':' || job.project_id
            AND run.idempotency_key = job.job_id
            AND job.leased_by IS NULL
            AND job.lease_expires_at IS NULL
            AND (SELECT count(*) FROM run_stages stage WHERE stage.run_id = run.id) = 1
            AND EXISTS (
              SELECT 1 FROM run_stages stage
               WHERE stage.run_id = run.id
                 AND stage.stage = 'traffic-analysis'
                 AND (
                   (run.status IN ('partial', 'failed') AND stage.status IN ('partial', 'failed'))
                   OR (
                     job.status = 'failed'
                     AND job.error ->> 'code' = 'SYNC_JOB_ATTEMPTS_EXHAUSTED'
                     AND run.status = 'queued'
                     AND stage.status = 'queued'
                   )
                 )
            )
            AND NOT EXISTS (SELECT 1 FROM data_snapshots snapshot WHERE snapshot.run_id = run.id)
       ) AS eligible`,
      [row.job_id, row.organization_id],
    );
    if (result.rows[0]?.eligible !== true) return [];
    return fileStages.length > 0 ? fileStages : ["traffic"];
  }

  private async dynamicTrafficSnapshotState(
    runId: string,
  ): Promise<"pending" | "ready"> {
    const result = await this.queries.query<{ status: string }>(
      `SELECT status FROM run_stages
        WHERE run_id = $1 AND stage = 'traffic-analysis'`,
      [runId],
    );
    return result.rows[0]?.status === "succeeded" ? "ready" : "pending";
  }

  private async queuePosition(row: SyncJobRow): Promise<number | null> {
    if (row.status === "running") return 0;
    if (row.status !== "queued") return null;
    const result = await this.queries.query<{ position: number }>(
      `SELECT count(*)::integer AS position
       FROM sync_jobs
       WHERE organization_id = $1
         AND status = 'queued'
         AND (created_at, job_id) <= ($2::timestamptz, $3)`,
      [row.organization_id, row.created_at, row.job_id],
    );
    return result.rows[0]?.position ?? null;
  }
}

function mergeStages(
  stages: readonly SyncJobStageRecord[],
  patches: readonly (Partial<SyncJobStageRecord> & Pick<SyncJobStageRecord, "id">)[],
): readonly SyncJobStageRecord[] {
  if (patches.length === 0) return stages;
  const patchesById = new Map(patches.map((patch) => [patch.id, patch]));
  return stages.map((stage) =>
    patchesById.has(stage.id) ? { ...stage, ...patchesById.get(stage.id)! } : stage,
  );
}

function settleTerminalStages(
  stages: readonly SyncJobStageRecord[],
  outcome: "completed" | "failed",
  completedAt: string,
  message: string,
): readonly SyncJobStageRecord[] {
  return stages.map((stage) => {
    if (stage.kind === "manual") return stage;
    if (["done", "skipped", "failed"].includes(stage.status)) return stage;
    if (!["active", "running", "pending"].includes(stage.status)) return stage;
    return {
      ...stage,
      status: outcome === "completed"
        ? (stage.status === "pending" ? "skipped" : "done")
        : "failed",
      detail: outcome === "failed" ? message : stage.detail,
      completedAt,
    };
  });
}

const resumableStageStatuses = new Set(["failed", "partial", "pending", "active", "running"]);

function failedOrUnfinishedStageIds(stages: readonly SyncJobStageRecord[]): readonly string[] {
  return stages
    .filter((stage) => stage.kind === "auto" && stage.id !== "queue" && resumableStageStatuses.has(stage.status))
    .map((stage) => stage.id);
}

function repairStageIds(job: SyncJobRecord): readonly string[] {
  const value = job.error?.resumeStages;
  if (Array.isArray(value) && value.every((stage) => typeof stage === "string")) {
    return value;
  }
  return failedOrUnfinishedStageIds(job.stages);
}

function mergeProgress(
  current: SyncJobRecord["asinProgress"],
  modules: readonly SyncJobModuleRecord[],
): SyncJobRecord["asinProgress"] {
  const next: Record<
    string,
    Record<string, Omit<SyncJobModuleRecord, "asin" | "module">>
  > = {};
  for (const [asin, values] of Object.entries(current)) {
    next[asin] = { ...values };
  }
  for (const progressModule of modules) {
    next[progressModule.asin] ??= {};
    next[progressModule.asin]![progressModule.module] = {
      status: progressModule.status,
      reason: progressModule.reason,
      updatedAt: progressModule.updatedAt,
    };
  }
  return next;
}

function parseAsins(value: unknown): readonly string[] {
  return parseStoredValue(syncJobAsinsSchema, value);
}

function parseStages(value: unknown): readonly SyncJobStageRecord[] {
  return parseStoredValue(z.array(syncJobStageSchema), value);
}

function parseObjectProgress(value: unknown): SyncJobRecord["asinProgress"] {
  return parseStoredValue(syncJobProgressSchema, value);
}

function parseNullableRecord(value: unknown): Record<string, unknown> | null {
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

const projectableStageIds = new Set<ProjectableSyncStage>([
  "keywords", "reviews", "sales_trend", "fba", "listing", "category", "traffic",
]);
const terminalOutputStatuses = new Set(["done", "partial", "failed"]);
const gapReasonCodes = new Set(["CONNECT_TIMEOUT", "UPSTREAM_EMPTY", "CONNECTOR_FAILED"]);

function validScopedStageOutput(
  output: StageOutputDraft,
  job: SyncJobRecord,
  stages: readonly SyncJobStageRecord[],
): boolean {
  if (!job.projectId || !job.runId) return false;
  if (output.organizationId !== job.organizationId || output.projectId !== job.projectId || output.runId !== job.runId) {
    return false;
  }
  if (!projectableStageIds.has(output.stage) || !terminalOutputStatuses.has(output.stageStatus)) return false;
  if (!/^[a-f0-9]{64}$/.test(output.contentHash)) return false;
  const stage = stages.find((candidate) => candidate.id === output.stage);
  if (!stage || stage.status !== output.stageStatus) return false;
  const hasData = output.data !== undefined && isRecord(output.data);
  const hasGap = output.gap !== undefined
    && output.gap.state === output.stageStatus
    && output.stageStatus !== "done"
    && gapReasonCodes.has(output.gap.reasonCode);
  return hasData !== hasGap && (output.stageStatus === "done" ? hasData : hasGap);
}

function parseStageOutput(row: SyncJobStageOutputRow): StageOutputProjection {
  if (!projectableStageIds.has(row.stage_id) || !terminalOutputStatuses.has(row.stage_status)) {
    throw new SyncJobDataError();
  }
  const data = parseNullableRecord(row.data_json);
  const rawGap = parseNullableRecord(row.gap_json);
  const gap = rawGap && typeof rawGap.state === "string" && typeof rawGap.reasonCode === "string"
    && (rawGap.state === "partial" || rawGap.state === "failed")
    && gapReasonCodes.has(rawGap.reasonCode)
    ? { state: rawGap.state, reasonCode: rawGap.reasonCode }
    : undefined;
  if ((data === null) === (gap === undefined) || !/^[a-f0-9]{64}$/.test(row.content_hash)) {
    throw new SyncJobDataError();
  }
  return {
    jobId: row.job_id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    runId: row.run_id,
    stage: row.stage_id,
    stageStatus: row.stage_status,
    jobVersion: Number(row.job_version),
    outputVersion: Number(row.output_version),
    contentHash: row.content_hash,
    updatedAt: iso(row.updated_at),
    ...(data ? { data } : {}),
    ...(gap ? { gap } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`Invalid sync job ${name}`);
  }
}

function normalizeAdmissionInput(input: AdmitSyncJobInput): AdmitSyncJobInput {
  const marketplace = String(input.marketplace).trim().toUpperCase();
  if (marketplace !== "US") {
    throw new TypeError("Unsupported sync job marketplace");
  }
  return {
    ...input,
    marketplace: "US",
    asins: normalizeStoredAsins(input.asins),
  };
}

function assertCompatibleActiveRun(
  input: AdmitSyncJobInput,
  existing: SyncJobRecord,
): void {
  if (
    !input.canonicalRun &&
    input.runId !== null &&
    existing.runId !== input.runId
  ) {
    throw new SyncJobRunConflictError();
  }
}

function normalizeStoredAsins(values: readonly string[]): readonly string[] {
  return [...new Set(values.map((value) => value.trim().toUpperCase()))].sort();
}

function matchesPersistedRepairScope(job: SyncJobRecord, scope: ExactSyncJobScope): boolean {
  return job.jobId === scope.jobId
    && job.organizationId === scope.organizationId
    && job.projectId === scope.projectId
    && job.runId === scope.runId
    && job.fingerprint === scope.fingerprint
    && job.marketplace === scope.marketplace
    && equalExactStrings(job.asins, scope.asins)
    && job.scope.organizationId === scope.organizationId
    && job.scope.projectId === scope.projectId
    && job.scope.runId === scope.runId
    && job.scope.marketplace === scope.marketplace
    && equalExactStrings(job.scope.asins, scope.asins);
}

function equalExactStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

interface PersistedReadinessRepairMarker {
  readonly token?: unknown;
  readonly state?: unknown;
  readonly evidenceDigest?: unknown;
  readonly mirrorBeforeDigest?: unknown;
  readonly mirrorAfterDigest?: unknown;
  readonly module?: unknown;
  readonly [key: string]: unknown;
}

class PersistedReadinessWriteConflict extends Error {}

function persistedReadinessRepairMarker(
  error: Record<string, unknown> | null,
): PersistedReadinessRepairMarker | undefined {
  const marker = error?.persistedReadinessRepair;
  return marker && typeof marker === "object" && !Array.isArray(marker)
    ? marker as PersistedReadinessRepairMarker
    : undefined;
}

function parseStoredValue<Output>(
  schema: z.ZodType<Output>,
  value: unknown,
): Output {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new SyncJobDataError();
  return parsed.data;
}

async function retrySerializable<Result>(
  operation: () => Promise<Result>,
): Promise<Result> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isRetryableTransactionError(error)) throw error;
      lastError = error;
      await delay(Math.min(75, 5 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableTransactionError(error: unknown): boolean {
  const code = postgresErrorCode(error);
  return code === "40001" || code === "40P01";
}

function postgresErrorCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : null;
}
