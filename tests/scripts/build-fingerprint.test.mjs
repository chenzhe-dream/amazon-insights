import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  beginStableBuildFingerprint,
  completeStableBuildFingerprint,
  stableBuildFingerprintMarker,
} from "../../scripts/lib/build-fingerprint.mjs";

test("build fingerprint fails when a build input changes between before and after samples", async () => {
  const worktree = await fs.mkdtemp(path.join(os.tmpdir(), "build-fingerprint-stability-"));
  try {
    await fs.mkdir(path.join(worktree, "app"), { recursive: true });
    await fs.writeFile(path.join(worktree, "app", "input.ts"), "before", "utf8");
    const marker = path.join(worktree, ".runtime", "build-source-before.json");
    const target = path.join(worktree, "dist", "build-fingerprint.json");
    await beginStableBuildFingerprint(worktree, marker);
    await fs.writeFile(path.join(worktree, "app", "input.ts"), "after", "utf8");
    await assert.rejects(completeStableBuildFingerprint(worktree, marker, target), /changed during build/);
    await assert.rejects(fs.access(target), { code: "ENOENT" });
  } finally {
    await fs.rm(worktree, { recursive: true, force: true });
  }
});

test("concurrent build invocations use isolated UUID marker paths", () => {
  const worktree = path.resolve("C:/isolated-build-worktree");
  const first = stableBuildFingerprintMarker(worktree, "11111111-1111-4111-8111-111111111111");
  const second = stableBuildFingerprintMarker(worktree, "22222222-2222-4222-8222-222222222222");
  assert.notEqual(first, second);
  assert.equal(path.dirname(first), path.join(worktree, ".runtime", "build-fingerprints"));
  assert.match(path.basename(first), /^11111111-1111-4111-8111-111111111111\.json$/);
});
