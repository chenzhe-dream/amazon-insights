import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  claimRebuildLock,
  readRebuildLock,
  releaseRebuildLock,
} from "../../scripts/lib/rebuild-lock.mjs";

async function withWorktree(run) {
  const worktree = await fs.mkdtemp(path.join(os.tmpdir(), "rebuild-lock-"));
  try { await run(worktree); }
  finally { await fs.rm(worktree, { recursive: true, force: true }); }
}

test("concurrent rebuild claims have exactly one atomic owner", async () => {
  await withWorktree(async (worktree) => {
    const claims = await Promise.all([
      claimRebuildLock(worktree, { owner: "owner-a" }),
      claimRebuildLock(worktree, { owner: "owner-b" }),
    ]);
    assert.equal(claims.filter((claim) => claim.acquired).length, 1);
    assert.equal((await readRebuildLock(worktree)).owner, claims.find((claim) => claim.acquired).owner);
  });
});

test("an old owner cannot delete a replacement owner's lock", async () => {
  await withWorktree(async (worktree) => {
    assert.equal((await claimRebuildLock(worktree, { owner: "old-owner" })).acquired, true);
    assert.equal(await releaseRebuildLock(worktree, "old-owner"), true);
    assert.equal((await claimRebuildLock(worktree, { owner: "new-owner" })).acquired, true);
    assert.equal(await releaseRebuildLock(worktree, "old-owner"), false);
    assert.equal((await readRebuildLock(worktree)).owner, "new-owner");
  });
});

test("a legitimate fifteen-minute publication is not considered stale", async () => {
  await withWorktree(async (worktree) => {
    const startedAt = new Date("2026-08-29T00:00:00.000Z");
    assert.equal((await claimRebuildLock(worktree, {
      owner: "long-build",
      now: () => startedAt,
    })).acquired, true);
    const contender = await claimRebuildLock(worktree, {
      owner: "contender",
      now: () => new Date(startedAt.getTime() + 16 * 60 * 1_000),
    });
    assert.equal(contender.acquired, false);
    assert.equal((await readRebuildLock(worktree)).owner, "long-build");
  });
});
