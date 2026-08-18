import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { openSqliteAgentRepository } from "../../server/db/sqlite-repository";
import type { SessionRecord } from "../../server/db/repository";

const NOW = "2026-08-18T00:00:00.000Z";
const LATER = "2026-08-18T08:00:00.000Z";
const EXPIRED = "2026-08-17T23:59:59.000Z";
const ADMIN_ID = "10000000-0000-4000-8000-000000000001";
const SECOND_ADMIN_ID = "10000000-0000-4000-8000-000000000002";
const MEMBER_ID = "10000000-0000-4000-8000-000000000003";
const ORGANIZATION_ID = "20000000-0000-4000-8000-000000000001";
const PASSWORD_RECORD =
  "scrypt-v1$16384$8$1$YWdlbnQtYXV0aC1kdW1teQ$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const RAW_TOKEN = "raw-session-token-that-must-never-be-persisted";
const TOKEN_HASH = createHash("sha256").update(RAW_TOKEN).digest("hex");

function temporaryDatabase(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "amazon-auth-repository-"));
  return { directory, path: join(directory, "agent.sqlite") };
}

function openRepository(t: test.TestContext) {
  const temporary = temporaryDatabase(t);
  const repository = openSqliteAgentRepository({
    path: temporary.path,
    busyTimeoutMs: 5_000,
  });
  t.after(() => {
    repository.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });
  return { ...temporary, repository };
}

function inspect<T>(path: string, query: string, ...params: unknown[]): T {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return database.prepare(query).get(...params) as T;
  } finally {
    database.close();
  }
}

function createInitialAdminInput(id = ADMIN_ID) {
  return {
    id,
    organizationId: ORGANIZATION_ID,
    email: "admin@example.com",
    displayName: "First Admin",
    passwordHash: PASSWORD_RECORD,
    createdAt: NOW,
  };
}

function createSessionRecord(
  overrides: Partial<SessionRecord> = {},
): SessionRecord {
  return {
    id: "30000000-0000-4000-8000-000000000001",
    userId: ADMIN_ID,
    tokenHash: TOKEN_HASH,
    expiresAt: LATER,
    revokedAt: null,
    createdAt: NOW,
    lastSeenAt: null,
    ...overrides,
  };
}

test("initial admin bootstrap is atomic and writes one sanitized audit event", async (t) => {
  const { path, repository } = openRepository(t);

  const first = await repository.createInitialAdmin(createInitialAdminInput());
  assert.equal(first?.role, "admin");
  assert.equal(first?.status, "active");
  assert.equal("passwordHash" in first!, false);

  const repeated = await repository.createInitialAdmin(
    createInitialAdminInput(SECOND_ADMIN_ID),
  );
  assert.equal(repeated, null);

  const counts = inspect<{ user_count: number; event_count: number }>(
    path,
    `SELECT
       (SELECT COUNT(*) FROM users) AS user_count,
       (SELECT COUNT(*) FROM audit_events
        WHERE action = 'auth.first-admin-initialized') AS event_count`,
  );
  assert.equal(counts.user_count, 1);
  assert.equal(counts.event_count, 1);

  const event = inspect<{
    actor_user_id: string | null;
    target_type: string;
    target_id: string;
    metadata_json: string;
  }>(
    path,
    `SELECT actor_user_id, target_type, target_id, metadata_json
     FROM audit_events WHERE action = 'auth.first-admin-initialized'`,
  );
  assert.equal(event.actor_user_id, null);
  assert.equal(event.target_type, "user");
  assert.equal(event.target_id, ADMIN_ID);
  assert.deepEqual(JSON.parse(event.metadata_json), { role: "admin" });
});

