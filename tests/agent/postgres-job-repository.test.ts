import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import type { Pool } from "pg";

import {
  VOC_SOURCE_REFERENCES,
  buildVocSnapshotCandidate,
} from "../../server/data/voc-data-snapshot";
import { JobLeaseLostError } from "../../server/db/repository";
import { PostgresAgentRunStore } from "../../server/db/postgres/agent-run-store";
import { PostgresCoreStore } from "../../server/db/postgres/core-store";
import { PostgresJobStore } from "../../server/db/postgres/job-store";
import { runPostgresMigrations } from "../../server/db/postgres/migrations";
import { PostgresQueryContext } from "../../server/db/postgres/query-context";
import {
  startPostgresTestContainer,
  type PostgresTestContainer,
} from "./helpers/postgres-test-container";

const NOW = "2026-08-14T08:00:00.000Z";

let postgres: PostgresTestContainer;

before(async () => {
  postgres = await startPostgresTestContainer();
});

after(async () => {
  await postgres?.close();
});

async function createSchema() {
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  await postgres.pool.query(`CREATE SCHEMA ${schema}`);
  const firstPool = postgres.createPool({ searchPath: schema });
  const secondPool = postgres.createPool({ searchPath: schema });
  await runPostgresMigrations(firstPool);
  return { firstPool, secondPool };
}

