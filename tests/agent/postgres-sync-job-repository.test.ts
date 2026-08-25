import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import type { Pool } from "pg";

import { runPostgresMigrations } from "../../server/db/postgres/migrations";
import { PostgresQueryContext } from "../../server/db/postgres/query-context";
import { PostgresSyncJobStore } from "../../server/db/postgres/sync-job-store";
import { openRuntimeAgentRepository } from "../../server/db/open-runtime-repository";
import {
  SyncJobLeaseLostError,
  SyncJobQueueUnavailableError,
  type SyncJobRepository,
} from "../../server/db/sync-job-repository";
import {
  startPostgresTestContainer,
  type PostgresTestContainer,
} from "./helpers/postgres-test-container";

const NOW = "2026-08-20T09:00:00.000Z";
const LATER = "2026-08-20T09:00:01.000Z";

let postgres: PostgresTestContainer;

before(async () => {
  postgres = await startPostgresTestContainer();
});

after(async () => {
  await postgres?.close();
});

test("PostgreSQL sync jobs survive restart and deduplicate only inside tenant scope", async () => {
  const { first, second } = await createRepositories();
  const input = syncJobInput({
    organizationId: "91000000-0000-4000-8000-000000000001",
    projectId: "91000000-0000-4000-8000-000000000002",
    runId: "91000000-0000-4000-8000-000000000003",
    fingerprint: "same-request",
    asins: ["B0SYNC0001", "B0SYNC0002"],
  });

  const created = await first.admit(input);
  assert.equal(created.disposition, "created");

  const deduplicated = await second.admit({
    ...input,
    jobId: randomUUID(),
    asins: [...input.asins].reverse(),
  });
  assert.equal(deduplicated.disposition, "deduplicated");
  assert.equal(deduplicated.job.jobId, created.job.jobId);
  assert.deepEqual(deduplicated.job.asins, input.asins);

  const otherTenant = await second.admit({
    ...input,
    jobId: randomUUID(),
    organizationId: "91000000-0000-4000-8000-000000000099",
  });
  assert.equal(otherTenant.disposition, "created");
  assert.notEqual(otherTenant.job.jobId, created.job.jobId);
});

test("active scoped sync rejects a different explicit run without creating durable work", async () => {
  const { first, second, firstPool } = await createRepositories();
  const organizationId = randomUUID();
  const actorId = randomUUID();
  const projectId = randomUUID();
  const firstRunId = randomUUID();
  const secondRunId = randomUUID();
  await firstPool.query(
    `INSERT INTO users
       (id, organization_id, email, display_name, role, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'Explicit owner', 'member', 'active', $4, $4)`,
    [actorId, organizationId, `${actorId}@example.test`, NOW],
  );
  await firstPool.query(
    `INSERT INTO projects
       (id, organization_id, name, marketplace, asins_json, created_by, created_at, updated_at)
     VALUES ($1, $2, 'Explicit runs', 'US', '["B0SYNC0401"]', $3, $4, $4)`,
    [projectId, organizationId, actorId, NOW],
  );
  for (const [index, runId] of [firstRunId, secondRunId].entries()) {
    await firstPool.query(
      `INSERT INTO analysis_runs
         (id, project_id, mode, status, created_by, data_cutoff_at,
          idempotency_scope, idempotency_key, created_at, updated_at)
       VALUES ($1, $2, 'existing-data', 'queued', $3, $4, $5, $6, $4, $4)`,
      [runId, projectId, actorId, NOW, `explicit:${projectId}`, `run-${index}`],
    );
  }
  const fingerprint = `explicit:${projectId}:B0SYNC0401`;
  const firstAdmission = await first.admit(syncJobInput({
    organizationId,
    projectId,
    runId: firstRunId,
    actorId,
    fingerprint,
    asins: ["B0SYNC0401"],
  }));

  await assert.rejects(second.admit(syncJobInput({
    organizationId,
    projectId,
    runId: secondRunId,
    actorId,
    fingerprint,
    asins: ["B0SYNC0401"],
  })), (error: unknown) => error instanceof Error && error.name === "SyncJobRunConflictError");

  assert.equal((await firstPool.query<{ count: number }>(
    "SELECT count(*)::integer AS count FROM sync_jobs WHERE organization_id = $1",
    [organizationId],
  )).rows[0]?.count, 1);
  assert.equal(await submissionCount(firstPool, organizationId), 1);
  assert.equal((await firstPool.query<{ count: number }>(
    "SELECT count(*)::integer AS count FROM run_stages WHERE run_id IN ($1, $2)",
    [firstRunId, secondRunId],
  )).rows[0]?.count, 0);
  assert.equal(firstAdmission.job.runId, firstRunId);
});

test("PostgreSQL sync job admission is atomic under identical concurrent submissions", async () => {
  const { first, firstPool } = await createRepositories();
  const organizationId = "95000000-0000-4000-8000-000000000001";
  const actorId = "95000000-0000-4000-8000-000000000002";
  const submissions = await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      first.admit(syncJobInput({
        jobId: randomUUID(),
        organizationId,
        actorId,
        fingerprint: "atomic-identical",
        asins: index % 2 === 0
          ? ["B0SYNC0502", "B0SYNC0501", "B0SYNC0501"]
          : ["B0SYNC0501", "B0SYNC0502"],
        createdAt: `2026-08-20T09:30:${String(index).padStart(2, "0")}.000Z`,
      })),
    ),
  );

  assert.equal(new Set(submissions.map((submission) => submission.job.jobId)).size, 1);
  assert.equal(submissions.filter((submission) => submission.disposition === "created").length, 1);
  assert.equal(submissions.filter((submission) => submission.disposition === "deduplicated").length, 19);
  assert.deepEqual(submissions[0]!.job.asins, ["B0SYNC0501", "B0SYNC0502"]);
  assert.equal(await activeJobCount(firstPool, organizationId), 1);
  assert.equal(await submissionCount(firstPool, organizationId), 20);
});

test("canonical sync admission atomically reuses one run, traffic stage, job, and worker", async () => {
  const { first, firstPool } = await createRepositories();
  const organizationId = randomUUID();
  const actorId = randomUUID();
  const projectId = randomUUID();
  await firstPool.query(
    `INSERT INTO users
       (id, organization_id, email, display_name, role, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'Sync owner', 'member', 'active', $4, $4)`,
    [actorId, organizationId, `${actorId}@example.test`, NOW],
  );
  await firstPool.query(
    `INSERT INTO projects
       (id, organization_id, name, marketplace, asins_json, created_by, created_at, updated_at)
     VALUES ($1, $2, 'Canonical sync', 'US', '["B0SYNC0602","B0SYNC0601"]', $3, $4, $4)`,
    [projectId, organizationId, actorId, NOW],
  );

  const admissions = await Promise.all(Array.from({ length: 12 }, async () => {
    const runId = randomUUID();
    return await first.admit(syncJobInput({
      jobId: randomUUID(),
      organizationId,
      projectId,
      runId,
      actorId,
      fingerprint: `canonical:${projectId}:B0SYNC0601:B0SYNC0602`,
      asins: ["B0SYNC0601", "B0SYNC0602"],
      canonicalRun: {
        runId,
        stageId: randomUUID(),
        dataCutoffAt: NOW,
      },
    }));
  }));

  assert.equal(new Set(admissions.map(({ job }) => job.jobId)).size, 1);
  assert.equal(new Set(admissions.map(({ job }) => job.runId)).size, 1);
  assert.equal(admissions.filter(({ disposition }) => disposition === "created").length, 1);
  const runId = admissions[0]!.job.runId;
  assert.ok(runId);
  assert.deepEqual((await firstPool.query(
    `SELECT DISTINCT run_id FROM sync_job_submissions WHERE organization_id = $1`,
    [organizationId],
  )).rows, [{ run_id: runId }]);
  assert.deepEqual((await firstPool.query(
    `SELECT project_id, status, created_by FROM analysis_runs WHERE id = $1`,
    [runId],
  )).rows, [{ project_id: projectId, status: "queued", created_by: actorId }]);
  assert.deepEqual((await firstPool.query(
    `SELECT stage, status FROM run_stages WHERE run_id = $1`,
    [runId],
  )).rows, [{ stage: "traffic-analysis", status: "queued" }]);
  assert.equal((await firstPool.query(
    `SELECT count(*)::integer AS count FROM job_attempts
      WHERE stage_id IN (SELECT id FROM run_stages WHERE run_id = $1)`,
    [runId],
  )).rows[0]?.count, 0);
  const lease = await first.claimNext({
    workerId: "canonical-worker",
    leaseMs: 30_000,
    wholeJobLimit: 4,
    claimedAt: NOW,
  });
  assert.equal(lease?.job.jobId, admissions[0]!.job.jobId);
  assert.equal(await first.claimNext({
    workerId: "duplicate-canonical-worker",
    leaseMs: 30_000,
    wholeJobLimit: 4,
    claimedAt: NOW,
  }), null);
  assert.equal(await first.beginCanonicalTrafficRun({
    jobId: lease!.job.jobId,
    runId,
    actorId,
    leaseGeneration: lease!.leaseGeneration,
    workerId: "canonical-worker",
    maxAttempts: 3,
    startedAt: NOW,
  }), "started");
  assert.equal(await first.settleCanonicalTrafficRun({
    jobId: lease!.job.jobId,
    runId,
    outcome: "succeeded",
    settledAt: LATER,
    error: null,
  }), true);
  assert.deepEqual((await firstPool.query(
    `SELECT status, progress, completed_at IS NOT NULL AS completed
       FROM run_stages WHERE run_id = $1`,
    [runId],
  )).rows, [{ status: "succeeded", progress: 100, completed: true }]);
  assert.equal((await firstPool.query<{ status: string }>(
    `SELECT status FROM analysis_runs WHERE id = $1`,
    [runId],
  )).rows[0]?.status, "succeeded");
});

