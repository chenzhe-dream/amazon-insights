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
import { publishManualWebUpdate } from "../../scripts/lib/manual-web-publication.mjs";

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
      maxPublishAttempts: 1,
      automaticRecovery: false,
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
        maxPublishAttempts: 1,
        automaticRecovery: false,
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

test("generation 20 to 21 automatically converges after one globally throttled pause", {
  skip: containsLegacyRestart && "legacy entrypoint must be removed before importing it",
}, async () => {
  await withTemporaryWorktree(async ({ worktree }) => {
    recordAlexaVocGeneration({ worktree, source: "generation-1" });
    claimAlexaPublicationWorker(worktree, { token: "bounded-owner", pid: process.pid });
    const published = [];
    let pauses = 0;
    await runner.runBackgroundRebuild({
      worktree,
      env: { AGENT_FORMAL_WORKTREE_ROOT: worktree },
      owner: "bounded-owner",
      maxGenerationsPerRun: 20,
      convergenceBackoffMs: 1,
      sleep: async () => { pauses += 1; },
      publish: async (input) => {
        published.push(input.generation);
        if (input.generation <= 20) recordAlexaVocGeneration({ worktree, source: `generation-${input.generation + 1}` });
      },
    });
    assert.equal(published.at(-1), 21);
    assert.equal(pauses, 1);
    assert.equal(readAlexaPublicationState(worktree).dirty, false);
  });
});

test("a transient publication failure retries with backoff and converges without another request", {
  skip: containsLegacyRestart && "legacy entrypoint must be removed before importing it",
}, async () => {
  await withTemporaryWorktree(async ({ worktree }) => {
    recordAlexaVocGeneration({ worktree, source: "retry-latest" });
    claimAlexaPublicationWorker(worktree, { token: "retry-owner", pid: process.pid });
    let attempts = 0;
    const delays = [];
    await runner.runBackgroundRebuild({
      worktree,
      env: { AGENT_FORMAL_WORKTREE_ROOT: worktree },
      owner: "retry-owner",
      maxPublishAttempts: 3,
      retryBackoffMs: 25,
      sleep: async (milliseconds) => { delays.push(milliseconds); },
      publish: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("transient");
      },
    });
    assert.equal(attempts, 2);
    assert.deepEqual(delays, [25]);
    assert.equal(readAlexaPublicationState(worktree).dirty, false);
  });
});

test("three consecutive publication failures stay with one owner and automatically converge", {
  skip: containsLegacyRestart && "legacy entrypoint must be removed before importing it",
}, async () => {
  await withTemporaryWorktree(async ({ worktree }) => {
    recordAlexaVocGeneration({ worktree, source: "retry-after-three" });
    claimAlexaPublicationWorker(worktree, { token: "single-retry-owner", pid: process.pid });
    let attempts = 0;
    const delays = [];
    await runner.runBackgroundRebuild({
      worktree,
      env: { AGENT_FORMAL_WORKTREE_ROOT: worktree },
      owner: "single-retry-owner",
      maxPublishAttempts: 3,
      retryBackoffMs: 10,
      recoveryBackoffMs: 40,
      sleep: async (milliseconds) => { delays.push(milliseconds); },
      publish: async () => {
        attempts += 1;
        if (attempts <= 3) throw new Error("temporarily unavailable");
      },
    });
    assert.equal(attempts, 4);
    assert.deepEqual(delays, [10, 20, 40]);
    const state = readAlexaPublicationState(worktree);
    assert.equal(state.dirty, false);
    assert.equal(state.worker, null);
  });
});

test("permanent reload failure has a bounded worker budget and reuses one generation artifact", {
  skip: containsLegacyRestart && "legacy entrypoint must be removed before importing it",
}, async () => {
  await withTemporaryWorktree(async ({ worktree }) => {
    recordAlexaVocGeneration({ worktree, source: "bounded-permanent-failure" });
    const claim = claimAlexaPublicationWorker(worktree, { token: "bounded-failure-owner", pid: process.pid });
    let builds = 0;
    let sleeps = 0;
    await assert.rejects(runner.runBackgroundRebuild({
      worktree,
      env: { AGENT_FORMAL_WORKTREE_ROOT: worktree },
      owner: claim.token,
      epoch: claim.epoch,
      maxPublishAttempts: 2,
      maxFailureBursts: 2,
      recoveryBackoffMs: 1,
      retryBackoffMs: 1,
      sleep: async () => {
        sleeps += 1;
        if (sleeps > 8) throw new Error("unbounded retry loop");
      },
      build: async () => {
        builds += 1;
        await fs.mkdir(path.join(worktree, "dist"), { recursive: true });
        await fs.writeFile(path.join(worktree, "dist", "index.txt"), "candidate", "utf8");
      },
      publish: (input) => publishManualWebUpdate({
        ...input,
        writeReloadRequest: () => { throw new Error("reload spool unavailable"); },
      }),
    }), /reload spool unavailable/);
    assert.equal(builds, 1);
    const artifacts = (await fs.readdir(path.join(worktree, "data", "web-runtime-artifacts")))
      .filter((name) => name.startsWith("publication-"));
    assert.equal(artifacts.length, 1);
    const state = readAlexaPublicationState(worktree);
    assert.equal(state.dirty, true);
    assert.equal(state.worker, null);
    assert.equal(state.failure.attempts, 4);
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
      runProcess: async (options) => {
        observed = options;
        const error = new Error("timed out");
        error.code = "ETIMEDOUT";
        throw error;
      },
    });
    await assert.rejects(build(), /build timed out/);
    assert.equal(observed.timeout, 1234);
    assert.equal(observed.cwd, worktree);
    assert.equal(observed.shell, false);
    assert.equal(observed.command, process.execPath);
    assert.deepEqual(observed.args, [path.join(worktree, "scripts", "run-stable-build.mjs")]);
  });
});

test("Windows build timeout terminates the explicitly spawned grandchild tree", {
  skip: process.platform !== "win32" && "Windows taskkill tree semantics",
}, async () => {
  await withTemporaryWorktree(async ({ worktree }) => {
    const pidFile = path.join(worktree, "grandchild.pid");
    const helper = path.resolve("tests", "helpers", "hanging-process-tree.mjs");
    const build = runner.createBoundedBuild({
      worktree,
      env: process.env,
      command: process.execPath,
      args: [helper, pidFile],
      timeoutMs: 750,
    });
    await assert.rejects(build(), /build timed out/);
    const grandchildPid = Number(await fs.readFile(pidFile, "utf8"));
    let alive = true;
    for (let attempt = 0; attempt < 20 && alive; attempt += 1) {
      try { process.kill(grandchildPid, 0); }
      catch (error) { if (error?.code === "ESRCH") alive = false; }
      if (alive) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(alive, false, `grandchild ${grandchildPid} survived tree timeout`);
  });
});
