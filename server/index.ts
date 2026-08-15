import { createAgentService } from "./agent-service";
import { loadAgentConfig } from "./config";

const agentService = await createAgentService({ logger: true });
let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  agentService.app.log.info({ signal }, "stopping Agent Service");
  try {
    await agentService.stop();
    agentService.app.log.info({ signal }, "Agent Service stopped");
  } catch {
    process.exitCode = 1;
  }
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await agentService.start(loadAgentConfig());
} catch (error) {
  agentService.app.log.error(error, "failed to start Agent Service");
  process.exitCode = 1;
  await agentService.stop();
}
