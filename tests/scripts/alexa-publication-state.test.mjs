import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  beginAlexaPublicationGeneration,
  claimAlexaPublicationWorker,
  completeAlexaPublicationGeneration,
  failAlexaPublicationWorker,
  readAlexaPublicationState,
  recordAlexaVocGeneration,
} from "../../scripts/lib/alexa-publication-state.mjs";

async function withWorktree(run) {
  const worktree = await fs.mkdtemp(path.join(os.tmpdir(), "alexa-publication-state-"));
  try {
    await fs.mkdir(path.join(worktree, "app"), { recursive: true });
    await fs.mkdir(path.join(worktree, "scripts"), { recursive: true });
    await fs.writeFile(path.join(worktree, "package.json"), "{}", "utf8");
    await fs.writeFile(path.join(worktree, "app", "rufus-voc-data.ts"), "source-zero", "utf8");
    await fs.writeFile(path.join(worktree, "scripts", "run-background-rebuild.mjs"), "export {};", "utf8");
    await run(worktree);
  } finally {
    await fs.rm(worktree, { recursive: true, force: true });
  }
}

test("N concurrent requests merge into one durable dirty generation and one worker owner", async () => {
  await withWorktree(async (worktree) => {
    await recordAlexaVocGeneration({ worktree, source: "generation-one" });
    const claims = await Promise.all(Array.from({ length: 25 }, (_, index) =>
      claimAlexaPublicationWorker(worktree, { token: `worker-${index}`, pid: process.pid })
    ));
    assert.equal(claims.filter((claim) => claim.spawnNeeded).length, 1);
    const state = await readAlexaPublicationState(worktree);
    assert.equal(state.generation, 1);
    assert.equal(state.dirty, true);
    assert.equal(state.worker.token, claims.find((claim) => claim.spawnNeeded).token);
  });
});

test("A to B to A keeps monotonic generations and publishes the latest snapshot despite equal hashes", async () => {
  await withWorktree(async (worktree) => {
    const a1 = await recordAlexaVocGeneration({ worktree, source: "A" });
    await claimAlexaPublicationWorker(worktree, { token: "owner", pid: process.pid });
    const building = await beginAlexaPublicationGeneration(worktree, { token: "owner", pid: process.pid });
    const b = await recordAlexaVocGeneration({ worktree, source: "B" });
    const a2 = await recordAlexaVocGeneration({ worktree, source: "A" });
    assert.deepEqual([a1.generation, b.generation, a2.generation], [1, 2, 3]);
    assert.equal(a1.sourceHash, a2.sourceHash);
    assert.notEqual(a1.snapshotPath, a2.snapshotPath);
    assert.equal((await completeAlexaPublicationGeneration(worktree, {
      token: "owner", generation: building.generation,
    })).continue, true);
    const latest = await beginAlexaPublicationGeneration(worktree, { token: "owner", pid: process.pid });
    assert.equal(latest.generation, 3);
    assert.equal(latest.sourceHash, createHash("sha256").update("A").digest("hex"));
    assert.equal(await fs.readFile(latest.snapshotPath, "utf8"), "A");
  });
});

test("publication failure retains dirty generation and a later worker can compensate", async () => {
  await withWorktree(async (worktree) => {
    await recordAlexaVocGeneration({ worktree, source: "latest" });
    await claimAlexaPublicationWorker(worktree, { token: "failed", pid: process.pid });
    await beginAlexaPublicationGeneration(worktree, { token: "failed", pid: process.pid });
    await failAlexaPublicationWorker(worktree, { token: "failed" });
    let state = await readAlexaPublicationState(worktree);
    assert.equal(state.dirty, true);
    assert.equal(state.worker, null);
    assert.equal((await claimAlexaPublicationWorker(worktree, {
      token: "retry", pid: process.pid,
    })).spawnNeeded, true);
    const retry = await beginAlexaPublicationGeneration(worktree, { token: "retry", pid: process.pid });
    assert.equal(retry.generation, 1);
    state = await readAlexaPublicationState(worktree);
    assert.equal(state.worker.token, "retry");
  });
});

test("legacy and malformed lock files migrate without permanent EEXIST", async () => {
  await withWorktree(async (worktree) => {
    const legacy = path.join(worktree, "data", ".rebuild-lock.json");
    await fs.mkdir(path.dirname(legacy), { recursive: true });
    for (const value of [JSON.stringify({ startedAt: "2026-08-29T00:00:00.000Z" }), "{partial"]) {
      await fs.writeFile(legacy, value, "utf8");
      const claim = await claimAlexaPublicationWorker(worktree, {
        token: `migration-${value.length}`,
        pid: process.pid,
      });
      assert.equal(claim.spawnNeeded, true);
      await failAlexaPublicationWorker(worktree, { token: claim.token });
      await assert.rejects(fs.access(legacy), { code: "ENOENT" });
    }
  });
});

test("two stale-owner contenders elect one replacement and fence the former owner", async () => {
  await withWorktree(async (worktree) => {
    const start = new Date("2026-08-29T00:00:00.000Z");
    await recordAlexaVocGeneration({ worktree, source: "latest" });
    await claimAlexaPublicationWorker(worktree, {
      token: "stale", pid: 999_999_999, now: () => start,
    });
    const replacements = await Promise.all(["fresh-a", "fresh-b"].map((token) =>
      claimAlexaPublicationWorker(worktree, {
        token, pid: process.pid, now: () => new Date(start.getTime() + 60_000),
      })
    ));
    assert.equal(replacements.filter((replacement) => replacement.spawnNeeded).length, 1);
    const replacementToken = replacements.find((replacement) => replacement.spawnNeeded).token;
    await failAlexaPublicationWorker(worktree, { token: "stale" });
    assert.equal((await readAlexaPublicationState(worktree)).worker.token, replacementToken);
  });
});
