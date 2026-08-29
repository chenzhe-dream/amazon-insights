import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  claimAlexaPublicationWorker,
  readAlexaPublicationState,
  recordAlexaVocGeneration,
} from "../../scripts/lib/alexa-publication-state.mjs";

const runnerPath = path.resolve("scripts/run-background-rebuild.mjs");
const source = await fs.readFile(runnerPath, "utf8");
const containsLegacyRestart = /start-team-server\.ps1|spawn\(|3000/.test(source);
const runner = containsLegacyRestart ? null : await import(pathToFileURL(runnerPath).href);

async function withTemporaryWorktree(run) {
  const worktree = await fs.mkdtemp(path.join(os.tmpdir(), "background-rebuild-"));
  try {
    await fs.mkdir(path.join(worktree, "app"), { recursive: true });
    await fs.mkdir(path.join(worktree, "scripts"), { recursive: true });
    await fs.writeFile(path.join(worktree, "package.json"), "{}", "utf8");
    await fs.writeFile(path.join(worktree, "app", "rufus-voc-data.ts"), "source-zero", "utf8");
    await fs.writeFile(path.join(worktree, "scripts", "run-background-rebuild.mjs"), "export {};", "utf8");
    await run({ worktree });
  } finally {
    await fs.rm(worktree, { recursive: true, force: true });
  }
}

test("background rebuild has no legacy restart, detached follower, or port-3000 path", () => {
  assert.doesNotMatch(source, /start-team-server\.ps1/);
  assert.doesNotMatch(source, /\bspawn\s*\(/);
  assert.doesNotMatch(source, /ALEXA_REBUILD_WAIT_FOR_LOCK/);
  assert.doesNotMatch(source, /3000/);
});

test("Alexa import CLI guidance describes formal publication instead of team-service restart", async () => {
  for (const file of [
    path.resolve("scripts/import-alexa-voc-from-chrome.mjs"),
    path.resolve("scripts/import-alexa-voc-from-text.mjs"),
    path.resolve("scripts/run-alexa-voc-capture.mjs"),
  ]) {
    const cliSource = await fs.readFile(file, "utf8");
    assert.doesNotMatch(cliSource, /构建并重启团队服务|重启团队服务|npm run build && npm run (?:start|serve)/);
    assert.match(cliSource, /正式页面发布/);
  }
});

test("one worker drains a newer generation recorded during the active build", {
  skip: containsLegacyRestart && "legacy entrypoint must be removed before importing it",
}, async () => {
  await withTemporaryWorktree(async ({ worktree }) => {
    recordAlexaVocGeneration({ worktree, source: "generation-one" });
    claimAlexaPublicationWorker(worktree, { token: "owner", pid: process.pid });
    const published = [];
    await runner.runBackgroundRebuild({
      worktree,
      env: { AGENT_FORMAL_WORKTREE_ROOT: worktree },
      owner: "owner",
      heartbeatIntervalMs: 5,
      publish: async (input) => {
        published.push({ generation: input.generation, sourceHash: input.sourceHash });
        if (input.generation === 1) recordAlexaVocGeneration({ worktree, source: "generation-two" });
        return { artifactId: String(input.generation).repeat(64) };
      },
    });
    assert.deepEqual(published.map((item) => item.generation), [1, 2]);
    assert.equal(await fs.readFile(path.join(worktree, "app", "rufus-voc-data.ts"), "utf8"), "generation-two");
    const state = readAlexaPublicationState(worktree);
    assert.equal(state.generation, 2);
    assert.equal(state.dirty, false);
    assert.equal(state.worker, null);
  });
});

test("publication failure retains the latest dirty generation for compensation", {
  skip: containsLegacyRestart && "legacy entrypoint must be removed before importing it",
}, async () => {
  await withTemporaryWorktree(async ({ worktree }) => {
    recordAlexaVocGeneration({ worktree, source: "must-not-be-lost" });
    claimAlexaPublicationWorker(worktree, { token: "owner", pid: process.pid });
    let attempts = 0;
    await assert.rejects(runner.runBackgroundRebuild({
      worktree,
      env: { AGENT_FORMAL_WORKTREE_ROOT: worktree },
      owner: "owner",
      maxGenerationsPerRun: 3,
      publish: async () => {
        attempts += 1;
        throw new Error("publication failed");
      },
    }), /publication failed/);
    assert.equal(attempts, 1);
    const state = readAlexaPublicationState(worktree);
    assert.equal(state.generation, 1);
    assert.equal(state.dirty, true);
    assert.equal(state.worker, null);
  });
});

test("three failed workers cannot silently discard the latest generation", {
  skip: containsLegacyRestart && "legacy entrypoint must be removed before importing it",
}, async () => {
  await withTemporaryWorktree(async ({ worktree }) => {
    recordAlexaVocGeneration({ worktree, source: "latest-after-three-failures" });
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const owner = `failed-owner-${attempt}`;
      assert.equal(claimAlexaPublicationWorker(worktree, { token: owner, pid: process.pid }).spawnNeeded, true);
      await assert.rejects(runner.runBackgroundRebuild({
        worktree,
        env: { AGENT_FORMAL_WORKTREE_ROOT: worktree },
        owner,
        publish: async () => { throw new Error(`failure-${attempt}`); },
      }), new RegExp(`failure-${attempt}`));
      const failedState = readAlexaPublicationState(worktree);
      assert.equal(failedState.generation, 1);
      assert.equal(failedState.dirty, true);
      assert.equal(failedState.worker, null);
    }
    assert.equal(claimAlexaPublicationWorker(worktree, { token: "compensating-owner", pid: process.pid }).spawnNeeded, true);
    const published = [];
    await runner.runBackgroundRebuild({
      worktree,
      env: { AGENT_FORMAL_WORKTREE_ROOT: worktree },
      owner: "compensating-owner",
      publish: async (input) => { published.push(input.generation); },
    });
    assert.deepEqual(published, [1]);
    assert.equal(readAlexaPublicationState(worktree).dirty, false);
  });
});

test("continuous imports stop at the explicit generation bound and remain compensatable", {
  skip: containsLegacyRestart && "legacy entrypoint must be removed before importing it",
}, async () => {
  await withTemporaryWorktree(async ({ worktree }) => {
    recordAlexaVocGeneration({ worktree, source: "generation-1" });
    claimAlexaPublicationWorker(worktree, { token: "bounded-owner", pid: process.pid });
    await assert.rejects(runner.runBackgroundRebuild({
      worktree,
      env: { AGENT_FORMAL_WORKTREE_ROOT: worktree },
      owner: "bounded-owner",
      maxGenerationsPerRun: 3,
      publish: async (input) => {
        recordAlexaVocGeneration({ worktree, source: `generation-${input.generation + 1}` });
      },
    }), /generation limit exceeded/);
    const bounded = readAlexaPublicationState(worktree);
    assert.equal(bounded.generation, 4);
    assert.equal(bounded.dirty, true);
    assert.equal(bounded.worker, null);

    claimAlexaPublicationWorker(worktree, { token: "bounded-retry", pid: process.pid });
    const retried = [];
    await runner.runBackgroundRebuild({
      worktree,
      env: { AGENT_FORMAL_WORKTREE_ROOT: worktree },
      owner: "bounded-retry",
      publish: async (input) => { retried.push(input.generation); },
    });
    assert.deepEqual(retried, [4]);
    assert.equal(readAlexaPublicationState(worktree).dirty, false);
  });
});

test("default build has a bounded timeout and surfaces a hung child", {
  skip: containsLegacyRestart && "legacy entrypoint must be removed before importing it",
}, async () => {
  await withTemporaryWorktree(async ({ worktree }) => {
    let observed = null;
    const build = runner.createBoundedBuild({
      worktree,
      env: {},
      timeoutMs: 1234,
      spawnSync: (_command, _args, options) => {
        observed = options;
        const error = new Error("timed out");
        error.code = "ETIMEDOUT";
        return { status: null, stdout: "", stderr: "", error };
      },
    });
    assert.throws(() => build(), /build timed out/);
    assert.equal(observed.timeout, 1234);
    assert.equal(observed.cwd, worktree);
  });
});
