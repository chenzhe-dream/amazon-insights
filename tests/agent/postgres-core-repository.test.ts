import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import type { Pool } from "pg";

import {
  PostgresCoreStore,
  PostgresCoreStoreConflictError,
  PostgresCoreStoreDataError,
} from "../../server/db/postgres/core-store";
import { runPostgresMigrations } from "../../server/db/postgres/migrations";
import { PostgresQueryContext } from "../../server/db/postgres/query-context";
import type {
  AnalysisRunRecord,
  ConnectorStatusRecord,
  RunStageRecord,
  SessionRecord,
  UserRecord,
} from "../../server/db/repository";
import {
  startPostgresTestContainer,
  type PostgresTestContainer,
} from "./helpers/postgres-test-container";

const NOW = "2026-08-18T00:00:00.000Z";
const LATER = "2026-08-18T08:00:00.000Z";
const ADMIN_ID = "10000000-0000-4000-8000-000000000001";
const SECOND_ADMIN_ID = "10000000-0000-4000-8000-000000000002";
const MEMBER_ID = "10000000-0000-4000-8000-000000000003";
const OTHER_MEMBER_ID = "10000000-0000-4000-8000-000000000004";
const ORGANIZATION_ID = "20000000-0000-4000-8000-000000000001";
const OTHER_ORGANIZATION_ID = "20000000-0000-4000-8000-000000000002";
const PROJECT_ID = "30000000-0000-4000-8000-000000000001";
const OTHER_PROJECT_ID = "30000000-0000-4000-8000-000000000002";
const RUN_ID = "40000000-0000-4000-8000-000000000001";
const STAGE_ID = "50000000-0000-4000-8000-000000000001";
const SESSION_ID = "60000000-0000-4000-8000-000000000001";
const PASSWORD_RECORD =
  "scrypt-v1$16384$8$1$YWdlbnQtYXV0aC1kdW1teQ$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const TOKEN_HASH = createHash("sha256").update("postgres-session").digest("hex");

let postgres: PostgresTestContainer;

before(async () => {
  postgres = await startPostgresTestContainer();
});

after(async () => {
  await postgres?.close();
});

async function createSchema(): Promise<string> {
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  await postgres.pool.query(`CREATE SCHEMA ${schema}`);
  const migrationPool = postgres.createPool({ searchPath: schema });
  try {
    await runPostgresMigrations(migrationPool);
  } finally {
    await migrationPool.end();
  }
  return schema;
}

function openStore(
  t: test.TestContext,
  schema: string,
): Readonly<{ pool: Pool; store: PostgresCoreStore }> {
  const pool = postgres.createPool({ searchPath: schema });
  const context = new PostgresQueryContext(pool);
  t.after(async () => {
    await context.close();
  });
  return { pool, store: new PostgresCoreStore(context) };
}

function initialAdmin(
  overrides: Partial<Parameters<PostgresCoreStore["createInitialAdmin"]>[0]> = {},
) {
  return {
    id: ADMIN_ID,
    organizationId: ORGANIZATION_ID,
    email: "admin@example.com",
    displayName: "First Admin",
    passwordHash: PASSWORD_RECORD,
    createdAt: NOW,
    ...overrides,
  };
}

