import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { runPostgresMigrations } from "../../server/db/postgres/migrations";
import { PostgresQueryContext } from "../../server/db/postgres/query-context";
import { PostgresSyncJobStore } from "../../server/db/postgres/sync-job-store";
import {
  SyncJobDataError,
  type StageOutputDraft,
  type SyncJobLease,
  type SyncJobRepository,
} from "../../server/db/sync-job-repository";
import { SyncJobWorkerHandler } from "../../server/services/sync-job-worker-handler";
import { LocalDataStageOutputResponseSchema } from "../../shared/agent-contracts";
import { projectStageOutput } from "../../scripts/lib/sync-stage-output.mjs";
import {
  startPostgresTestContainer,
  type PostgresTestContainer,
} from "./helpers/postgres-test-container";

const NOW = "2026-08-25T09:00:00.000Z";
let postgres: PostgresTestContainer;

before(async () => {
  postgres = await startPostgresTestContainer();
});

after(async () => {
  await postgres?.close();
});

test("terminal stage and output commit atomically and repeated mirror polls do not raise versions", async () => {
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  await postgres.pool.query(`CREATE SCHEMA ${schema}`);
  const pool = postgres.createPool({ searchPath: schema });
  await runPostgresMigrations(pool);
  const store = new PostgresSyncJobStore(new PostgresQueryContext(pool));
  const organizationId = randomUUID();
  const projectId = randomUUID();
  const runId = randomUUID();
  const jobId = randomUUID();
  const admitted = await store.admit({
    jobId,
    organizationId,
    projectId,
    runId,
    actorId: null,
    fingerprint: `stage-output:${jobId}`,
    asins: ["B0TEST0001"],
    marketplace: "US",
    createdAt: NOW,
    currentStageId: "sales_trend",
    message: "Queued",
    stages: [{ id: "sales_trend", label: "Sales", kind: "auto", status: "active", estimatedSeconds: 1 }],
  });
  const lease = await store.claimNext({
    workerId: "stage-output-worker",
    leaseMs: 30_000,
    wholeJobLimit: 1,
    claimedAt: NOW,
  });
  assert.equal(lease?.job.jobId, admitted.job.jobId);
  const salesDraft: StageOutputDraft = {
    organizationId,
    projectId,
    runId,
    stage: "sales_trend",
    stageStatus: "done",
    contentHash: "a".repeat(64),
    updatedAt: NOW,
    data: { trendByAsin: { B0TEST0001: { status: "ready", volume: [] } } },
  };
  const progress = () => ({
    jobId,
    leaseGeneration: lease!.leaseGeneration,
    workerId: "stage-output-worker",
    recordedAt: NOW,
    stage: { id: "sales_trend", status: "done", completedAt: NOW },
    outputs: [salesDraft],
  });
  const exactScope = {
    organizationId,
    projectId,
    runId,
    jobId,
    stage: "sales_trend" as const,
  };

  const first = await store.recordProgress(progress());
  const output = await store.readStageOutput(exactScope);
  assert.equal(first.stages.find((stage) => stage.id === "sales_trend")?.status, "done");
  assert.equal(output?.jobVersion, first.jobVersion);
  assert.equal(output?.outputVersion, 1);
  const second = await store.recordProgress(progress());
  assert.equal(second.jobVersion, first.jobVersion);
  assert.equal((await store.readStageOutput(exactScope))?.outputVersion, 1);
  await pool.query(
    "UPDATE sync_job_stage_outputs SET project_id = $2 WHERE job_id = $1 AND stage_id = 'sales_trend'",
    [jobId, randomUUID()],
  );
  assert.equal(await store.readStageOutput(exactScope), null);
  await pool.query(
    "UPDATE sync_job_stage_outputs SET project_id = $2 WHERE job_id = $1 AND stage_id = 'sales_trend'",
    [jobId, projectId],
  );
  await pool.query("UPDATE sync_jobs SET project_id = $2 WHERE job_id = $1", [jobId, randomUUID()]);
  assert.equal(await store.readStageOutput(exactScope), null);
});

