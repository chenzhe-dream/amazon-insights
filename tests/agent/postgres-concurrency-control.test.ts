import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import type { Pool, PoolClient } from "pg";

import { runPostgresMigrations } from "../../server/db/postgres/migrations";
import { PostgresConcurrencyControlStore } from "../../server/db/postgres/concurrency-control-store";
import { PostgresQueryContext } from "../../server/db/postgres/query-context";
import {
  PostgresResourceGovernor,
  ResourceGovernorAdmissionError,
  type GovernedResource,
} from "../../server/db/concurrency-control-repository";
import {
  STANDARD_CONCURRENCY_PROFILE,
} from "../../server/concurrency/concurrency-policy";
import {
  createPostgresResourceGovernor,
  ResourceGovernorAdmissionError as ScriptResourceGovernorAdmissionError,
} from "../../scripts/lib/postgres-resource-governor.mjs";
import type { SyncJobLease } from "../../server/db/sync-job-repository";
import { createDetachedRunner } from "../../server/services/sync-job-worker-handler";
import {
  startPostgresTestContainer,
  type PostgresTestContainer,
} from "./helpers/postgres-test-container";

let postgres: PostgresTestContainer;

before(async () => {
  postgres = await startPostgresTestContainer();
  await runPostgresMigrations(postgres.pool);
});

after(async () => {
  await postgres?.close();
});

test("default effective policy is the immutable standard profile", async () => {
  const { first } = createStores();
  const policy = await first.getEffectivePolicy("cc000000-0000-4000-8000-000000000001");

  assert.equal(policy.profile, "standard");
  assert.equal(policy.version, STANDARD_CONCURRENCY_PROFILE.version);
  assert.deepEqual(policy.limits, {
    wholeJob: 4,
    sellerSprite: 2,
    sif: 1,
    sorftime: 1,
    model: 2,
    image: 4,
  });
  assert.deepEqual(policy.sellerSpriteRolling, {
    maxAttempts: 30,
    windowMs: 60_000,
  });
});

test("two PostgreSQL store instances racing for permits never exceed every resource cap", async () => {
  const { first, second } = createStores();
  const organizationId = "cc100000-0000-4000-8000-000000000001";
  const resources: ReadonlyArray<[GovernedResource, number]> = [
    ["wholeJob", 4],
    ["sellerSprite", 2],
    ["sif", 1],
    ["sorftime", 1],
    ["model", 2],
    ["image", 4],
  ];

  for (const [resource, cap] of resources) {
    const attempts = await Promise.allSettled(
      Array.from({ length: cap + 6 }, (_, index) =>
        (index % 2 === 0 ? first : second).acquirePermit({
          organizationId,
          resource,
          jobId: `job-${resource}-${index}`,
          attemptKind: "initial",
          ownerId: `owner-${resource}-${index}`,
          leaseMs: 30_000,
          maxWaitMs: 0,
          acquiredAt: "2026-08-22T01:00:00.000Z",
        }),
      ),
    );
    assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, cap);
    for (const rejected of attempts.filter((attempt) => attempt.status === "rejected")) {
      assert.ok(rejected.reason instanceof ResourceGovernorAdmissionError);
      assert.doesNotMatch(String(rejected.reason.message), /postgres|owner-|secret|https?:|database/i);
    }
  }
});