test("canonical sync admission rolls back job and run when stage creation fails", async () => {
  const { first, firstPool } = await createRepositories();
  const organizationId = randomUUID();
  const actorId = randomUUID();
  const projectId = randomUUID();
  const existingRunId = randomUUID();
  const conflictingStageId = randomUUID();
  const candidateRunId = randomUUID();
  const candidateJobId = randomUUID();
  await firstPool.query(
    `INSERT INTO users
       (id, organization_id, email, display_name, role, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'Rollback owner', 'member', 'active', $4, $4)`,
    [actorId, organizationId, `${actorId}@example.test`, NOW],
  );
  await firstPool.query(
    `INSERT INTO projects
       (id, organization_id, name, marketplace, asins_json, created_by, created_at, updated_at)
     VALUES ($1, $2, 'Rollback', 'US', '["B0SYNC0701"]', $3, $4, $4)`,
    [projectId, organizationId, actorId, NOW],
  );
  await firstPool.query(
    `INSERT INTO analysis_runs
       (id, project_id, mode, status, created_by, data_cutoff_at,
        idempotency_scope, idempotency_key, created_at, updated_at)
     VALUES ($1, $2, 'existing-data', 'succeeded', $3, $4, $5, 'existing', $4, $4)`,
    [existingRunId, projectId, actorId, NOW, `existing:${projectId}`],
  );
  await firstPool.query(
    `INSERT INTO run_stages
       (id, run_id, stage, status, progress, created_at, updated_at)
     VALUES ($1, $2, 'traffic-analysis', 'succeeded', 100, $3, $3)`,
    [conflictingStageId, existingRunId, NOW],
  );

  await assert.rejects(first.admit(syncJobInput({
    jobId: candidateJobId,
    organizationId,
    projectId,
    runId: candidateRunId,
    actorId,
    fingerprint: `rollback:${projectId}:B0SYNC0701`,
    asins: ["B0SYNC0701"],
    canonicalRun: {
      runId: candidateRunId,
      stageId: conflictingStageId,
      dataCutoffAt: NOW,
    },
  })));

  assert.equal((await firstPool.query<{ count: number }>(
    `SELECT count(*)::integer AS count FROM sync_jobs WHERE job_id = $1`,
    [candidateJobId],
  )).rows[0]?.count, 0);
  assert.equal((await firstPool.query<{ count: number }>(
    `SELECT count(*)::integer AS count FROM analysis_runs WHERE id = $1`,
    [candidateRunId],
  )).rows[0]?.count, 0);
  assert.deepEqual((await firstPool.query(
    `SELECT run_id, status, progress FROM run_stages WHERE id = $1`,
    [conflictingStageId],
  )).rows, [{ run_id: existingRunId, status: "succeeded", progress: 100 }]);
});

test("terminal canonical sync permits an explicit restart with a new job and run", async () => {
  const { first, firstPool } = await createRepositories();
  const organizationId = randomUUID();
  const actorId = randomUUID();
  const projectId = randomUUID();
  const fingerprint = `restart:${projectId}:B0SYNC0751`;
  await firstPool.query(
    `INSERT INTO users
       (id, organization_id, email, display_name, role, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'Restart owner', 'member', 'active', $4, $4)`,
    [actorId, organizationId, `${actorId}@example.test`, NOW],
  );
  await firstPool.query(
    `INSERT INTO projects
       (id, organization_id, name, marketplace, asins_json, created_by, created_at, updated_at)
     VALUES ($1, $2, 'Restart', 'US', '["B0SYNC0751"]', $3, $4, $4)`,
    [projectId, organizationId, actorId, NOW],
  );
  const admitCanonical = (jobId: string, runId: string, stageId: string, createdAt: string) =>
    first.admit(syncJobInput({
      jobId,
      organizationId,
      projectId,
      runId,
      actorId,
      fingerprint,
      asins: ["B0SYNC0751"],
      createdAt,
      canonicalRun: { runId, stageId, dataCutoffAt: createdAt },
    }));
  const firstJobId = randomUUID();
  const firstRunId = randomUUID();
  const firstAdmission = await admitCanonical(firstJobId, firstRunId, randomUUID(), NOW);
  const lease = await first.claimNext({
    workerId: "restart-worker",
    leaseMs: 30_000,
    wholeJobLimit: 4,
    claimedAt: NOW,
  });
  assert.equal(lease?.job.jobId, firstAdmission.job.jobId);
  assert.equal(await first.beginCanonicalTrafficRun({
    jobId: firstJobId,
    runId: firstRunId,
    actorId,
    leaseGeneration: lease!.leaseGeneration,
    workerId: "restart-worker",
    maxAttempts: 3,
    startedAt: NOW,
  }), "started");
  assert.equal(await first.settleCanonicalTrafficRun({
    jobId: firstJobId,
    runId: firstRunId,
    outcome: "succeeded",
    settledAt: LATER,
    error: null,
  }), true);
  await first.complete({
    jobId: firstJobId,
    leaseGeneration: lease!.leaseGeneration,
    workerId: "restart-worker",
    completedAt: LATER,
    message: "completed",
  });

  const secondJobId = randomUUID();
  const secondRunId = randomUUID();
  const restarted = await admitCanonical(
    secondJobId,
    secondRunId,
    randomUUID(),
    "2026-08-20T09:00:02.000Z",
  );

  assert.equal(restarted.disposition, "created");
  assert.equal(restarted.job.jobId, secondJobId);
  assert.equal(restarted.job.runId, secondRunId);
  assert.notEqual(restarted.job.runId, firstRunId);
  assert.equal((await firstPool.query<{ count: number }>(
    "SELECT count(*)::integer AS count FROM analysis_runs WHERE project_id = $1",
    [projectId],
  )).rows[0]?.count, 2);
  assert.equal((await firstPool.query<{ count: number }>(
    "SELECT count(*)::integer AS count FROM run_stages WHERE run_id IN ($1, $2)",
    [firstRunId, secondRunId],
  )).rows[0]?.count, 2);
});

