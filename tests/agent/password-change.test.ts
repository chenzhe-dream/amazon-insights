import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

import { AuthenticationService } from "../../server/auth/authentication-service";
import { BoundedLoginRateLimiter } from "../../server/auth/login-rate-limiter";
import { hashPassword } from "../../server/auth/password";
import { openSqliteAgentRepository } from "../../server/db/sqlite-repository";
import {
  ChangePasswordRequestSchema,
  LoginRequestSchema,
} from "../../shared/agent-contracts";

const directories: string[] = [];
after(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "agent-password-change-"));
  directories.push(directory);
  const path = join(directory, "agent.sqlite");
  const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  const service = new AuthenticationService({
    repository,
    limiter: new BoundedLoginRateLimiter({ windowMs: 60_000, maxFailures: 20, maxEntries: 100 }),
    sessionTtlMs: 3_600_000,
  });
  return { path, repository, service };
}

async function login(service: AuthenticationService, password: string) {
  return service.login({ email: "member@example.test", password, source: "127.0.0.1" });
}

test("password request and login validation reject seven characters and accept eight", () => {
  assert.equal(LoginRequestSchema.safeParse({ email: "a@b.co", password: "1234567" }).success, false);
  assert.equal(LoginRequestSchema.safeParse({ email: "a@b.co", password: "12345678" }).success, true);
  assert.equal(ChangePasswordRequestSchema.safeParse({ currentPassword: "old-password", newPassword: "1234567", confirmation: "1234567" }).success, false);
  assert.equal(ChangePasswordRequestSchema.safeParse({ currentPassword: "old-password", newPassword: "12345678", confirmation: "12345678" }).success, true);
});

test("password change verifies current password, retains current session and revokes every other session", async () => {
  const { path, repository, service } = fixture();
  const now = new Date().toISOString();
  await repository.createInitialAdmin({
    id: "10000000-0000-4000-8000-000000000001",
    organizationId: "20000000-0000-4000-8000-000000000001",
    email: "member@example.test",
    displayName: "Member",
    passwordHash: await hashPassword("old-password"),
    createdAt: now,
  });

  const current = await login(service, "old-password");
  const other = await login(service, "old-password");
  assert.equal(current.status, "authenticated");
  assert.equal(other.status, "authenticated");
  if (current.status !== "authenticated" || other.status !== "authenticated") return;

  assert.deepEqual(await service.changePassword(current.principal, {
    currentPassword: "wrong-password",
    newPassword: "new-password",
  }), { status: "invalid-credentials" });
  assert.equal((await login(service, "old-password")).status, "authenticated");

  assert.deepEqual(await service.changePassword(current.principal, {
    currentPassword: "old-password",
    newPassword: "new-password",
  }), { status: "changed" });
  assert.equal((await login(service, "old-password")).status, "invalid-credentials");
  assert.equal((await login(service, "new-password")).status, "authenticated");
  assert.ok(await service.authenticate(current.rawSessionToken));
  assert.equal(await service.authenticate(other.rawSessionToken), null);

  repository.close();
  const database = new DatabaseSync(path, { readOnly: true });
  const auditText = JSON.stringify(database
    .prepare("SELECT action, metadata_json FROM audit_events ORDER BY created_at")
    .all());
  database.close();
  assert.doesNotMatch(auditText, /old-password|new-password|wrong-password/);
});

test("two concurrent password changes using the same current hash allow exactly one winner", async () => {
  const { repository, service } = fixture();
  const now = new Date().toISOString();
  await repository.createInitialAdmin({
    id: "10000000-0000-4000-8000-000000000001",
    organizationId: "20000000-0000-4000-8000-000000000001",
    email: "member@example.test",
    displayName: "Member",
    passwordHash: await hashPassword("old-password"),
    createdAt: now,
  });
  const loginResult = await login(service, "old-password");
  assert.equal(loginResult.status, "authenticated");
  if (loginResult.status !== "authenticated") return;

  const results = await Promise.all([
    service.changePassword(loginResult.principal, { currentPassword: "old-password", newPassword: "winner-one" }),
    service.changePassword(loginResult.principal, { currentPassword: "old-password", newPassword: "winner-two" }),
  ]);
  assert.equal(results.filter(({ status }) => status === "changed").length, 1);
  assert.equal(results.filter(({ status }) => status === "invalid-credentials").length, 1);
  const accepted = await Promise.all([login(service, "winner-one"), login(service, "winner-two")]);
  assert.equal(accepted.filter(({ status }) => status === "authenticated").length, 1);
  repository.close();
});
