import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { resolveFormalWorktreeRoot } from "./lib/formal-worktree-root.mjs";
import { publishManualWebUpdate } from "./lib/manual-web-publication.mjs";
import {
  claimRebuildLock,
  readRebuildLock,
  releaseRebuildLock,
} from "./lib/rebuild-lock.mjs";

function run(label, command, args, worktree, env) {
  console.log(`[rebuild] ${label}`);
  const result = spawnSync(command, args, {
    cwd: worktree,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    throw new Error(`${label} failed (exit ${result.status})`);
  }
}

export async function runBackgroundRebuild({
  env = process.env,
  cwd = process.cwd(),
  worktree,
  owner = env.ALEXA_REBUILD_LOCK_OWNER ?? randomUUID(),
  waitForLock = env.ALEXA_REBUILD_WAIT_FOR_LOCK === "1",
  lockWaitMs = 60 * 60 * 1_000,
  lockRetryMs = 250,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  build,
  publish = publishManualWebUpdate,
} = {}) {
  const formalWorktree = resolveFormalWorktreeRoot({ env, cwd, worktree });
  const buildFormal = build ?? (async () => run("build", "npm", ["run", "build"], formalWorktree, env));
  const deadline = Date.now() + lockWaitMs;
  let owned = (await readRebuildLock(formalWorktree))?.owner === owner;
  while (!owned) {
    const claim = await claimRebuildLock(formalWorktree, { owner });
    owned = claim.acquired;
    if (owned) break;
    if (!waitForLock || Date.now() >= deadline) throw new Error("Rebuild publication lock is busy");
    await sleep(lockRetryMs);
  }
  try {
    return await publish({ worktree: formalWorktree, env, build: buildFormal });
  } finally {
    await releaseRebuildLock(formalWorktree, owner);
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
