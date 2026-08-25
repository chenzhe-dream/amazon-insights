import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { runPostgresMigrations } from "../../server/db/postgres/migrations";
import { PostgresQueryContext } from "../../server/db/postgres/query-context";
import { PostgresSyncJobStore } from "../../server/db/postgres/sync-job-store";
import type { StageOutputDraft } from "../../server/db/sync-job-repository";
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
});

test("out-of-scope output drafts are ignored while the fenced stage patch remains valid", async () => {
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
  await store.recordProgress({
    jobId, leaseGeneration: lease.leaseGeneration, workerId: "scope-worker", recordedAt: NOW,
    stage: { id: "sales_trend", status: "done", completedAt: NOW },
    outputs: [{
      organizationId, projectId: randomUUID(), runId, stage: "sales_trend", stageStatus: "done",
      contentHash: "b".repeat(64), updatedAt: NOW, data: { trendByAsin: {} },
    }],
  });
  assert.equal(await store.readStageOutput({ organizationId, projectId, runId, jobId, stage: "sales_trend" }), null);
});
