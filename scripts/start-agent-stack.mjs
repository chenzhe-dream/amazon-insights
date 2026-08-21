import { spawn as spawnChild } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadLocalEnv } from "./lib/local-env.mjs";
import {
  consumeWebReloadRequest,
  createWebReloadTarget,
} from "./lib/web-reload-request.mjs";

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

async function defaultAllocatePreflightPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (!address || typeof address === "string") throw new Error("Unable to allocate preflight port");
  return address.port;
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
  allocatePreflightPort = defaultAllocatePreflightPort,
  reloadRequest,
  setIntervalImplementation = setInterval,
  clearIntervalImplementation = clearInterval,
} = {}) {
  const mode = argv.includes("dev") ? "dev" : "prod";
  const settings = resolveStackSettings(env, mode);
  const children = [];
  let stopping = false;
  let cleanupPromise = null;
  let exitPromise = null;
  let unexpectedExitHandled = false;
  let agentChild = null;
  let webChild = null;
  let reloadTimer = null;
  let reloadPromise = null;
  const expectedReloadTarget = createWebReloadTarget({
    worktree: root,
    webHost: settings.web.host,
    webPort: settings.web.port,
  });
  const ignoredUnexpectedExits = new WeakSet();

  async function terminateChild(child, signal) {
    if (!isChildRunning(child)) return;
    if (platform === "win32") {
      await treeKill(child, signal);
      return;
    }
    child.kill(signal);
  }

  async function stopChildForReplacement(child) {
    if (!isChildRunning(child)) return;
    ignoredUnexpectedExits.add(child);
    await terminateChild(child, "SIGTERM");
    if (await waitForChildrenExit([child], cleanupTimeoutMs, clock)) return;
    await terminateChild(child, "SIGKILL");
    if (await waitForChildrenExit([child], cleanupTimeoutMs, clock)) return;
    throw new Error("Web child did not stop");
  }

  async function cleanup(signal = "SIGTERM") {
    if (cleanupPromise) return cleanupPromise;
    stopping = true;
    if (reloadTimer) clearIntervalImplementation(reloadTimer);
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

  function spawnNode(args, childEnv, { watchUnexpectedExit = true } = {}) {
    const child = spawn(process.execPath, args, {
      cwd: root,
      env: childEnv,
      stdio: "inherit",
      windowsHide: true,
    });
    children.push(child);
    child.once("exit", (code, signal) => {
      if (stopping) return;
      if (ignoredUnexpectedExits.has(child)) return;
      if (!watchUnexpectedExit) return;
      if (unexpectedExitHandled) return;
      unexpectedExitHandled = true;
      void exitAfterCleanup(signal ?? "SIGTERM", childExitCode(code, signal) || 1);
    });
    return child;
  }

  function webArguments(spec) {
    return settings.mode === "dev"
      ? [
          vinextCli,
          "dev",
          "--hostname",
          spec.host,
          "--port",
          String(spec.port),
        ]
      : [path.join(root, "scripts", "team-prod-server.mjs")];
  }

  function webHealthUrl(spec) {
    return `http://${healthProbeHost(spec.host)}:${spec.port}/api/health`;
  }

  function spawnWeb(spec, baseEnv, { watchUnexpectedExit = true } = {}) {
    return spawnNode(webArguments(spec), {
      ...baseEnv,
      HOST: spec.host,
      PORT: String(spec.port),
    }, { watchUnexpectedExit });
  }

  async function replaceWeb(baseEnv) {
    const previousWeb = webChild;
    if (!previousWeb || !isChildRunning(previousWeb)) throw new Error("No healthy Web child to replace");
    const configuredSpec = { host: settings.web.host, port: settings.web.port };
    const preflightSpec = { host: "127.0.0.1", port: await allocatePreflightPort() };
    const candidate = spawnWeb(preflightSpec, baseEnv, { watchUnexpectedExit: false });

    try {
      await wait(webHealthUrl(preflightSpec));
    } catch {
      await stopChildForReplacement(candidate);
      throw new Error("Web preflight failed");
    }

    await stopChildForReplacement(candidate);
    await stopChildForReplacement(previousWeb);

    const replacement = spawnWeb(configuredSpec, baseEnv);
    try {
      await wait(webHealthUrl(configuredSpec));
      webChild = replacement;
    } catch {
      await stopChildForReplacement(replacement);
      const restored = spawnWeb(configuredSpec, baseEnv);
      webChild = restored;
      try {
        await wait(webHealthUrl(configuredSpec));
      } catch {
        throw new Error("Web reload failed and previous Web could not be restored");
      }
      throw new Error("Web reload failed; previous Web restored");
    }
  }

  async function processReloadRequests() {
    if (reloadPromise) return reloadPromise;
    reloadPromise = (async () => {
      const baseEnv = {
        ...process.env,
        ...env,
        AGENT_SERVICE_HOST: settings.agent.host,
        AGENT_SERVICE_PORT: String(settings.agent.port),
        AGENT_SERVICE_INTERNAL_URL: settings.agent.internalUrl,
      };
      const consumer = reloadRequest?.consume
        ? reloadRequest.consume
        : (options) => consumeWebReloadRequest({
            spoolDir: path.join(root, "data", "web-reload-requests"),
            ...options,
          });
      try {
        return await consumer({
          expectedTarget: expectedReloadTarget,
          apply: async () => replaceWeb(baseEnv),
        });
      } finally {
        reloadPromise = null;
      }
    })();
    return reloadPromise;
  }

  function startReloadMonitor() {
    reloadTimer = setIntervalImplementation(() => {
      void processReloadRequests().catch(() => undefined);
    }, 1_000);
    reloadTimer.unref?.();
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
      agentChild = spawnNode(agentArgs, baseEnv);
      await wait(settings.agent.healthUrl);

      webChild = spawnWeb(settings.web, baseEnv);
      await wait(settings.web.healthUrl);
      if (!reloadRequest) startReloadMonitor();

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

  return Object.freeze({ start, cleanup, processReloadRequests, settings });
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
