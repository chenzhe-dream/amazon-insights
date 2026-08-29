import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  beginStableBuildFingerprint,
  completeStableBuildFingerprint,
  stableBuildFingerprintMarker,
} from "./lib/build-fingerprint.mjs";
import { runBoundedProcess } from "./lib/bounded-process.mjs";
import { acquireInterprocessLock } from "./lib/interprocess-lock.mjs";

const worktree = path.resolve(".");
const marker = stableBuildFingerprintMarker(worktree, randomUUID());
const target = path.join(worktree, "dist", "build-fingerprint.json");
const release = await acquireInterprocessLock(path.join(worktree, ".runtime", "stable-build.lock"), {
  attempts: 36_000,
  retryMs: 50,
});
try {
  const markerDirectory = path.dirname(marker);
  await fs.mkdir(markerDirectory, { recursive: true });
  for (const name of await fs.readdir(markerDirectory)) {
    if (/^[a-f0-9-]{36}\.json$/i.test(name)) await fs.rm(path.join(markerDirectory, name), { force: true });
  }
  await beginStableBuildFingerprint(worktree, marker);
  const result = await runBoundedProcess({
    command: process.execPath,
    args: [path.join(worktree, "node_modules", "vinext", "dist", "cli.js"), "build"],
    cwd: worktree,
    env: process.env,
    timeout: 30 * 60 * 1_000,
  });
  if (result.code !== 0) throw new Error(`vinext build failed (exit ${result.code})`);
  await completeStableBuildFingerprint(worktree, marker, target);
} catch (error) {
  await fs.rm(marker, { force: true });
  throw error;
} finally {
  release();
}
