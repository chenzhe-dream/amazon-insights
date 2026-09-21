import assert from "node:assert/strict";
import test from "node:test";

import type { SyncJobRecord } from "../../server/db/sync-job-repository";
import { PostgresSyncJobStore } from "../../server/db/postgres/sync-job-store";
import {
  SyncLegacyRepairConflictError,
  SyncLegacyStatusRepairService,
  legacyRepairCandidates,
  legacyRepairVersion,
  type SyncLegacyRepairRepository,
} from "../../server/services/sync-legacy-status-repair-service";
import {
  SyncLegacyRepairApplyRequestSchema,
  SyncLegacyRepairResponseSchema,
  findHttpContract,
} from "../../shared/agent-contracts";

const ORGANIZATION_ID = "20000000-0000-4000-8000-000000000001";
const FOREIGN_ORGANIZATION_ID = "20000000-0000-4000-8000-000000000099";
const NOW = "2026-08-23T09:00:00.000Z";
const UPDATED = "2026-08-23T08:00:00.000Z";

test("legacy repair contracts are strict, secret-free, and registered", () => {
  const response = {
    jobId: "legacy-job",
    version: "opaque-version",
    candidates: [{
      asin: "B0CCYMV1T1",
      module: "keywords",
      connectorId: "sif",
      nextStatus: "pending",
      reason: "LEGACY_UNVERIFIED",
    }],
  };
  assert.equal(SyncLegacyRepairResponseSchema.safeParse(response).success, true);
  assert.equal(SyncLegacyRepairResponseSchema.safeParse({ ...response, secret: "sentinel" }).success, false);
  assert.equal(SyncLegacyRepairApplyRequestSchema.safeParse({ version: response.version }).success, true);
  assert.equal(SyncLegacyRepairApplyRequestSchema.safeParse({ version: response.version, resume: true }).success, false);
  assert.ok(findHttpContract("POST", "/v1/admin/sync-asins/legacy-job/legacy-repair/preview"));
  assert.ok(findHttpContract("POST", "/v1/admin/sync-asins/legacy-job/legacy-repair/apply"));
});

test("preview selects only unverified pre-diagnostics upstream-empty modules and remains offline", async () => {
  let providerCalls = 0;
  const provider = () => {
    providerCalls += 1;
    throw new Error("legacy repair must remain offline");
  };
  void provider;
  const repository = memoryRepository(legacyJob());
  const service = new SyncLegacyStatusRepairService({ repository, now: () => NOW });

  const preview = await service.preview({ organizationId: ORGANIZATION_ID, jobId: "legacy-job" });
  assert.deepEqual(preview, {
    jobId: "legacy-job",
    version: legacyRepairVersion(UPDATED),
    candidates: [{
      asin: "B0CCYMV1T1",
      module: "keywords",
      connectorId: "sif",
      nextStatus: "pending",
      reason: "LEGACY_UNVERIFIED",
    }],
  });
  assert.equal(repository.updates, 0);
  assert.equal(providerCalls, 0);

  assert.equal(await service.preview({ organizationId: FOREIGN_ORGANIZATION_ID, jobId: "legacy-job" }), null);
  repository.job = { ...legacyJob(), status: "running" };
  assert.equal(await service.preview({ organizationId: ORGANIZATION_ID, jobId: "legacy-job" }), null);
  repository.job = { ...legacyJob(), error: { diagnosticsVersion: "1" } };
  assert.deepEqual(
    await service.preview({ organizationId: ORGANIZATION_ID, jobId: "legacy-job" }),
    { jobId: "legacy-job", version: legacyRepairVersion(UPDATED), candidates: [] },
  );
  repository.job = null;
  assert.equal(await service.preview({ organizationId: ORGANIZATION_ID, jobId: "missing" }), null);
});

