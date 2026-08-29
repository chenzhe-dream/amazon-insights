import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  beginAlexaPublicationGeneration,
  completeAlexaPublicationGeneration,
  failAlexaPublicationWorker,
  heartbeatAlexaPublicationWorker,
} from "./lib/alexa-publication-state.mjs";
import { resolveFormalWorktreeRoot } from "./lib/formal-worktree-root.mjs";
import { publishManualWebUpdate } from "./lib/manual-web-publication.mjs";

const DEFAULT_BUILD_TIMEOUT_MS = 15 * 60 * 1_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30 * 1_000;
const DEFAULT_MAX_GENERATIONS_PER_RUN = 20;

export function createBoundedBuild({
  worktree,
  env,
  timeoutMs = DEFAULT_BUILD_TIMEOUT_MS,
  spawnSync: runBuildProcess = spawnSync,
}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("Invalid build timeout");
  return function build() {
    console.log("[rebuild] build");
    const result = runBuildProcess("npm", ["run", "build"], {
      cwd: worktree,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
      timeout: timeoutMs,
    });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.error?.code === "ETIMEDOUT") throw new Error("build timed out");
    if (result.error) throw new Error("build failed to start");
    if (result.status !== 0) throw new Error(`build failed (exit ${result.status})`);
  };
}

export async function runBackgroundRebuild({
  env = process.env,
  cwd = process.cwd(),
  worktree,
  owner = env.ALEXA_REBUILD_LOCK_OWNER,
  heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
  maxGenerationsPerRun = DEFAULT_MAX_GENERATIONS_PER_RUN,
  setIntervalImplementation = setInterval,
  clearIntervalImplementation = clearInterval,
  build,
  publish = publishManualWebUpdate,
} = {}) {
  if (typeof owner !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(owner)) {
    throw new Error("Alexa publication worker owner is required");
  }
  if (!Number.isSafeInteger(maxGenerationsPerRun) || maxGenerationsPerRun < 1) {
    throw new Error("Invalid Alexa publication generation limit");
  }
  const formalWorktree = resolveFormalWorktreeRoot({ env, cwd, worktree });
  const buildFormal = build ?? createBoundedBuild({ worktree: formalWorktree, env });
  let heartbeatFailure = null;
  const timer = setIntervalImplementation(() => {
    try {
      heartbeatAlexaPublicationWorker(formalWorktree, { token: owner, pid: process.pid });
    } catch (error) {
      heartbeatFailure = error;
    }
  }, heartbeatIntervalMs);
  timer?.unref?.();

  try {
    let latestResult;
    for (let attempt = 0; attempt < maxGenerationsPerRun; attempt += 1) {
      if (heartbeatFailure) throw heartbeatFailure;
      const generation = beginAlexaPublicationGeneration(formalWorktree, {
        token: owner,
        pid: process.pid,
      });
      latestResult = await publish({
        worktree: formalWorktree,
        env,
        build: buildFormal,
        ...generation,
      });
      if (heartbeatFailure) throw heartbeatFailure;
      const completion = completeAlexaPublicationGeneration(formalWorktree, {
        token: owner,
        generation: generation.generation,
      });
      if (!completion.continue) return latestResult;
    }
    throw new Error("Alexa publication generation limit exceeded");
  } catch (error) {
    failAlexaPublicationWorker(formalWorktree, { token: owner });
    throw error;
  } finally {
    clearIntervalImplementation(timer);
  }
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) {
  runBackgroundRebuild().then(
    () => console.log("[rebuild] publication requested"),
    () => {
      console.error("[rebuild] publication failed");
      process.exitCode = 1;
    },
  );
}
