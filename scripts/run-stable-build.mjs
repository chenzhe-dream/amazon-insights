import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  beginStableBuildFingerprint,
  completeStableBuildFingerprint,
  stableBuildFingerprintMarker,
} from "./lib/build-fingerprint.mjs";
import { runBoundedProcess } from "./lib/bounded-process.mjs";
import { acquireInterprocessLock } from "./lib/interprocess-lock.mjs";

export async function runStableBuild({
  worktree = path.resolve("."),
  runProcess = runBoundedProcess,
} = {}) {
  const resolvedWorktree = path.resolve(worktree);
  const marker = stableBuildFingerprintMarker(resolvedWorktree, randomUUID());
  const target = path.join(resolvedWorktree, "dist", "build-fingerprint.json");
  const release = await acquireInterprocessLock(path.join(resolvedWorktree, ".runtime", "stable-build.lock"), {
    attempts: 36_000,
    retryMs: 50,
  });
  try {
    const markerDirectory = path.dirname(marker);
    await fs.mkdir(markerDirectory, { recursive: true });
    for (const name of await fs.readdir(markerDirectory)) {
      if (/^[a-f0-9-]{36}\.json$/i.test(name)) await fs.rm(path.join(markerDirectory, name), { force: true });
    }
    await beginStableBuildFingerprint(resolvedWorktree, marker);
    const result = await runProcess({
      command: process.execPath,
      args: [path.join(resolvedWorktree, "node_modules", "vinext", "dist", "cli.js"), "build"],
      cwd: resolvedWorktree,
      env: process.env,
      timeout: 30 * 60 * 1_000,
    });
    if (result.code !== 0) throw new Error(`vinext build failed (exit ${result.code})`);
    await completeStableBuildFingerprint(resolvedWorktree, marker, target);
  } catch (error) {
    await fs.rm(marker, { force: true });
    throw error;
  } finally {
    release();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runStableBuild();