test("apply compares the opaque version, recomputes candidates, and preserves successful state", async () => {
  const original = legacyJob();
  const repository = memoryRepository(original);
  const service = new SyncLegacyStatusRepairService({ repository, now: () => NOW });
  await assert.rejects(
    service.apply({ organizationId: ORGANIZATION_ID, jobId: original.jobId, version: "stale-version" }),
    SyncLegacyRepairConflictError,
  );
  assert.equal(repository.updates, 0);

  const applied = await service.apply({
    organizationId: ORGANIZATION_ID,
    jobId: original.jobId,
    version: legacyRepairVersion(original.updatedAt),
  });
  assert.ok(applied);
  assert.deepEqual(applied.candidates, legacyRepairCandidates(original));
  assert.equal(repository.updates, 1);
  assert.equal(repository.job?.jobId, original.jobId);
  assert.deepEqual(repository.job?.scope, original.scope);
  assert.equal(repository.job?.fingerprint, original.fingerprint);
  assert.equal(repository.job?.leaseGeneration, original.leaseGeneration);
  assert.deepEqual(repository.job?.asinProgress.B0CCYMV1T1?.keywords, {
    status: "pending",
    reason: "LEGACY_UNVERIFIED",
    updatedAt: NOW,
  });
  assert.deepEqual(repository.job?.asinProgress.B0CCYMV1T1?.reviews, original.asinProgress.B0CCYMV1T1?.reviews);
  assert.deepEqual(repository.job?.asinProgress.B0CCYMV1T1?.sales_trend, original.asinProgress.B0CCYMV1T1?.sales_trend);
  assert.deepEqual(repository.job?.asinProgress.B0CCYMV1T1?.alexa_voc, original.asinProgress.B0CCYMV1T1?.alexa_voc);
  assert.deepEqual(repository.job?.error?.generatedFiles, original.error?.generatedFiles);
  assert.equal(repository.job?.error?.trafficSnapshotId, original.error?.trafficSnapshotId);
});

test("PostgreSQL apply locks and updates only recomputed candidate modules", async () => {
  const sql: string[] = [];
  let applied = false;
  const target = legacyJob();
  const row = jobRow(target);
  const modules = Object.entries(target.asinProgress.B0CCYMV1T1 ?? {}).map(([module, progress]) => ({
    asin: "B0CCYMV1T1",
    module,
    status: progress.status,
    reason: progress.reason,
    updated_at: progress.updatedAt,
  }));
  const queries = {
    async transaction<T>(operation: () => Promise<T>) { return operation(); },
    async query(text: string, values?: unknown[]) {
      sql.push(text);
      if (/FROM sync_jobs[\s\S]+FOR UPDATE/.test(text)) return { rows: [row] };
      if (/FROM sync_job_modules/.test(text)) {
        return {
          rows: modules.map((module) => module.module === "keywords" && applied
            ? { ...module, status: "pending", reason: "LEGACY_UNVERIFIED", updated_at: NOW }
            : module),
        };
      }
      if (/UPDATE sync_job_modules/.test(text)) {
        applied = true;
        assert.deepEqual(values?.slice(0, 3), ["legacy-job", "B0CCYMV1T1", "keywords"]);
        return { rows: [] };
      }
      if (/UPDATE sync_jobs[\s\S]+asin_progress/.test(text)) {
        return {
          rows: [{
            ...row,
            asin_progress: JSON.parse(String(values?.[2])),
            updated_at: NOW,
          }],
        };
      }
      throw new Error("unexpected test query");
    },
  };
  const store = new PostgresSyncJobStore(queries as never);
  const result = await store.applyLegacyStatusRepair({
    jobId: target.jobId,
    organizationId: ORGANIZATION_ID,
    version: legacyRepairVersion(target.updatedAt),
    appliedAt: NOW,
  });
  assert.equal(result?.disposition, "applied");
  assert.equal(sql.some((statement) => /FOR UPDATE/.test(statement)), true);
  assert.equal(sql.filter((statement) => /UPDATE sync_job_modules/.test(statement)).length, 1);
  assert.equal(sql.some((statement) => /job_attempts|data_snapshots|traffic_data/i.test(statement)), false);
});