test("out-of-scope output drafts cannot make a projectable stage terminal", async () => {
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  await postgres.pool.query(`CREATE SCHEMA ${schema}`);
  const pool = postgres.createPool({ searchPath: schema });
  await runPostgresMigrations(pool);
  const store = new PostgresSyncJobStore(new PostgresQueryContext(pool));
  const organizationId = randomUUID();
  const projectId = randomUUID();
  const runId = randomUUID();
  const jobId = randomUUID();
  await store.admit({
    jobId, organizationId, projectId, runId, actorId: null,
    fingerprint: `stage-output-scope:${jobId}`, asins: ["B0TEST0002"], marketplace: "US",
    createdAt: NOW, currentStageId: "sales_trend", message: "Queued",
    stages: [{ id: "sales_trend", label: "Sales", kind: "auto", status: "active", estimatedSeconds: 1 }],
  });
  const lease = await store.claimNext({ workerId: "scope-worker", leaseMs: 30_000, wholeJobLimit: 1, claimedAt: NOW });
  assert.ok(lease);
  await assert.rejects(store.recordProgress({
    jobId, leaseGeneration: lease.leaseGeneration, workerId: "scope-worker", recordedAt: NOW,
    stage: { id: "sales_trend", status: "done", completedAt: NOW },
    outputs: [{
      organizationId, projectId: randomUUID(), runId, stage: "sales_trend", stageStatus: "done",
      contentHash: "b".repeat(64), updatedAt: NOW, data: { trendByAsin: {} },
    }],
  }), SyncJobDataError);
  assert.equal(await store.readStageOutput({ organizationId, projectId, runId, jobId, stage: "sales_trend" }), null);
  assert.equal((await store.findById(jobId))?.stages.find((stage) => stage.id === "sales_trend")?.status, "active");
  await assert.rejects(store.recordProgress({
    jobId, leaseGeneration: lease.leaseGeneration, workerId: "scope-worker", recordedAt: NOW,
    stage: { id: "sales_trend", status: "done", completedAt: NOW },
    outputs: [{
      organizationId, projectId, runId, stage: "sales_trend", stageStatus: "done",
      contentHash: "d".repeat(64), updatedAt: NOW,
      data: { rawProviderBody: { token: "must-not-persist" } },
    }],
  }), SyncJobDataError);
});

test("every done projector draft satisfies the Task 1 stage-output schema", () => {
  const projectId = randomUUID();
  const runId = randomUUID();
  const asin = "B0TEST0005";
  const exports: Record<string, Record<string, unknown>> = {
    sifKeywordAnalysisData: { [asin]: { keywords: [{ keyword: "alpha" }] } },
    sifKeywordEnrichmentData: { alpha: { status: "ready" } },
    sorftimeReviewAnalysisData: { [asin]: { status: "ready" } },
    sorftimeRatingData: { [asin]: { status: "ready" } },
    sorftimeSalesTrendData: { [asin]: { status: "ready" } },
    sorftimeFbaFeeData: { [asin]: { status: "ready" } },
    sorftimeListingContentData: { [asin]: { status: "ready" } },
    sorftimeCategoryTrendData: { node: { nodeId: "node", asins: [asin] } },
    sifListingTrafficRawByAsin: { [asin]: { overview: {} } },
    sifMonthlyTrafficRawByAsin: { [asin]: { dates: [] } },
  };
  for (const stage of ["keywords", "reviews", "sales_trend", "fba", "listing", "category", "traffic"] as const) {
    const draft = projectStageOutput(stage, [asin], {
      organizationId: randomUUID(), projectId, runId, updatedAt: NOW,
      readExport: (_file: string, name: string) => exports[name],
    });
    const { organizationId: _organizationId, ...responseDraft } = draft;
    assert.equal(LocalDataStageOutputResponseSchema.safeParse({
      ...responseDraft, jobId: "schema-test", jobVersion: 1, outputVersion: 1,
    }).success, true, stage);
  }
});

