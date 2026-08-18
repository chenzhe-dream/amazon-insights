import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import { hashPassword } from "../auth/password";
import {
  loadAgentStorageConfig,
  type AgentStorageConfig,
} from "../config";
import {
  openRuntimeAgentRepository,
  type OpenRuntimeAgentRepositoryResult,
} from "../db/open-runtime-repository";
import { promptHiddenConfirmedPassword } from "./hidden-password-prompt";

export { promptHiddenConfirmedPassword } from "./hidden-password-prompt";

export interface AdminInitOptions {
  readonly email: string;
  readonly displayName: string;
  readonly organizationId: string;
}

type AdminInitDependencies = Readonly<{
  promptPassword?: typeof promptHiddenConfirmedPassword;
  openRepository?: (
    config: AgentStorageConfig,
  ) => OpenRuntimeAgentRepositoryResult | Promise<OpenRuntimeAgentRepositoryResult>;
  hash?: typeof hashPassword;
}>;

type AdminInitIo = Readonly<{
  input: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
}>;

const ALLOWED_ARGUMENTS = new Set([
  "--email",
  "--display-name",
  "--organization-id",
]);

export function parseAdminInitArgv(argv: readonly string[]): AdminInitOptions {
  const values = new Map<string, string>();

  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === "--password") {
      throw new Error("Password arguments are not allowed");
    }
    if (!name || !ALLOWED_ARGUMENTS.has(name)) {
      throw new Error("Unknown argument");
    }
    if (values.has(name)) {
      throw new Error("Duplicate argument");
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error("Missing required argument value");
    }
    values.set(name, value.trim());
    index += 1;
  }

  const email = values.get("--email");
  const displayName = values.get("--display-name");
  const organizationId = values.get("--organization-id");
  if (!email || !displayName || !organizationId) {
    throw new Error("Missing required admin init option");
  }

  return { email, displayName, organizationId };
}

export async function runAdminInit(
  options: AdminInitOptions,
  dependencies: AdminInitDependencies = {},
): Promise<Readonly<{ userId: string; email: string }>> {
  const promptPassword =
    dependencies.promptPassword ?? promptHiddenConfirmedPassword;
  const hash = dependencies.hash ?? hashPassword;
  const password = await promptPassword(process.stdin, process.stdout);
  const passwordHash = await hash(password);
  const openRepository =
    dependencies.openRepository ?? openRuntimeAgentRepository;
  const repository = await openRepository(resolveStorageConfig(dependencies));

  try {
    const user = await repository.createInitialAdmin({
      id: randomUUID(),
      organizationId: options.organizationId.trim(),
      email: options.email.trim().toLowerCase(),
      displayName: options.displayName.trim(),
      passwordHash,
      createdAt: new Date().toISOString(),
    });
    if (!user) {
      throw new Error("Initial administrator already exists");
    }
    return Object.freeze({ userId: user.id, email: user.email });
  } finally {
    await closeRepository(repository);
  }
}

export async function runAdminInitCli(
  argv: readonly string[] = process.argv.slice(2),
  io: AdminInitIo = {
    input: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  },
  dependencies: AdminInitDependencies = {},
): Promise<number> {
  try {
    const options = parseAdminInitArgv(argv);
    const result = await runAdminInit(options, {
      ...dependencies,
      promptPassword:
        dependencies.promptPassword ??
        (() => promptHiddenConfirmedPassword(io.input, io.stdout)),
    });
    io.stdout.write(
      `${JSON.stringify({
        status: "ready",
        userId: result.userId,
        email: result.email,
      })}\n`,
    );
    return 0;
  } catch (error) {
    io.stderr.write(`Admin initialization failed: ${safeErrorMessage(error)}\n`);
    return 1;
  }
}

function resolveStorageConfig(
  dependencies: AdminInitDependencies,
): AgentStorageConfig {
  if (
    dependencies.openRepository === undefined ||
    process.env.AGENT_DATABASE_URL?.trim() ||
    process.env.AGENT_SQLITE_PATH?.trim()
  ) {
    return loadAgentStorageConfig();
  }
  return {
    kind: "sqlite",
    sqlite: { path: "", busyTimeoutMs: 5_000 },
  };
}

async function closeRepository(
  repository: OpenRuntimeAgentRepositoryResult,
): Promise<void> {
  await Promise.resolve(repository.close());
}

function safeErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return "Admin initialization failed";
  if (isSafePublicMessage(error.message)) return error.message;
  return "Admin initialization failed";
}

function isSafePublicMessage(message: string): boolean {
  return [
    "Duplicate argument",
    "Initial administrator already exists",
    "Missing required admin init option",
    "Missing required argument value",
    "Password arguments are not allowed",
    "Password confirmation does not match",
    "Password length is invalid",
    "Password prompt cancelled",
    "Password prompt failed",
    "Password prompt requires an interactive TTY",
    "Unknown argument",
  ].includes(message);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const exitCode = await runAdminInitCli();
  process.exitCode = exitCode;
}