function user(overrides: Partial<UserRecord> = {}): UserRecord {
  return {
    id: MEMBER_ID,
    organizationId: ORGANIZATION_ID,
    email: "member@example.com",
    displayName: "Member",
    role: "member",
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function project(overrides: Record<string, unknown> = {}) {
  return {
    id: PROJECT_ID,
    organizationId: ORGANIZATION_ID,
    name: "Core repository project",
    marketplace: "US",
    asins: ["B000000001", "B000000002", "B000000003"],
    createdBy: MEMBER_ID,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function analysisRun(overrides: Partial<AnalysisRunRecord> = {}): AnalysisRunRecord {
  return {
    id: RUN_ID,
    projectId: PROJECT_ID,
    mode: "existing-data",
    status: "queued",
    createdBy: MEMBER_ID,
    dataCutoffAt: NOW,
    idempotencyScope: `organization:${ORGANIZATION_ID}:project:${PROJECT_ID}`,
    idempotencyKey: "create-run-request",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function stage(overrides: Partial<RunStageRecord> = {}): RunStageRecord {
  return {
    id: STAGE_ID,
    runId: RUN_ID,
    stage: "voc-positioning",
    status: "queued",
    progress: 0,
    attemptCount: 0,
    startedAt: null,
    completedAt: null,
    lastError: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: SESSION_ID,
    userId: ADMIN_ID,
    tokenHash: TOKEN_HASH,
    expiresAt: LATER,
    revokedAt: null,
    createdAt: NOW,
    lastSeenAt: null,
    ...overrides,
  };
}

async function seedProject(store: PostgresCoreStore): Promise<void> {
  await store.createUser(user());
  await store.createProject(project());
}

test("first-admin bootstrap is atomic across independent PostgreSQL connections", async (t) => {
  const schema = await createSchema();
  const first = openStore(t, schema);
  const second = openStore(t, schema);

  const results = await Promise.all([
    first.store.createInitialAdmin(initialAdmin()),
    second.store.createInitialAdmin(
      initialAdmin({
        id: SECOND_ADMIN_ID,
        email: "second-admin@example.com",
      }),
    ),
  ]);

  assert.equal(results.filter((result) => result !== null).length, 1);
  assert.equal(results.filter((result) => result === null).length, 1);
  const counts = await first.pool.query<{ users: string; events: string }>(
    `SELECT
       (SELECT COUNT(*) FROM users) AS users,
       (SELECT COUNT(*) FROM audit_events
         WHERE action = 'auth.first-admin-initialized') AS events`,
  );
  assert.deepEqual(counts.rows[0], { users: "1", events: "1" });

  assert.equal(
    await first.store.createInitialAdmin(
      initialAdmin({
        id: "10000000-0000-4000-8000-000000000005",
        email: "third-admin@example.com",
      }),
    ),
    null,
  );
});

test("authentication sessions follow SQLite lifecycle and disabled-user semantics", async (t) => {
  const { store } = openStore(t, await createSchema());
  const admin = await store.createInitialAdmin(initialAdmin());
  assert.ok(admin);
  assert.equal("passwordHash" in admin, false);
  assert.deepEqual(await store.findAuthenticationUserByEmail("ADMIN@EXAMPLE.COM"), {
    user: admin,
    passwordHash: PASSWORD_RECORD,
  });

  assert.deepEqual(await store.createSession(session()), session());
  assert.deepEqual(
    await store.findActiveSessionPrincipalByTokenHash({
      tokenHash: TOKEN_HASH,
      asOf: NOW,
    }),
    {
      sessionId: SESSION_ID,
      userId: ADMIN_ID,
      organizationId: ORGANIZATION_ID,
      role: "admin",
    },
  );
  assert.equal(
    await store.findActiveSessionPrincipalByTokenHash({
      tokenHash: "not-a-digest",
      asOf: NOW,
    }),
    null,
  );
  assert.equal(
    await store.revokeSessionByTokenHash({ tokenHash: TOKEN_HASH, revokedAt: NOW }),
    true,
  );
  assert.equal(
    await store.revokeSessionByTokenHash({ tokenHash: TOKEN_HASH, revokedAt: NOW }),
    false,
  );

  await store.createUser(
    user({
      id: OTHER_MEMBER_ID,
      email: "disabled@example.com",
      status: "disabled",
    }),
  );
  const disabledHash = createHash("sha256").update("disabled").digest("hex");
  await store.createSession(
    session({
      id: "60000000-0000-4000-8000-000000000002",
      userId: OTHER_MEMBER_ID,
      tokenHash: disabledHash,
    }),
  );
  assert.equal(
    await store.findActiveSessionPrincipalByTokenHash({
      tokenHash: disabledHash,
      asOf: NOW,
    }),
    null,
  );
  assert.equal(
    await store.revokeUserSessions({ userId: OTHER_MEMBER_ID, revokedAt: NOW }),
    1,
  );
  assert.equal(
    await store.revokeUserSessions({ userId: OTHER_MEMBER_ID, revokedAt: NOW }),
    0,
  );
});

test("project writes enforce organization ownership", async (t) => {
  const { store } = openStore(t, await createSchema());
  await store.createUser(user());
  await store.createUser(
    user({
      id: OTHER_MEMBER_ID,
      organizationId: OTHER_ORGANIZATION_ID,
      email: "other@example.com",
    }),
  );

  const created = await store.createProject(project());
  assert.deepEqual(await store.findProjectById(PROJECT_ID), created);
  await assert.rejects(
    store.createProject(
      project({
        id: OTHER_PROJECT_ID,
        organizationId: OTHER_ORGANIZATION_ID,
        createdBy: MEMBER_ID,
      }),
    ),
    PostgresCoreStoreConflictError,
  );
});

test("analysis-run creation is idempotent and conflicts on changed payload", async (t) => {
  const { store } = openStore(t, await createSchema());
  await seedProject(store);

  const first = await store.createAnalysisRunOnce(analysisRun());
  const repeated = await store.createAnalysisRunOnce(
    analysisRun({
      id: "40000000-0000-4000-8000-000000000002",
      createdAt: LATER,
      updatedAt: LATER,
    }),
  );

  assert.equal(first.created, true);
  assert.equal(repeated.created, false);
  assert.deepEqual(repeated.run, first.run);
  assert.equal((await store.findProjectById(PROJECT_ID))?.currentRunId, RUN_ID);
  assert.deepEqual(await store.listAnalysisRuns(PROJECT_ID), [first.run]);

  await assert.rejects(
    store.createAnalysisRunOnce(analysisRun({ mode: "collect-missing" })),
    (error: unknown) => {
      assert.ok(error instanceof PostgresCoreStoreConflictError);
      assert.doesNotMatch(error.message, /postgres(?:ql)?:\/\//i);
      assert.doesNotMatch(error.message, /password|secret|connection/i);
      return true;
    },
  );
});

test("repository transactions roll back and nested calls reuse the outer query context", async (t) => {
  const { store } = openStore(t, await createSchema());

  await assert.rejects(
    store.transaction(async (outer) => {
      await outer.createUser(user());
      await outer.transaction(async (nested) => {
        assert.equal(nested, outer);
        await nested.createProject(project());
      });
      throw new Error("force rollback");
    }),
    /force rollback/,
  );

  assert.equal(await store.findUserById(MEMBER_ID), null);
  assert.equal(await store.findProjectById(PROJECT_ID), null);
});

test("run and stage state constraints reject invalid transitions", async (t) => {
  const { store } = openStore(t, await createSchema());
  await seedProject(store);

  await assert.rejects(
    store.createAnalysisRun(
      analysisRun({ status: "not-a-run-status" as AnalysisRunRecord["status"] }),
    ),
    PostgresCoreStoreDataError,
  );

  await store.createAnalysisRun(analysisRun());
  assert.deepEqual(await store.createRunStage(stage()), stage());
  assert.deepEqual(await store.listRunStages(RUN_ID), [stage()]);
  assert.deepEqual(await store.findRunStage(STAGE_ID), stage());

  await assert.rejects(
    store.createRunStage(
      stage({
        id: "50000000-0000-4000-8000-000000000002",
        stage: "traffic-analysis",
        status: "succeeded",
        progress: 0,
        completedAt: null,
      }),
    ),
    PostgresCoreStoreDataError,
  );
});

test("connector upsert, read, and list remain isolated by organization", async (t) => {
  const { store } = openStore(t, await createSchema());
  const first: ConnectorStatusRecord = {
    id: "70000000-0000-4000-8000-000000000001",
    organizationId: ORGANIZATION_ID,
    connector: "sif",
    configured: true,
    health: "available",
    lastCheckedAt: NOW,
    lastError: null,
    updatedAt: NOW,
  };
  const second: ConnectorStatusRecord = {
    ...first,
    id: "70000000-0000-4000-8000-000000000002",
    organizationId: OTHER_ORGANIZATION_ID,
    configured: false,
    health: "unavailable",
    lastError: { code: "probe-failed", message: "unavailable" },
  };

  await store.upsertConnectorStatus(first);
  await store.upsertConnectorStatus(second);
  const updated = await store.upsertConnectorStatus({
    ...first,
    health: "unavailable",
    lastError: { code: "probe-failed", message: "timed out" },
    updatedAt: LATER,
  });

  assert.equal(updated.id, first.id);
  assert.deepEqual(await store.listConnectorStatuses(ORGANIZATION_ID), [updated]);
  assert.deepEqual(
    await store.findConnectorStatus(OTHER_ORGANIZATION_ID, "sif"),
    second,
  );
  assert.equal(
    await store.findConnectorStatus(ORGANIZATION_ID, "sellerSprite"),
    null,
  );
});
