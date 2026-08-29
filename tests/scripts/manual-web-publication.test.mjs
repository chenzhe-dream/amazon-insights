import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  manualWebPublicationDescriptor,
  publishManualWebUpdate,
} from "../../scripts/lib/manual-web-publication.mjs";
import { createWebArtifactStore } from "../../scripts/lib/web-artifact-store.mjs";
import {
  beginAlexaPublicationGeneration,
  claimAlexaPublicationWorker,
  recordAlexaVocGeneration,
} from "../../scripts/lib/alexa-publication-state.mjs";

test("manual publication identity binds generation and exact snapshot hash", () => {
  const artifactId = "a".repeat(64);
  const hash = createHash("sha256").update("exact-voc-source").digest("hex");
  const descriptor = manualWebPublicationDescriptor({ artifactId, generation: 7, sourceHash: hash });
  assert.match(descriptor.jobId, /^manual-alexa-voc-g7-/);
  assert.equal(descriptor.jobVersion, 7);
  assert.deepEqual(descriptor.stageContentHashes, { alexa_voc: hash });
});

test("manual publication rejects a projection or snapshot that differs from the claimed build input", async () => {
  const worktree = await fs.mkdtemp(path.join(os.tmpdir(), "manual-snapshot-mismatch-"));
  try {
    await fs.mkdir(path.join(worktree, "app"), { recursive: true });
    const snapshotPath = path.join(worktree, "snapshot.ts");
    await fs.writeFile(path.join(worktree, "app", "rufus-voc-data.ts"), "projection", "utf8");
    await fs.writeFile(snapshotPath, "snapshot", "utf8");
    await assert.rejects(publishManualWebUpdate({
      worktree,
      resolveWorktree: () => worktree,
      env: { WEB_PORT: "31900" },
      generation: 1,
      sourceHash: createHash("sha256").update("snapshot").digest("hex"),
      snapshotPath,
      build: async () => assert.fail("mismatched input must not build"),
    }), /snapshot mismatch/);
  } finally {
    await fs.rm(worktree, { recursive: true, force: true });
  }
});

