import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  resolveFormalWorktreeRoot,
} from "../../scripts/lib/formal-worktree-root.mjs";
import { startAlexaPublicationWorker } from "../../scripts/lib/alexa-publication-worker.mjs";

export type RebuildResult = {
  started: boolean;
  message: string;
};

type TriggerDependencies = {
  env: Readonly<Record<string, string | undefined>>;
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
    return startAlexaPublicationWorker({
      worktree,
      env,
      spawn: start,
      token: randomOwner(),
    });
  };
}

export const triggerBackgroundRebuild = createTriggerBackgroundRebuild();