test("standard image governance admits four physical dispatches and bounds the fifth", async () => {
  const { firstPool } = createStores();
  const organizationId = "cc100000-0000-4000-8000-000000000099";
  const jobId = "image-four-worker-contract";
  const governor = createPostgresResourceGovernor({
    pool: postgres.createPool(),
    ownerId: "image-four-worker-owner",
  });
  let providerDispatches = 0;
  let releaseProvider = () => undefined;
  let markFourEntered = () => undefined;
  const providerGate = new Promise<void>((resolve) => {
    releaseProvider = resolve;
  });
  const fourEntered = new Promise<void>((resolve) => {
    markFourEntered = resolve;
  });

  const runs = Array.from({ length: 5 }, async (_, index) => {
    try {
      return {
        status: "fulfilled" as const,
        value: await governor.run({
          organizationId,
          resource: "image",
          jobId,
          attemptKind: "initial",
          maxWaitMs: 0,
          operation: async () => {
            providerDispatches += 1;
            if (providerDispatches === 4) markFourEntered();
            await providerGate;
            return index;
          },
        }),
      };
    } catch (reason) {
      return { status: "rejected" as const, reason };
    }
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const fourEnteredWithinBound = await Promise.race([
    fourEntered.then(() => true),
    new Promise<boolean>((resolve) => {
      timeout = setTimeout(() => resolve(false), 2_000);
    }),
  ]);
  clearTimeout(timeout);
  releaseProvider();
  const results = await Promise.all(runs);
  const attempts = await firstPool.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM concurrency_physical_attempts
      WHERE organization_id = $1
        AND resource = 'image'
        AND job_id = $2`,
    [organizationId, jobId],
  );

  assert.equal(fourEnteredWithinBound, true, `only ${providerDispatches} image workers entered`);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 4);
  const rejected = results.filter((result) => result.status === "rejected");
  assert.equal(rejected.length, 1);
  for (const result of rejected) {
    assert.ok(result.reason instanceof ScriptResourceGovernorAdmissionError);
    assert.equal(result.reason.message, "External request capacity is temporarily unavailable");
    assert.doesNotMatch(String(result.reason), /secret|credential|database|https?:/i);
  }
  assert.equal(providerDispatches, 4);
  assert.deepEqual(attempts.rows, [{ count: "4" }]);
});

test("SellerSprite rolling physical attempts are capped at thirty per sixty seconds", async () => {
  const { first, second } = createStores();
  const organizationId = "cc200000-0000-4000-8000-000000000001";

  for (let index = 0; index < 30; index += 1) {
    await (index % 2 === 0 ? first : second).recordPhysicalAttempt({
      organizationId,
      resource: "sellerSprite",
      jobId: `rolling-${index}`,
      attemptKind: index === 0 ? "initial" : "retry",
      recordedAt: "2026-08-22T02:00:00.000Z",
    });
  }

  await assert.rejects(
    first.recordPhysicalAttempt({
      organizationId,
      resource: "sellerSprite",
      jobId: "rolling-31",
      attemptKind: "retry",
      recordedAt: "2026-08-22T02:00:59.999Z",
    }),
    ResourceGovernorAdmissionError,
  );
  await first.recordPhysicalAttempt({
    organizationId,
    resource: "sellerSprite",
    jobId: "rolling-after-window",
    attemptKind: "quota-refresh",
    recordedAt: "2026-08-22T02:01:00.001Z",
  });
});

test("expired permits recover and stale owners cannot heartbeat or release replacements", async () => {
  const { first, second } = createStores();
  const organizationId = "cc300000-0000-4000-8000-000000000001";
  const stale = await first.acquirePermit({
    organizationId,
    resource: "sif",
    jobId: "fenced-job",
    attemptKind: "initial",
    ownerId: "stale-owner",
    leaseMs: 1_000,
    maxWaitMs: 0,
    acquiredAt: "2026-08-22T03:00:00.000Z",
  });

  const replacement = await second.acquirePermit({
    organizationId,
    resource: "sif",
    jobId: "fenced-job",
    attemptKind: "retry",
    ownerId: "fresh-owner",
    leaseMs: 1_000,
    maxWaitMs: 0,
    acquiredAt: "2026-08-22T03:00:01.001Z",
  });

  assert.notEqual(replacement.permitId, stale.permitId);
  assert.equal(
    await first.heartbeatPermit({
      permitId: stale.permitId,
      ownerId: stale.ownerId,
      leaseGeneration: stale.leaseGeneration,
      leaseMs: 1_000,
      heartbeatAt: "2026-08-22T03:00:01.002Z",
    }),
    false,
  );
  assert.equal(
    await first.releasePermit({
      permitId: stale.permitId,
      ownerId: stale.ownerId,
      leaseGeneration: stale.leaseGeneration,
      releasedAt: "2026-08-22T03:00:01.003Z",
    }),
    false,
  );
  assert.equal(
    await second.releasePermit({
      permitId: replacement.permitId,
      ownerId: replacement.ownerId,
      leaseGeneration: replacement.leaseGeneration,
      releasedAt: "2026-08-22T03:00:01.004Z",
    }),
    true,
  );
});

test("governor cancellation stops queued admission before record or operation", async () => {
  const { first, second, firstPool } = createStores();
  const organizationId = "cc400000-0000-4000-8000-000000000099";
  const blocker = await first.acquirePermit({
    organizationId,
    resource: "sif",
    jobId: "cancellation-blocker",
    attemptKind: "initial",
    ownerId: "cancellation-blocker-owner",
    leaseMs: 30_000,
    maxWaitMs: 0,
  });

  const queuedController = new AbortController();
  let queuedOperations = 0;
  const queued = new PostgresResourceGovernor(
    second,
    "cancellation-queued-owner",
  ).run({
    organizationId,
    resource: "sif",
    jobId: "cancellation-queued",
    attemptKind: "initial",
    signal: queuedController.signal,
    maxWaitMs: 1_000,
    operation: async () => {
      queuedOperations += 1;
    },
  });
  await new Promise(resolve => setTimeout(resolve, 20));
  queuedController.abort();
  await assert.rejects(queued, ResourceGovernorAdmissionError);
  assert.equal(queuedOperations, 0);

  const preAbortedController = new AbortController();
  preAbortedController.abort();
  let preAbortedOperations = 0;
  await assert.rejects(
    new PostgresResourceGovernor(second, "cancellation-pre-owner").run({
      organizationId,
      resource: "sif",
      jobId: "cancellation-pre-aborted",
      attemptKind: "initial",
      signal: preAbortedController.signal,
      operation: async () => {
        preAbortedOperations += 1;
      },
    }),
    ResourceGovernorAdmissionError,
  );
  assert.equal(preAbortedOperations, 0);

  const beforeRelease = await firstPool.query<{
    attempts: string;
    queued_permits: string;
  }>(
    `SELECT
       (SELECT count(*)::text
          FROM concurrency_physical_attempts
         WHERE organization_id = $1
           AND job_id IN ('cancellation-queued', 'cancellation-pre-aborted')) AS attempts,
       (SELECT count(*)::text
          FROM concurrency_resource_permits
         WHERE organization_id = $1
           AND owner_id IN ('cancellation-queued-owner', 'cancellation-pre-owner')) AS queued_permits`,
    [organizationId],
  );
  assert.deepEqual(beforeRelease.rows, [{ attempts: "0", queued_permits: "0" }]);

  await first.releasePermit({
    permitId: blocker.permitId,
    ownerId: blocker.ownerId,
    leaseGeneration: blocker.leaseGeneration,
  });

  let normalOperations = 0;
  const normalResult = await new PostgresResourceGovernor(
    second,
    "cancellation-normal-owner",
  ).run({
    organizationId,
    resource: "sif",
    jobId: "cancellation-normal",
    attemptKind: "initial",
    operation: async () => {
      normalOperations += 1;
      return "ok";
    },
  });
  assert.equal(normalResult, "ok");
  assert.equal(normalOperations, 1);

  const afterNormal = await firstPool.query<{
    attempts: string;
    unreleased_permits: string;
  }>(
    `SELECT
       (SELECT count(*)::text
          FROM concurrency_physical_attempts
         WHERE organization_id = $1
           AND job_id = 'cancellation-normal') AS attempts,
       (SELECT count(*)::text
          FROM concurrency_resource_permits
         WHERE organization_id = $1
           AND owner_id = 'cancellation-normal-owner'
           AND released_at IS NULL) AS unreleased_permits`,
    [organizationId],
  );
  assert.deepEqual(afterNormal.rows, [{ attempts: "1", unreleased_permits: "0" }]);
});

test("governor compensates only its committed physical attempt when abort wins before operation", async () => {
  const { first, firstPool } = createStores();
  const organizationId = "cc400000-0000-4000-8000-000000000101";
  const otherOrganizationId = "cc400000-0000-4000-8000-000000000102";
  await first.recordPhysicalAttempt({
    organizationId,
    resource: "sellerSprite",
    jobId: "compensation-other-job",
    attemptKind: "initial",
  });
  await first.recordPhysicalAttempt({
    organizationId: otherOrganizationId,
    resource: "sellerSprite",
    jobId: "compensation-target-job",
    attemptKind: "initial",
  });

  const controller = new AbortController();
  const hookedPool = abortAfterPhysicalAttemptCommit(
    postgres.createPool(),
    () => controller.abort(),
  );
  const store = new PostgresConcurrencyControlStore(
    new PostgresQueryContext(hookedPool),
    { permitId: () => randomUUID() },
  );
  let operations = 0;

  await assert.rejects(
    new PostgresResourceGovernor(store, "compensation-owner").run({
      organizationId,
      resource: "sellerSprite",
      jobId: "compensation-target-job",
      attemptKind: "initial",
      signal: controller.signal,
      operation: async () => {
        operations += 1;
      },
    }),
    ResourceGovernorAdmissionError,
  );

  const attempts = await firstPool.query<{
    organization_id: string;
    job_id: string;
  }>(
    `SELECT organization_id, job_id
       FROM concurrency_physical_attempts
      WHERE organization_id IN ($1, $2)
        AND job_id IN ('compensation-other-job', 'compensation-target-job')
      ORDER BY organization_id, job_id`,
    [organizationId, otherOrganizationId],
  );
  assert.equal(operations, 0);
  assert.deepEqual(attempts.rows, [
    {
      organization_id: organizationId,
      job_id: "compensation-other-job",
    },
    {
      organization_id: otherOrganizationId,
      job_id: "compensation-target-job",
    },
  ]);
});

test("script governor compensates its committed physical attempt before invoking fetch", async () => {
  const { first, firstPool } = createStores();
  const organizationId = "cc400000-0000-4000-8000-000000000103";
  await first.recordPhysicalAttempt({
    organizationId,
    resource: "sellerSprite",
    jobId: "script-compensation-other-job",
    attemptKind: "initial",
  });

  const controller = new AbortController();
  const governorOptions = {
    pool: abortAfterPhysicalAttemptCommit(
      postgres.createPool(),
      () => controller.abort(),
    ),
    ownerId: "script-compensation-owner",
  };
  const governor = createPostgresResourceGovernor(governorOptions);
  let operations = 0;

  await assert.rejects(
    governor.run({
      organizationId,
      resource: "sellerSprite",
      jobId: "script-compensation-target-job",
      attemptKind: "initial",
      signal: controller.signal,
      operation: async () => {
        operations += 1;
      },
    }),
    ScriptResourceGovernorAdmissionError,
  );

  const attempts = await firstPool.query<{ job_id: string }>(
    `SELECT job_id
       FROM concurrency_physical_attempts
      WHERE organization_id = $1
        AND job_id LIKE 'script-compensation-%'
      ORDER BY job_id`,
    [organizationId],
  );
  assert.equal(operations, 0);
  assert.deepEqual(attempts.rows, [
    { job_id: "script-compensation-other-job" },
  ]);
});

test("script governor never invokes fetch when compensation storage fails", async () => {
  const { firstPool } = createStores();
  const organizationId = "cc400000-0000-4000-8000-000000000105";
  const controller = new AbortController();
  const governorOptions = {
    pool: abortAfterPhysicalAttemptCommit(
      postgres.createPool(),
      () => controller.abort(),
      { failCompensation: true },
    ),
    ownerId: "script-compensation-failure-owner",
  };
  const governor = createPostgresResourceGovernor(governorOptions);
  let fetchDispatches = 0;

  await assert.rejects(
    governor.run({
      organizationId,
      resource: "sellerSprite",
      jobId: "script-compensation-failure-job",
      attemptKind: "initial",
      signal: controller.signal,
      operation: async () => {
        fetchDispatches += 1;
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof ScriptResourceGovernorAdmissionError);
      assert.equal(error.message, "External request capacity is temporarily unavailable");
      assert.doesNotMatch(String(error), /database|secret|sentinel/i);
      return true;
    },
  );

  const retained = await firstPool.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM concurrency_physical_attempts
      WHERE organization_id = $1
        AND job_id = 'script-compensation-failure-job'`,
    [organizationId],
  );
  assert.equal(fetchDispatches, 0);
  assert.deepEqual(retained.rows, [{ count: "1" }]);
});

test("script governor records separate governed metadata for a transient retry", async () => {
  const { firstPool } = createStores();
  const organizationId = "cc400000-0000-4000-8000-000000000106";
  const jobId = "script-category-transient-retry";
  const logicalOperationKey = "sorftime:category:logical-operation";
  const governorOptions = {
    pool: postgres.createPool(),
    ownerId: "script-category-retry-owner",
  };
  const governor = createPostgresResourceGovernor(governorOptions);

  for (const attemptKind of ["initial", "transient-retry"] as const) {
    assert.equal(await governor.run({
      organizationId,
      resource: "sorftime",
      jobId,
      stageId: "category",
      logicalOperationKey,
      dispatchKey: `${logicalOperationKey}:${attemptKind}`,
      attemptKind,
      operation: async () => attemptKind,
    }), attemptKind);
  }

  const attempts = await firstPool.query<{
    attempt_kind: string;
    stage_id: string;
    logical_operation_key: string;
    dispatch_key: string;
  }>(
    `SELECT attempt_kind, stage_id, logical_operation_key, dispatch_key
       FROM concurrency_physical_attempts
      WHERE organization_id = $1 AND job_id = $2
      ORDER BY CASE attempt_kind WHEN 'initial' THEN 0 ELSE 1 END`,
    [organizationId, jobId],
  );
  const permits = await firstPool.query<{
    attempt_kind: string;
    stage_id: string;
    logical_operation_key: string;
    dispatch_key: string;
    released: boolean;
  }>(
    `SELECT attempt_kind, stage_id, logical_operation_key, dispatch_key,
            released_at IS NOT NULL AS released
       FROM concurrency_resource_permits
      WHERE organization_id = $1 AND job_id = $2
      ORDER BY CASE attempt_kind WHEN 'initial' THEN 0 ELSE 1 END`,
    [organizationId, jobId],
  );

  const expected = ["initial", "transient-retry"].map(attemptKind => ({
    attempt_kind: attemptKind,
    stage_id: "category",
    logical_operation_key: logicalOperationKey,
    dispatch_key: `${logicalOperationKey}:${attemptKind}`,
  }));
  assert.deepEqual(attempts.rows, expected);
  assert.deepEqual(permits.rows, expected.map(row => ({ ...row, released: true })));
});

test("detached worker marks only explicit resumed leases as repair attempts", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "resource-attempt-kind-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runnerPath = join(directory, "capture-attempt-kind.mjs");
  const outputPath = join(directory, "attempt-kind.txt");
  await writeFile(
    runnerPath,
    `import { writeFile } from "node:fs/promises";\n` +
      `await writeFile(process.env.ATTEMPT_KIND_OUTPUT, process.env.AGENT_RESOURCE_ATTEMPT_KIND ?? "missing");\n`,
  );
  const runner = createDetachedRunner(process.cwd(), {
    runnerPath,
    environment: {
      NODE_ENV: "test",
      ATTEMPT_KIND_OUTPUT: outputPath,
    },
  });
  const context = {
    workerId: "attempt-kind-worker",
    leaseGeneration: 1,
    mirrorPath: join(directory, "mirror.json"),
    async writeMirror() {},
  };

  await runner(resourceAttemptLease(null), context);
  assert.equal(await readFile(outputPath, "utf8"), "initial");

  await runner(resourceAttemptLease({
    code: "SYNC_JOB_EXPLICIT_RESUME",
    resumeStages: ["category"],
  }), context);
  assert.equal(await readFile(outputPath, "utf8"), "repair");
});

