import { randomBytes, randomUUID } from "node:crypto";
import { chmod, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { EntityIdSchema } from "../../shared/agent-contracts";
import { hashPassword } from "../auth/password";
import { loadAgentStorageConfig } from "../config";
import { openRuntimeAgentRepository } from "../db/open-runtime-repository";
import type { AuthenticationRepository } from "../db/repository";

const TEST_ACCOUNTS = Object.freeze([
  { email: "test-admin@amazon-insights.local", displayName: "Test Admin", role: "admin" as const },
  { email: "test-member-1@amazon-insights.local", displayName: "Test Member 1", role: "member" as const },
  { email: "test-member-2@amazon-insights.local", displayName: "Test Member 2", role: "member" as const },
  { email: "test-member-3@amazon-insights.local", displayName: "Test Member 3", role: "member" as const },
  { email: "test-member-4@amazon-insights.local", displayName: "Test Member 4", role: "member" as const },
]);

type SeedRepository = Required<Pick<AuthenticationRepository, "createLocalUser">>;

export async function seedTestUsers(
  organizationId: string,
  dependencies: Readonly<{
    repository: SeedRepository;
    createPassword?: () => string;
    credentialsPath?: string;
  }>,
) {
  const normalizedOrganizationId = EntityIdSchema.parse(organizationId);
  const createdAt = new Date().toISOString();
  const credentialLines: string[] = [];
  const accounts = [];
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
  for (const [index, account] of TEST_ACCOUNTS.entries()) {
    const password = passwords[index]!;
    const result = await dependencies.repository.createLocalUser({
      id: randomUUID(),
      organizationId: normalizedOrganizationId,
      email: account.email,
      displayName: account.displayName,
      role: account.role,
      status: "active",
      createdAt,
      updatedAt: createdAt,
      passwordHash: await hashPassword(password),
    });
    accounts.push(Object.freeze({ email: account.email, role: account.role, created: result.created }));
    if (result.created) {
      credentialLines.push(`email=${account.email}`, `role=${account.role}`, `password=${password}`, "");
    }
  }
  const credentialsPath = dependencies.credentialsPath ?? join(
    tmpdir(),
    `amazon-insights-test-users-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}.txt`,
  );
  await writeFile(credentialsPath, credentialLines.join("\n"), {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  try {
    await chmod(credentialsPath, 0o600);
  } catch (error) {
    await unlink(credentialsPath).catch(() => undefined);
    throw error;
  }
  return Object.freeze({ accounts: Object.freeze(accounts), credentialsPath });
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