test("canonical traffic run lifecycle closes partial, failed, and cancelled outcomes", async () => {
  const { first, firstPool } = await createRepositories();
  const outcomes = ["partial", "failed", "cancelled"] as const;
  for (const [index, outcome] of outcomes.entries()) {
    const organizationId = randomUUID();
    const actorId = randomUUID();
    const projectId = randomUUID();
    const runId = randomUUID();
    await firstPool.query(
      `INSERT INTO users
         (id, organization_id, email, display_name, role, status, created_at, updated_at)
       VALUES ($1, $2, $3, 'Terminal owner', 'member', 'active', $4, $4)`,
      [actorId, organizationId, `${actorId}@example.test`, NOW],
    );
    await firstPool.query(
      `INSERT INTO projects
         (id, organization_id, name, marketplace, asins_json, created_by, created_at, updated_at)
       VALUES ($1, $2, 'Terminal', 'US', $3::jsonb, $4, $5, $5)`,
      [projectId, organizationId, JSON.stringify([`B0SYNC08${index}1`]), actorId, NOW],
    );
    const admitted = await first.admit(syncJobInput({
      organizationId,
      projectId,
      runId,
      actorId,
      fingerprint: `terminal:${projectId}`,
      asins: [`B0SYNC08${index}1`],
      canonicalRun: { runId, stageId: randomUUID(), dataCutoffAt: NOW },
    }));
    const lease = await first.claimNext({
      workerId: `terminal-worker-${index}`,
      leaseMs: 30_000,
      wholeJobLimit: 4,
      claimedAt: NOW,
    });
    assert.equal(lease?.job.jobId, admitted.job.jobId);
    assert.equal(await first.beginCanonicalTrafficRun({
      jobId: admitted.job.jobId,
      runId,
      actorId,
      leaseGeneration: lease!.leaseGeneration,
      workerId: `terminal-worker-${index}`,
      maxAttempts: 3,
      startedAt: NOW,
    }), "started");
    assert.equal(await first.settleCanonicalTrafficRun({
      jobId: admitted.job.jobId,
      runId,
      outcome,
      settledAt: LATER,
      error: { code: `TEST_${outcome.toUpperCase()}` },
    }), true);
    assert.equal((await firstPool.query<{ status: string }>(
      "SELECT status FROM analysis_runs WHERE id = $1",
      [runId],
    )).rows[0]?.status, outcome);
    assert.equal((await firstPool.query<{ status: string }>(
      "SELECT status FROM run_stages WHERE run_id = $1",
      [runId],
    )).rows[0]?.status, outcome);
  }
});

test("non-category failed stages are not eligible for explicit in-place resume", async () => {
  const { first, second, firstPool } = await createRepositories();
  const created = await first.admit(syncJobInput({
    fingerprint: "resume-original-scope",
    asins: ["B0SYNC0901"],
    stages: [
      { id: "queue", label: "Queue", kind: "auto", status: "done", estimatedSeconds: 1 },
      { id: "catalog", label: "Catalog", kind: "auto", status: "done", estimatedSeconds: 1 },
      { id: "keywords", label: "Keywords", kind: "auto", status: "failed", estimatedSeconds: 1 },
      { id: "reviews", label: "Reviews", kind: "auto", status: "partial", estimatedSeconds: 1 },
      { id: "alexa_voc", label: "Alexa", kind: "manual", status: "manual", estimatedSeconds: 1 },
      { id: "build", label: "Build", kind: "auto", status: "skipped", estimatedSeconds: 1 },
    ],
    currentStageId: "reviews",
  }));
  const lease = await first.claimNext({
    workerId: "initial-resume-worker",
    leaseMs: 30_000,
    wholeJobLimit: 4,
    claimedAt: NOW,
  });
  assert.ok(lease);
  await first.recordProgress({
    jobId: created.job.jobId,
    leaseGeneration: lease.leaseGeneration,
    workerId: "initial-resume-worker",
    recordedAt: NOW,
    modules: [
      { asin: "B0SYNC0901", module: "catalog", status: "ready", reason: null, updatedAt: NOW },
      { asin: "B0SYNC0901", module: "keywords", status: "connector-failed", reason: "DNS_NOT_FOUND", updatedAt: NOW },
    ],
  });
  await first.complete({
    jobId: created.job.jobId,
    leaseGeneration: lease.leaseGeneration,
    workerId: "initial-resume-worker",
    completedAt: LATER,
    message: "completed with gaps",
  });

  const before = await first.findById(created.job.jobId);
  await Promise.all([
    assert.rejects(first.resume({
      jobId: created.job.jobId,
      organizationId: created.job.organizationId,
      actorId: created.job.actorId,
      resumedAt: "2026-08-20T09:00:02.000Z",
    }), /Permanent category gap is not eligible/i),
    assert.rejects(second.resume({
      jobId: created.job.jobId,
      organizationId: created.job.organizationId,
      actorId: created.job.actorId,
      resumedAt: "2026-08-20T09:00:02.000Z",
    }), /Permanent category gap is not eligible/i),
  ]);
  assert.deepEqual(await first.findById(created.job.jobId), before);
  assert.equal(await activeJobCount(firstPool, created.job.organizationId), 0);
});

test("permanent category gap resumes only category in place without creating identities", async () => {
  const { first, firstPool } = await createRepositories();
  const organizationId = randomUUID();
  const ownerId = randomUUID();
  const adminId = randomUUID();
  const projectId = randomUUID();
  const runId = randomUUID();
  const runStageId = randomUUID();
  const asin = "B0SYNC0971";
  await firstPool.query(
    `INSERT INTO users
       (id, organization_id, email, display_name, role, status, created_at, updated_at)
     VALUES
       ($1, $3, $4, 'Category owner', 'member', 'active', $6, $6),
       ($2, $3, $5, 'Category admin', 'admin', 'active', $6, $6)`,
    [ownerId, adminId, organizationId, `${ownerId}@example.test`, `${adminId}@example.test`, NOW],
  );
  await firstPool.query(
    `INSERT INTO projects
       (id, organization_id, name, marketplace, asins_json, created_by, created_at, updated_at)
     VALUES ($1, $2, 'Category resume', 'US', $3::jsonb, $4, $5, $5)`,
    [projectId, organizationId, JSON.stringify([asin]), ownerId, NOW],
  );
  const admitted = await first.admit(syncJobInput({
    organizationId,
    projectId,
    runId,
    actorId: ownerId,
    fingerprint: `category-resume:${projectId}:${asin}`,
    asins: [asin],
    canonicalRun: { runId, stageId: runStageId, dataCutoffAt: NOW },
    stages: [
      { id: "queue", label: "Queue", kind: "auto", status: "done", estimatedSeconds: 0 },
      { id: "keywords", label: "Keywords", kind: "auto", status: "done", estimatedSeconds: 1 },
      { id: "category", label: "Category", kind: "auto", status: "pending", estimatedSeconds: 1 },
      { id: "traffic", label: "Traffic", kind: "auto", status: "done", estimatedSeconds: 1 },
    ],
    currentStageId: "category",
  }));
  const lease = await first.claimNext({
    workerId: "category-timeout-worker",
    leaseMs: 30_000,
    wholeJobLimit: 4,
    claimedAt: NOW,
  });
  assert.equal(lease?.job.jobId, admitted.job.jobId);
  await first.recordProgress({
    jobId: admitted.job.jobId,
    leaseGeneration: lease!.leaseGeneration,
    workerId: "category-timeout-worker",
    recordedAt: LATER,
    currentStageId: "category",
    stage: { id: "category", status: "failed", completedAt: LATER },
    modules: [
      { asin, module: "keywords", status: "ready", reason: null, updatedAt: LATER },
      { asin, module: "category", status: "timeout", reason: "CONNECT_TIMEOUT", updatedAt: LATER },
    ],
    outputs: [{
      organizationId,
      projectId,
      runId,
      stage: "category",
      stageStatus: "failed",
      contentHash: "c".repeat(64),
      gap: { state: "failed", reasonCode: "CONNECT_TIMEOUT" },
      updatedAt: LATER,
    }],
  });
  await first.complete({
    jobId: admitted.job.jobId,
    leaseGeneration: lease!.leaseGeneration,
    workerId: "category-timeout-worker",
    completedAt: LATER,
    message: "completed with permanent category gap",
  });
  await firstPool.query(
    `INSERT INTO concurrency_physical_attempts
       (organization_id, resource, job_id, attempt_kind, policy_version, recorded_at,
        stage_id, logical_operation_key, dispatch_key)
     VALUES
       ($1, 'sorftime', $2, 'initial',
        (SELECT policy_version FROM concurrency_policy_versions ORDER BY created_at DESC LIMIT 1), $3,
        'category', 'category-resume-operation', 'category-resume-operation:initial'),
       ($1, 'sorftime', $2, 'transient-retry',
        (SELECT policy_version FROM concurrency_policy_versions ORDER BY created_at DESC LIMIT 1), $4,
        'category', 'category-resume-operation', 'category-resume-operation:transient-retry')`,
    [organizationId, admitted.job.jobId, NOW, LATER],
  );

  assert.deepEqual((await first.findById(admitted.job.jobId))?.resumableStages, ["category"]);
  const before = await categoryResumeIdentityCounts(firstPool, admitted.job.jobId, projectId, runId);
  const beforeOutput = await categoryOutputSnapshot(firstPool, admitted.job.jobId);
  const resumed = await first.resume({
    jobId: admitted.job.jobId,
    organizationId,
    actorId: adminId,
    resumedAt: "2026-08-20T09:00:02.000Z",
  });
  const after = await categoryResumeIdentityCounts(firstPool, admitted.job.jobId, projectId, runId);

  assert.deepEqual(resumed?.resumedStages, ["category"]);
  assert.deepEqual(after, before);
  assert.equal(resumed?.job.jobId, admitted.job.jobId);
  assert.equal(resumed?.job.runId, runId);
  assert.equal(resumed?.job.stages.find((stage) => stage.id === "category")?.status, "pending");
  assert.equal(resumed?.job.stages.find((stage) => stage.id === "keywords")?.status, "done");
  assert.equal(resumed?.job.asinProgress[asin]?.category?.status, "pending");
  assert.equal(resumed?.job.asinProgress[asin]?.keywords?.status, "ready");
  assert.deepEqual(resumed?.job.error?.resumeStages, ["category"]);
  assert.deepEqual(await categoryOutputSnapshot(firstPool, admitted.job.jobId), beforeOutput);
});

