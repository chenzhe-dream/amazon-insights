import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { seedTestUsers } from "../../server/cli/seed-test-users";
import type {
  AgentRepository,
  AuthenticationUserRecord,
  CreateLocalUserResult,
  LocalUserInput,
} from "../../server/db/repository";

const paths: string[] = [];
after(() => {
  for (const path of paths) rmSync(path, { force: true });
});

function atomicSeedRepository(options: { failCreateAt?: number } = {}) {
  const users = new Map<string, LocalUserInput>();
  let failCreateAt = options.failCreateAt ?? 0;
  return {
    users,
    allowCreates() {
      failCreateAt = 0;
    },
    repository: {
      async transaction<T>(operation: (repository: AgentRepository) => Promise<T>): Promise<T> {
        const pending = new Map(users);
        let createCalls = 0;
        const transactional = {
          async findAuthenticationUserByEmail(email: string): Promise<AuthenticationUserRecord | null> {
            const existing = pending.get(email);
            return existing ? { user: existing, passwordHash: existing.passwordHash } : null;
          },
          async createLocalUser(input: LocalUserInput): Promise<CreateLocalUserResult> {
            createCalls += 1;
            if (createCalls === failCreateAt) throw new Error("simulated later conflict");
            const existing = pending.get(input.email);
            if (existing) return { user: existing, created: false };
            pending.set(input.email, input);
            return { user: input, created: true };
          },
        } as AgentRepository;
        const result = await operation(transactional);
        users.clear();
        for (const [email, user] of pending) users.set(email, user);
        return result;
      },
    } as Pick<AgentRepository, "transaction">,
  };
}

test("seeds one admin and four members idempotently without resetting existing passwords", async () => {
  const fixture = atomicSeedRepository();
  const first = await seedTestUsers("20000000-0000-4000-8000-000000000001", {
    repository: fixture.repository,
  });
  paths.push(first.credentialsPath);
  assert.deepEqual(first.accounts.map(({ role }) => role), ["admin", "member", "member", "member", "member"]);
  assert.equal(new Set([...fixture.users.values()].map(({ passwordHash }) => passwordHash)).size, 5);
  const credentials = readFileSync(first.credentialsPath, "utf8");
  assert.equal(first.accounts.every(({ email }) => credentials.includes(email)), true);
  assert.equal(credentials.split("\n").filter((line) => line.startsWith("password=")).length, 5);

  const firstHashes = new Map([...fixture.users].map(([email, user]) => [email, user.passwordHash]));
  const second = await seedTestUsers("20000000-0000-4000-8000-000000000001", {
    repository: fixture.repository,
  });
  paths.push(second.credentialsPath);
  assert.equal(second.accounts.every(({ created }) => !created), true);
  assert.deepEqual(new Map([...fixture.users].map(([email, user]) => [email, user.passwordHash])), firstHashes);
  assert.equal(readFileSync(second.credentialsPath, "utf8").includes("password="), false);
});

test("rolls back all users and removes credentials when a later create conflicts, then permits retry", async () => {
  const fixture = atomicSeedRepository({ failCreateAt: 4 });
  const credentialsPath = join(tmpdir(), `seed-later-conflict-${crypto.randomUUID()}.txt`);
  paths.push(credentialsPath);
  await assert.rejects(
    seedTestUsers("20000000-0000-4000-8000-000000000001", {
      repository: fixture.repository,
      credentialsPath,
    }),
    /simulated later conflict/,
  );
  assert.equal(fixture.users.size, 0);
  assert.equal(existsSync(credentialsPath), false);

  fixture.allowCreates();
  const retry = await seedTestUsers("20000000-0000-4000-8000-000000000001", {
    repository: fixture.repository,
    credentialsPath,
  });
  assert.equal(retry.accounts.every(({ created }) => created), true);
  assert.equal(fixture.users.size, 5);
});

test("does not create users when the secure credentials write fails and permits retry", async () => {
  const fixture = atomicSeedRepository();
  const credentialsPath = join(tmpdir(), `seed-write-failure-${crypto.randomUUID()}.txt`);
  paths.push(credentialsPath);
  await assert.rejects(
    seedTestUsers("20000000-0000-4000-8000-000000000001", {
      repository: fixture.repository,
      credentialsPath,
      writeCredentials: async () => { throw new Error("simulated secure write failure"); },
    }),
    /simulated secure write failure/,
  );
  assert.equal(fixture.users.size, 0);

  const retry = await seedTestUsers("20000000-0000-4000-8000-000000000001", {
    repository: fixture.repository,
    credentialsPath,
  });
  assert.equal(retry.accounts.every(({ created }) => created), true);
  assert.equal(fixture.users.size, 5);
});

test("fails closed before repository writes when secure password generation repeats", async () => {
  let transactions = 0;
  await assert.rejects(
    seedTestUsers("20000000-0000-4000-8000-000000000001", {
      repository: {
        async transaction<T>(): Promise<T> {
          transactions += 1;
          throw new Error("transaction must not run");
        },
      },
      createPassword: () => "duplicate-password",
    }),
    /unique test passwords/i,
  );
  assert.equal(transactions, 0);
});