async function seedQueuedJob(
  pool: Pool,
  suffix: string,
  maxAttempts = 3,
  stage: "traffic-analysis" | "alexa-voc-normalization" | "voc-positioning" | "product-definition" = "voc-positioning",
) {
  const core = new PostgresCoreStore(new PostgresQueryContext(pool));
  const jobs = new PostgresJobStore(new PostgresQueryContext(pool));
  const userId = randomUUID();
  const organizationId = randomUUID();
  const projectId = randomUUID();
  const runId = randomUUID();
  const stageId = randomUUID();
  const jobId = randomUUID();
  await core.createUser({
    id: userId,
    organizationId,
    email: `${suffix}@example.com`,
    displayName: "PostgreSQL job test",
    role: "member",
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
  });
  await core.createProject({
    id: projectId,
    organizationId,
    name: "Lease test",
    marketplace: "US",
    asins: ["B0ABC12345", "B0DEF67890", "B0GHI13579"],
    createdBy: userId,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await core.createAnalysisRun({
    id: runId,
    projectId,
    mode: "existing-data",
    status: "queued",
    createdBy: userId,
    dataCutoffAt: NOW,
    idempotencyScope: `job:${suffix}`,
    idempotencyKey: "create",
    createdAt: NOW,
    updatedAt: NOW,
  });
  await core.createRunStage({
    id: stageId,
    runId,
    stage,
    status: "queued",
    progress: 0,
    attemptCount: 0,
    startedAt: null,
    completedAt: null,
    lastError: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await jobs.enqueueJob({
    id: jobId,
    stageId,
    attemptNumber: 1,
    maxAttempts,
    availableAt: NOW,
    createdAt: NOW,
  });
  return { jobId, organizationId, runId, stageId };
}

test("PostgreSQL claims, releases, reclaims, and completes Alexa normalization jobs", async () => {
  const { firstPool, secondPool } = await createSchema();
  const subject = await seedQueuedJob(
    firstPool,
    "alexa-normalization",
    3,
    "alexa-voc-normalization",
  );
  const firstStore = new PostgresJobStore(new PostgresQueryContext(firstPool));
  const secondStore = new PostgresJobStore(new PostgresQueryContext(secondPool));
  const first = await firstStore.claimNextJob({
    ownerId: "normalizer-1",
    stage: "alexa-voc-normalization",
    claimedAt: "2026-09-01T00:00:01.000Z",
    leaseDurationMs: 30_000,
  });
  assert.equal(first?.id, subject.jobId);
  await firstStore.releaseJobLease({
    jobId: subject.jobId,
    ownerId: "normalizer-1",
    leaseGeneration: first!.leaseGeneration,
    releasedAt: "2026-09-01T00:00:02.000Z",
  });
  const second = await secondStore.claimNextJob({
    ownerId: "normalizer-2",
    stage: "alexa-voc-normalization",
    claimedAt: "2026-09-01T00:00:02.000Z",
    leaseDurationMs: 30_000,
  });
  assert.equal(second?.id, subject.jobId);
  assert.equal((await secondStore.completeJob({
    jobId: subject.jobId,
    ownerId: "normalizer-2",
    leaseGeneration: second!.leaseGeneration,
    completedAt: "2026-09-01T00:00:03.000Z",
  })).status, "succeeded");
});

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

async function completeAgentRunForJob(
  pool: Pool,
  subject: Awaited<ReturnType<typeof seedQueuedJob>>,
  job: NonNullable<Awaited<ReturnType<PostgresJobStore["claimNextJob"]>>>,
  claimedAt: string,
) {
  const repository = new PostgresAgentRunStore(new PostgresQueryContext(pool));
  const contentHash = "c".repeat(64);
  const skill = await repository.registerSkillVersion({
    id: randomUUID(),
    skillId: "define-amazon-voc-positioning",
    version: "1.0.0",
    contentHash,
    manifest: {
      id: "define-amazon-voc-positioning",
      version: "1.0.0",
      entry: "SKILL.md",
      allowedReferences: ["references/priority-rules.md"],
      inputSchema: "VocPositioningInput@1.0.0",
      outputSchema: "VocPositioningOutput@1.0.0",
      fixtures: ["postgres-job-publication"],
      contentHash,
    },
    createdAt: NOW,
  });
  const snapshotId = randomUUID();
  const asins = ["B0ABC12345", "B0DEF67890", "B0GHI13579"] as const;
  const candidate = buildVocSnapshotCandidate({
    marketplace: "US",
    asins,
    dataCutoffAt: NOW,
    sourceBundles: [
      {
        sourceId: "alexa-voc",
        type: "manual-voc",
        reference: VOC_SOURCE_REFERENCES.alexaVoc,
        marketplace: "US",
        capturedAt: NOW,
        records: [
          {
            asin: "B0ABC12345",
            attention: ["fixture"],
            positives: ["fixture"],
            negatives: ["fixture"],
            unmet: ["fixture"],
            audiences: ["fixture"],
            scenarios: ["fixture"],
            motives: ["fixture"],
            captureStatus: "dialog",
            alexaReport: {
              title: "Fixture",
              asin: "B0ABC12345",
              rating: 4,
              reviewCount: 1,
              prompt: "Fixture",
              overallConclusion: "Fixture",
            },
          },
        ],
      },
    ],
  });
  await pool.query(
    `INSERT INTO data_snapshots
       (id, run_id, snapshot_kind, artifact_kind, schema_version, marketplace,
        asins_json, data_cutoff_at, sources_json, payload_json, content_hash,
        created_at)
     VALUES ($1, $2, 'voc', 'voc', $3, $4, $5::jsonb, $6, $7::jsonb, $8::jsonb, $9, $6)`,
    [
      snapshotId,
      subject.runId,
      candidate.schemaVersion,
      candidate.marketplace,
      JSON.stringify(candidate.asins),
      NOW,
      JSON.stringify(candidate.sources),
      JSON.stringify(candidate.payload),
      candidate.contentHash,
    ],
  );
  const claimToken = `claim-${randomUUID()}`;
  const begun = await repository.beginAgentRun({
    id: randomUUID(),
    organizationId: subject.organizationId,
    runId: subject.runId,
    stageId: subject.stageId,
    jobAttemptId: job.id,
    skillVersionId: skill.id,
    snapshotIds: [snapshotId],
    executionFingerprint: "d".repeat(64),
    logicalExecutionLineage: sha256(`lineage:${subject.stageId}`),
    logicalExecutionCycleId: job.logicalExecutionCycleId,
    outputSchemaDigest: "e".repeat(64),
    provider: "fake",
    model: "configured-test-model",
    inputSummary: { contentHash: "f".repeat(64), recordCount: 1 },
    outputSchemaVersion: "1.0.0",
    dataCutoffAt: NOW,
    startedAt: claimedAt,
    leaseOwnerId: job.leasedBy!,
    leaseGeneration: job.leaseGeneration,
    claimToken,
    claimAcquiredAt: claimedAt,
    claimExpiresAt: new Date(new Date(claimedAt).getTime() + 30_000).toISOString(),
  });
  await repository.finalizeAgentRun({
    agentRunId: begun.record.id,
    organizationId: subject.organizationId,
    leaseOwnerId: job.leasedBy!,
    leaseGeneration: job.leaseGeneration,
    claimToken,
    completedAt: new Date(new Date(claimedAt).getTime() + 1).toISOString(),
    outcome: {
      terminalStatus: "succeeded",
      validationStatus: "passed",
      responseId: "response-publication",
      output: { status: "complete" },
      error: null,
      inputTokens: 1,
      outputTokens: 1,
      estimatedCostMicros: 1,
      durationMs: 1,
      attemptCount: 1,
      usageCompleteness: "complete",
      attempts: [
        {
          ordinal: 0,
          kind: "initial",
          transientRetryCount: 0,
          formatRepair: false,
          accounting: "settled",
          errorClassification: null,
        },
      ],
      terminalMetadata: { kind: "succeeded" },
    },
  });
}

async function seedStoredPublicationRetry(pool: Pool, suffix: string) {
  const subject = await seedQueuedJob(pool, suffix);
  const explicitCycle = "a".repeat(64);
  const jobId = randomUUID();
  const retryAt = "2026-08-14T08:01:00.000Z";
  await pool.query(
    "UPDATE job_attempts SET status = 'succeeded' WHERE id = $1",
    [subject.jobId],
  );
  await pool.query(
    `INSERT INTO job_attempts (
       id, stage_id, attempt_number, max_attempts,
       retry_cycle_start_attempt, logical_execution_cycle_id,
       report_publication_cycle, report_publication_attempt_count,
       report_publication_max_attempts, report_publication_initial_delay_ms,
       report_publication_max_delay_ms, report_publication_retry_at,
       status, available_at, leased_by, lease_expires_at, lease_generation,
       retryable, retry_scheduled_at, started_at, completed_at, error_json,
       created_at, updated_at
     ) VALUES (
       $1, $2, 2, 3, 2, $3, 2, 1, 3, 1000, 4000, $4,
       'failed', $5, NULL, NULL, 1, TRUE, NULL, $5, $5, $6::jsonb, $5, $5
     )`,
    [
      jobId,
      subject.stageId,
      explicitCycle,
      retryAt,
      NOW,
      JSON.stringify({
        classification: "upstream-temporary",
        message: "publication failed",
      }),
    ],
  );
  return {
    explicitCycle,
    jobId,
    jobs: new PostgresJobStore(new PostgresQueryContext(pool)),
    retryAt,
    subject,
  };
}

test("two PostgreSQL pools atomically claim one queued job", async () => {
  const { firstPool, secondPool } = await createSchema();
  await seedQueuedJob(firstPool, "claim");
  const first = new PostgresJobStore(new PostgresQueryContext(firstPool));
  const second = new PostgresJobStore(new PostgresQueryContext(secondPool));
  const claimedAt = "2026-08-14T08:00:01.000Z";

  const claims = await Promise.all([
    first.claimNextJob({ ownerId: "worker-a", claimedAt, leaseDurationMs: 30_000 }),
    second.claimNextJob({ ownerId: "worker-b", claimedAt, leaseDurationMs: 30_000 }),
  ]);

  const winners = claims.filter((claim) => claim !== null);
  assert.equal(winners.length, 1);
  assert.equal(winners[0]?.attemptNumber, 1);
  assert.match(winners[0]?.leasedBy ?? "", /^worker-[ab]$/);
  assert.match(winners[0]?.logicalExecutionCycleId ?? "", /^[0-9a-f]{64}$/);
});

test("expired leases recover with fencing, backoff, and terminal max-attempt failure", async () => {
  const { firstPool, secondPool } = await createSchema();
  const { jobId, stageId } = await seedQueuedJob(firstPool, "recovery");
  const first = new PostgresJobStore(new PostgresQueryContext(firstPool));
  const second = new PostgresJobStore(new PostgresQueryContext(secondPool));
  const oldClaim = await first.claimNextJob({
    ownerId: "old-worker",
    claimedAt: "2026-08-14T08:00:01.000Z",
    leaseDurationMs: 1_000,
  });
  assert.ok(oldClaim);
  assert.equal(
    await second.claimNextJob({
      ownerId: "new-worker",
      claimedAt: "2026-08-14T08:00:01.999Z",
      leaseDurationMs: 1_000,
    }),
    null,
  );

  const recovered = await second.claimNextJob({
    ownerId: "new-worker",
    claimedAt: "2026-08-14T08:00:02.001Z",
    leaseDurationMs: 1_000,
  });
  assert.equal(recovered?.attemptNumber, 2);
  assert.equal(recovered?.leasedBy, "new-worker");
  assert.equal(recovered?.retryCycleStartAttempt, 1);

  for (const mutation of [
    () =>
      first.renewJobLease({
        jobId,
        ownerId: "old-worker",
        leaseGeneration: oldClaim.leaseGeneration,
        renewedAt: "2026-08-14T08:00:02.100Z",
        leaseDurationMs: 1_000,
      }),
    () =>
      first.completeJob({
        jobId,
        ownerId: "old-worker",
        leaseGeneration: oldClaim.leaseGeneration,
        completedAt: "2026-08-14T08:00:02.100Z",
      }),
    () =>
      first.failJob({
        jobId,
        ownerId: "old-worker",
        leaseGeneration: oldClaim.leaseGeneration,
        failedAt: "2026-08-14T08:00:02.100Z",
        retryable: false,
        retryAt: null,
        error: { code: "STALE", message: "stale worker" },
      }),
  ]) {
    await assert.rejects(mutation, JobLeaseLostError);
  }

  const renewed = await second.renewJobLease({
    jobId: recovered!.id,
    ownerId: "new-worker",
    leaseGeneration: recovered!.leaseGeneration,
    renewedAt: "2026-08-14T08:00:02.100Z",
    leaseDurationMs: 2_000,
  });
  assert.equal(renewed.leaseExpiresAt, "2026-08-14T08:00:04.100Z");

  await second.failJob({
    jobId: recovered!.id,
    ownerId: "new-worker",
    leaseGeneration: recovered!.leaseGeneration,
    failedAt: "2026-08-14T08:00:02.500Z",
    retryable: true,
    retryAt: "2026-08-14T08:00:05.000Z",
    error: { code: "UPSTREAM_TEMPORARY", message: "retry later" },
  });
  assert.equal(
    await first.claimNextJob({
      ownerId: "last-worker",
      claimedAt: "2026-08-14T08:00:04.999Z",
      leaseDurationMs: 1_000,
    }),
    null,
  );
  const last = await first.claimNextJob({
    ownerId: "last-worker",
    claimedAt: "2026-08-14T08:00:05.000Z",
    leaseDurationMs: 1_000,
  });
  assert.equal(last?.attemptNumber, 3);

  assert.equal(
    await second.claimNextJob({
      ownerId: "too-late",
      claimedAt: "2026-08-14T08:00:06.001Z",
      leaseDurationMs: 1_000,
    }),
    null,
  );
  const attempts = await first.listJobAttempts(stageId);
  assert.equal(attempts.length, 3);
  assert.equal(attempts.at(-1)?.status, "failed");
  assert.equal(attempts.at(-1)?.retryable, false);
  const stage = await firstPool.query<{ status: string }>(
    "SELECT status FROM run_stages WHERE id = $1",
    [stageId],
  );
  assert.equal(stage.rows[0]?.status, "failed");
});

test("lease generation fences a reused owner after release and reclaim", async () => {
  const { firstPool, secondPool } = await createSchema();
  const { jobId } = await seedQueuedJob(firstPool, "generation");
  const first = new PostgresJobStore(new PostgresQueryContext(firstPool));
  const second = new PostgresJobStore(new PostgresQueryContext(secondPool));
  const initial = await first.claimNextJob({
    ownerId: "reused-worker",
    claimedAt: "2026-08-14T08:00:01.000Z",
    leaseDurationMs: 5_000,
  });
  assert.ok(initial);
  await first.releaseJobLease({
    jobId,
    ownerId: "reused-worker",
    leaseGeneration: initial.leaseGeneration,
    releasedAt: "2026-08-14T08:00:01.100Z",
  });
  const current = await second.claimNextJob({
    ownerId: "reused-worker",
    claimedAt: "2026-08-14T08:00:01.100Z",
    leaseDurationMs: 5_000,
  });
  assert.ok(current);
  assert.equal(current.id, jobId);
  assert.ok(current.leaseGeneration > initial.leaseGeneration);
  await assert.rejects(
    first.completeJob({
      jobId,
      ownerId: "reused-worker",
      leaseGeneration: initial.leaseGeneration,
      completedAt: "2026-08-14T08:00:02.000Z",
    }),
    JobLeaseLostError,
  );
  const completed = await second.completeJob({
    jobId,
    ownerId: "reused-worker",
    leaseGeneration: current.leaseGeneration,
    completedAt: "2026-08-14T08:00:02.000Z",
  });
  assert.equal(completed.status, "succeeded");
});

test("PostgreSQL jobs preserve stored logical cycles and publication state", async () => {
  const { firstPool } = await createSchema();
  const { explicitCycle, jobId, jobs, retryAt, subject } =
    await seedStoredPublicationRetry(firstPool, "stored-lineage");
  const stored = (await jobs.listJobAttempts(subject.stageId)).find(
    ({ id }) => id === jobId,
  );
  assert.deepEqual(
    {
      logicalExecutionCycleId: stored?.logicalExecutionCycleId,
      reportPublicationCycle: stored?.reportPublicationCycle,
      reportPublicationAttemptCount: stored?.reportPublicationAttemptCount,
      reportPublicationMaxAttempts: stored?.reportPublicationMaxAttempts,
      reportPublicationInitialDelayMs: stored?.reportPublicationInitialDelayMs,
      reportPublicationMaxDelayMs: stored?.reportPublicationMaxDelayMs,
      reportPublicationRetryAt: stored?.reportPublicationRetryAt,
    },
    {
      logicalExecutionCycleId: explicitCycle,
      reportPublicationCycle: 2,
      reportPublicationAttemptCount: 1,
      reportPublicationMaxAttempts: 3,
      reportPublicationInitialDelayMs: 1000,
      reportPublicationMaxDelayMs: 4000,
      reportPublicationRetryAt: retryAt,
    },
  );
});

test("PostgreSQL jobs do not claim a future publication retry", async () => {
  const { firstPool } = await createSchema();
  const { jobs } = await seedStoredPublicationRetry(
    firstPool,
    "future-publication",
  );
  assert.equal(
    await jobs.claimNextJob({
      ownerId: "early-publication-worker",
      claimedAt: "2026-08-14T08:00:59.999Z",
      leaseDurationMs: 10_000,
    }),
    null,
  );
});

test("PostgreSQL report-only failure persists durable publication retry state", async () => {
  const { firstPool } = await createSchema();
  const subject = await seedQueuedJob(firstPool, "publication-retry");
  const jobs = new PostgresJobStore(new PostgresQueryContext(firstPool));
  const claimedAt = new Date().toISOString();
  const claimed = await jobs.claimNextJob({
    ownerId: "publication-worker",
    claimedAt,
    leaseDurationMs: 60_000,
  });
  assert.ok(claimed);
  await completeAgentRunForJob(firstPool, subject, claimed, claimedAt);

  const beforeFailure = Date.now();
  const failed = await jobs.failJob({
    jobId: claimed.id,
    ownerId: "publication-worker",
    leaseGeneration: claimed.leaseGeneration,
    failedAt: new Date(beforeFailure).toISOString(),
    retryable: true,
    retryAt: new Date(beforeFailure + 30_000).toISOString(),
    reportPublicationRetryPolicy: {
      maxAttempts: 3,
      initialDelayMs: 100,
      maxDelayMs: 400,
    },
    error: {
      classification: "upstream-temporary",
      message: "report publication failed",
    },
  });
  const afterFailure = Date.now();
  assert.equal(failed.reportPublicationAttemptCount, 1);
  assert.equal(failed.reportPublicationMaxAttempts, 3);
  assert.equal(failed.reportPublicationInitialDelayMs, 100);
  assert.equal(failed.reportPublicationMaxDelayMs, 400);
  assert.ok(failed.reportPublicationRetryAt);
  const retryAt = new Date(failed.reportPublicationRetryAt).getTime();
  assert.ok(retryAt >= beforeFailure + 100);
  assert.ok(retryAt <= afterFailure + 100);
  assert.equal(failed.availableAt, failed.reportPublicationRetryAt);
  assert.deepEqual(
    (await jobs.listJobAttempts(subject.stageId))[0],
    failed,
  );

  const reclaimed = await jobs.claimNextJob({
    ownerId: "publication-worker-2",
    claimedAt: failed.reportPublicationRetryAt,
    leaseDurationMs: 60_000,
  });
  assert.ok(reclaimed);
  assert.equal(reclaimed.id, failed.id);
  assert.equal(reclaimed.reportPublicationAttemptCount, 1);
  assert.equal(reclaimed.reportPublicationRetryAt, null);
  const failedAgain = await jobs.failJob({
    jobId: reclaimed.id,
    ownerId: "publication-worker-2",
    leaseGeneration: reclaimed.leaseGeneration,
    failedAt: new Date().toISOString(),
    retryable: true,
    retryAt: new Date(Date.now() + 30_000).toISOString(),
    error: {
      classification: "upstream-temporary",
      message: "report publication failed again",
    },
  });
  assert.equal(failedAgain.reportPublicationAttemptCount, 2);
  assert.equal(failedAgain.reportPublicationMaxAttempts, 3);
  assert.equal(failedAgain.reportPublicationInitialDelayMs, 100);
  assert.equal(failedAgain.reportPublicationMaxDelayMs, 400);
  assert.ok(failedAgain.reportPublicationRetryAt);
});
