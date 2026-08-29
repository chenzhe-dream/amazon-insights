import { spawn as spawnChild } from "node:child_process";
import { randomUUID } from "node:crypto";

import { resolveFormalWorktreeRunner } from "./formal-worktree-root.mjs";
import {
  adoptAlexaPublicationWorker,
  claimAlexaPublicationWorker,
  failAlexaPublicationWorker,
} from "./alexa-publication-state.mjs";

export function startAlexaPublicationWorker({
  worktree,
  env = process.env,
  spawn = spawnChild,
  token = randomUUID(),
} = {}) {
  const runner = resolveFormalWorktreeRunner({ env, worktree, cwd: worktree });
  const claim = claimAlexaPublicationWorker(worktree, { token, pid: process.pid });
  if (!claim.spawnNeeded) {
    return Object.freeze({ started: false, message: "最新发布需求已合并", generation: claim.generation });
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
