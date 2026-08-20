import { spawn as spawnChild } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadLocalEnv } from "./lib/local-env.mjs";

const root = path.resolve(import.meta.dirname, "..");
const tsxCli = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
const vinextCli = path.join(root, "node_modules", "vinext", "dist", "cli.js");

function readPort(value, fallback) {
  if (value === undefined || value === "") return fallback;
  if (!/^[1-9]\d*$/.test(value)) throw new Error("Invalid stack port");
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port > 65_535) {
    throw new Error("Invalid stack port");
  }
  return port;
}

function healthProbeHost(host) {
  if (host === "0.0.0.0") return "127.0.0.1";
  if (host === "::") return "[::1]";
  return host;
}

export function resolveStackSettings(env = process.env, mode = "prod") {
  const webHost = env.WEB_HOST ?? env.HOST ?? "127.0.0.1";
  const webProbeHost = healthProbeHost(webHost);
  const webPort = readPort(env.WEB_PORT ?? env.PORT, 3001);
  const agentHost = env.AGENT_SERVICE_HOST ?? "127.0.0.1";
  const agentPort = readPort(env.AGENT_SERVICE_PORT, 3100);
  const internalUrl =
    env.AGENT_SERVICE_INTERNAL_URL ?? `http://${agentHost}:${agentPort}`;

  return Object.freeze({
    mode: mode === "dev" ? "dev" : "prod",
    web: Object.freeze({
      host: webHost,
      port: webPort,
      healthUrl: `http://${webProbeHost}:${webPort}/api/health`,
    }),
    agent: Object.freeze({
      host: agentHost,
      port: agentPort,
      internalUrl,
      healthUrl: `${internalUrl.replace(/\/$/, "")}/health`,
    }),
  });
}

export async function waitForHealth(
  url,
  {
    fetchImplementation = fetch,
    timeoutMs = 30_000,
    intervalMs = 250,
  } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() <= deadline) {
    try {
      const response = await fetchImplementation(url, { redirect: "error" });
      if (response.ok) return;
      lastError = new Error(`Health check returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Health check did not become ready: ${lastError instanceof Error ? lastError.message : "unknown"}`);
}

function childExitCode(code, signal) {
  if (typeof code === "number") return code;
  return signal ? 1 : 0;
}

const defaultClock = Object.freeze({
  sleep(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  },
});

function isChildRunning(child) {
  return child.exitCode === null && child.signalCode === null;
}

function waitForChildExit(child) {
  if (!isChildRunning(child)) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", resolve));
}

async function waitForChildrenExit(children, timeoutMs, clock) {
  if (children.every((child) => !isChildRunning(child))) return true;
  return await Promise.race([
    Promise.all(children.map(waitForChildExit)).then(() => true),
    clock.sleep(timeoutMs).then(() => false),
  ]);
}

function defaultTreeKill(child, signal) {
  if (!child.pid) {
    child.kill(signal);
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const args = ["/pid", String(child.pid), "/t"];
    if (signal === "SIGKILL") args.push("/f");
    const killer = spawnChild("taskkill", args, {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.once("error", () => resolve());
    killer.once("exit", () => resolve());
  });
}

export function createStackLauncher({
  env = process.env,
  argv = process.argv.slice(2),
  spawn = spawnChild,
  waitForHealth: wait = waitForHealth,
  onceProcessSignal = (signal, handler) => process.once(signal, handler),
  exit = (code) => process.exit(code),
  platform = process.platform,
  treeKill = defaultTreeKill,
  clock = defaultClock,
  cleanupTimeoutMs = 5_000,
} = {}) {
  const mode = argv.includes("dev") ? "dev" : "prod";
  const settings = resolveStackSettings(env, mode);
  const children = [];
  let stopping = false;
  let cleanupPromise = null;
  let exitPromise = null;
  let unexpectedExitHandled = false;

  async function terminateChild(child, signal) {
    if (!isChildRunning(child)) return;
    if (platform === "win32") {
      await treeKill(child, signal);
      return;
    }
    child.kill(signal);
  }

  async function cleanup(signal = "SIGTERM") {
    if (cleanupPromise) return cleanupPromise;
    stopping = true;
    cleanupPromise = (async () => {
      const targets = children.filter(isChildRunning);
      await Promise.all(targets.map((child) => terminateChild(child, signal)));
      const graceful = await waitForChildrenExit(targets, cleanupTimeoutMs, clock);
      if (graceful) return;

      const stuck = targets.filter(isChildRunning);
      await Promise.all(stuck.map((child) => terminateChild(child, "SIGKILL")));
      await waitForChildrenExit(stuck, cleanupTimeoutMs, clock);
    })();
    return cleanupPromise;
  }

  function exitAfterCleanup(signal, code) {
    exitPromise ??= cleanup(signal).then(
      () => exit(code),
      () => exit(1),
    );
    return exitPromise;
  }

  function spawnNode(args, childEnv) {
    const child = spawn(process.execPath, args, {
      cwd: root,
      env: childEnv,
      stdio: "inherit",
      windowsHide: true,
    });
    children.push(child);
    child.once("exit", (code, signal) => {
      if (stopping) return;
      if (unexpectedExitHandled) return;
      unexpectedExitHandled = true;
      void exitAfterCleanup(signal ?? "SIGTERM", childExitCode(code, signal) || 1);
    });
    return child;
  }

  async function start() {
    try {
      const baseEnv = {
        ...process.env,
        ...env,
        AGENT_SERVICE_HOST: settings.agent.host,
        AGENT_SERVICE_PORT: String(settings.agent.port),
        AGENT_SERVICE_INTERNAL_URL: settings.agent.internalUrl,
      };
      const agentArgs =
        settings.mode === "dev"
          ? [tsxCli, "watch", path.join(root, "server", "index.ts")]
          : [tsxCli, path.join(root, "server", "index.ts")];
      spawnNode(agentArgs, baseEnv);
      await wait(settings.agent.healthUrl);

      const webArgs =
        settings.mode === "dev"
          ? [
              vinextCli,
              "dev",
              "--hostname",
              settings.web.host,
              "--port",
              String(settings.web.port),
            ]
          : [path.join(root, "scripts", "team-prod-server.mjs")];
      spawnNode(webArgs, {
        ...baseEnv,
        HOST: settings.web.host,
        PORT: String(settings.web.port),
      });
      await wait(settings.web.healthUrl);

      for (const signal of ["SIGINT", "SIGTERM"]) {
        onceProcessSignal(signal, () => {
          void exitAfterCleanup(signal, 0);
        });
      }
    } catch (error) {
      await cleanup("SIGTERM");
      throw error;
    }
  }

  return Object.freeze({ start, cleanup, settings });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  loadLocalEnv();
  const launcher = createStackLauncher();
  launcher.start().catch((error) => {
    console.error(error instanceof Error ? error.message : "Stack failed to start");
    process.exit(1);
  });
}
