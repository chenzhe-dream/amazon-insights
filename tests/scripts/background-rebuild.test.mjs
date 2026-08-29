import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

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

test("background rebuild publishes once and clears its lock", {
  skip: containsLegacyRestart && "legacy entrypoint must be removed before importing it",
}, async () => {
  await withTemporaryWorktree(async ({ worktree, lockFile }) => {
    await fs.mkdir(path.dirname(lockFile), { recursive: true });
    await fs.writeFile(lockFile, "{}", "utf8");
    const calls = [];

    await runner.runBackgroundRebuild({
      worktree,
      env: { WEB_HOST: "0.0.0.0", WEB_PORT: "31900" },
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
    await fs.mkdir(path.dirname(lockFile), { recursive: true });
    await fs.writeFile(lockFile, "{}", "utf8");
    const failure = new Error("publication failed");

    await assert.rejects(
      runner.runBackgroundRebuild({
        worktree,
        build: async () => assert.fail("a failed publisher must not run the build"),
        publish: async () => { throw failure; },
      }),
      failure,
    );
    await assert.rejects(fs.access(lockFile), { code: "ENOENT" });
  });
});
