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
import { runBoundedProcess } from "./lib/bounded-process.mjs";

const DEFAULT_BUILD_TIMEOUT_MS = 15 * 60 * 1_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30 * 1_000;
const DEFAULT_MAX_GENERATIONS_PER_RUN = 20;

export function createBoundedBuild({
  worktree,
  env,
  timeoutMs = DEFAULT_BUILD_TIMEOUT_MS,
  command = process.platform === "win32" ? "npm.cmd" : "npm",
  args = ["run", "build"],
  runProcess = runBoundedProcess,
}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("Invalid build timeout");
  return async function build() {
    console.log("[rebuild] build");
    let result;
    try {
      result = await runProcess({ command, args, cwd: worktree, env, timeout: timeoutMs, shell: false });
    } catch (error) {
      if (error?.code === "ETIMEDOUT") throw new Error("build timed out", { cause: error });
      throw new Error("build failed to start", { cause: error });
    }
    if (result.code !== 0) throw new Error(`build failed (exit ${result.code})`);
  };
}

export async function runBackgroundRebuild({
  env = process.env,
  cwd = process.cwd(),
  worktree,
  owner = env.ALEXA_REBUILD_LOCK_OWNER,
  epoch = env.ALEXA_PUBLICATION_EPOCH === undefined ? undefined : Number(env.ALEXA_PUBLICATION_EPOCH),
  heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
  maxGenerationsPerRun = DEFAULT_MAX_GENERATIONS_PER_RUN,
  maxPublishAttempts = 3,
  retryBackoffMs = 1_000,
  recoveryBackoffMs = 30_000,
  automaticRecovery = true,
  convergenceBackoffMs = 1_000,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
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
  if (!Number.isSafeInteger(maxPublishAttempts) || maxPublishAttempts < 1 || maxPublishAttempts > 10) {
    throw new Error("Invalid Alexa publication retry limit");
  }
  if (!Number.isSafeInteger(recoveryBackoffMs) || recoveryBackoffMs < 1) {
    throw new Error("Invalid Alexa publication recovery backoff");
  }
  const formalWorktree = resolveFormalWorktreeRoot({ env, cwd, worktree });
  const buildFormal = build ?? createBoundedBuild({ worktree: formalWorktree, env });
  let heartbeatFailure = null;
  const timer = setIntervalImplementation(() => {
    try {
      heartbeatAlexaPublicationWorker(formalWorktree, { token: owner, epoch, pid: process.pid });
    } catch (error) {
      heartbeatFailure = error;
    }
  }, heartbeatIntervalMs);
  timer?.unref?.();

  try {
    let latestResult;
    let generationsInBatch = 0;
    while (true) {
      if (heartbeatFailure) throw heartbeatFailure;
      const generation = beginAlexaPublicationGeneration(formalWorktree, {
        token: owner,
        epoch,
        pid: process.pid,
      });
      let published = false;
      while (!published) {
        let finalFailure;
        for (let attempt = 0; attempt < maxPublishAttempts; attempt += 1) {
          try {
            latestResult = await publish({
              worktree: formalWorktree,
              env,
              build: buildFormal,
              token: owner,
              ...generation,
            });
            published = true;
            break;
          } catch (error) {
            finalFailure = error;
            if (attempt + 1 < maxPublishAttempts) {
              const delay = retryBackoffMs * (2 ** attempt);
              await sleep(delay);
              heartbeatAlexaPublicationWorker(formalWorktree, { token: owner, epoch, pid: process.pid });
            }
          }
        }
        if (published) break;
        if (!automaticRecovery) throw finalFailure;
        await sleep(recoveryBackoffMs);
        heartbeatAlexaPublicationWorker(formalWorktree, { token: owner, epoch, pid: process.pid });
      }
      if (heartbeatFailure) throw heartbeatFailure;
      const completion = completeAlexaPublicationGeneration(formalWorktree, {
        token: owner,
        epoch,
        generation: generation.generation,
      });
      if (!completion.continue) return latestResult;
      generationsInBatch += 1;
      if (generationsInBatch >= maxGenerationsPerRun) {
        await sleep(convergenceBackoffMs);
        heartbeatAlexaPublicationWorker(formalWorktree, { token: owner, epoch, pid: process.pid });
        generationsInBatch = 0;
      }
    }
  } catch (error) {
    failAlexaPublicationWorker(formalWorktree, { token: owner, epoch });
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
