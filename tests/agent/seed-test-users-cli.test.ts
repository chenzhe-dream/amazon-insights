import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { after, test } from "node:test";

import { seedTestUsers } from "../../server/cli/seed-test-users";
import type { CreateLocalUserResult, LocalUserInput } from "../../server/db/repository";

const paths: string[] = [];
after(() => {
  for (const path of paths) rmSync(path, { force: true });
});

test("seeds one admin and four members idempotently without resetting existing passwords", async () => {
  const users = new Map<string, LocalUserInput>();
  const calls: LocalUserInput[] = [];
  const repository = {
    async createLocalUser(input: LocalUserInput): Promise<CreateLocalUserResult> {
      calls.push(input);
      const existing = users.get(input.email);
      if (existing) return { user: existing, created: false };
      users.set(input.email, input);
      return { user: input, created: true };
    },
  };
  const first = await seedTestUsers("20000000-0000-4000-8000-000000000001", { repository });
  paths.push(first.credentialsPath);
  assert.deepEqual(first.accounts.map(({ role }) => role), ["admin", "member", "member", "member", "member"]);
  assert.equal(new Set(calls.map(({ passwordHash }) => passwordHash)).size, 5);
  const credentials = readFileSync(first.credentialsPath, "utf8");
  assert.equal(first.accounts.every(({ email }) => credentials.includes(email)), true);
  assert.equal(credentials.split("\n").filter((line) => line.startsWith("password=")).length, 5);

  const firstHashes = new Map([...users].map(([email, user]) => [email, user.passwordHash]));
  const second = await seedTestUsers("20000000-0000-4000-8000-000000000001", { repository });
  paths.push(second.credentialsPath);
  assert.equal(second.accounts.every(({ created }) => !created), true);
  assert.deepEqual(new Map([...users].map(([email, user]) => [email, user.passwordHash])), firstHashes);
  assert.equal(readFileSync(second.credentialsPath, "utf8").includes("password="), false);
});
