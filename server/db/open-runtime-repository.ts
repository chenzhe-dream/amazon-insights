import type { AgentStorageConfig } from "../config";
import type {
  RuntimeAgentRepository,
  RuntimeAgentRepositoryLifecycle,
} from "./repository";
import { openPostgresAgentRepository } from "./postgres-repository";
import { openSqliteAgentRepository } from "./sqlite-repository";
import { UnavailableSyncJobRepository } from "./sync-job-repository";

const POSTGRES_RUNTIME_POOL_MAX = 10;

export type OpenRuntimeAgentRepositoryResult = RuntimeAgentRepository &
  RuntimeAgentRepositoryLifecycle;

export async function openRuntimeAgentRepository(
  config: AgentStorageConfig,
): Promise<OpenRuntimeAgentRepositoryResult> {
  if (config.kind === "postgres") {
    return await openPostgresAgentRepository({
      connectionString: config.databaseUrl,
      pool: { max: POSTGRES_RUNTIME_POOL_MAX },
    });
  }
  return Object.assign(openSqliteAgentRepository(config.sqlite), {
    syncJobs: new UnavailableSyncJobRepository(),
  });
}
