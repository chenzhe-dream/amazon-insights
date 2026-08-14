import { buildAgentApp } from "./app";
import { loadAgentConfig } from "./config";

const config = loadAgentConfig();
const app = buildAgentApp({ logger: true });
let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "stopping Agent Service");

  try {
    await app.close();
  } catch (error) {
    app.log.error(error, "failed to stop Agent Service cleanly");
    process.exitCode = 1;
  }
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen(config);
} catch (error) {
  app.log.error(error, "failed to start Agent Service");
  process.exitCode = 1;
  await app.close();
}
