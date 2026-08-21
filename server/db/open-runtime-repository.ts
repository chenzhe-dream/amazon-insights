import type { AgentStorageConfig } from "../config";
import type {
  RuntimeAgentRepository,
  RuntimeAgentRepositoryLifecycle,
} from "./repository";
import { openPostgresAgentRepository } from "./postgres-repository";
import { openSqliteAgentRepository } from "./sqlite-repository";

export type OpenRuntimeAgentRepositoryResult = RuntimeAgentRepository &
  RuntimeAgentRepositoryLifecycle;

export async function openRuntimeAgentRepository(
  config: AgentStorageConfig,
): Promise<OpenRuntimeAgentRepositoryResult> {
  if (config.kind === "postgres") {
    return await openPostgresAgentRepository({
      connectionString: config.databaseUrl,
    });
  }
  return openSqliteAgentRepository(config.sqlite);
}