test("concurrent first-admin attempts create only one user and zero duplicate events", async (t) => {
  const temporary = temporaryDatabase(t);
  const firstRepository = openSqliteAgentRepository({
    path: temporary.path,
    busyTimeoutMs: 5_000,
  });
  const secondRepository = openSqliteAgentRepository({
    path: temporary.path,
    busyTimeoutMs: 5_000,
  });
  t.after(() => {
    firstRepository.close();
    secondRepository.close();
    rmSync(temporary.directory, { recursive: true, force: true });
  });

  const results = await Promise.all([
    firstRepository.createInitialAdmin(createInitialAdminInput(ADMIN_ID)),
    secondRepository.createInitialAdmin(
      createInitialAdminInput(SECOND_ADMIN_ID),
    ),
  ]);

  assert.equal(results.filter((result) => result !== null).length, 1);
  assert.equal(results.filter((result) => result === null).length, 1);

  const counts = inspect<{ user_count: number; event_count: number }>(
    temporary.path,
    `SELECT
       (SELECT COUNT(*) FROM users) AS user_count,
       (SELECT COUNT(*) FROM audit_events
        WHERE action = 'auth.first-admin-initialized') AS event_count`,
  );
  assert.equal(counts.user_count, 1);
  assert.equal(counts.event_count, 1);
});

test("authentication email lookup is case-insensitive and keeps password hashes private", async (t) => {
  const { repository } = openRepository(t);
  const user = await repository.createInitialAdmin(createInitialAdminInput());

  const found = await repository.findAuthenticationUserByEmail(
    "ADMIN@EXAMPLE.COM",
  );
  assert.deepEqual(found, { user, passwordHash: PASSWORD_RECORD });
  assert.equal("passwordHash" in found!.user, false);

  assert.equal(
    await repository.findAuthenticationUserByEmail("missing@example.com"),
    null,
  );
});

test("sessions persist only token digests and active lookup fails closed", async (t) => {
  const { directory, path, repository } = openRepository(t);
  await repository.createInitialAdmin(createInitialAdminInput());

  const created = await repository.createSession(createSessionRecord());
  assert.equal(created.tokenHash, TOKEN_HASH);
  assert.equal(created.tokenHash === RAW_TOKEN, false);

  for (const filename of ["agent.sqlite", "agent.sqlite-wal", "agent.sqlite-shm"]) {
    const filePath = join(directory, filename);
    if (existsSync(filePath)) {
      assert.equal(readFileSync(filePath).includes(RAW_TOKEN), false);
    }
  }

  assert.deepEqual(
    await repository.findActiveSessionPrincipalByTokenHash({
      tokenHash: TOKEN_HASH,
      asOf: NOW,
    }),
    {
      sessionId: created.id,
      userId: ADMIN_ID,
      organizationId: ORGANIZATION_ID,
      role: "admin",
    },
  );

  assert.equal(
    await repository.findActiveSessionPrincipalByTokenHash({
      tokenHash: "not-a-digest",
      asOf: NOW,
    }),
    null,
  );
  assert.equal(
    await repository.findActiveSessionPrincipalByTokenHash({
      tokenHash: TOKEN_HASH.toUpperCase(),
      asOf: NOW,
    }),
    null,
  );
  assert.equal(
    await repository.findActiveSessionPrincipalByTokenHash({
      tokenHash: TOKEN_HASH,
      asOf: "not-a-timestamp",
    }),
    null,
  );

  await repository.createSession(
    createSessionRecord({
      id: "30000000-0000-4000-8000-000000000002",
      tokenHash: createHash("sha256").update("expired").digest("hex"),
      expiresAt: EXPIRED,
    }),
  );
  assert.equal(
    await repository.findActiveSessionPrincipalByTokenHash({
      tokenHash: createHash("sha256").update("expired").digest("hex"),
      asOf: NOW,
    }),
    null,
  );

  await repository.createSession(
    createSessionRecord({
      id: "30000000-0000-4000-8000-000000000003",
      tokenHash: createHash("sha256").update("revoked").digest("hex"),
      revokedAt: NOW,
    }),
  );
  assert.equal(
    await repository.findActiveSessionPrincipalByTokenHash({
      tokenHash: createHash("sha256").update("revoked").digest("hex"),
      asOf: NOW,
    }),
    null,
  );

  await repository.createSession(
    createSessionRecord({
      id: "30000000-0000-4000-8000-000000000004",
      tokenHash: createHash("sha256").update("malformed-row").digest("hex"),
    }),
  );
  const database = new DatabaseSync(path);
  database
    .prepare("UPDATE sessions SET expires_at = ? WHERE id = ?")
    .run("not-a-timestamp", "30000000-0000-4000-8000-000000000004");
  database.close();
  assert.equal(
    await repository.findActiveSessionPrincipalByTokenHash({
      tokenHash: createHash("sha256").update("malformed-row").digest("hex"),
      asOf: NOW,
    }),
    null,
  );

  const member = {
    id: MEMBER_ID,
    organizationId: ORGANIZATION_ID,
    email: "member@example.com",
    displayName: "Member",
    role: "member" as const,
    status: "active" as const,
    createdAt: NOW,
    updatedAt: NOW,
  };
  await repository.createUser(member);
  const disabledHash = createHash("sha256").update("disabled").digest("hex");
  await repository.createSession(
    createSessionRecord({
      id: "30000000-0000-4000-8000-000000000005",
      userId: MEMBER_ID,
      tokenHash: disabledHash,
    }),
  );
  const writable = new DatabaseSync(path);
  writable
    .prepare("UPDATE users SET status = 'disabled' WHERE id = ?")
    .run(MEMBER_ID);
  writable.close();
  assert.equal(
    await repository.findActiveSessionPrincipalByTokenHash({
      tokenHash: disabledHash,
      asOf: NOW,
    }),
    null,
  );
});

