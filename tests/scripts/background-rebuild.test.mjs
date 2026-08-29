import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  claimRebuildLock,
  readRebuildLock,
  releaseRebuildLock,
} from "../../scripts/lib/rebuild-lock.mjs";

const runnerPath = path.resolve("scripts/run-background-rebuild.mjs");
const source = await fs.readFile(runnerPath, "utf8");
const containsLegacyRestart = /start-team-server\.ps1|spawn\(|3000/.test(source);
const runner = containsLegacyRestart
  ? null
  : await import(pathToFileURL(runnerPath).href);

async function withTemporaryWorktree(run) {
  const worktree = await fs.mkdtemp(path.join(os.tmpdir(), "background-rebuild-"));
  const lockFile = path.join(worktree, "data", ".rebuild-lock.json");
  try {
    await fs.mkdir(path.join(worktree, "app"), { recursive: true });
    await fs.mkdir(path.join(worktree, "scripts"), { recursive: true });
    await fs.writeFile(path.join(worktree, "package.json"), "{}", "utf8");
    await fs.writeFile(path.join(worktree, "app", "rufus-voc-data.ts"), "export {};", "utf8");
    await fs.writeFile(path.join(worktree, "scripts", "run-background-rebuild.mjs"), "export {};", "utf8");
    await run({ worktree, lockFile });
  } finally {
    await fs.rm(worktree, { recursive: true, force: true });
  }
}

test("background rebuild has no legacy restart or port-3000 path", () => {
  assert.doesNotMatch(source, /start-team-server\.ps1/);
  assert.doesNotMatch(source, /spawn\(/);
  assert.doesNotMatch(source, /3000/);
});

test("Alexa import CLI guidance describes formal publication instead of team-service restart", async () => {
  for (const file of [
    path.resolve("scripts/import-alexa-voc-from-chrome.mjs"),
    path.resolve("scripts/import-alexa-voc-from-text.mjs"),
  ]) {
    const cliSource = await fs.readFile(file, "utf8");
    assert.doesNotMatch(cliSource, /构建并重启团队服务|重启团队服务/);
    assert.match(cliSource, /正式页面发布/);
  }
});

test("background rebuild publishes once and clears its lock", {
  skip: containsLegacyRestart && "legacy entrypoint must be removed before importing it",
}, async () => {
  await withTemporaryWorktree(async ({ worktree, lockFile }) => {
    await claimRebuildLock(worktree, { owner: "success-owner" });
    const calls = [];

    await runner.runBackgroundRebuild({
      worktree,
      owner: "success-owner",
      env: { AGENT_FORMAL_WORKTREE_ROOT: worktree, WEB_HOST: "0.0.0.0", WEB_PORT: "31900" },
      build: async () => calls.push("build"),
      publish: async (input) => {
        calls.push("publish");
        await input.build();
        return { artifactId: "a".repeat(64) };
      },
    });

    assert.deepEqual(calls, ["publish", "build"]);
    await assert.rejects(fs.access(lockFile), { code: "ENOENT" });
  });
});

test("background rebuild clears its lock when publication fails", {
  skip: containsLegacyRestart && "legacy entrypoint must be removed before importing it",
}, async () => {
  await withTemporaryWorktree(async ({ worktree, lockFile }) => {
    await claimRebuildLock(worktree, { owner: "failure-owner" });
    const failure = new Error("publication failed");

    await assert.rejects(
      runner.runBackgroundRebuild({
        worktree,
        owner: "failure-owner",
        env: { AGENT_FORMAL_WORKTREE_ROOT: worktree },
        build: async () => assert.fail("a failed publisher must not run the build"),
        publish: async () => { throw failure; },
      }),
      failure,
    );
    await assert.rejects(fs.access(lockFile), { code: "ENOENT" });
  });
});

test("background rebuild only clears its own lock owner", {
  skip: containsLegacyRestart && "legacy entrypoint must be removed before importing it",
}, async () => {
  await withTemporaryWorktree(async ({ worktree }) => {
    assert.equal((await claimRebuildLock(worktree, { owner: "runner-owner" })).acquired, true);
    await runner.runBackgroundRebuild({
      worktree,
      env: { AGENT_FORMAL_WORKTREE_ROOT: worktree },
      owner: "runner-owner",
      publish: async () => {
        await fs.rm(path.join(worktree, "data", ".rebuild-lock.json"), { force: true });
        assert.equal((await claimRebuildLock(worktree, { owner: "replacement-owner" })).acquired, true);
        return { artifactId: "a".repeat(64) };
      },
    });
    assert.equal((await readRebuildLock(worktree)).owner, "replacement-owner");
  });
});

test("a queued follower claims after the active owner and publishes instead of exiting early", {
  skip: containsLegacyRestart && "legacy entrypoint must be removed before importing it",
}, async () => {
  await withTemporaryWorktree(async ({ worktree }) => {
    assert.equal((await claimRebuildLock(worktree, { owner: "active-owner" })).acquired, true);
    let publishes = 0;
    let sleeps = 0;
    await runner.runBackgroundRebuild({
      worktree,
      env: { AGENT_FORMAL_WORKTREE_ROOT: worktree },
      owner: "queued-owner",
      waitForLock: true,
      lockWaitMs: 10_000,
      lockRetryMs: 1,
      sleep: async () => {
        sleeps += 1;
        await releaseRebuildLock(worktree, "active-owner");
      },
      publish: async () => {
        publishes += 1;
        assert.equal((await readRebuildLock(worktree)).owner, "queued-owner");
        return { artifactId: "a".repeat(64) };
      },
    });
    assert.equal(sleeps, 1);
    assert.equal(publishes, 1);
    assert.equal(await readRebuildLock(worktree), null);
  });
});
