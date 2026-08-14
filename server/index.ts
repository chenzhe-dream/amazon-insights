import { buildAgentApp } from "./app";
import {
  loadAgentConfig,
  loadAgentDatabaseConfig,
  loadAnalysisExecutionContext,
} from "./config";
import { openSqliteAgentRepository } from "./db/sqlite-repository";

const config = loadAgentConfig();
const repository = openSqliteAgentRepository(loadAgentDatabaseConfig());
const executionContext = loadAnalysisExecutionContext();
const app = buildAgentApp({
  logger: true,
  storageAvailable: true,
  repository,
  ...(executionContext ? { executionContext } : {}),
});
let shuttingDown = false;
let repositoryClosed = false;

function closeRepository() {
  if (repositoryClosed) return;
  repositoryClosed = true;
  repository.close();
}

async function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "stopping Agent Service");

  try {
    await app.close();
    app.log.info({ signal }, "Agent Service stopped");
  } catch (error) {
    app.log.error(error, "failed to stop Agent Service cleanly");
    process.exitCode = 1;
  } finally {
    closeRepository();
  }
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen(config);
} catch (error) {
  app.log.error(error, "failed to start Agent Service");
  process.exitCode = 1;
  try {
    await app.close();
  } finally {
    closeRepository();
  }
}