test("terminal canonical traffic gap is not eligible for category-only resume", async () => {
  const { first, second, firstPool } = await createRepositories();
  const organizationId = randomUUID();
  const ownerId = randomUUID();
  const adminId = randomUUID();
  const projectId = randomUUID();
  const runId = randomUUID();
  const stageId = randomUUID();
  await firstPool.query(
    `INSERT INTO users
       (id, organization_id, email, display_name, role, status, created_at, updated_at)
     VALUES
       ($1, $3, $4, 'Sync owner', 'member', 'active', $6, $6),
       ($2, $3, $5, 'Resume admin', 'admin', 'active', $6, $6)`,
    [
      ownerId,
      adminId,
      organizationId,
      `${ownerId}@example.test`,
      `${adminId}@example.test`,
      NOW,
    ],
  );
  await firstPool.query(
    `INSERT INTO projects
       (id, organization_id, name, marketplace, asins_json, created_by, created_at, updated_at)
     VALUES ($1, $2, 'Canonical resume', 'US', '["B0SYNC0951"]', $3, $4, $4)`,
    [projectId, organizationId, ownerId, NOW],
  );
  const admitted = await first.admit(syncJobInput({
    organizationId,
    projectId,
    runId,
    actorId: ownerId,
    fingerprint: `canonical-resume:${projectId}:B0SYNC0951`,
    asins: ["B0SYNC0951"],
    canonicalRun: { runId, stageId, dataCutoffAt: NOW },
    stages: [
      { id: "queue", label: "Queue", kind: "auto", status: "done", estimatedSeconds: 0 },
      { id: "catalog", label: "Catalog", kind: "auto", status: "done", estimatedSeconds: 1 },
      { id: "traffic", label: "Traffic", kind: "auto", status: "skipped", estimatedSeconds: 1 },
      { id: "alexa_voc", label: "Alexa VOC", kind: "manual", status: "manual", estimatedSeconds: 0 },
    ],
    currentStageId: "traffic",
  }));
  const initialLease = await first.claimNext({
    workerId: "canonical-resume-initial",
    leaseMs: 30_000,
    wholeJobLimit: 4,
    claimedAt: NOW,
  });
  assert.equal(initialLease?.job.jobId, admitted.job.jobId);
  assert.equal(await first.beginCanonicalTrafficRun({
    jobId: admitted.job.jobId,
    runId,
    actorId: ownerId,
    leaseGeneration: initialLease!.leaseGeneration,
    workerId: "canonical-resume-initial",
    maxAttempts: 3,
    startedAt: NOW,
  }), "started");
  assert.equal(await first.settleCanonicalTrafficRun({
    jobId: admitted.job.jobId,
    runId,
    outcome: "partial",
    settledAt: LATER,
    error: { code: "SYNC_TRAFFIC_SNAPSHOT_FAILED" },
  }), true);
  await first.recordProgress({
    jobId: admitted.job.jobId,
    leaseGeneration: initialLease!.leaseGeneration,
    workerId: "canonical-resume-initial",
    recordedAt: LATER,
    modules: [
      { asin: "B0SYNC0951", module: "catalog", status: "ready", reason: null, updatedAt: LATER },
      { asin: "B0SYNC0951", module: "traffic", status: "connector-failed", reason: "SIF_TRAFFIC_SCHEMA_INVALID", updatedAt: LATER },
    ],
  });
  await first.complete({
    jobId: admitted.job.jobId,
    leaseGeneration: initialLease!.leaseGeneration,
    workerId: "canonical-resume-initial",
    completedAt: LATER,
    message: "completed with traffic gap",
  });
  assert.equal((await first.findById(admitted.job.jobId))?.resumableStages, undefined);

  assert.equal(await second.resume({
    jobId: admitted.job.jobId,
    organizationId: randomUUID(),
    actorId: adminId,
    resumedAt: "2026-08-20T09:00:02.000Z",
  }), null);
  assert.deepEqual((await firstPool.query(
    "SELECT status FROM analysis_runs WHERE id = $1",
    [runId],
  )).rows, [{ status: "partial" }]);

  const before = await canonicalResumeSnapshot(firstPool, admitted.job.jobId, runId);
  await assert.rejects(first.resume({
      jobId: admitted.job.jobId,
      organizationId,
      actorId: adminId,
      resumedAt: "2026-08-20T09:00:02.000Z",
    }), /Permanent category gap is not eligible/i);
  assert.deepEqual(await canonicalResumeSnapshot(firstPool, admitted.job.jobId, runId), before);
  assert.equal((await firstPool.query<{ count: number }>(
    "SELECT count(*)::integer AS count FROM sync_jobs WHERE organization_id = $1",
    [organizationId],
  )).rows[0]?.count, 1);
  assert.equal((await firstPool.query<{ count: number }>(
    "SELECT count(*)::integer AS count FROM analysis_runs WHERE project_id = $1",
    [projectId],
  )).rows[0]?.count, 1);
  assert.equal((await firstPool.query<{ count: number }>(
    "SELECT count(*)::integer AS count FROM run_stages WHERE run_id = $1",
    [runId],
  )).rows[0]?.count, 1);
  assert.equal((await firstPool.query<{ count: number }>(
    "SELECT count(*)::integer AS count FROM job_attempts WHERE stage_id = $1",
    [stageId],
  )).rows[0]?.count, 0);
});

