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

test("PostgreSQL binding lookup is exact, read-only, current, and provider-scoped", async (t) => {
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  await postgres.pool.query(`CREATE SCHEMA ${schema}`);
  const pool = postgres.createPool({ searchPath: schema });
  await runPostgresMigrations(pool);
  const context = new PostgresQueryContext(pool);
  const store = new PostgresCoreStore(context);
  t.after(() => context.close());

  const identity = {
    id: "10000000-0000-4000-8000-000000000010",
    organizationId: "20000000-0000-4000-8000-000000000010",
    corpId: "exact-corp",
    subjectId: "exact-subject",
    candidateEmail: "exact@example.com",
    fallbackEmail: "dingtalk+exact@identity.invalid",
    displayName: "Exact Person",
    createdAt: NOW,
    auditEventId: "30000000-0000-4000-8000-000000000010",
  };
  // Legacy account fixture: this test exercises binding lookup across organization
  // changes, not provisioning. New accounts now have an organization-bound snapshot.
  await pool.query(
    `INSERT INTO users(id,organization_id,email,display_name,role,status,created_at,updated_at)
     VALUES($1,$2,$3,$4,'member','active',$5,$5)`,
    [identity.id,identity.organizationId,identity.candidateEmail,identity.displayName,NOW],
  );
  await pool.query(
    `INSERT INTO auth_identities(provider,corp_id,subject_id,user_id,created_at,last_login_at)
     VALUES('dingtalk',$1,$2,$3,$4,$4)`,
    [identity.corpId,identity.subjectId,identity.id,NOW],
  );
  const before = await pool.query(
    "SELECT provider, corp_id, subject_id, user_id, created_at, last_login_at FROM auth_identities WHERE user_id = $1",
    [identity.id],
  );
  assert.deepEqual(await store.findDingTalkIdentityByUserId(identity.id), {
    userId: identity.id,
    organizationId: identity.organizationId,
    corpId: identity.corpId,
    subjectId: identity.subjectId,
  });
  const after = await pool.query(
    "SELECT provider, corp_id, subject_id, user_id, created_at, last_login_at FROM auth_identities WHERE user_id = $1",
    [identity.id],
  );
  assert.deepEqual(after.rows, before.rows);

  const movedOrganization = "20000000-0000-4000-8000-000000000099";
  await pool.query("UPDATE users SET organization_id = $1 WHERE id = $2", [movedOrganization, identity.id]);
  assert.equal(
    (await store.findDingTalkIdentityByUserId(identity.id))?.organizationId,
    movedOrganization,
  );

  await pool.query("DELETE FROM auth_identities WHERE user_id = $1", [identity.id]);
  assert.equal(await store.findDingTalkIdentityByUserId(identity.id), null);
  await pool.query(
    "ALTER TABLE auth_identities DROP CONSTRAINT auth_identities_provider_check",
  );
  await pool.query(
    `INSERT INTO auth_identities (provider, corp_id, subject_id, user_id, created_at, last_login_at)
     VALUES ('not-dingtalk', $1, $2, $3, $4, $4)`,
    [identity.corpId, identity.subjectId, identity.id, identity.createdAt],
  );
  assert.equal(await store.findDingTalkIdentityByUserId(identity.id), null);
});
