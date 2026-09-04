import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";

import { openSqliteAgentRepository } from "../../server/db/sqlite-repository";

const NOW = "2026-09-04T08:00:00.000Z";
const ORGANIZATION_ID = "20000000-0000-4000-8000-000000000001";

function temporaryRepository(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "dingtalk-auth-sqlite-"));
  const path = join(directory, "agent.sqlite");
  const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  let repositoryClosed = false;
  t.after(() => {
    if (!repositoryClosed) repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    path,
    repository,
    closeRepository() {
      repository.close();
      repositoryClosed = true;
    },
  };
}

function verifiedUser(overrides: Record<string, string> = {}) {
  return {
    id: "10000000-0000-4000-8000-000000000001",
    organizationId: ORGANIZATION_ID,
    corpId: "ding-corp-id",
    subjectId: "ding-subject-1",
    candidateEmail: "person@example.com",
    fallbackEmail: "dingtalk+subject-1@identity.invalid",
    displayName: "DingTalk Person",
    createdAt: NOW,
    auditEventId: "30000000-0000-4000-8000-000000000001",
    ...overrides,
  };
}

test("OAuth login state is stored hashed, consumed once, and expires closed", async (t) => {
  const { path, repository } = temporaryRepository(t);
  const created = await repository.createOAuthLoginState({
    stateHash: "a".repeat(64),
    returnPath: "/projects/current",
    expiresAt: "2026-09-04T08:05:00.000Z",
    createdAt: NOW,
  });
  assert.equal(created.returnPath, "/projects/current");
  assert.equal(created.consumedAt, null);

  const inspector = new DatabaseSync(path, { readOnly: true });
  assert.equal(
    Number(inspector.prepare("SELECT COUNT(*) AS count FROM oauth_login_states WHERE state_hash = ?").get("a".repeat(64))!.count),
    1,
  );
  inspector.close();

  assert.equal((await repository.consumeOAuthLoginState({
    stateHash: created.stateHash,
    asOf: "2026-09-04T08:01:00.000Z",
    consumedAt: "2026-09-04T08:01:00.000Z",
  }))?.returnPath, "/projects/current");
  assert.equal(await repository.consumeOAuthLoginState({
    stateHash: created.stateHash,
    asOf: "2026-09-04T08:02:00.000Z",
    consumedAt: "2026-09-04T08:02:00.000Z",
  }), null);

  await repository.createOAuthLoginState({
    stateHash: "b".repeat(64),
    returnPath: "/",
    expiresAt: "2026-09-04T08:03:00.000Z",
    createdAt: NOW,
  });
  assert.equal(await repository.consumeOAuthLoginState({
    stateHash: "b".repeat(64),
    asOf: "2026-09-04T08:03:00.000Z",
    consumedAt: "2026-09-04T08:03:00.000Z",
  }), null);

  await repository.createOAuthLoginState({
    stateHash: "c".repeat(64),
    returnPath: "/fresh",
    expiresAt: "2026-09-04T08:11:00.000Z",
    createdAt: "2026-09-04T08:06:00.000Z",
  });
  const prunedInspector = new DatabaseSync(path, { readOnly: true });
  assert.deepEqual(
    prunedInspector.prepare("SELECT state_hash FROM oauth_login_states ORDER BY state_hash")
      .all()
      .map((row) => String(row.state_hash)),
    ["c".repeat(64)],
  );
  prunedInspector.close();
});

test("first DingTalk login provisions one member and concurrent calls converge", async (t) => {
  const { repository } = temporaryRepository(t);
  const input = verifiedUser();
  const results = await Promise.all([
    repository.findOrCreateDingTalkUser(input),
    repository.findOrCreateDingTalkUser({
      ...input,
      id: "10000000-0000-4000-8000-000000000002",
      auditEventId: "30000000-0000-4000-8000-000000000002",
    }),
  ]);

  assert.equal(results.filter((result) => result.created).length, 1);
  assert.equal(new Set(results.map((result) => result.user.id)).size, 1);
  assert.equal(results[0]!.user.role, "member");
  assert.equal(results[0]!.user.status, "active");
});

test("DingTalk identity preserves role/status and does not bind an email collision", async (t) => {
  const { path, repository, closeRepository } = temporaryRepository(t);
  await repository.createUser({
    id: "10000000-0000-4000-8000-000000000010",
    organizationId: ORGANIZATION_ID,
    email: "person@example.com",
    displayName: "Existing Local Admin",
    role: "admin",
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
  });

  const first = await repository.findOrCreateDingTalkUser(verifiedUser());
  assert.equal(first.created, true);
  assert.equal(first.user.id, "10000000-0000-4000-8000-000000000001");
  assert.equal(first.user.email, "dingtalk+subject-1@identity.invalid");
  assert.equal(first.user.role, "member");

  closeRepository();
  const database = new DatabaseSync(path);
  database.prepare("UPDATE users SET role = 'admin', status = 'disabled' WHERE id = ?").run(first.user.id);
  database.close();
  const reopened = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });

  const existing = await reopened.findOrCreateDingTalkUser({
    ...verifiedUser(),
    id: "10000000-0000-4000-8000-000000000099",
    displayName: "Updated DingTalk Person",
    createdAt: "2026-09-04T09:00:00.000Z",
    auditEventId: "30000000-0000-4000-8000-000000000099",
  });
  assert.equal(existing.created, false);
  assert.equal(existing.user.id, first.user.id);
  assert.equal(existing.user.role, "admin");
  assert.equal(existing.user.status, "disabled");
  assert.equal(existing.user.displayName, "Updated DingTalk Person");
  assert.equal(existing.user.updatedAt, "2026-09-04T09:00:00.000Z");
  reopened.close();
});
