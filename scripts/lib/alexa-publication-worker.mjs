import { spawn as spawnChild } from "node:child_process";
import { randomUUID } from "node:crypto";

import { resolveFormalWorktreeRunner } from "./formal-worktree-root.mjs";
import {
  adoptAlexaPublicationWorker,
  claimAlexaPublicationWorker,
  failAlexaPublicationWorker,
  readAlexaPublicationState,
} from "./alexa-publication-state.mjs";

const legacyWakeups = new Map();

function scheduleLegacyWakeup(options) {
  const key = options.worktree;
  if (options.legacyWakeAttempt >= options.legacyWakeAttempts) return false;
  if (legacyWakeups.has(key)) return true;
  const timer = options.schedule(() => {
    legacyWakeups.delete(key);
    try { startAlexaPublicationWorker({ ...options, legacyWakeAttempt: options.legacyWakeAttempt + 1 }); }
    catch (error) { options.onWakeError(error); }
  }, options.legacyRetryMs);
  timer?.unref?.();
  legacyWakeups.set(key, timer ?? true);
  return true;
}

/**
 * @typedef {object} AlexaPublicationWorkerOptions
 * @property {string} [worktree]
 * @property {Readonly<Record<string, string | undefined>>} [env]
 * @property {typeof spawnChild} [spawn]
 * @property {string} [token]
 * @property {(callback: () => void, delay: number) => { unref?: () => unknown } | undefined} [schedule]
 * @property {number} [legacyRetryMs]
 * @property {number} [legacyWakeAttempts]
 * @property {number} [legacyWakeAttempt]
 * @property {(error: unknown) => void} [onWakeError]
 */

/** @param {AlexaPublicationWorkerOptions} [options] */
export function startAlexaPublicationWorker(options = {}) {
  const {
    worktree,
    env = process.env,
    spawn = spawnChild,
    token = randomUUID(),
    schedule = setTimeout,
    legacyRetryMs = 30_000,
    legacyWakeAttempts = 3,
    legacyWakeAttempt = 0,
    onWakeError = (error) => console.error("Alexa publication legacy handoff retry failed", error),
  } = options;
  if (
    !Number.isSafeInteger(legacyRetryMs) || legacyRetryMs < 1
    || !Number.isSafeInteger(legacyWakeAttempts) || legacyWakeAttempts < 0 || legacyWakeAttempts > 10
    || !Number.isSafeInteger(legacyWakeAttempt) || legacyWakeAttempt < 0
    || typeof schedule !== "function"
  ) {
    throw new Error("Invalid Alexa publication legacy retry");
  }
  const runner = resolveFormalWorktreeRunner({ env, worktree, cwd: worktree });
  const claim = claimAlexaPublicationWorker(worktree, { token, pid: process.pid });
  if (!claim.spawnNeeded) {
    const wakeScheduled = claim.legacyBusy && !claim.manualRecovery
      ? scheduleLegacyWakeup({
          worktree, env, spawn, token, schedule, legacyRetryMs, legacyWakeAttempts, legacyWakeAttempt, onWakeError,
        })
      : false;
    return Object.freeze({
      started: false,
      message: claim.manualRecovery
        ? "旧版发布锁无法验证；确认旧任务已停止后执行受控隔离命令"
        : claim.legacyBusy ? "等待旧版发布任务安全退出" : "最新发布需求已合并",
      generation: claim.generation,
      wakeScheduled,
      manualRecovery: Boolean(claim.manualRecovery),
    });
  }
  let child;
  try {
    child = spawn(process.execPath, [runner], {
      cwd: worktree,
      detached: true,
      stdio: "ignore",
      env: {
        ...env,
        AGENT_FORMAL_WORKTREE_ROOT: worktree,
        ALEXA_REBUILD_LOCK_OWNER: token,
        ALEXA_PUBLICATION_EPOCH: String(claim.epoch),
      },
    });
    if (!Number.isSafeInteger(child.pid) || child.pid < 1) throw new Error("Alexa publication worker did not start");
    adoptAlexaPublicationWorker(worktree, { token, epoch: claim.epoch, pid: child.pid });
  } catch (error) {
    failAlexaPublicationWorker(worktree, { token, epoch: claim.epoch });
    throw error;
  }
  const cleanup = () => { failAlexaPublicationWorker(worktree, { token, epoch: claim.epoch }); };
  child.once("error", cleanup);
  child.once("exit", cleanup);
  child.unref();
  return Object.freeze({ started: true, message: "已启动后台构建与正式页面发布", generation: claim.generation });
}

/** @param {AlexaPublicationWorkerOptions} [options] */
export function recoverAlexaPublicationWorkerOnStartup(options = {}) {
  const state = readAlexaPublicationState(options.worktree);
  if (!state.dirty) return Object.freeze({ started: false, dirty: false });
  return startAlexaPublicationWorker(options);
}