test("session creation validates digests and revocation is idempotent", async (t) => {
  const { repository } = openRepository(t);
  await repository.createInitialAdmin(createInitialAdminInput());

  await assert.rejects(
    repository.createSession(createSessionRecord({ tokenHash: RAW_TOKEN })),
    /session/i,
  );
  await assert.rejects(
    repository.createSession(createSessionRecord({ expiresAt: "soon" })),
    /session/i,
  );

  await repository.createSession(createSessionRecord());
  assert.equal(
    await repository.revokeSessionByTokenHash({
      tokenHash: TOKEN_HASH,
      revokedAt: NOW,
    }),
    true,
  );
  assert.equal(
    await repository.revokeSessionByTokenHash({
      tokenHash: TOKEN_HASH,
      revokedAt: NOW,
    }),
    false,
  );
  assert.equal(
    await repository.findActiveSessionPrincipalByTokenHash({
      tokenHash: TOKEN_HASH,
      asOf: NOW,
    }),
    null,
  );
});

test("revoking a user removes every active session and ignores inactive sessions", async (t) => {
  const { repository } = openRepository(t);
  await repository.createInitialAdmin(createInitialAdminInput());

  const activeHashes = ["one", "two"].map((value, index) => {
    const tokenHash = createHash("sha256").update(value).digest("hex");
    return {
      id: `30000000-0000-4000-8000-00000000000${index + 1}`,
      tokenHash,
    };
  });
  for (const session of activeHashes) {
    await repository.createSession(
      createSessionRecord({ id: session.id, tokenHash: session.tokenHash }),
    );
  }
  await repository.createSession(
    createSessionRecord({
      id: "30000000-0000-4000-8000-000000000003",
      tokenHash: createHash("sha256").update("already-revoked").digest("hex"),
      revokedAt: NOW,
    }),
  );
  await repository.createSession(
    createSessionRecord({
      id: "30000000-0000-4000-8000-000000000004",
      tokenHash: createHash("sha256").update("already-expired").digest("hex"),
      expiresAt: EXPIRED,
    }),
  );

  assert.equal(
    await repository.revokeUserSessions({ userId: ADMIN_ID, revokedAt: NOW }),
    2,
  );
  assert.equal(
    await repository.revokeUserSessions({ userId: ADMIN_ID, revokedAt: NOW }),
    0,
  );

  for (const session of activeHashes) {
    assert.equal(
      await repository.findActiveSessionPrincipalByTokenHash({
        tokenHash: session.tokenHash,
        asOf: NOW,
      }),
      null,
    );
  }
});
