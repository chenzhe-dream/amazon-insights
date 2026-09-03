import { pathToFileURL } from "node:url";

import { loadAgentStorageConfig } from "../config";
import { openRuntimeAgentRepository } from "../db/open-runtime-repository";
import { LegacyProjectOwnershipService } from "../services/legacy-project-ownership-service";

export type LegacyProjectOwnerCliOptions = Readonly<{
  legacyProjectId: string;
  ownerUserId: string;
  operatorUserId: string;
}>;

const allowedArguments = new Map([
  ["--legacy-project-id", "legacyProjectId"],
  ["--owner-user-id", "ownerUserId"],
  ["--operator-user-id", "operatorUserId"],
] as const);

export function parseLegacyProjectOwnerArgv(argv: readonly string[]): LegacyProjectOwnerCliOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const argument = argv[index];
    const key = argument
      ? allowedArguments.get(
          argument as "--legacy-project-id" | "--owner-user-id" | "--operator-user-id",
        )
      : undefined;
    const value = argv[index + 1]?.trim();
    if (!argument || !key) throw new Error("Unknown argument");
    if (!value || value.startsWith("--")) throw new Error("Missing argument value");
    if (values.has(key)) throw new Error("Duplicate argument");
    values.set(key, value);
  }
  const legacyProjectId = values.get("legacyProjectId");
  const ownerUserId = values.get("ownerUserId");
  const operatorUserId = values.get("operatorUserId");
  if (!legacyProjectId || !ownerUserId || !operatorUserId) {
    throw new Error("Missing required argument");
  }
  return { legacyProjectId, ownerUserId, operatorUserId };
}

export async function runBindLegacyProjectOwnerCli(
  argv: readonly string[] = process.argv.slice(2),
  io: Readonly<{ stdout: NodeJS.WriteStream; stderr: NodeJS.WriteStream }> = {
    stdout: process.stdout,
    stderr: process.stderr,
  },
): Promise<number> {
  let repository: Awaited<ReturnType<typeof openRuntimeAgentRepository>> | null = null;
  try {
    const options = parseLegacyProjectOwnerArgv(argv);
    repository = await openRuntimeAgentRepository(loadAgentStorageConfig());
    const operator = await repository.findUserById(options.operatorUserId);
    if (!operator || operator.status !== "active" || operator.role !== "admin") {
      throw new Error("Operator must be an active administrator");
    }
    const result = await new LegacyProjectOwnershipService(repository).bindOnce({
      principal: {
        kind: "user",
        userId: operator.id,
        organizationId: operator.organizationId,
        email: operator.email,
        role: operator.role,
        sessionId: `cli:${operator.id}`,
      },
      legacyProjectId: options.legacyProjectId,
      ownerUserId: options.ownerUserId,
    });
    io.stdout.write(`${JSON.stringify({ status: result.created ? "bound" : "already-bound" })}\n`);
    return 0;
  } catch (error) {
    io.stderr.write(`Legacy project owner binding failed: ${safeMessage(error)}\n`);
    return 1;
  } finally {
    await Promise.resolve(repository?.close());
  }
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : "binding failed";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runBindLegacyProjectOwnerCli();
}
