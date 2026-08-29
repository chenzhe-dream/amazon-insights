import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  quarantineLegacyAlexaPublicationLockSync,
  recordAlexaVocGeneration,
} from "../../scripts/lib/alexa-publication-state.mjs";
import {
  recoverAlexaPublicationWorkerOnStartup,
  startAlexaPublicationWorker,
} from "../../scripts/lib/alexa-publication-worker.mjs";

async function withWorktree(run) {
  const worktree = await fs.mkdtemp(path.join(os.tmpdir(), "alexa-publication-worker-"));
  try {
    await fs.mkdir(path.join(worktree, "app"), { recursive: true });
    await fs.mkdir(path.join(worktree, "scripts"), { recursive: true });
    await fs.writeFile(path.join(worktree, "package.json"), "{}", "utf8");
    await fs.writeFile(path.join(worktree, "app", "rufus-voc-data.ts"), "initial", "utf8");
    await fs.writeFile(path.join(worktree, "scripts", "run-background-rebuild.mjs"), "export {};", "utf8");
    await run(worktree);
  } finally {
    await fs.rm(worktree, { recursive: true, force: true });
  }
}

test("a PID-less legacy lock requires one explicit quiescent quarantine and never polls forever", async () => {
  await withWorktree(async (worktree) => {
    recordAlexaVocGeneration({ worktree, source: "latest" });
    const legacy = path.join(worktree, "data", ".rebuild-lock.json");
    await fs.writeFile(legacy, "{partial", "utf8");
    const scheduled = [];
    const spawned = [];
    const schedule = (callback, delay) => {
      scheduled.push({ callback, delay });
      return { unref() {} };
    };
    const spawn = (...args) => {
      spawned.push(args);
      return Object.assign(new EventEmitter(), { pid: 72_001, unref() {} });
    };

    const first = startAlexaPublicationWorker({
      worktree, spawn, schedule, legacyRetryMs: 25, token: "wake-owner",
    });
    const duplicate = startAlexaPublicationWorker({
      worktree, spawn, schedule, legacyRetryMs: 25, token: "wake-owner-duplicate",
    });
    assert.equal(first.started, false);
    assert.equal(first.manualRecovery, true);
    assert.equal(first.wakeScheduled, false);
    assert.equal(duplicate.wakeScheduled, false);
    assert.equal(scheduled.length, 0);
    assert.equal(spawned.length, 0);

    quarantineLegacyAlexaPublicationLockSync(worktree, { confirmQuiescent: true });
    startAlexaPublicationWorker({ worktree, spawn, schedule, legacyRetryMs: 25, token: "after-quarantine" });
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0][2].cwd, worktree);
    assert.equal(spawned[0][2].env.AGENT_FORMAL_WORKTREE_ROOT, worktree);
  });
});

test("startup recovery wakes one dirty generation after a dead legacy runner", async () => {
  await withWorktree(async (worktree) => {
    recordAlexaVocGeneration({ worktree, source: "latest-after-web-restart" });
    await fs.writeFile(path.join(worktree, "data", ".rebuild-lock.json"), JSON.stringify({
      pid: 999_999_999,
      startedAt: new Date().toISOString(),
    }), "utf8");
    const spawned = [];
    const spawn = (...args) => {
      spawned.push(args);
      return Object.assign(new EventEmitter(), { pid: 72_002, unref() {} });
    };
    const recovery = recoverAlexaPublicationWorkerOnStartup({ worktree, spawn, token: "startup-recovery" });
    assert.equal(recovery.started, true);
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0][2].cwd, worktree);
  });
});
