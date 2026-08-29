import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  resolveFormalWorktreeRoot,
  resolveFormalWorktreeRunner,
} from "../../scripts/lib/formal-worktree-root.mjs";
import {
  claimRebuildLockSync,
  releaseRebuildLockSync,
} from "../../scripts/lib/rebuild-lock.mjs";

export type RebuildResult = {
  started: boolean;
  message: string;
};

type TriggerDependencies = {
  env: NodeJS.ProcessEnv;
  cwd: string;
  spawn: typeof spawn;
  randomOwner: () => string;
};

export function createTriggerBackgroundRebuild(dependencies: Partial<TriggerDependencies> = {}) {
  const env = dependencies.env ?? process.env;
  const cwd = dependencies.cwd ?? process.cwd();
  const start = dependencies.spawn ?? spawn;
  const randomOwner = dependencies.randomOwner ?? (() => randomUUID());

  return function triggerBackgroundRebuild(): RebuildResult {
    const worktree = resolveFormalWorktreeRoot({ env, cwd });
    const runner = resolveFormalWorktreeRunner({ env, cwd, worktree });
    const owner = randomOwner();
    const claim = claimRebuildLockSync(worktree, { owner });
    const childEnv: NodeJS.ProcessEnv = {
      ...env,
      AGENT_FORMAL_WORKTREE_ROOT: worktree,
      ALEXA_REBUILD_LOCK_OWNER: owner,
      ...(claim.acquired ? {} : { ALEXA_REBUILD_WAIT_FOR_LOCK: "1" }),
    };
    let child;
    try {
      child = start(process.execPath, [runner], {
        cwd: worktree,
        detached: true,
        stdio: "ignore",
        env: childEnv,
      });
    } catch (error) {
      if (claim.acquired) releaseRebuildLockSync(worktree, owner);
      throw error;
    }
    if (claim.acquired) {
      const cleanup = () => { releaseRebuildLockSync(worktree, owner); };
      child.once("error", cleanup);
      child.once("exit", cleanup);
    }
    child.unref();
    return claim.acquired
      ? { started: true, message: "已启动后台构建与正式页面发布" }
      : { started: true, message: "正式页面发布已排队" };
  };
}

export const triggerBackgroundRebuild = createTriggerBackgroundRebuild();

export function markRebuildComplete(owner?: string) {
  if (!owner) return false;
  const worktree = resolveFormalWorktreeRoot();
  return releaseRebuildLockSync(worktree, owner);
}