test("physical attempt receipts are immutable and stale scope cannot delete another row", async () => {
  const { first, firstPool } = createStores();
  const organizationId = "cc400000-0000-4000-8000-000000000104";
  const receipt = await first.recordPhysicalAttempt({
    organizationId,
    resource: "sellerSprite",
    jobId: "receipt-exact-job",
    attemptKind: "retry",
    recordedAt: "2026-08-24T03:00:00.000Z",
  });
  const wrongScope = Object.freeze({
    ...receipt,
    jobId: "receipt-other-job",
  });

  assert.equal(Object.isFrozen(receipt), true);
  assert.equal(await first.cancelUndispatchedPhysicalAttempt(wrongScope), false);
  const afterWrongScope = await firstPool.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM concurrency_physical_attempts
      WHERE id = $1::bigint`,
    [receipt.attemptId],
  );
  assert.deepEqual(afterWrongScope.rows, [{ count: "1" }]);

  assert.equal(await first.cancelUndispatchedPhysicalAttempt(receipt), true);
  assert.equal(await first.cancelUndispatchedPhysicalAttempt(receipt), false);
});

test("permits and attempts use the sync job bound policy version instead of widened current policy", async () => {
  const { first, second, firstPool } = createStores();
  const organizationId = "cc500000-0000-4000-8000-000000000001";
  const jobId = "job-bound-standard";
  await firstPool.query(
    `INSERT INTO sync_jobs (
       job_id, organization_id, project_id, run_id, actor_id, fingerprint,
       marketplace, asins, status, message, current_stage_id, stages,
       policy_version, created_at, updated_at
     )
     VALUES (
       $1, $2, NULL, NULL, NULL, 'bound-standard',
       'US', '["B0BOUND0001"]'::jsonb, 'queued', 'Queued', 'queue', '[]'::jsonb,
       'standard-v1', $3, $3
     )`,
    [jobId, organizationId, "2026-08-22T05:00:00.000Z"],
  );
  await firstPool.query(
    `INSERT INTO concurrency_policy_current (organization_id, policy_version, updated_at)
     VALUES ($1, 'fast-v1', $2)
     ON CONFLICT (organization_id)
     DO UPDATE SET policy_version = EXCLUDED.policy_version, updated_at = EXCLUDED.updated_at`,
    [organizationId, "2026-08-22T05:00:01.000Z"],
  );

  const attempts = await Promise.allSettled([
    first.acquirePermit({
      organizationId,
      resource: "sellerSprite",
      jobId,
      attemptKind: "initial",
      ownerId: "bound-a",
      leaseMs: 30_000,
      maxWaitMs: 0,
      acquiredAt: "2026-08-22T05:00:02.000Z",
    }),
    second.acquirePermit({
      organizationId,
      resource: "sellerSprite",
      jobId,
      attemptKind: "retry",
      ownerId: "bound-b",
      leaseMs: 30_000,
      maxWaitMs: 0,
      acquiredAt: "2026-08-22T05:00:02.000Z",
    }),
    first.acquirePermit({
      organizationId,
      resource: "sellerSprite",
      jobId,
      attemptKind: "repair",
      ownerId: "bound-c",
      leaseMs: 30_000,
      maxWaitMs: 0,
      acquiredAt: "2026-08-22T05:00:02.000Z",
    }),
  ]);

  assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 2);
  await first.recordPhysicalAttempt({
    organizationId,
    resource: "sellerSprite",
    jobId,
    attemptKind: "initial",
    recordedAt: "2026-08-22T05:00:03.000Z",
  });
  const recorded = await firstPool.query<{ policy_version: string }>(
    `SELECT policy_version
     FROM concurrency_physical_attempts
     WHERE organization_id = $1 AND job_id = $2`,
    [organizationId, jobId],
  );
  assert.deepEqual(recorded.rows.map((row) => row.policy_version), ["standard-v1"]);
});

test("SellerSprite open circuit fails closed before permits or physical attempts while other resources continue", async () => {
  const { first, firstPool } = createStores();
  const organizationId = "cc600000-0000-4000-8000-000000000001";
  await firstPool.query(
    `INSERT INTO users
       (id, organization_id, email, display_name, role, status, created_at, updated_at)
     VALUES ('cc600000-0000-4000-8000-0000000000a1', $1, 'admin@example.com',
             'Admin', 'admin', 'active', $2, $2)`,
    [organizationId, "2026-08-22T06:00:00.000Z"],
  );
  await firstPool.query(
    `INSERT INTO concurrency_resource_circuits
       (organization_id, resource, manual_hold, auto_paused, reason, updated_by, updated_at)
     VALUES ($1, 'sellerSprite', TRUE, FALSE, 'manual-hold',
             'cc600000-0000-4000-8000-0000000000a1', $2)`,
    [organizationId, "2026-08-22T06:00:01.000Z"],
  );

  await assert.rejects(
    first.acquirePermit({
      organizationId,
      resource: "sellerSprite",
      jobId: "blocked-seller",
      attemptKind: "initial",
      ownerId: "blocked-owner",
      leaseMs: 30_000,
      maxWaitMs: 0,
      acquiredAt: "2026-08-22T06:00:02.000Z",
    }),
    ResourceGovernorAdmissionError,
  );
  await assert.rejects(
    first.recordPhysicalAttempt({
      organizationId,
      resource: "sellerSprite",
      jobId: "blocked-seller",
      attemptKind: "retry",
      recordedAt: "2026-08-22T06:00:03.000Z",
    }),
    ResourceGovernorAdmissionError,
  );

  const sifPermit = await first.acquirePermit({
    organizationId,
    resource: "sif",
    jobId: "unrelated-sif",
    attemptKind: "initial",
    ownerId: "sif-owner",
    leaseMs: 30_000,
    maxWaitMs: 0,
    acquiredAt: "2026-08-22T06:00:04.000Z",
  });
  assert.equal(sifPermit.resource, "sif");
  await first.recordPhysicalAttempt({
    organizationId,
    resource: "sif",
    jobId: "unrelated-sif",
    attemptKind: "initial",
    recordedAt: "2026-08-22T06:00:05.000Z",
  });

  const rows = await firstPool.query<{ resource: string; permits: string; attempts: string }>(
    `SELECT resource,
            (SELECT count(*)::text FROM concurrency_resource_permits p
              WHERE p.organization_id = $1 AND p.resource = a.resource) AS permits,
            count(*)::text AS attempts
       FROM concurrency_physical_attempts a
      WHERE organization_id = $1
      GROUP BY resource
      ORDER BY resource`,
    [organizationId],
  );
  assert.deepEqual(rows.rows, [
    { resource: "sif", permits: "1", attempts: "1" },
  ]);
});

test("scheduled low SellerSprite quota atomically downgrades policy without overwriting manual hold", async () => {
  const { first, firstPool } = createStores();
  const organizationId = "cc700000-0000-4000-8000-000000000001";
  const actorUserId = "cc700000-0000-4000-8000-0000000000a1";
  await firstPool.query(
    `INSERT INTO users
       (id, organization_id, email, display_name, role, status, created_at, updated_at)
     VALUES ($1, $2, 'scheduled-policy@example.com', 'Admin', 'admin', 'active', $3, $3)`,
    [actorUserId, organizationId, "2026-08-22T07:00:00.000Z"],
  );
  await firstPool.query(
    `INSERT INTO concurrency_resource_circuits
       (organization_id, resource, manual_hold, auto_paused, reason, updated_by, updated_at)
     VALUES ($1, 'sellerSprite', TRUE, FALSE, 'manual-hold', $2, $3)`,
    [organizationId, actorUserId, "2026-08-22T07:00:01.000Z"],
  );

  await assert.rejects(
    first.recordSellerSpriteQuotaSnapshot({
      id: "cc700000-0000-4000-8000-0000000000c0",
      organizationId,
      actorUserId: null,
      remaining: 8,
      used: 92,
      providerTotal: 100,
      source: "provider",
      status: "conservative",
      errorCode: null,
      checkedAt: "2026-08-22T07:00:02.000Z",
      quotaAuditEventId: "cc700000-0000-4000-8000-0000000000d0",
      policyAuditEventId: "cc700000-0000-4000-8000-0000000000e0",
    }),
    /scheduled quota refresh/i,
  );

  await first.recordSellerSpriteQuotaSnapshot({
    id: "cc700000-0000-4000-8000-0000000000c1",
    organizationId,
    actorUserId: null,
    trustedSource: "scheduled-quota-refresh",
    remaining: 8,
    used: 92,
    providerTotal: 100,
    source: "provider",
    status: "conservative",
    errorCode: null,
    checkedAt: "2026-08-22T07:00:03.000Z",
    quotaAuditEventId: "cc700000-0000-4000-8000-0000000000d1",
    policyAuditEventId: "cc700000-0000-4000-8000-0000000000e1",
  });

  const [state, policy, audit] = await Promise.all([
    first.readConcurrencyAdminState({
      organizationId,
      now: "2026-08-22T07:00:04.000Z",
    }),
    first.getEffectivePolicy(organizationId),
    firstPool.query<{ action: string; actor_user_id: string | null; metadata_json: unknown }>(
      `SELECT action, actor_user_id, metadata_json
       FROM audit_events
       WHERE organization_id = $1
         AND action IN ('seller-sprite.quota-refreshed-scheduled',
                        'concurrency.policy-changed-scheduled')
       ORDER BY created_at, action`,
      [organizationId],
    ),
  ]);
  assert.equal(state.sellerSpriteQuota.status, "conservative");
  assert.equal(state.connectors.sellerSprite.circuit.manualHold, true);
  assert.equal(state.connectors.sellerSprite.circuit.paused, true);
  assert.equal(policy.profile, "conservative");
  assert.deepEqual(audit.rows, [
    {
      action: "concurrency.policy-changed-scheduled",
      actor_user_id: null,
      metadata_json: { profile: "conservative", reason: "seller-sprite-quota-low" },
    },
    {
      action: "seller-sprite.quota-refreshed-scheduled",
      actor_user_id: null,
      metadata_json: { status: "conservative" },
    },
  ]);
});

function createStores() {
  const firstPool = postgres.createPool();
  const secondPool = postgres.createPool();
  return {
    firstPool,
    first: new PostgresConcurrencyControlStore(new PostgresQueryContext(firstPool), {
      permitId: () => randomUUID(),
    }),
    second: new PostgresConcurrencyControlStore(new PostgresQueryContext(secondPool), {
      permitId: () => randomUUID(),
    }),
  };
}

function resourceAttemptLease(error: Record<string, unknown> | null): SyncJobLease {
  return {
    leaseGeneration: 1,
    job: {
      jobId: "attempt-kind-job",
      organizationId: "cc400000-0000-4000-8000-000000000107",
      projectId: null,
      runId: null,
      actorId: null,
      fingerprint: "attempt-kind-fingerprint",
      marketplace: "US",
      asins: ["B0TEST0001"],
      status: "running",
      message: "running",
      currentStageId: "category",
      stages: [],
      asinProgress: {},
      leasedBy: "attempt-kind-worker",
      leaseGeneration: 1,
      leaseExpiresAt: null,
      error,
      createdAt: "2026-08-25T00:00:00.000Z",
      updatedAt: "2026-08-25T00:00:00.000Z",
      scope: {
        organizationId: "cc400000-0000-4000-8000-000000000107",
        projectId: null,
        runId: null,
        marketplace: "US",
        asins: ["B0TEST0001"],
      },
    },
  };
}

function abortAfterPhysicalAttemptCommit(
  pool: Pool,
  onCommit: () => void,
  options: Readonly<{ failCompensation?: boolean }> = {},
): Pool {
  return new Proxy(pool, {
    get(target, property, receiver) {
      if (property === "query") {
        return async (...args: unknown[]) => {
          const statement = sqlText(args[0]);
          if (
            options.failCompensation &&
            /^DELETE FROM concurrency_physical_attempts\b/i.test(statement)
          ) {
            throw new Error("raw-database-secret-sentinel");
          }
          return await Reflect.apply(target.query, target, args);
        };
      }
      if (property === "connect") {
        return async () => {
          const client = await target.connect();
          let insertedPhysicalAttempt = false;
          return new Proxy(client, {
            get(clientTarget, clientProperty, clientReceiver) {
              if (clientProperty === "query") {
                return async (...args: unknown[]) => {
                  const statement = sqlText(args[0]);
                  const result = await Reflect.apply(clientTarget.query, clientTarget, args);
                  if (/^INSERT INTO concurrency_physical_attempts\b/i.test(statement)) {
                    insertedPhysicalAttempt = true;
                  }
                  if (insertedPhysicalAttempt && statement === "COMMIT") {
                    insertedPhysicalAttempt = false;
                    onCommit();
                  }
                  return result;
                };
              }
              const value = Reflect.get(clientTarget, clientProperty, clientReceiver);
              return typeof value === "function" ? value.bind(clientTarget) : value;
            },
          }) as PoolClient;
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function sqlText(query: unknown): string {
  if (typeof query === "string") return query.trim();
  if (query && typeof query === "object" && "text" in query) {
    return String(query.text).trim();
  }
  return "";
}
