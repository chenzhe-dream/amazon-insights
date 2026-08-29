import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { publishManualWebUpdate } from "./lib/manual-web-publication.mjs";

const root = path.resolve(import.meta.dirname, "..");

function clearLock(worktree) {
  const lockFile = path.join(worktree, "data", ".rebuild-lock.json");
  if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
}

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
  worktree = root,
  env = process.env,
  build = async () => run("build", "npm", ["run", "build"], worktree, env),
  publish = publishManualWebUpdate,
} = {}) {
  try {
    return await publish({ worktree, env, build });
  } finally {
    clearLock(worktree);
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