test("complete and fail settle projectable stages only with fixed atomic gaps", async () => {
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  await postgres.pool.query(`CREATE SCHEMA ${schema}`);
  const pool = postgres.createPool({ searchPath: schema });
  await runPostgresMigrations(pool);
  const store = new PostgresSyncJobStore(new PostgresQueryContext(pool));
  for (const outcome of ["completed", "failed"] as const) {
    const organizationId = randomUUID();
    const projectId = randomUUID();
    const runId = randomUUID();
    const jobId = randomUUID();
    await store.admit({
      jobId, organizationId, projectId, runId, actorId: null,
      fingerprint: `auto-gap:${outcome}:${jobId}`, asins: ["B0TEST0006"], marketplace: "US",
      createdAt: NOW, currentStageId: "sales_trend", message: "Queued",
      stages: [{ id: "sales_trend", label: "Sales", kind: "auto", status: "active", estimatedSeconds: 1 }],
    });
    const lease = await store.claimNext({ workerId: `gap-${outcome}`, leaseMs: 30_000, wholeJobLimit: 1, claimedAt: NOW });
    assert.ok(lease);
    if (outcome === "completed") {
      await store.complete({ jobId, leaseGeneration: lease.leaseGeneration, workerId: `gap-${outcome}`, completedAt: NOW, message: "done" });
    } else {
      await store.fail({ jobId, leaseGeneration: lease.leaseGeneration, workerId: `gap-${outcome}`, failedAt: NOW, message: "failed", error: { code: "TEST" } });
    }
    const output = await store.readStageOutput({ organizationId, projectId, runId, jobId, stage: "sales_trend" });
    assert.deepEqual(output?.gap, {
      state: outcome === "completed" ? "partial" : "failed",
      reasonCode: outcome === "completed" ? "UPSTREAM_EMPTY" : "CONNECTOR_FAILED",
    });
    assert.equal((await store.findById(jobId))?.stages[0]?.status, outcome === "completed" ? "partial" : "failed");
  }
});

test("worker discards an invalid output draft instead of forwarding its terminal stage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sync-output-worker-"));
  const organizationId = randomUUID();
  const projectId = randomUUID();
  const runId = randomUUID();
  const job = {
    jobId: "worker-output-job", organizationId, projectId, runId, actorId: null,
    fingerprint: "worker-output", asins: ["B0TEST0007"], marketplace: "US" as const,
    status: "running" as const, message: "Running", currentStageId: "sales_trend",
    stages: [{ id: "sales_trend", label: "Sales", kind: "auto" as const, status: "active", estimatedSeconds: 1 }],
    asinProgress: {}, leasedBy: "worker-output", leaseGeneration: 1, jobVersion: 1,
    leaseExpiresAt: null, error: null, createdAt: NOW, updatedAt: NOW,
    scope: { organizationId, projectId, runId, marketplace: "US" as const, asins: ["B0TEST0007"] },
  };
  const progress: Array<Record<string, unknown>> = [];
  const repository = {
    async heartbeat() { return job; },
    async recordProgress(input: Record<string, unknown>) { progress.push(input); return job; },
    async complete() { return job; },
    async fail() { return job; },
  } as unknown as SyncJobRepository;
  const lease: SyncJobLease = { job, leaseGeneration: 1 };
  const handler = new SyncJobWorkerHandler({
    syncJobs: repository,
    mirrorDirectory: directory,
    heartbeatIntervalMs: 60_000,
    progressPollMs: 60_000,
    runner: async (_lease, context) => {
      await context.writeMirror({
        currentStageId: "sales_trend",
        stages: [{ ...job.stages[0], status: "done", completedAt: NOW }],
        outputs: [{
          organizationId, projectId, runId, stage: "sales_trend", stageStatus: "done",
          contentHash: "c".repeat(64), updatedAt: NOW, data: { rawProviderBody: {} },
        }],
      });
      return { status: "completed" };
    },
  });
  try {
    await handler.handle(lease);
    assert.equal(progress.some((input) => {
      const stage = input.stage as { id?: string; status?: string } | undefined;
      return stage?.id === "sales_trend" && stage.status === "done";
    }), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
