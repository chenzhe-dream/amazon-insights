import type { QueryResultRow } from "pg";
import { z } from "zod";

import type { PostgresQueryContext } from "./query-context";
import {
  SyncJobDataError,
  SyncJobLeaseLostError,
  type AdmitSyncJobInput,
  type SyncJobModuleRecord,
  type SyncJobRecord,
  type SyncJobRepository,
  type SyncJobStageRecord,
} from "../sync-job-repository";

const claimLockId = "731553996872021105";
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
  readonly lease_expires_at: Date | string | null;
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
  lease_expires_at,
  error,
  created_at,
  updated_at,
  completed_at
`;

export class PostgresSyncJobStore implements SyncJobRepository {
  constructor(private readonly queries: PostgresQueryContext) {}

  async admit(input: AdmitSyncJobInput) {
    const existing = await this.findActiveByFingerprint(
      input.organizationId,
      input.fingerprint,
    );
    if (existing) {
      await this.recordSubmission(input, existing.jobId, "deduplicated");
      return { job: existing, disposition: "deduplicated" as const };
    }

    try {
      const inserted = await this.queries.query<SyncJobRow>(
        `INSERT INTO sync_jobs (
           job_id, organization_id, project_id, run_id, actor_id, fingerprint,
           marketplace, asins, status, message, current_stage_id, stages,
           created_at, updated_at
         )
         VALUES (
           $1, $2, $3, $4, $5, $6,
           $7, $8::jsonb, 'queued', $9, $10, $11::jsonb,
           $12, $12
         )
         RETURNING ${jobColumns}`,
        [
          input.jobId,
          input.organizationId,
          input.projectId,
          input.runId,
          input.actorId,
          input.fingerprint,
          input.marketplace,
          JSON.stringify(input.asins),
          input.message,
          input.currentStageId,
          JSON.stringify(input.stages),
          input.createdAt,
        ],
      );
      await this.recordSubmission(input, input.jobId, "created");
      return {
        job: await this.mapJobRow(inserted.rows[0]!),
        disposition: "created" as const,
      };
    } catch (error) {
      if (postgresErrorCode(error) !== "23505") throw error;
      const deduplicated = await this.findActiveByFingerprint(
        input.organizationId,
        input.fingerprint,
      );
      if (!deduplicated) throw error;
      await this.recordSubmission(input, deduplicated.jobId, "deduplicated");
      return { job: deduplicated, disposition: "deduplicated" as const };
    }
  }

  async findById(jobId: string): Promise<SyncJobRecord | null> {
    const result = await this.queries.query<SyncJobRow>(
      `SELECT ${jobColumns} FROM sync_jobs WHERE job_id = $1`,
      [jobId],
    );
    const row = result.rows[0];
    return row ? await this.mapJobRow(row) : null;
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
    const result = await this.queries.query<SyncJobRow>(
      `WITH claim_lock AS (
         SELECT pg_advisory_xact_lock($5::bigint)
       ),
       running_capacity AS (
         SELECT count(*)::integer AS active_running_count
         FROM sync_jobs, claim_lock
         WHERE status = 'running'
           AND lease_expires_at > $1
       ),
       candidate AS (
         SELECT job_id
         FROM sync_jobs
         CROSS JOIN running_capacity
         WHERE (
           status = 'running' AND lease_expires_at <= $1
         )
         OR (
           status = 'queued'
           AND running_capacity.active_running_count < $2
         )
         ORDER BY
           CASE
             WHEN status = 'running' AND lease_expires_at <= $1 THEN 0
             ELSE 1
           END,
           created_at ASC,
           job_id ASC
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
        claimLockId,
      ],
    );
    const row = result.rows[0];
    if (!row) return null;
    const job = await this.mapJobRow(row);
    return { job, leaseGeneration: job.leaseGeneration };
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
    recordedAt: string;
    currentStageId?: string;
    stage?: Partial<SyncJobStageRecord> & Pick<SyncJobStageRecord, "id">;
    modules?: readonly SyncJobModuleRecord[];
    message?: string;
  }): Promise<SyncJobRecord> {
    assertPositiveInteger(input.leaseGeneration, "leaseGeneration");
    return await this.queries.transaction(async () => {
      const current = await this.lockFencedJob(input.jobId, input.leaseGeneration);
      const stages = mergeStage(current.stages, input.stage);
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
             updated_at = $7
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
        ],
      );
      return await this.requireFencedRow(updated.rows[0]);
    });
  }

  async complete(input: {
    jobId: string;
    leaseGeneration: number;
    completedAt: string;
    message: string;
  }): Promise<SyncJobRecord> {
    assertPositiveInteger(input.leaseGeneration, "leaseGeneration");
    const result = await this.queries.query<SyncJobRow>(
      `UPDATE sync_jobs
       SET status = 'completed',
           message = $3,
           leased_by = NULL,
           lease_expires_at = NULL,
           completed_at = $4,
           updated_at = $4
       WHERE job_id = $1
         AND lease_generation = $2
         AND status = 'running'
       RETURNING ${jobColumns}`,
      [input.jobId, input.leaseGeneration, input.message, input.completedAt],
    );
    return await this.requireFencedRow(result.rows[0]);
  }

  async fail(input: {
    jobId: string;
    leaseGeneration: number;
    failedAt: string;
    message: string;
    error: Record<string, unknown>;
  }): Promise<SyncJobRecord> {
    assertPositiveInteger(input.leaseGeneration, "leaseGeneration");
    const result = await this.queries.query<SyncJobRow>(
      `UPDATE sync_jobs
       SET status = 'failed',
           message = $3,
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
        JSON.stringify(input.error),
      ],
    );
    return await this.requireFencedRow(result.rows[0]);
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
  ): Promise<SyncJobRecord> {
    const result = await this.queries.query<SyncJobRow>(
      `SELECT ${jobColumns}
       FROM sync_jobs
       WHERE job_id = $1
         AND lease_generation = $2
         AND status = 'running'
       FOR UPDATE`,
      [jobId, leaseGeneration],
    );
    return await this.requireFencedRow(result.rows[0]);
  }

  private async requireFencedRow(
    row: SyncJobRow | undefined,
  ): Promise<SyncJobRecord> {
    if (!row) throw new SyncJobLeaseLostError();
    return await this.mapJobRow(row);
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
      stages: parseStages(row.stages),
      asinProgress,
      leasedBy: row.leased_by,
      leaseGeneration: row.lease_generation,
      leaseExpiresAt: row.lease_expires_at ? iso(row.lease_expires_at) : null,
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
    });
  }
}

function mergeStage(
  stages: readonly SyncJobStageRecord[],
  patch: (Partial<SyncJobStageRecord> & Pick<SyncJobStageRecord, "id">) | undefined,
): readonly SyncJobStageRecord[] {
  if (!patch) return stages;
  return stages.map((stage) =>
    stage.id === patch.id ? { ...stage, ...patch } : stage,
  );
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

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`Invalid sync job ${name}`);
  }
}

function parseStoredValue<Output>(
  schema: z.ZodType<Output>,
  value: unknown,
): Output {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new SyncJobDataError();
  return parsed.data;
}

function postgresErrorCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : null;
}
