import assert from "node:assert/strict";
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
