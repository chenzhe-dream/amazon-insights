import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { runPostgresMigrations } from "../../server/db/postgres/migrations";
import { PostgresConcurrencyControlStore } from "../../server/db/postgres/concurrency-control-store";
import { PostgresQueryContext } from "../../server/db/postgres/query-context";
import {
  ResourceGovernorAdmissionError,
  type GovernedResource,
} from "../../server/db/concurrency-control-repository";
import {
  STANDARD_CONCURRENCY_PROFILE,
} from "../../server/concurrency/concurrency-policy";
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
    image: 2,
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
    ["image", 2],
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

function createStores() {
  const firstPool = postgres.createPool();
  const secondPool = postgres.createPool();
  return {
    first: new PostgresConcurrencyControlStore(new PostgresQueryContext(firstPool), {
      permitId: () => randomUUID(),
    }),
    second: new PostgresConcurrencyControlStore(new PostgresQueryContext(secondPool), {
      permitId: () => randomUUID(),
    }),
  };
}
