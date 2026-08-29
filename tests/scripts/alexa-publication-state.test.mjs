import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  beginAlexaPublicationGeneration,
  ALEXA_SNAPSHOT_SINGLE_MAX_BYTES,
  claimAlexaPublicationWorker,
  createLegacyAlexaPublicationLockRecord,
  legacyAlexaPublicationWorktreeIdentity,
  quarantineLegacyAlexaPublicationLockSync,
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

test("isolated process contenders elect exactly one durable worker owner", async () => {
  await withWorktree(async (worktree) => {
    recordAlexaVocGeneration({ worktree, source: "cross-process-source" });
    const helper = path.resolve("tests", "helpers", "alexa-publication-contender.mjs");
    const children = ["process-a", "process-b"].map((token) => spawn(process.execPath, [helper, worktree, token], {
      cwd: path.resolve("."),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }));
    try {
      const claims = await Promise.all(children.map((child) => new Promise((resolve, reject) => {
        let output = "";
        let errors = "";
        child.stderr.on("data", (chunk) => { errors += chunk; });
        child.stdout.on("data", (chunk) => {
          output += chunk;
          const newline = output.indexOf("\n");
          if (newline >= 0) {
            try { resolve(JSON.parse(output.slice(0, newline))); }
            catch (error) { reject(error); }
          }
        });
        child.once("error", reject);
        child.once("exit", (code) => {
          if (!output.includes("\n")) reject(new Error(`contender exited ${code}: ${errors}`));
        });
      })));
      assert.equal(claims.filter((claim) => claim.spawnNeeded).length, 1);
      const winner = claims.find((claim) => claim.spawnNeeded);
      assert.equal(readAlexaPublicationState(worktree).worker.token, winner.token);
    } finally {
      for (const child of children) child.kill("SIGTERM");
      await Promise.all(children.map((child) => new Promise((resolve) => {
        if (child.exitCode !== null) resolve();
        else child.once("exit", resolve);
      })));
    }
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

test("legacy handoff only quarantines a confirmed dead pid and never steals from a live pid", async () => {
  await withWorktree(async (worktree) => {
    const legacy = path.join(worktree, "data", ".rebuild-lock.json");
    await fs.mkdir(path.dirname(legacy), { recursive: true });
    await fs.writeFile(legacy, JSON.stringify({ pid: process.pid, startedAt: "2026-08-29T00:00:00.000Z" }), "utf8");
    const stale = new Date(Date.now() - 36 * 60 * 1_000);
    await fs.utimes(legacy, stale, stale);
    const live = claimAlexaPublicationWorker(worktree, { token: "live-contender", pid: process.pid });
    assert.equal(live.spawnNeeded, false);
    assert.equal(live.legacyBusy, true);
    assert.equal(live.manualRecovery, true);
    await fs.access(legacy);

    await fs.writeFile(legacy, JSON.stringify({ pid: 999_999_999, startedAt: "2026-08-29T00:00:00.000Z" }), "utf8");
    const dead = claimAlexaPublicationWorker(worktree, { token: "dead-successor", pid: process.pid });
    assert.equal(dead.spawnNeeded, true);
    await failAlexaPublicationWorker(worktree, { token: dead.token, epoch: dead.epoch });
    await assert.rejects(fs.access(legacy), { code: "ENOENT" });
    assert.ok((await fs.readdir(path.dirname(legacy))).some((name) => name.startsWith(".rebuild-lock.json.quarantine-")));
  });
});

test("unverifiable legacy handoff remains conservatively busy instead of using mtime to steal", async () => {
  await withWorktree(async (worktree) => {
    const legacy = path.join(worktree, "data", ".rebuild-lock.json");
    await fs.mkdir(path.dirname(legacy), { recursive: true });
    await fs.writeFile(legacy, "{partial", "utf8");
    const stale = new Date(Date.now() - 36 * 60 * 1_000);
    await fs.utimes(legacy, stale, stale);
    const claim = claimAlexaPublicationWorker(worktree, { token: "unknown-contender", pid: process.pid });
    assert.equal(claim.spawnNeeded, false);
    assert.equal(claim.legacyBusy, true);
    assert.equal(claim.manualRecovery, true);
    await fs.access(legacy);
    assert.equal(quarantineLegacyAlexaPublicationLockSync(worktree, { confirmQuiescent: true }), true);
    await assert.rejects(fs.access(legacy), { code: "ENOENT" });
  });
});

test("v2 legacy identity detects PID reuse while an exact live process remains busy", async () => {
  await withWorktree(async (worktree) => {
    recordAlexaVocGeneration({ worktree, source: "pid-reuse" });
    const legacy = path.join(worktree, "data", ".rebuild-lock.json");
    const record = createLegacyAlexaPublicationLockRecord({
      worktree,
      pid: 44_001,
      pidBirth: "2026-08-29T00:00:00.000Z",
      command: "node scripts/run-background-rebuild.mjs",
      now: () => new Date("2026-08-29T00:00:01.000Z"),
    });
    assert.equal(record.worktreeId, legacyAlexaPublicationWorktreeIdentity(worktree));
    await fs.writeFile(legacy, JSON.stringify(record), "utf8");
    const exact = claimAlexaPublicationWorker(worktree, {
      token: "exact-live",
      inspectLegacyProcess: () => ({
        alive: true,
        pidBirth: record.pidBirth,
        command: record.command,
        worktreeId: record.worktreeId,
      }),
    });
    assert.equal(exact.spawnNeeded, false);
    assert.equal(exact.legacyBusy, true);
    assert.equal(exact.manualRecovery, false);

    const reused = claimAlexaPublicationWorker(worktree, {
      token: "pid-reused",
      inspectLegacyProcess: () => ({
        alive: true,
        pidBirth: "2026-08-29T02:00:00.000Z",
        command: record.command,
        worktreeId: record.worktreeId,
      }),
    });
    assert.equal(reused.spawnNeeded, true);
    assert.ok((await fs.readdir(path.dirname(legacy))).some((name) => name.startsWith(".rebuild-lock.json.quarantine-")));
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

test("duplicate source hashes reuse one generation and snapshot retention stays bounded", async () => {
  await withWorktree(async (worktree) => {
    const first = recordAlexaVocGeneration({ worktree, source: "same-source" });
    for (let index = 0; index < 25; index += 1) {
      const duplicate = recordAlexaVocGeneration({ worktree, source: "same-source" });
      assert.equal(duplicate.generation, first.generation);
      assert.equal(duplicate.deduplicated, true);
    }
    for (let index = 0; index < 20; index += 1) {
      recordAlexaVocGeneration({ worktree, source: `distinct-source-${index}` });
    }
    const snapshots = await fs.readdir(path.join(worktree, "data", "alexa-publication-snapshots"));
    const sizes = await Promise.all(snapshots.map(async (name) =>
      (await fs.stat(path.join(worktree, "data", "alexa-publication-snapshots", name))).size
    ));
    assert.ok(snapshots.length <= 4, `retained ${snapshots.length} snapshots`);
    assert.ok(sizes.reduce((total, size) => total + size, 0) <= 8 * 1024 * 1024);
  });
});

test("an oversized immutable snapshot is rejected before state or disk generation changes", async () => {
  await withWorktree(async (worktree) => {
    assert.throws(() => recordAlexaVocGeneration({
      worktree,
      source: "x".repeat(ALEXA_SNAPSHOT_SINGLE_MAX_BYTES + 1),
    }), /snapshot source exceeds quota/);
    const state = readAlexaPublicationState(worktree);
    assert.equal(state.generation, 0);
    assert.equal(state.dirty, false);
    const snapshotDir = path.join(worktree, "data", "alexa-publication-snapshots");
    assert.deepEqual(await fs.readdir(snapshotDir).catch((error) => error.code === "ENOENT" ? [] : Promise.reject(error)), []);
  });
});

test("state recovery fails closed when the high-water snapshot is missing", async () => {
  await withWorktree(async (worktree) => {
    recordAlexaVocGeneration({ worktree, source: "generation-one" });
    const second = recordAlexaVocGeneration({ worktree, source: "generation-two" });
    await fs.rm(second.snapshotPath);
    assert.throws(() => readAlexaPublicationState(worktree), /recovery needed/);
  });
});

test("state recovery repairs logical inconsistency from the exact valid high-water snapshot", async () => {
  await withWorktree(async (worktree) => {
    recordAlexaVocGeneration({ worktree, source: "generation-one" });
    const recovered = readAlexaPublicationState(worktree);
    const statePath = path.join(worktree, "data", "alexa-publication-state.json");
    await fs.writeFile(statePath, JSON.stringify({
      ...recovered,
      buildingGeneration: recovered.generation + 1,
      worker: null,
    }), "utf8");
    const repaired = readAlexaPublicationState(worktree);
    assert.equal(repaired.generation, 1);
    assert.equal(repaired.buildingGeneration, null);
    assert.equal(repaired.worker, null);
    assert.equal(repaired.dirty, true);
    assert.equal(await fs.readFile(path.join(worktree, "data", "alexa-publication-snapshots", repaired.snapshotFile), "utf8"), "generation-one");
  });
});

test("state recovery during building G preserves the valid G+1 snapshot content and hash", async () => {
  await withWorktree(async (worktree) => {
    recordAlexaVocGeneration({ worktree, source: "generation-one" });
    const claim = claimAlexaPublicationWorker(worktree, { token: "building-owner", pid: process.pid });
    beginAlexaPublicationGeneration(worktree, { token: claim.token, epoch: claim.epoch, pid: process.pid });
    const latest = recordAlexaVocGeneration({ worktree, source: "generation-two-latest" });
    await fs.writeFile(path.join(worktree, "data", "alexa-publication-state.json"), "{truncated", "utf8");

    const recovered = readAlexaPublicationState(worktree);
    assert.equal(recovered.generation, 2);
    assert.equal(recovered.sourceHash, latest.sourceHash);
    assert.equal(
      await fs.readFile(path.join(worktree, "data", "alexa-publication-snapshots", recovered.snapshotFile), "utf8"),
      "generation-two-latest",
    );
    assert.equal(recovered.worker, null);
    assert.equal(recovered.buildingGeneration, null);
    assert.equal(recovered.dirty, true);
  });
});

test("state recovery rejects a missing building-generation snapshot even when the latest snapshot is valid", async () => {
  await withWorktree(async (worktree) => {
    recordAlexaVocGeneration({ worktree, source: "generation-one-building" });
    const claim = claimAlexaPublicationWorker(worktree, { token: "missing-building", pid: process.pid });
    beginAlexaPublicationGeneration(worktree, { token: claim.token, epoch: claim.epoch, pid: process.pid });
    recordAlexaVocGeneration({ worktree, source: "generation-two-latest" });
    const before = readAlexaPublicationState(worktree);
    const snapshotDirectory = path.join(worktree, "data", "alexa-publication-snapshots");
    const buildingFile = (await fs.readdir(snapshotDirectory)).find((name) => name.startsWith("generation-1-"));
    await fs.rm(path.join(snapshotDirectory, buildingFile));

    const recovered = readAlexaPublicationState(worktree);
    assert.equal(recovered.generation, 2);
    assert.equal(recovered.sourceHash, before.sourceHash);
    assert.equal(recovered.worker, null);
    assert.equal(recovered.buildingGeneration, null);
    assert.equal(recovered.dirty, true);
  });
});

test("state validation rejects unreachable dirty worker building and lease combinations", async () => {
  await withWorktree(async (worktree) => {
    recordAlexaVocGeneration({ worktree, source: "valid-recovery-source" });
    const statePath = path.join(worktree, "data", "alexa-publication-state.json");
    const valid = readAlexaPublicationState(worktree);
    const worker = {
      token: "invalid-owner",
      pid: process.pid,
      epoch: 1,
      heartbeatAt: "2026-08-29T01:00:00.000Z",
      leaseExpiresAt: "2026-08-29T00:59:00.000Z",
    };
    const cases = [
      { ...valid, dirty: false, worker: { ...worker, leaseExpiresAt: "2026-08-29T01:20:00.000Z" }, epoch: 1 },
      { ...valid, dirty: false, buildingGeneration: 1, worker: { ...worker, leaseExpiresAt: "2026-08-29T01:20:00.000Z" }, epoch: 1 },
      { ...valid, dirty: true, worker, epoch: 1 },
      { ...valid, generation: 0, dirty: true, worker: { ...worker, leaseExpiresAt: "2026-08-29T01:20:00.000Z" }, epoch: 1 },
      { ...valid, worker: { ...worker, leaseExpiresAt: "2026-08-29T01:21:00.000Z" }, epoch: 1 },
      { ...valid, dirty: false, failure: { message: "failed", attempts: 1, at: "2026-08-29T01:00:00.000Z" } },
    ];
    for (const malformed of cases) {
      await fs.writeFile(statePath, JSON.stringify(malformed), "utf8");
      const recovered = readAlexaPublicationState(worktree);
      assert.equal(recovered.generation, 1);
      assert.equal(recovered.dirty, true);
      assert.equal(recovered.worker, null);
      assert.equal(recovered.buildingGeneration, null);
    }
  });
});

test("a recent legacy runner lock blocks new ownership until the safe handoff window", async () => {
  await withWorktree(async (worktree) => {
    recordAlexaVocGeneration({ worktree, source: "legacy-handoff" });
    const legacy = path.join(worktree, "data", ".rebuild-lock.json");
    await fs.writeFile(legacy, JSON.stringify({ version: 1, owner: "legacy", startedAt: new Date().toISOString() }), "utf8");
    const blocked = claimAlexaPublicationWorker(worktree, { token: "new-owner", pid: process.pid });
    assert.equal(blocked.spawnNeeded, false);
    assert.equal(blocked.legacyBusy, true);
    await fs.access(legacy);
  });
});