test("a fenced reload releases only its reservation so the unreferenced artifact is quota-reclaimable", async () => {
  const worktree = await fs.mkdtemp(path.join(os.tmpdir(), "manual-reservation-release-"));
  try {
    const source = "export const rufusVocData = { generation: 1 };";
    await fs.mkdir(path.join(worktree, "app"), { recursive: true });
    await fs.mkdir(path.join(worktree, "scripts"), { recursive: true });
    await fs.writeFile(path.join(worktree, "package.json"), "{}", "utf8");
    await fs.writeFile(path.join(worktree, "scripts", "run-background-rebuild.mjs"), "export {};", "utf8");
    recordAlexaVocGeneration({ worktree, source });
    const claim = claimAlexaPublicationWorker(worktree, { token: "reservation-owner", pid: process.pid });
    const building = beginAlexaPublicationGeneration(worktree, {
      token: "reservation-owner", epoch: claim.epoch, pid: process.pid,
    });
    const artifactId = "9".repeat(64);
    await assert.rejects(publishManualWebUpdate({
      worktree,
      env: { AGENT_FORMAL_WORKTREE_ROOT: worktree, WEB_PORT: "31900" },
      ...building,
      token: "reservation-owner",
      createArtifactId: () => artifactId,
      writeReloadRequest: () => { throw new Error("reload writer failed before reference"); },
      build: async () => {
        await fs.mkdir(path.join(worktree, "dist"), { recursive: true });
        await fs.writeFile(path.join(worktree, "dist", "index.html"), "candidate", "utf8");
      },
    }), /reload writer failed/i);
    const reservations = path.join(worktree, "data", "web-runtime-artifacts", ".reservations");
    assert.deepEqual(await fs.readdir(reservations), []);
    const candidate = path.join(worktree, "data", "web-runtime-artifacts", `publication-${artifactId}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await fs.mkdir(path.join(worktree, "data", "web-runtime-artifacts", `publication-${"8".repeat(64)}`));
    await createWebArtifactStore({ worktree, maxSnapshots: 1 }).prune();
    await assert.rejects(fs.access(candidate), (error) => error?.code === "ENOENT");
  } finally {
    await fs.rm(worktree, { recursive: true, force: true });
  }
});

test("reservation cleanup failure is awaited and attached without replacing the publication error", async () => {
  const worktree = await fs.mkdtemp(path.join(os.tmpdir(), "manual-reservation-cleanup-error-"));
  try {
    const source = "export const rufusVocData = { cleanup: true };";
    await fs.mkdir(path.join(worktree, "app"), { recursive: true });
    const generation = recordAlexaVocGeneration({ worktree, source });
    const claim = claimAlexaPublicationWorker(worktree, { token: "cleanup-owner", pid: process.pid });
    const building = beginAlexaPublicationGeneration(worktree, {
      token: "cleanup-owner", epoch: claim.epoch, pid: process.pid,
    });
    let cleanupFinished = false;
    let observed;
    try {
      await publishManualWebUpdate({
        worktree, resolveWorktree: () => worktree, env: { WEB_PORT: "31900" },
        ...generation, ...building, token: "fenced-cleanup-owner",
        createArtifactId: () => "7".repeat(64),
        publishArtifact: async () => ({ reservationToken: "00000000-0000-0000-0000-000000000000" }),
        finalizeReservation: async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          cleanupFinished = true;
          throw new Error("reservation cleanup lock timeout");
        },
      });
    } catch (error) { observed = error; }
    assert.match(observed.message, /worker was fenced/i);
    assert.equal(cleanupFinished, true);
    assert.match(observed.cause.message, /cleanup lock timeout/i);
  } finally {
    await fs.rm(worktree, { recursive: true, force: true });
  }
});

test("real artifact and reload modules publish the exact generation snapshot to formal 31900", async () => {
  const worktree = await fs.mkdtemp(path.join(os.tmpdir(), "manual-integration-"));
  try {
    const source = "export const rufusVocData = { generation: 9 };";
    await fs.mkdir(path.join(worktree, "app"), { recursive: true });
    await fs.mkdir(path.join(worktree, "scripts"), { recursive: true });
    await fs.writeFile(path.join(worktree, "package.json"), "{}", "utf8");
    await fs.writeFile(path.join(worktree, "scripts", "run-background-rebuild.mjs"), "export {};", "utf8");
    const projection = path.join(worktree, "app", "rufus-voc-data.ts");
    await fs.writeFile(projection, "generation-zero", "utf8");
    for (let generation = 1; generation <= 9; generation += 1) {
      recordAlexaVocGeneration({ worktree, source: generation === 9 ? source : `generation-${generation}` });
    }
    const claim = claimAlexaPublicationWorker(worktree, { token: "integration-owner", pid: process.pid });
    const building = beginAlexaPublicationGeneration(worktree, {
      token: "integration-owner", epoch: claim.epoch, pid: process.pid,
    });
    const artifactId = "d".repeat(64);
    const hash = createHash("sha256").update(source).digest("hex");
    const result = await publishManualWebUpdate({
      worktree,
      env: { AGENT_FORMAL_WORKTREE_ROOT: worktree, WEB_HOST: "0.0.0.0", WEB_PORT: "31900" },
      token: "integration-owner",
      ...building,
      createArtifactId: () => artifactId,
      build: async () => {
        await fs.mkdir(path.join(worktree, "dist"), { recursive: true });
        await fs.writeFile(path.join(worktree, "dist", "index.html"), "lightweight-build", "utf8");
        await fs.writeFile(path.join(worktree, "dist", "voc-source.txt"), await fs.readFile(projection, "utf8"), "utf8");
      },
    });
    const candidate = path.join(worktree, "data", "web-runtime-artifacts", `publication-${artifactId}`);
    const manifest = JSON.parse(await fs.readFile(path.join(candidate, "web-artifact.json"), "utf8"));
    const pendingDir = path.join(worktree, "data", "web-reload-requests", "pending");
    const pendingNames = await fs.readdir(pendingDir);
    assert.equal(pendingNames.length, 1);
    const pending = JSON.parse(await fs.readFile(path.join(pendingDir, pendingNames[0]), "utf8"));
    const expectedWorktreeId = createHash("sha256").update(path.resolve(worktree)).digest("hex");
    assert.equal(await fs.readFile(path.join(candidate, "voc-source.txt"), "utf8"), source);
    assert.equal(manifest.jobVersion, 9);
    assert.equal(manifest.stageContentHashes.alexa_voc, hash);
    assert.equal(pending.jobVersion, 9);
    assert.equal(pending.stageContentHashes.alexa_voc, hash);
    assert.deepEqual(pending.target, { worktreeId: expectedWorktreeId, webHost: "0.0.0.0", webPort: 31900 });
    assert.equal(result.sourceHash, hash);
    assert.equal(result.generation, 9);
  } finally {
    await fs.rm(worktree, { recursive: true, force: true });
  }
});

test("an expired live owner fenced by takeover cannot write a stale reload request", async () => {
  const worktree = await fs.mkdtemp(path.join(os.tmpdir(), "manual-fenced-reload-"));
  try {
    await fs.mkdir(path.join(worktree, "app"), { recursive: true });
    await fs.mkdir(path.join(worktree, "scripts"), { recursive: true });
    await fs.writeFile(path.join(worktree, "package.json"), "{}", "utf8");
    await fs.writeFile(path.join(worktree, "app", "rufus-voc-data.ts"), "initial", "utf8");
    await fs.writeFile(path.join(worktree, "scripts", "run-background-rebuild.mjs"), "export {};", "utf8");
    recordAlexaVocGeneration({ worktree, source: "fenced-source" });
    const started = new Date("2026-08-29T00:00:00.000Z");
    const old = claimAlexaPublicationWorker(worktree, { token: "old-owner", pid: process.pid, now: () => started });
    const building = beginAlexaPublicationGeneration(worktree, {
      token: "old-owner", epoch: old.epoch, pid: process.pid, now: () => started,
    });
    let reloadWrites = 0;
    await assert.rejects(publishManualWebUpdate({
      worktree,
      env: { AGENT_FORMAL_WORKTREE_ROOT: worktree, WEB_PORT: "31900" },
      token: "old-owner",
      epoch: old.epoch,
      ...building,
      createArtifactId: () => "e".repeat(64),
      build: async () => {},
      publishArtifact: async () => {
        const replacement = claimAlexaPublicationWorker(worktree, {
          token: "new-owner",
          pid: process.pid,
          now: () => new Date(started.getTime() + 21 * 60 * 1_000),
        });
        assert.equal(replacement.spawnNeeded, true);
      },
      writeReloadRequest: () => {
        reloadWrites += 1;
        return { id: "f".repeat(64) };
      },
    }), /worker was fenced/);
    assert.equal(reloadWrites, 0);
  } finally {
    await fs.rm(worktree, { recursive: true, force: true });
  }
});