test("stranded exhausted canonical traffic remains ineligible for category-only resume", async () => {
  const { first, second, firstPool } = await createRepositories();
  const fixture = await createTerminalCanonicalFixture(
    first,
    firstPool,
    "stranded-exhausted",
  );
  await firstPool.query(
    `UPDATE sync_jobs
        SET status = 'failed', message = 'attempts exhausted',
            completed_at = NULL, failed_at = $2,
            leased_by = NULL, lease_expires_at = NULL,
            error = error || '{"code":"SYNC_JOB_ATTEMPTS_EXHAUSTED"}'::jsonb,
            updated_at = $2
      WHERE job_id = $1`,
    [fixture.jobId, LATER],
  );
  await firstPool.query(
    "UPDATE analysis_runs SET status = 'queued', updated_at = $2 WHERE id = $1",
    [fixture.runId, LATER],
  );
  await firstPool.query(
    `UPDATE run_stages
        SET status = 'queued', progress = 0, attempt_count = 0,
            started_at = NULL, completed_at = NULL, last_error_json = NULL,
            updated_at = $2
      WHERE id = $1`,
    [fixture.stageId, LATER],
  );

  assert.equal((await first.findById(fixture.jobId))?.resumableStages, undefined);
  assert.equal(await second.resume({
    jobId: fixture.jobId,
    organizationId: randomUUID(),
    actorId: fixture.actorId,
    resumedAt: "2026-08-20T09:00:02.000Z",
  }), null);

  const before = await canonicalResumeSnapshot(firstPool, fixture.jobId, fixture.runId);
  await assert.rejects(first.resume({
      jobId: fixture.jobId,
      organizationId: fixture.organizationId,
      actorId: fixture.actorId,
      resumedAt: "2026-08-20T09:00:02.000Z",
    }), /Permanent category gap is not eligible/i);
  assert.deepEqual(await canonicalResumeSnapshot(firstPool, fixture.jobId, fixture.runId), before);
  assert.equal((await firstPool.query<{ count: number }>(
    "SELECT count(*)::integer AS count FROM sync_jobs WHERE organization_id = $1",
    [fixture.organizationId],
  )).rows[0]?.count, 1);
  assert.equal((await firstPool.query<{ count: number }>(
    "SELECT count(*)::integer AS count FROM analysis_runs WHERE project_id = $1",
    [fixture.projectId],
  )).rows[0]?.count, 1);
  assert.equal((await firstPool.query<{ count: number }>(
    "SELECT count(*)::integer AS count FROM run_stages WHERE run_id = $1",
    [fixture.runId],
  )).rows[0]?.count, 1);
  assert.equal((await firstPool.query<{ count: number }>(
    "SELECT count(*)::integer AS count FROM job_attempts WHERE stage_id = $1",
    [fixture.stageId],
  )).rows[0]?.count, 0);
});

test("canonical resume fails closed for a non-unique traffic lifecycle or an existing snapshot", async () => {
  for (const condition of ["non-unique-stage", "existing-snapshot"] as const) {
    const { first, firstPool } = await createRepositories();
    const fixture = await createTerminalCanonicalFixture(first, firstPool, condition);
    if (condition === "non-unique-stage") {
      await firstPool.query(
        `INSERT INTO run_stages
           (id, run_id, stage, status, progress, attempt_count, created_at, updated_at)
         VALUES ($1, $2, 'voc-positioning', 'failed', 0, 0, $3, $3)`,
        [randomUUID(), fixture.runId, NOW],
      );
    } else {
      await firstPool.query(
        `INSERT INTO data_snapshots
           (id, run_id, snapshot_kind, artifact_kind, schema_version, marketplace,
            asins_json, data_cutoff_at, sources_json, payload_json, content_hash, created_at)
         VALUES ($1, $2, NULL, 'traffic', '1.0.0', 'US', $3::jsonb, $4,
                 '[{},{}]'::jsonb, $5::jsonb, $6, $4)`,
        [
          randomUUID(),
          fixture.runId,
          JSON.stringify([fixture.asin]),
          NOW,
          JSON.stringify({
            input: {
              kind: "competitor-traffic-analysis-input",
              marketplace: "US",
              dataCutoffAt: NOW,
            },
          }),
          "a".repeat(64),
        ],
      );
    }
    const before = await canonicalResumeSnapshot(firstPool, fixture.jobId, fixture.runId);
    assert.equal((await first.findById(fixture.jobId))?.resumableStages, undefined);

    await assert.rejects(first.resume({
      jobId: fixture.jobId,
      organizationId: fixture.organizationId,
      actorId: fixture.actorId,
      resumedAt: "2026-08-20T09:00:02.000Z",
    }), /not eligible for in-place resume/i);

    assert.deepEqual(
      await canonicalResumeSnapshot(firstPool, fixture.jobId, fixture.runId),
      before,
    );
  }
});

test("category-only resume leaves a canonical traffic lifecycle and its trigger untouched", async () => {
  const { first, firstPool } = await createRepositories();
  const fixture = await createTerminalCanonicalFixture(first, firstPool, "rollback");
  const before = await canonicalResumeSnapshot(firstPool, fixture.jobId, fixture.runId);
  await firstPool.query(
    `CREATE FUNCTION reject_canonical_run_resume()
     RETURNS TRIGGER LANGUAGE plpgsql AS $$
     BEGIN
       IF NEW.id = '${fixture.runId}' AND NEW.status = 'queued' THEN
         RAISE EXCEPTION 'injected canonical resume failure';
       END IF;
       RETURN NEW;
     END;
     $$;
     CREATE TRIGGER reject_canonical_run_resume
     BEFORE UPDATE ON analysis_runs
     FOR EACH ROW EXECUTE FUNCTION reject_canonical_run_resume();`,
  );

  await assert.rejects(first.resume({
    jobId: fixture.jobId,
    organizationId: fixture.organizationId,
    actorId: fixture.actorId,
    resumedAt: "2026-08-20T09:00:02.000Z",
  }), /Permanent category gap is not eligible/i);

  assert.deepEqual(
    await canonicalResumeSnapshot(firstPool, fixture.jobId, fixture.runId),
    before,
  );
  assert.equal((await firstPool.query<{ count: number }>(
    "SELECT count(*)::integer AS count FROM sync_jobs WHERE organization_id = $1",
    [fixture.organizationId],
  )).rows[0]?.count, 1);
  assert.equal((await firstPool.query<{ count: number }>(
    "SELECT count(*)::integer AS count FROM analysis_runs WHERE project_id = $1",
    [fixture.projectId],
  )).rows[0]?.count, 1);
});

test("sync resume fails closed when the linked run lacks canonical ownership", async () => {
  const { first, firstPool } = await createRepositories();
  const organizationId = randomUUID();
  const actorId = randomUUID();
  const projectId = randomUUID();
  const runId = randomUUID();
  const trafficStageId = randomUUID();
  const attemptId = randomUUID();
  await firstPool.query(
    `INSERT INTO users
       (id, organization_id, email, display_name, role, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'Generic owner', 'member', 'active', $4, $4)`,
    [actorId, organizationId, `${actorId}@example.test`, NOW],
  );
  await firstPool.query(
    `INSERT INTO projects
       (id, organization_id, name, marketplace, asins_json, created_by, created_at, updated_at)
     VALUES ($1, $2, 'Generic resume', 'US', '["B0SYNC0961"]', $3, $4, $4)`,
    [projectId, organizationId, actorId, NOW],
  );
  await firstPool.query(
    `INSERT INTO analysis_runs
       (id, project_id, mode, status, created_by, data_cutoff_at,
        idempotency_scope, idempotency_key, created_at, updated_at)
     VALUES ($1, $2, 'existing-data', 'partial', $3, $4, $5, 'generic-resume', $4, $4)`,
    [runId, projectId, actorId, NOW, `generic:${projectId}`],
  );
  const genericStages = [
    [trafficStageId, "traffic-analysis", "partial"],
    [randomUUID(), "voc-positioning", "succeeded"],
    [randomUUID(), "product-definition", "waiting-input"],
  ] as const;
  for (const [id, stage, status] of genericStages) {
    await firstPool.query(
      `INSERT INTO run_stages
         (id, run_id, stage, status, progress, attempt_count, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 0, 1, $5, $5)`,
      [id, runId, stage, status, NOW],
    );
  }
  await firstPool.query(
    `INSERT INTO job_attempts
       (id, stage_id, attempt_number, status, available_at, created_at, updated_at)
     VALUES ($1, $2, 1, 'failed', $3, $3, $3)`,
    [attemptId, trafficStageId, NOW],
  );
  const admitted = await first.admit(syncJobInput({
    organizationId,
    projectId,
    runId,
    actorId,
    fingerprint: `generic-resume:${projectId}`,
    asins: ["B0SYNC0961"],
    stages: [
      { id: "queue", label: "Queue", kind: "auto", status: "done", estimatedSeconds: 0 },
      { id: "keywords", label: "Keywords", kind: "auto", status: "failed", estimatedSeconds: 1 },
    ],
    currentStageId: "keywords",
  }));
  const lease = await first.claimNext({
    workerId: "generic-resume-initial",
    leaseMs: 30_000,
    wholeJobLimit: 4,
    claimedAt: NOW,
  });
  await first.complete({
    jobId: admitted.job.jobId,
    leaseGeneration: lease!.leaseGeneration,
    workerId: "generic-resume-initial",
    completedAt: LATER,
    message: "completed with gaps",
  });
  const before = {
    job: (await canonicalResumeSnapshot(firstPool, admitted.job.jobId, runId)).job,
    lifecycle: await genericRunSnapshot(firstPool, runId),
  };
  assert.equal((await first.findById(admitted.job.jobId))?.resumableStages, undefined);

  await assert.rejects(first.resume({
    jobId: admitted.job.jobId,
    organizationId,
    actorId,
    resumedAt: "2026-08-20T09:00:02.000Z",
  }), /not eligible for in-place resume/i);

  assert.deepEqual({
    job: (await canonicalResumeSnapshot(firstPool, admitted.job.jobId, runId)).job,
    lifecycle: await genericRunSnapshot(firstPool, runId),
  }, before);
});

