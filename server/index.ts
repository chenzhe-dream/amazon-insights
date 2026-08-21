import { createAgentService } from "./agent-service";
import { loadAgentConfig } from "./config";

let shuttingDown = false;
let agentService: Awaited<ReturnType<typeof createAgentService>> | null = null;

async function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  agentService?.app.log.info({ signal }, "stopping Agent Service");
  try {
    await agentService?.stop();
    agentService?.app.log.info({ signal }, "Agent Service stopped");
  } catch {
    process.exitCode = 1;
  }
}

try {
  agentService = await createAgentService({ logger: true });
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  await agentService.start(loadAgentConfig());
} catch {
  process.exitCode = 1;
  console.error("Agent Service failed to start");
  await shutdown("SIGTERM");
}
