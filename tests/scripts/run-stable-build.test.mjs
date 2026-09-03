import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runStableBuild } from "../../scripts/run-stable-build.mjs";

test("two stable build writers never enter the build process concurrently", async () => {
  const worktree = await fs.mkdtemp(path.join(os.tmpdir(), "stable-build-lock-"));
  let active = 0;
  let maximum = 0;
  const runProcess = async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 40));
    active -= 1;
    return { code: 0 };
  };
  try {
    await Promise.all([
      runStableBuild({ worktree, runProcess }),
      runStableBuild({ worktree, runProcess }),
    ]);
    assert.equal(maximum, 1);
  } finally {
    await fs.rm(worktree, { recursive: true, force: true });
  }
});

test("stable build lock excludes a real competing process and recovers after its exit", async () => {
  const worktree = await fs.mkdtemp(path.join(os.tmpdir(), "stable-build-process-lock-"));
  const fixture = path.resolve("tests/fixtures/hold-interprocess-lock.mjs");
  const lockPath = path.join(worktree, ".runtime", "stable-build.lock");
  const owner = spawn(process.execPath, [fixture, lockPath], {
    cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  try {
    await once(owner.stdout, "data");
    await assert.rejects(runStableBuild({
      worktree,
      lockOptions: { attempts: 2, retryMs: 1 },
      runProcess: async () => ({ code: 0 }),
    }), /Timed out acquiring interprocess lock/);
    const exited = once(owner, "exit");
    owner.kill("SIGKILL");
    await exited;
    await runStableBuild({ worktree, runProcess: async () => ({ code: 0 }) });
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) {
      const exited = once(owner, "exit");
      owner.kill("SIGKILL");
      await exited;
    }
    await fs.rm(worktree, { recursive: true, force: true });
  }
});