function legacyJob(): SyncJobRecord {
  return {
    jobId: "legacy-job",
    organizationId: ORGANIZATION_ID,
    projectId: "10000000-0000-4000-8000-000000000003",
    runId: "10000000-0000-4000-8000-000000000004",
    actorId: "10000000-0000-4000-8000-000000000001",
    fingerprint: "f".repeat(64),
    asins: ["B0CCYMV1T1"],
    marketplace: "US",
    status: "completed",
    message: "Completed with gaps",
    currentStageId: "build",
    stages: [
      { id: "keywords", label: "Keywords", kind: "auto", status: "partial", estimatedSeconds: 1 },
      { id: "alexa_voc", label: "Alexa", kind: "manual", status: "manual", estimatedSeconds: 1 },
    ],
    asinProgress: {
      B0CCYMV1T1: {
        keywords: { status: "upstream-empty", reason: "上游未返回可用数据", updatedAt: UPDATED },
        reviews: { status: "upstream-empty", reason: "PROVIDER_SCHEMA_VALID_EMPTY", updatedAt: UPDATED },
        traffic: { status: "upstream-empty", reason: "上游未返回可用数据", updatedAt: UPDATED },
        sales_trend: { status: "ready", reason: null, updatedAt: UPDATED },
        alexa_voc: { status: "manual", reason: "需人工录入 Alexa VOC", updatedAt: UPDATED },
      },
    },
    leasedBy: null,
    leaseGeneration: 3,
    leaseExpiresAt: null,
    error: {
      providerEvidence: [{ asin: "B0CCYMV1T1", module: "traffic", outcome: "success" }],
      generatedFiles: ["safe-generated-ref"],
      trafficSnapshotId: "safe-traffic-ref",
    },
    createdAt: "2026-08-20T08:00:00.000Z",
    updatedAt: UPDATED,
    completedAt: UPDATED,
    scope: {
      organizationId: ORGANIZATION_ID,
      projectId: "10000000-0000-4000-8000-000000000003",
      runId: "10000000-0000-4000-8000-000000000004",
      marketplace: "US",
      asins: ["B0CCYMV1T1"],
    },
  };
}

function memoryRepository(initial: SyncJobRecord | null) {
  const repository: SyncLegacyRepairRepository & { job: SyncJobRecord | null; updates: number } = {
    job: initial,
    updates: 0,
    async findById() { return repository.job; },
    async applyLegacyStatusRepair(input) {
      if (!repository.job || repository.job.organizationId !== input.organizationId) return null;
      if (legacyRepairVersion(repository.job.updatedAt) !== input.version) return { disposition: "conflict" as const };
      const candidates = legacyRepairCandidates(repository.job);
      const asinProgress = { ...structuredClone(repository.job.asinProgress) };
      for (const candidate of candidates) {
        asinProgress[candidate.asin] = { ...asinProgress[candidate.asin], [candidate.module]: {
          status: "pending",
          reason: "LEGACY_UNVERIFIED",
          updatedAt: input.appliedAt,
        } };
      }
      repository.updates += 1;
      repository.job = { ...repository.job, asinProgress, updatedAt: input.appliedAt };
      return { disposition: "applied" as const, job: repository.job, candidates };
    },
  };
  return repository;
}

function jobRow(job: SyncJobRecord) {
  return {
    job_id: job.jobId,
    organization_id: job.organizationId,
    project_id: job.projectId,
    run_id: job.runId,
    actor_id: job.actorId,
    fingerprint: job.fingerprint,
    marketplace: job.marketplace,
    asins: job.asins,
    status: job.status,
    message: job.message,
    current_stage_id: job.currentStageId,
    stages: job.stages,
    asin_progress: job.asinProgress,
    leased_by: job.leasedBy,
    lease_generation: job.leaseGeneration,
    lease_expires_at: job.leaseExpiresAt,
    policy_version: "standard-v1",
    error: job.error,
    created_at: job.createdAt,
    updated_at: job.updatedAt,
    completed_at: job.completedAt ?? null,
  };
}
