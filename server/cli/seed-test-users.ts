import { randomBytes, randomUUID } from "node:crypto";
import { chmod, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { EntityIdSchema } from "../../shared/agent-contracts";
import { hashPassword } from "../auth/password";
import { loadAgentStorageConfig } from "../config";
import { openRuntimeAgentRepository } from "../db/open-runtime-repository";
import type { AgentRepository } from "../db/repository";

const TEST_ACCOUNTS = Object.freeze([
  { email: "test-admin@amazon-insights.local", displayName: "Test Admin", role: "admin" as const },
  { email: "test-member-1@amazon-insights.local", displayName: "Test Member 1", role: "member" as const },
  { email: "test-member-2@amazon-insights.local", displayName: "Test Member 2", role: "member" as const },
  { email: "test-member-3@amazon-insights.local", displayName: "Test Member 3", role: "member" as const },
  { email: "test-member-4@amazon-insights.local", displayName: "Test Member 4", role: "member" as const },
]);

type SeedRepository = Pick<AgentRepository, "transaction">;

type CredentialsWriter = (path: string, contents: string) => Promise<void>;

export async function seedTestUsers(
  organizationId: string,
  dependencies: Readonly<{
    repository: SeedRepository;
    createPassword?: () => string;
    credentialsPath?: string;
    writeCredentials?: CredentialsWriter;
  }>,
) {
  const normalizedOrganizationId = EntityIdSchema.parse(organizationId);
  const createdAt = new Date().toISOString();
  const passwords: string[] = [];
  const uniquePasswords = new Set<string>();
  for (const _account of TEST_ACCOUNTS) {
    let password: string | undefined;
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const candidate = dependencies.createPassword?.() ?? randomBytes(24).toString("base64url");
      if (candidate.length >= 8 && !uniquePasswords.has(candidate)) {
        password = candidate;
        uniquePasswords.add(candidate);
        break;
      }
    }
    if (!password) throw new Error("Could not generate unique test passwords");
    passwords.push(password);
  }

  const inputs = await Promise.all(TEST_ACCOUNTS.map(async (account, index) => ({
      id: randomUUID(),
      organizationId: normalizedOrganizationId,
      email: account.email,
      displayName: account.displayName,
      role: account.role,
      status: "active",
      createdAt,
      updatedAt: createdAt,
      passwordHash: await hashPassword(passwords[index]!),
  })));
  const credentialsPath = dependencies.credentialsPath ?? join(
    tmpdir(),
    `amazon-insights-test-users-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}.txt`,
  );
  const credentialLines = TEST_ACCOUNTS.flatMap((account, index) => [
    `email=${account.email}`,
    `role=${account.role}`,
    `password=${passwords[index]!}`,
    "",
  ]);
  const writeCredentials = dependencies.writeCredentials ?? writeCredentialsSecurely;
  let credentialsCreated = false;
  try {
    const accounts = await dependencies.repository.transaction(async (repository) => {
      if (!repository.createLocalUser) throw new Error("Local user creation is unavailable");
      const existing = await Promise.all(
        TEST_ACCOUNTS.map((account) => repository.findAuthenticationUserByEmail(account.email)),
      );
      for (const [index, authentication] of existing.entries()) {
        if (!authentication) continue;
        const expected = TEST_ACCOUNTS[index]!;
        const actual = authentication.user;
        if (
          actual.email.toLowerCase() !== expected.email ||
          actual.organizationId !== normalizedOrganizationId ||
          actual.displayName !== expected.displayName ||
          actual.role !== expected.role ||
          actual.status !== "active" ||
          !authentication.passwordHash
        ) {
          throw new Error("Test user preflight conflict");
        }
      }
      const existingCount = existing.filter(Boolean).length;
      if (existingCount !== 0 && existingCount !== TEST_ACCOUNTS.length) {
        throw new Error("Test user preflight found a partial account set");
      }

      await writeCredentials(
        credentialsPath,
        existingCount === TEST_ACCOUNTS.length ? "" : credentialLines.join("\n"),
      );
      credentialsCreated = true;
      if (existingCount === TEST_ACCOUNTS.length) {
        return TEST_ACCOUNTS.map((account) =>
          Object.freeze({ email: account.email, role: account.role, created: false }));
      }

      const createdAccounts = [];
      for (const [index, input] of inputs.entries()) {
        const result = await repository.createLocalUser(input);
        if (!result.created) throw new Error("Test user creation raced with another seed");
        const account = TEST_ACCOUNTS[index]!;
        createdAccounts.push(Object.freeze({
          email: account.email,
          role: account.role,
          created: true,
        }));
      }
      return createdAccounts;
    });
    return Object.freeze({ accounts: Object.freeze(accounts), credentialsPath });
  } catch (error) {
    if (credentialsCreated) await unlink(credentialsPath).catch(() => undefined);
    throw error;
  }
}

async function writeCredentialsSecurely(path: string, contents: string) {
  await writeFile(path, contents, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  try {
    await chmod(path, 0o600);
  } catch (error) {
    await unlink(path).catch(() => undefined);
    throw error;
  }
}

async function runCli() {
  const [flag, organizationId] = process.argv.slice(2);
  if (flag !== "--organization-id" || !organizationId) {
    throw new Error("Usage: seed-test-users --organization-id <uuid>");
  }
  const repository = await openRuntimeAgentRepository(loadAgentStorageConfig());
  try {
    const result = await seedTestUsers(organizationId, { repository });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await repository.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch(() => {
    process.stderr.write("Test user seed failed\n");
    process.exitCode = 1;
  });
}