test("PostgreSQL sync job admission rejects per-user and organization backlog limits without side effects", async () => {
  const { first, firstPool } = await createRepositories();
  const organizationId = "96000000-0000-4000-8000-000000000001";
  const noisyActorId = "96000000-0000-4000-8000-000000000002";

  await first.admit(syncJobInput({
    organizationId,
    actorId: noisyActorId,
    fingerprint: "noisy-queued-a",
    asins: ["B0SYNC0601"],
  }));
  await first.admit(syncJobInput({
    organizationId,
    actorId: noisyActorId,
    fingerprint: "noisy-queued-b",
    asins: ["B0SYNC0602"],
  }));
  await assert.rejects(
    first.admit(syncJobInput({
      organizationId,
      actorId: noisyActorId,
      fingerprint: "noisy-queued-c",
      asins: ["B0SYNC0603"],
    })),
    /queued sync job limit/i,
  );
  assert.equal(await activeJobCount(firstPool, organizationId), 2);
  assert.equal(await submissionCount(firstPool, organizationId), 2);

  for (let index = 0; index < 98; index += 1) {
    await first.admit(syncJobInput({
      organizationId,
      actorId: `96000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`,
      fingerprint: `org-backlog-${index}`,
      asins: [`B0SYNC${String(700 + index).padStart(4, "0")}`],
      createdAt: `2026-08-20T09:${String(31 + Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
    }));
  }
  await assert.rejects(
    first.admit(syncJobInput({
      organizationId,
      actorId: "96000000-0000-4000-8000-000000009999",
      fingerprint: "org-backlog-overflow",
      asins: ["B0SYNC0999"],
    })),
    /organization sync job backlog/i,
  );
  assert.equal(await activeJobCount(firstPool, organizationId), 100);
  assert.equal(await submissionCount(firstPool, organizationId), 100);
});

test("PostgreSQL fair claim skips actors that already have a running sync job", async () => {
  const { first, second, firstPool } = await createRepositories();
  const organizationId = "97000000-0000-4000-8000-000000000001";
  const noisyActorId = "97000000-0000-4000-8000-000000000002";
  const quietActorA = "97000000-0000-4000-8000-000000000003";
  const quietActorB = "97000000-0000-4000-8000-000000000004";
  const noisyFirst = await first.admit(syncJobInput({
    organizationId,
    actorId: noisyActorId,
    fingerprint: "fair-noisy-first",
    asins: ["B0SYNC0801"],
    createdAt: "2026-08-20T09:40:00.000Z",
  }));
  const noisySecond = await first.admit(syncJobInput({
    organizationId,
    actorId: noisyActorId,
    fingerprint: "fair-noisy-second",
    asins: ["B0SYNC0802"],
    createdAt: "2026-08-20T09:40:01.000Z",
  }));
  const quietFirst = await first.admit(syncJobInput({
    organizationId,
    actorId: quietActorA,
    fingerprint: "fair-quiet-first",
    asins: ["B0SYNC0803"],
    createdAt: "2026-08-20T09:40:02.000Z",
  }));
  const quietSecond = await first.admit(syncJobInput({
    organizationId,
    actorId: quietActorB,
    fingerprint: "fair-quiet-second",
    asins: ["B0SYNC0804"],
    createdAt: "2026-08-20T09:40:03.000Z",
  }));

  const claims = await Promise.all([
    first.claimNext({ workerId: "fair-a", leaseMs: 30_000, wholeJobLimit: 4, claimedAt: "2026-08-20T09:41:00.000Z" }),
    second.claimNext({ workerId: "fair-b", leaseMs: 30_000, wholeJobLimit: 4, claimedAt: "2026-08-20T09:41:00.000Z" }),
    first.claimNext({ workerId: "fair-c", leaseMs: 30_000, wholeJobLimit: 4, claimedAt: "2026-08-20T09:41:00.000Z" }),
    second.claimNext({ workerId: "fair-d", leaseMs: 30_000, wholeJobLimit: 4, claimedAt: "2026-08-20T09:41:00.000Z" }),
  ]);
  const claimedJobIds = claims.flatMap((claim) => claim?.job.jobId ?? []);

  assert.deepEqual(new Set(claimedJobIds), new Set([
    noisyFirst.job.jobId,
    quietFirst.job.jobId,
    quietSecond.job.jobId,
  ]));
  assert.equal(claimedJobIds.includes(noisySecond.job.jobId), false);
  assert.equal(await activeRunningCount(firstPool, "2026-08-20T09:41:00.000Z"), 3);
  assert.equal(await duplicateRunningActorCount(firstPool), 0);
});

test("PostgreSQL sync jobs persist stage and module progress across repository instances", async () => {
  const { first, second } = await createRepositories();
  const admitted = await first.admit(
    syncJobInput({
      organizationId: "92000000-0000-4000-8000-000000000001",
      projectId: "92000000-0000-4000-8000-000000000002",
      runId: "92000000-0000-4000-8000-000000000003",
      fingerprint: "module-progress",
      asins: ["B0SYNC0003", "B0SYNC0004"],
    }),
  );

  const lease = await second.claimNext({
    workerId: "worker-a",
    leaseMs: 30_000,
    wholeJobLimit: 10,
    claimedAt: LATER,
  });
  assert.equal(lease?.job.jobId, admitted.job.jobId);
  assert.equal(lease?.leaseGeneration, 1);

  await first.recordProgress({
    jobId: admitted.job.jobId,
    leaseGeneration: lease!.leaseGeneration,
    recordedAt: "2026-08-20T09:00:02.000Z",
    currentStageId: "catalog",
    stage: {
      id: "catalog",
      status: "running",
      startedAt: "2026-08-20T09:00:02.000Z",
    },
    modules: [
      {
        asin: "B0SYNC0003",
        module: "catalog",
        status: "ready",
        reason: null,
        updatedAt: "2026-08-20T09:00:02.000Z",
      },
      {
        asin: "B0SYNC0004",
        module: "traffic",
        status: "connector-failed",
        reason: "SIF unavailable",
        updatedAt: "2026-08-20T09:00:03.000Z",
      },
    ],
  });

  const reopened = await second.findById(admitted.job.jobId);
  assert.equal(reopened?.currentStageId, "catalog");
  assert.equal(reopened?.stages.find((stage) => stage.id === "catalog")?.status, "running");
  assert.equal(reopened?.asinProgress.B0SYNC0003.catalog?.status, "ready");
  assert.equal(reopened?.asinProgress.B0SYNC0004.traffic?.reason, "SIF unavailable");
});

test("PostgreSQL sync job lease generation fences heartbeat and terminal writes", async () => {
  const { first } = await createRepositories();
  const admitted = await first.admit(
    syncJobInput({
      organizationId: "93000000-0000-4000-8000-000000000001",
      projectId: "93000000-0000-4000-8000-000000000002",
      runId: "93000000-0000-4000-8000-000000000003",
      fingerprint: "lease-fencing",
      asins: ["B0SYNC0005"],
    }),
  );
  const lease = await first.claimNext({
    workerId: "worker-fenced",
    leaseMs: 30_000,
    wholeJobLimit: 10,
    claimedAt: LATER,
  });

  await assert.rejects(
    first.heartbeat({
      jobId: admitted.job.jobId,
      leaseGeneration: lease!.leaseGeneration + 1,
      workerId: "worker-fenced",
      heartbeatAt: "2026-08-20T09:00:02.000Z",
      leaseMs: 30_000,
    }),
    SyncJobLeaseLostError,
  );
  await assert.rejects(
    first.complete({
      jobId: admitted.job.jobId,
      leaseGeneration: lease!.leaseGeneration + 1,
      completedAt: "2026-08-20T09:00:03.000Z",
      message: "done",
    }),
    SyncJobLeaseLostError,
  );

  const completed = await first.complete({
    jobId: admitted.job.jobId,
    leaseGeneration: lease!.leaseGeneration,
    completedAt: "2026-08-20T09:00:03.000Z",
    message: "done",
  });
  assert.equal(completed.status, "completed");
  assert.equal(completed.leasedBy, null);
});

test("PostgreSQL sync job wholeJobLimit counts running jobs, not ASINs", async () => {
  const { first } = await createRepositories();
  const firstJob = await first.admit(
    syncJobInput({
      fingerprint: "whole-job-limit-first",
      asins: Array.from(
        { length: 10 },
        (_, index) => `B0SYNC01${String(index).padStart(2, "0")}`,
      ),
    }),
  );
  const secondJob = await first.admit(
    syncJobInput({
      fingerprint: "whole-job-limit-second",
      asins: ["B0SYNC0200"],
      createdAt: "2026-08-20T09:00:01.000Z",
    }),
  );

  const firstLease = await first.claimNext({
    workerId: "limit-worker-a",
    leaseMs: 1_000,
    wholeJobLimit: 1,
    claimedAt: "2026-08-20T09:10:00.000Z",
  });
  assert.equal(firstLease?.job.jobId, firstJob.job.jobId);

  const blockedByActiveWholeJob = await first.claimNext({
    workerId: "limit-worker-b",
    leaseMs: 1_000,
    wholeJobLimit: 1,
    claimedAt: "2026-08-20T09:10:00.500Z",
  });
  assert.equal(blockedByActiveWholeJob, null);

  const recoveredExpiredLease = await first.claimNext({
    workerId: "limit-worker-c",
    leaseMs: 1_000,
    wholeJobLimit: 1,
    claimedAt: "2026-08-20T09:10:02.000Z",
  });
  assert.equal(recoveredExpiredLease?.job.jobId, firstJob.job.jobId);
  assert.equal(recoveredExpiredLease?.leaseGeneration, firstLease!.leaseGeneration + 1);

  await first.complete({
    jobId: firstJob.job.jobId,
    leaseGeneration: recoveredExpiredLease!.leaseGeneration,
    completedAt: "2026-08-20T09:10:03.000Z",
    message: "done",
  });
  const secondLease = await first.claimNext({
    workerId: "limit-worker-d",
    leaseMs: 1_000,
    wholeJobLimit: 1,
    claimedAt: "2026-08-20T09:10:04.000Z",
  });
  assert.equal(secondLease?.job.jobId, secondJob.job.jobId);
});

test("PostgreSQL expired running reclaim still respects wholeJobLimit", async () => {
  const { first, firstPool } = await createRepositories();
  const active = await first.admit(
    syncJobInput({
      fingerprint: "active-running-capacity",
      asins: ["B0SYNC0400"],
      createdAt: "2026-08-20T09:20:00.000Z",
    }),
  );
  const expiredA = await first.admit(
    syncJobInput({
      fingerprint: "expired-running-capacity-a",
      asins: ["B0SYNC0401"],
      createdAt: "2026-08-20T09:20:01.000Z",
    }),
  );
  const expiredB = await first.admit(
    syncJobInput({
      fingerprint: "expired-running-capacity-b",
      asins: ["B0SYNC0402"],
      createdAt: "2026-08-20T09:20:02.000Z",
    }),
  );

  const activeLease = await first.claimNext({
    workerId: "capacity-active",
    leaseMs: 60_000,
    wholeJobLimit: 10,
    claimedAt: "2026-08-20T09:21:00.000Z",
  });
  assert.equal(activeLease?.job.jobId, active.job.jobId);
  assert.equal(
    (await first.claimNext({
      workerId: "capacity-expired-a",
      leaseMs: 1_000,
      wholeJobLimit: 10,
      claimedAt: "2026-08-20T09:21:00.000Z",
    }))?.job.jobId,
    expiredA.job.jobId,
  );
  assert.equal(
    (await first.claimNext({
      workerId: "capacity-expired-b",
      leaseMs: 1_000,
      wholeJobLimit: 10,
      claimedAt: "2026-08-20T09:21:00.000Z",
    }))?.job.jobId,
    expiredB.job.jobId,
  );

  assert.equal(
    await activeRunningCount(firstPool, "2026-08-20T09:21:02.000Z"),
    1,
  );
  const blocked = await first.claimNext({
    workerId: "capacity-blocked",
    leaseMs: 10_000,
    wholeJobLimit: 1,
    claimedAt: "2026-08-20T09:21:02.000Z",
  });
  assert.equal(blocked, null);
  assert.equal(
    await activeRunningCount(firstPool, "2026-08-20T09:21:02.000Z"),
    1,
  );

  const concurrentReclaims = await Promise.all([
    first.claimNext({
      workerId: "capacity-reclaim-a",
      leaseMs: 10_000,
      wholeJobLimit: 2,
      claimedAt: "2026-08-20T09:21:02.000Z",
    }),
    first.claimNext({
      workerId: "capacity-reclaim-b",
      leaseMs: 10_000,
      wholeJobLimit: 2,
      claimedAt: "2026-08-20T09:21:02.000Z",
    }),
  ]);
  const reclaimed = concurrentReclaims.filter((lease) => lease !== null);
  assert.equal(reclaimed.length, 1);
  assert.ok(
    [expiredA.job.jobId, expiredB.job.jobId].includes(reclaimed[0]!.job.jobId),
  );
  assert.equal(
    await activeRunningCount(firstPool, "2026-08-20T09:21:02.000Z"),
    2,
  );
});

test("PostgreSQL sync job reader rejects corrupt stored stage and progress JSON", async () => {
  const { first, firstPool } = await createRepositories();
  const stageCorruption = await first.admit(
    syncJobInput({
      fingerprint: "corrupt-stage-json",
      asins: ["B0SYNC0300"],
    }),
  );
  await firstPool.query(
    "UPDATE sync_jobs SET stages = $2::jsonb WHERE job_id = $1",
    [stageCorruption.job.jobId, JSON.stringify([{ id: "catalog" }])],
  );

  await assert.rejects(
    first.findById(stageCorruption.job.jobId),
    (error: unknown) =>
      error instanceof Error &&
      error.name === "SyncJobDataError" &&
      error.message === "PostgreSQL sync job row contains invalid data",
  );

  const progressCorruption = await first.admit(
    syncJobInput({
      fingerprint: "corrupt-progress-json",
      asins: ["B0SYNC0301"],
    }),
  );
  await firstPool.query(
    "UPDATE sync_jobs SET asin_progress = $2::jsonb WHERE job_id = $1",
    [
      progressCorruption.job.jobId,
      JSON.stringify({
        B0SYNC0301: {
          catalog: {
            status: "surprising",
            reason: null,
            updatedAt: NOW,
          },
        },
      }),
    ],
  );

  await assert.rejects(
    first.findById(progressCorruption.job.jobId),
    (error: unknown) =>
      error instanceof Error &&
      error.name === "SyncJobDataError" &&
      error.message === "PostgreSQL sync job row contains invalid data",
  );
});

test("SQLite runtime storage stays open while sync queue operations fail closed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-sync-queue-"));
  const repository = await openRuntimeAgentRepository({
    kind: "sqlite",
    sqlite: {
      path: join(directory, "agent.sqlite"),
      busyTimeoutMs: 1_000,
    },
  });
  try {
    const user = await repository.createUser({
      id: "94000000-0000-4000-8000-000000000001",
      organizationId: "94000000-0000-4000-8000-000000000002",
      email: "sync-queue-sqlite@example.com",
      displayName: "SQLite queue boundary",
      role: "member",
      status: "active",
      createdAt: NOW,
      updatedAt: NOW,
    });
    assert.equal(user.email, "sync-queue-sqlite@example.com");

    await assert.rejects(
      repository.syncJobs.claimNext({
        workerId: "sqlite-worker",
        leaseMs: 30_000,
        wholeJobLimit: 10,
        claimedAt: LATER,
      }),
      SyncJobQueueUnavailableError,
    );
    await assert.rejects(
      repository.syncJobs.findById("sqlite-job"),
      SyncJobQueueUnavailableError,
    );
  } finally {
    await repository.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function createRepositories() {
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  await postgres.pool.query(`CREATE SCHEMA ${schema}`);
  const firstPool = postgres.createPool({ searchPath: schema });
  const secondPool = postgres.createPool({ searchPath: schema });
  await runPostgresMigrations(firstPool);
  return {
    firstPool,
    first: new PostgresSyncJobStore(new PostgresQueryContext(firstPool)),
    second: new PostgresSyncJobStore(new PostgresQueryContext(secondPool)),
  };
}

async function activeJobCount(pool: Pool, organizationId: string) {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM sync_jobs
     WHERE organization_id = $1
       AND status IN ('queued', 'running')`,
    [organizationId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function categoryResumeIdentityCounts(pool: Pool, jobId: string, projectId: string, runId: string) {
  const [jobs, runs, runStages, outputs, physicalAttempts] = await Promise.all([
    pool.query<{ count: number }>("SELECT count(*)::integer AS count FROM sync_jobs WHERE job_id = $1", [jobId]),
    pool.query<{ count: number }>("SELECT count(*)::integer AS count FROM analysis_runs WHERE id = $1 AND project_id = $2", [runId, projectId]),
    pool.query<{ count: number }>("SELECT count(*)::integer AS count FROM run_stages WHERE run_id = $1", [runId]),
    pool.query<{ count: number }>("SELECT count(*)::integer AS count FROM sync_job_stage_outputs WHERE job_id = $1", [jobId]),
    pool.query<{ count: number }>("SELECT count(*)::integer AS count FROM concurrency_physical_attempts WHERE job_id = $1", [jobId]),
  ]);
  return {
    jobs: jobs.rows[0]?.count,
    runs: runs.rows[0]?.count,
    runStages: runStages.rows[0]?.count,
    outputs: outputs.rows[0]?.count,
    physicalAttempts: physicalAttempts.rows[0]?.count,
  };
}

async function categoryOutputSnapshot(pool: Pool, jobId: string) {
  return (await pool.query(
    `SELECT job_id, organization_id, project_id, run_id, stage_id, stage_status,
            output_version, content_hash, data_json, gap_json, updated_at
       FROM sync_job_stage_outputs
      WHERE job_id = $1 AND stage_id = 'category'`,
    [jobId],
  )).rows;
}

async function submissionCount(pool: Pool, organizationId: string) {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM sync_job_submissions
     WHERE organization_id = $1`,
    [organizationId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function activeRunningCount(pool: Pool, asOf: string) {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM sync_jobs
     WHERE status = 'running'
       AND lease_expires_at > $1`,
    [asOf],
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function duplicateRunningActorCount(pool: Pool) {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM (
       SELECT actor_id
       FROM sync_jobs
       WHERE status = 'running'
       GROUP BY actor_id
       HAVING count(*) > 1
     ) duplicate_actors`,
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function createTerminalCanonicalFixture(
  store: PostgresSyncJobStore,
  pool: Pool,
  label: string,
) {
  const organizationId = randomUUID();
  const actorId = randomUUID();
  const projectId = randomUUID();
  const runId = randomUUID();
  const stageId = randomUUID();
  const asin = `B0${label.replaceAll("-", "").toUpperCase().slice(0, 8)}`;
  await pool.query(
    `INSERT INTO users
       (id, organization_id, email, display_name, role, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'Canonical fixture', 'member', 'active', $4, $4)`,
    [actorId, organizationId, `${actorId}@example.test`, NOW],
  );
  await pool.query(
    `INSERT INTO projects
       (id, organization_id, name, marketplace, asins_json, created_by, created_at, updated_at)
     VALUES ($1, $2, 'Canonical fixture', 'US', $3::jsonb, $4, $5, $5)`,
    [projectId, organizationId, JSON.stringify([asin]), actorId, NOW],
  );
  const admitted = await store.admit(syncJobInput({
    organizationId,
    projectId,
    runId,
    actorId,
    fingerprint: `canonical-fixture:${label}:${projectId}`,
    asins: [asin],
    canonicalRun: { runId, stageId, dataCutoffAt: NOW },
    stages: [
      { id: "queue", label: "Queue", kind: "auto", status: "done", estimatedSeconds: 0 },
      { id: "traffic", label: "Traffic", kind: "auto", status: "skipped", estimatedSeconds: 1 },
    ],
    currentStageId: "traffic",
  }));
  const lease = await store.claimNext({
    workerId: `fixture-${label}`,
    leaseMs: 30_000,
    wholeJobLimit: 4,
    claimedAt: NOW,
  });
  assert.equal(lease?.job.jobId, admitted.job.jobId);
  assert.equal(await store.beginCanonicalTrafficRun({
    jobId: admitted.job.jobId,
    runId,
    actorId,
    leaseGeneration: lease!.leaseGeneration,
    workerId: `fixture-${label}`,
    maxAttempts: 3,
    startedAt: NOW,
  }), "started");
  assert.equal(await store.settleCanonicalTrafficRun({
    jobId: admitted.job.jobId,
    runId,
    outcome: "partial",
    settledAt: LATER,
    error: { code: "SYNC_TRAFFIC_SNAPSHOT_FAILED" },
  }), true);
  await store.complete({
    jobId: admitted.job.jobId,
    leaseGeneration: lease!.leaseGeneration,
    workerId: `fixture-${label}`,
    completedAt: LATER,
    message: "completed with traffic gap",
  });
  return {
    jobId: admitted.job.jobId,
    organizationId,
    actorId,
    projectId,
    runId,
    stageId,
    asin,
  };
}

async function canonicalResumeSnapshot(pool: Pool, jobId: string, runId: string) {
  const job = (await pool.query(
    `SELECT job_id, status, actor_id, leased_by, completed_at, failed_at, stages
       FROM sync_jobs WHERE job_id = $1`,
    [jobId],
  )).rows;
  const run = (await pool.query(
    "SELECT id, status, created_by, updated_at FROM analysis_runs WHERE id = $1",
    [runId],
  )).rows;
  const stages = (await pool.query(
    `SELECT id, stage, status, progress, started_at, completed_at, last_error_json, updated_at
       FROM run_stages WHERE run_id = $1 ORDER BY id`,
    [runId],
  )).rows;
  return { job, run, stages };
}

async function genericRunSnapshot(pool: Pool, runId: string) {
  const run = (await pool.query(
    "SELECT id, status, created_by, updated_at FROM analysis_runs WHERE id = $1",
    [runId],
  )).rows;
  const stages = (await pool.query(
    `SELECT id, stage, status, progress, attempt_count, started_at, completed_at,
            last_error_json, updated_at
       FROM run_stages WHERE run_id = $1 ORDER BY stage`,
    [runId],
  )).rows;
  const attempts = (await pool.query(
    `SELECT attempt.id, attempt.stage_id, attempt.status, attempt.attempt_number,
            attempt.lease_generation, attempt.started_at, attempt.completed_at,
            attempt.error_json, attempt.updated_at
       FROM job_attempts attempt
       JOIN run_stages stage ON stage.id = attempt.stage_id
      WHERE stage.run_id = $1 ORDER BY attempt.id`,
    [runId],
  )).rows;
  return { run, stages, attempts };
}

function syncJobInput(
  overrides: Partial<Parameters<SyncJobRepository["admit"]>[0]>,
): Parameters<SyncJobRepository["admit"]>[0] {
  return {
    jobId: randomUUID(),
    organizationId: randomUUID(),
    projectId: null,
    runId: null,
    actorId: randomUUID(),
    fingerprint: randomUUID(),
    asins: ["B0SYNC0001"],
    marketplace: "US",
    createdAt: NOW,
    stages: [
      {
        id: "queued",
        label: "Queued",
        kind: "auto",
        status: "pending",
        estimatedSeconds: 0,
      },
      {
        id: "catalog",
        label: "Catalog",
        kind: "auto",
        status: "pending",
        estimatedSeconds: 30,
      },
    ],
    currentStageId: "queued",
    message: "Queued",
    ...overrides,
  };
}
