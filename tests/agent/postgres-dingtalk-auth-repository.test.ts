import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { PostgresCoreStore } from "../../server/db/postgres/core-store";
import { runPostgresMigrations } from "../../server/db/postgres/migrations";
import { PostgresQueryContext } from "../../server/db/postgres/query-context";
import {
  startPostgresTestContainer,
  type PostgresTestContainer,
} from "./helpers/postgres-test-container";

const NOW = "2026-09-04T08:00:00.000Z";
let postgres: PostgresTestContainer;

before(async () => {
  postgres = await startPostgresTestContainer();
});

after(async () => {
  await postgres?.close();
});

test(
  "PostgreSQL persists DingTalk state and provisions one member identity",
  async (t) => {
    const schema = `test_${randomUUID().replaceAll("-", "")}`;
    await postgres.pool.query(`CREATE SCHEMA ${schema}`);

    const pool = postgres.createPool({ searchPath: schema });
    await runPostgresMigrations(pool);
    const context = new PostgresQueryContext(pool);
    const store = new PostgresCoreStore(context);
    t.after(() => context.close());

    await store.createOAuthLoginState({
      stateHash: "a".repeat(64),
      returnPath: "/",
      expiresAt: "2026-09-04T08:05:00.000Z",
      createdAt: NOW,
    });
    assert.equal((await store.consumeOAuthLoginState({
      stateHash: "a".repeat(64),
      asOf: "2026-09-04T08:01:00.000Z",
      consumedAt: "2026-09-04T08:01:00.000Z",
    }))?.returnPath, "/");
    assert.equal(await store.consumeOAuthLoginState({
      stateHash: "a".repeat(64),
      asOf: "2026-09-04T08:02:00.000Z",
      consumedAt: "2026-09-04T08:02:00.000Z",
    }), null);
    await store.createOAuthLoginState({
      stateHash: "b".repeat(64),
      returnPath: "/fresh",
      expiresAt: "2026-09-04T08:11:00.000Z",
      createdAt: "2026-09-04T08:06:00.000Z",
    });
    const retainedStates = await pool.query(
      "SELECT state_hash FROM oauth_login_states ORDER BY state_hash",
    );
    assert.deepEqual(retainedStates.rows, [{ state_hash: "b".repeat(64) }]);

    const identity = {
      id: "10000000-0000-4000-8000-000000000001",
      organizationId: "20000000-0000-4000-8000-000000000001",
      corpId: "ding-corp-id",
      subjectId: "ding-subject-1",
      candidateEmail: "person@example.com",
      fallbackEmail: "dingtalk+subject-1@identity.invalid",
      displayName: "DingTalk Person",
      createdAt: NOW,
      auditEventId: "30000000-0000-4000-8000-000000000001",
    };
    const first = await store.findOrCreateDingTalkUser(identity);
    const existing = await store.findOrCreateDingTalkUser({
      ...identity,
      id: "10000000-0000-4000-8000-000000000002",
      displayName: "Updated DingTalk Person",
      createdAt: "2026-09-04T09:00:00.000Z",
      auditEventId: "30000000-0000-4000-8000-000000000002",
    });
    assert.equal(first.created, true);
    assert.equal(first.user.role, "member");
    assert.equal(existing.created, false);
    assert.equal(existing.user.id, first.user.id);
    assert.equal(existing.user.displayName, "Updated DingTalk Person");
    assert.equal(existing.user.updatedAt, "2026-09-04T09:00:00.000Z");
  },
);
