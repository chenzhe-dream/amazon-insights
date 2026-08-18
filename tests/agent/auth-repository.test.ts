import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
const repositoryModuleUrl = new URL(
  "../../server/db/sqlite-repository.ts",
  import.meta.url,
);

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

function createBootstrapProcess(
  path: string,
  input: ReturnType<typeof createInitialAdminInput>,
) {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--conditions=react-server",
      "-e",
      `
      const readline = require("node:readline");

      (async function main() {
        const { openSqliteAgentRepository } = await import(process.env.REPOSITORY_MODULE_URL);
        const repository = openSqliteAgentRepository({
          path: process.env.AGENT_SQLITE_PATH,
          busyTimeoutMs: 5000,
        });
        process.stdout.write(JSON.stringify({ ready: true }) + "\\n");
        const input = JSON.parse(process.env.ADMIN_INPUT_JSON);
        const reader = readline.createInterface({ input: process.stdin });
        reader.once("line", async (line) => {
          if (line.trim() !== "start") return;
          try {
            const user = await repository.createInitialAdmin(input);
            process.stdout.write(JSON.stringify({ userId: user ? user.id : null }) + "\\n");
          } finally {
            reader.close();
            repository.close();
          }
        });
      })().catch((error) => {
        process.stdout.write(JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        }) + "\\n");
        process.exitCode = 1;
      });
      `,
    ],
    {
      env: {
        ...process.env,
        ADMIN_INPUT_JSON: JSON.stringify(input),
        AGENT_SQLITE_PATH: path,
        REPOSITORY_MODULE_URL: repositoryModuleUrl.href,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  let stdout = "";
  let stderr = "";
  const exited = new Promise<void>((resolve, reject) => {
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`bootstrap process exited with ${code}: ${stderr}`));
    });
  });

  const ready = new Promise<void>((resolve, reject) => {
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      for (const line of stdout.split("\n")) {
        if (line.trim().length === 0) continue;
        const message = JSON.parse(line) as { ready?: boolean; error?: string };
        if (message.error) {
          reject(new Error(message.error));
          return;
        }
        if (message.ready) resolve();
      }
    });
    exited.catch(reject);
  });

  let parsedLineCount = 0;
  const result = new Promise<{ userId: string | null }>((resolve, reject) => {
    child.stdout.on("data", () => {
      const lines = stdout.split("\n").filter((line) => line.trim().length > 0);
      while (parsedLineCount < lines.length) {
        const message = JSON.parse(lines[parsedLineCount]) as {
          ready?: boolean;
          userId?: string | null;
          error?: string;
        };
        parsedLineCount += 1;
        if (message.error) {
          reject(new Error(message.error));
          return;
        }
        if ("userId" in message) {
          resolve({ userId: message.userId ?? null });
          return;
        }
      }
    });
    exited.catch(reject);
  });

  return {
    exited,
    ready,
    result,
    start: () => child.stdin.end("start\n"),
    stop: () => child.kill(),
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
  const migrator = openSqliteAgentRepository({
    path: temporary.path,
    busyTimeoutMs: 5_000,
  });
  migrator.close();
  t.after(() => {
    rmSync(temporary.directory, { recursive: true, force: true });
  });

  const workers = [
    createBootstrapProcess(
      temporary.path,
      createInitialAdminInput(ADMIN_ID),
    ),
    createBootstrapProcess(
      temporary.path,
      createInitialAdminInput(SECOND_ADMIN_ID),
    ),
  ];
  t.after(() => {
    for (const worker of workers) worker.stop();
  });
  await Promise.all(workers.map((worker) => worker.ready));
  for (const worker of workers) worker.start();

  const results = await Promise.all(workers.map((worker) => worker.result));
  await Promise.all(workers.map((worker) => worker.exited));

  assert.equal(results.filter((result) => result.userId !== null).length, 1);
  assert.equal(results.filter((result) => result.userId === null).length, 1);

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

  const offsetExpiredHash = createHash("sha256")
    .update("offset-expired")
    .digest("hex");
  await repository.createSession(
    createSessionRecord({
      id: "30000000-0000-4000-8000-000000000006",
      tokenHash: offsetExpiredHash,
    }),
  );
  const offsetExpiredDatabase = new DatabaseSync(path);
  offsetExpiredDatabase
    .prepare("UPDATE sessions SET expires_at = ? WHERE id = ?")
    .run(
      "2026-08-18T01:00:00.000+02:00",
      "30000000-0000-4000-8000-000000000006",
    );
  offsetExpiredDatabase.close();
  assert.equal(
    await repository.findActiveSessionPrincipalByTokenHash({
      tokenHash: offsetExpiredHash,
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
  const { path, repository } = openRepository(t);
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
  const offsetExpiredHash = createHash("sha256")
    .update("offset-expired-revoke")
    .digest("hex");
  await repository.createSession(
    createSessionRecord({
      id: "30000000-0000-4000-8000-000000000005",
      tokenHash: offsetExpiredHash,
    }),
  );
  const database = new DatabaseSync(path);
  database
    .prepare("UPDATE sessions SET expires_at = ? WHERE id = ?")
    .run(
      "2026-08-18T01:00:00.000+02:00",
      "30000000-0000-4000-8000-000000000005",
    );
  database.close();

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
