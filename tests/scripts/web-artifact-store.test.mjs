import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_WEB_BUILD_LOCK_WAIT_MS,
  createWebArtifactStore,
  clearWebArtifactManualRecoverySync,
  createWebPublicationArtifactId,
  finalizeWebArtifactReservation,
  publishImmutableWebArtifact,
  writeCurrentWebArtifact,
} from "../../scripts/lib/web-artifact-store.mjs";

const jobId = "job-safe-123";
const jobVersion = 9;
const stageContentHashes = Object.freeze({
  category: "b".repeat(64),
  keywords: "c".repeat(64),
});

async function withArtifactRoot(run) {
  const worktree = await mkdtemp(path.join(os.tmpdir(), "web-artifact-store-"));
  const artifactRoot = path.join(worktree, "dist");
  try {
    await run({ worktree, artifactRoot });
  } finally {
    await rm(worktree, { recursive: true, force: true });
  }
}

test("a build artifact identity is bounded and recovered from the dist manifest", async () => {
  await withArtifactRoot(async ({ worktree, artifactRoot }) => {
    const artifactId = createWebPublicationArtifactId();
    assert.match(artifactId, /^[a-f0-9]{64}$/);

    await writeCurrentWebArtifact({ worktree, artifactId, jobId, jobVersion, stageContentHashes });

    assert.deepEqual(createWebArtifactStore({ worktree, artifactRoot }).current(), {
      id: artifactId,
      root: artifactRoot,
      jobId,
      jobVersion,
      stageContentHashes,
    });
  });
});

test("manual Alexa stage hashes are accepted while unknown stages are rejected", async () => {
  await withArtifactRoot(async ({ worktree, artifactRoot }) => {
    const artifactId = "f".repeat(64);
    const alexaStageContentHashes = { alexa_voc: "e".repeat(64) };

    await writeCurrentWebArtifact({
      worktree,
      artifactId,
      jobId,
      jobVersion,
      stageContentHashes: alexaStageContentHashes,
    });
    assert.deepEqual(createWebArtifactStore({ worktree, artifactRoot }).current().stageContentHashes, alexaStageContentHashes);

    await assert.rejects(
      writeCurrentWebArtifact({
        worktree,
        artifactId,
        jobId,
        jobVersion,
        stageContentHashes: { unknown_stage: "e".repeat(64) },
      }),
      /Invalid Web artifact manifest/,
    );
  });
});

test("a known-good v1 manifest remains readable and unchanged", async () => {
  await withArtifactRoot(async ({ worktree, artifactRoot }) => {
    const artifactId = "a".repeat(64);
    const manifest = path.join(artifactRoot, "web-artifact.json");
    const serialized = JSON.stringify({ version: 1, artifactId });
    await mkdir(artifactRoot, { recursive: true });
    await writeFile(path.join(artifactRoot, "index.html"), "legacy artifact");
    await writeFile(manifest, serialized);

    const store = createWebArtifactStore({ worktree, artifactRoot });
    assert.deepEqual(store.current(), { id: artifactId, root: artifactRoot });
    await store.snapshot();
    assert.equal(await readFile(manifest, "utf8"), serialized);
    assert.equal(await readFile(path.join(artifactRoot, "index.html"), "utf8"), "legacy artifact");
  });
});

test("successive manifest replacements remain atomic on Windows filesystems", async () => {
  await withArtifactRoot(async ({ worktree, artifactRoot }) => {
    const first = "a".repeat(64);
    const second = "b".repeat(64);

    await writeCurrentWebArtifact({ worktree, artifactId: first, jobId, jobVersion, stageContentHashes });
    await writeCurrentWebArtifact({ worktree, artifactId: second, jobId, jobVersion, stageContentHashes });

    assert.deepEqual(createWebArtifactStore({ worktree, artifactRoot }).current(), {
      id: second,
      root: artifactRoot,
      jobId,
      jobVersion,
      stageContentHashes,
    });
    assert.deepEqual(await readdir(artifactRoot), ["web-artifact.json"]);
  });
});

test("snapshots preserve their path identity and supplied publication identity", async () => {
  await withArtifactRoot(async ({ worktree, artifactRoot }) => {
    await writeFile(path.join(worktree, "source.txt"), "artifact source");
    await writeCurrentWebArtifact({ worktree, artifactId: "c".repeat(64), jobId, jobVersion, stageContentHashes });
    await writeFile(path.join(artifactRoot, "index.html"), "artifact");

    const snapshot = await createWebArtifactStore({ worktree }).snapshot({
      id: "c".repeat(64),
      root: artifactRoot,
      publicationArtifactId: "d".repeat(64),
      jobId,
      jobVersion,
      stageContentHashes,
    });

    assert.match(snapshot.id, /^snapshot-\d+-[a-f0-9-]+$/);
    assert.equal(snapshot.publicationArtifactId, "d".repeat(64));
    assert.equal(snapshot.jobId, jobId);
    assert.equal(snapshot.jobVersion, jobVersion);
    assert.deepEqual(snapshot.stageContentHashes, stageContentHashes);
  });
});

test("published candidates are immutable and resolved by the exact request artifact", async () => {
  await withArtifactRoot(async ({ worktree, artifactRoot }) => {
    const first = "a".repeat(64);
    const second = "b".repeat(64);
    await publishImmutableWebArtifact({
      worktree, artifactId: first, jobId, jobVersion, stageContentHashes,
      build: async () => {
        await mkdir(artifactRoot, { recursive: true });
        await writeFile(path.join(artifactRoot, "index.html"), "artifact A");
      },
    });
    await writeFile(path.join(artifactRoot, "index.html"), "tampered mutable dist");
    await publishImmutableWebArtifact({
      worktree, artifactId: second, jobId, jobVersion: jobVersion + 1, stageContentHashes,
      build: async () => { await writeFile(path.join(artifactRoot, "index.html"), "artifact B"); },
    });

    const store = createWebArtifactStore({ worktree });
    const candidateA = store.candidate({ artifactId: first });
    const candidateB = store.candidate({ artifactId: second });
    assert.equal(await (await import("node:fs/promises")).readFile(path.join(candidateA.root, "index.html"), "utf8"), "artifact A");
    assert.equal(await (await import("node:fs/promises")).readFile(path.join(candidateB.root, "index.html"), "utf8"), "artifact B");
    assert.notEqual(candidateA.root, artifactRoot);
    assert.notEqual(candidateA.root, candidateB.root);
  });
});

test("publication pruning retains referenced roots and removes stopped or orphaned candidates", async () => {
  await withArtifactRoot(async ({ worktree, artifactRoot }) => {
    const ids = ["a".repeat(64), "b".repeat(64), "c".repeat(64)];
    for (const [index, id] of ids.entries()) {
      const artifact = await publishImmutableWebArtifact({
        worktree, artifactId: id, jobId, jobVersion: jobVersion + index, stageContentHashes,
        build: async () => {
          await mkdir(artifactRoot, { recursive: true });
          await writeFile(path.join(artifactRoot, "index.html"), `artifact ${index}`);
        },
      });
      await finalizeWebArtifactReservation({
        worktree, artifactId: id, reservationToken: artifact.reservationToken,
      });
    }
    await writeCurrentWebArtifact({
      worktree, artifactId: ids[1], jobId, jobVersion: jobVersion + 1, stageContentHashes,
    });
    const store = createWebArtifactStore({ worktree, maxSnapshots: 1 });
    const knownGoodA = store.candidate({ artifactId: ids[0] });
    const pendingB = store.candidate({ artifactId: ids[1] });

    await store.prune({ protectedArtifacts: [knownGoodA, pendingB] });
    let names = await readdir(path.join(worktree, "data", "web-runtime-artifacts"));
    assert.ok(names.includes(`publication-${ids[0]}`));
    assert.ok(names.includes(`publication-${ids[1]}`));
    assert.equal(names.includes(`publication-${ids[2]}`), false);
    assert.equal(store.current().id, ids[1]);
    assert.equal(store.candidate({ artifactId: ids[1] }).root, pendingB.root);

    await store.prune({ protectedArtifacts: [pendingB] });
    names = await readdir(path.join(worktree, "data", "web-runtime-artifacts"));
    assert.equal(names.includes(`publication-${ids[0]}`), false);
    assert.ok(names.includes(`publication-${ids[1]}`));
  });
});

test("a live build lock is not stolen and publication recovers after its owner crashes", async () => {
  await withArtifactRoot(async ({ worktree, artifactRoot }) => {
    const second = "b".repeat(64);
    const fixture = path.resolve("tests/fixtures/hold-interprocess-lock.mjs");
    const lockPath = path.join(worktree, "data", "web-runtime-artifacts", ".build-artifact.lock");
    const child = spawn(process.execPath, [fixture, lockPath], {
      cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    try {
      await new Promise((resolve, reject) => {
        let stderr = "";
        const timer = setTimeout(() => reject(new Error(`lock owner did not start; pid=${child.pid}; exit=${child.exitCode}: ${stderr}`)), 5_000);
        child.stderr.on("data", (chunk) => { stderr += String(chunk); });
        child.once("error", reject);
        child.stdout.once("data", () => { clearTimeout(timer); resolve(); });
        child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`lock owner exited ${code}: ${stderr}`)); });
      });
      await assert.rejects(publishImmutableWebArtifact({
        worktree, artifactId: second, jobId, jobVersion: jobVersion + 1, stageContentHashes,
        buildLockWaitMs: 3,
        buildLockRetryMs: 1,
        build: async () => undefined,
      }), /Timed out acquiring interprocess lock/);
      assert.equal(child.exitCode, null);

      const crashed = once(child, "exit");
      child.kill("SIGKILL");
      await crashed;
      await publishImmutableWebArtifact({
        worktree, artifactId: second, jobId, jobVersion: jobVersion + 1, stageContentHashes,
        build: async () => {
          await mkdir(artifactRoot, { recursive: true });
          await writeFile(path.join(artifactRoot, "index.html"), "recovered build");
        },
      });
      const candidate = createWebArtifactStore({ worktree }).candidate({ artifactId: second });
      assert.equal(await (await import("node:fs/promises")).readFile(path.join(candidate.root, "index.html"), "utf8"), "recovered build");
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
      }
    }
  });
});

test("a second publication waits beyond the former five-second build lock window without overlapping", async () => {
  assert.ok(DEFAULT_WEB_BUILD_LOCK_WAIT_MS >= 15 * 60 * 1_000);
  await withArtifactRoot(async ({ worktree, artifactRoot }) => {
    let activeBuilds = 0;
    let maximumActiveBuilds = 0;
    let releaseFirst;
    const firstHeld = new Promise((resolve) => { releaseFirst = resolve; });
    let announceFirst;
    const firstStarted = new Promise((resolve) => { announceFirst = resolve; });
    let secondStarted = false;
    const first = publishImmutableWebArtifact({
      worktree, artifactId: "a".repeat(64), jobId, jobVersion, stageContentHashes,
      build: async () => {
        activeBuilds += 1;
        maximumActiveBuilds = Math.max(maximumActiveBuilds, activeBuilds);
        announceFirst();
        await firstHeld;
        await mkdir(artifactRoot, { recursive: true });
        await writeFile(path.join(artifactRoot, "index.html"), "first build");
        activeBuilds -= 1;
      },
    });
    await firstStarted;
    const second = publishImmutableWebArtifact({
      worktree, artifactId: "b".repeat(64), jobId, jobVersion: jobVersion + 1, stageContentHashes,
      build: async () => {
        secondStarted = true;
        activeBuilds += 1;
        maximumActiveBuilds = Math.max(maximumActiveBuilds, activeBuilds);
        await writeFile(path.join(artifactRoot, "index.html"), "second build");
        activeBuilds -= 1;
      },
    });
    let secondFailure;
    void second.catch((error) => { secondFailure = error; });
    try {
      await new Promise((resolve) => setTimeout(resolve, 5_100));
      assert.equal(secondFailure, undefined);
      assert.equal(secondStarted, false);
    } finally {
      releaseFirst();
    }
    await Promise.all([first, second]);
    assert.equal(maximumActiveBuilds, 1);
    assert.equal(secondStarted, true);
  });
});

test("malformed, unknown, or out-of-worktree artifact manifests fail closed", async () => {
  await withArtifactRoot(async ({ worktree, artifactRoot }) => {
    const manifest = path.join(artifactRoot, "web-artifact.json");
    await mkdir(artifactRoot, { recursive: true });
    await writeFile(manifest, JSON.stringify({ artifactId: "wrong" }));
    assert.throws(() => createWebArtifactStore({ worktree, artifactRoot }).current(), /Invalid Web artifact manifest/);

    await writeFile(manifest, JSON.stringify({ version: 1, artifactId: "a".repeat(64), root: "C:/outside" }));
    assert.throws(() => createWebArtifactStore({ worktree, artifactRoot }).current(), /Invalid Web artifact manifest/);
  });
});

test("artifact writer rejects a dist junction that resolves outside its worktree", async () => {
  await withArtifactRoot(async ({ worktree, artifactRoot }) => {
    const externalRoot = await mkdtemp(path.join(os.tmpdir(), "web-artifact-external-"));
    try {
      await symlink(externalRoot, artifactRoot, "junction");
      await assert.rejects(
        writeCurrentWebArtifact({ worktree, artifactId: "e".repeat(64), jobId, jobVersion, stageContentHashes }),
        /Invalid Web artifact path/,
      );
      await assert.rejects(
        writeFile(path.join(externalRoot, "web-artifact.json"), "", { flag: "r" }),
        /ENOENT/,
      );
    } finally {
      await rm(externalRoot, { recursive: true, force: true });
    }
  });
});

test("artifact reservation and the shared build lock fence rename from concurrent prune until pending can reference it", async () => {
  await withArtifactRoot(async ({ worktree, artifactRoot }) => {
    const ids = ["1".repeat(64), "2".repeat(64), "3".repeat(64)];
    const published = [];
    for (const [index, artifactId] of ids.slice(0, 2).entries()) {
      const artifact = await publishImmutableWebArtifact({
        worktree, artifactId, jobId, jobVersion: jobVersion + index, stageContentHashes,
        build: async () => {
          await mkdir(artifactRoot, { recursive: true });
          await writeFile(path.join(artifactRoot, "index.html"), `artifact ${index}`);
        },
      });
      await finalizeWebArtifactReservation({
        worktree, artifactId, reservationToken: artifact.reservationToken,
      });
      published.push(artifact);
    }

    let renamed;
    let continuePublish;
    const renamedReached = new Promise((resolve) => { renamed = resolve; });
    const publishGate = new Promise((resolve) => { continuePublish = resolve; });
    const newestPromise = publishImmutableWebArtifact({
      worktree, artifactId: ids[2], jobId, jobVersion: jobVersion + 2, stageContentHashes,
      build: async () => { await writeFile(path.join(artifactRoot, "index.html"), "artifact 2"); },
      afterArtifactRename: async () => { renamed(); await publishGate; },
    });
    await renamedReached;

    let pruneFinished = false;
    const store = createWebArtifactStore({ worktree, maxSnapshots: 2 });
    const prunePromise = store.prune({ protectedArtifacts: published }).then(() => { pruneFinished = true; });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(pruneFinished, false, "prune must wait for the publisher's shared artifact lock");
    continuePublish();
    const newest = await newestPromise;
    await prunePromise;
    assert.match(newest.reservationToken, /^[a-f0-9-]{36}$/);
    const names = await readdir(path.join(worktree, "data", "web-runtime-artifacts"));
    assert.ok(names.includes(`publication-${ids[0]}`));
    assert.ok(names.includes(`publication-${ids[1]}`));
    assert.ok(names.includes(`publication-${ids[2]}`));
  });
});

test("idempotent publishers hold independent reservations until each durable reference is established", async () => {
  await withArtifactRoot(async ({ worktree, artifactRoot }) => {
    const artifactId = "4".repeat(64);
    const publish = () => publishImmutableWebArtifact({
      worktree,
      artifactId,
      jobId,
      jobVersion,
      stageContentHashes,
      build: async () => {
        await mkdir(artifactRoot, { recursive: true });
        await writeFile(path.join(artifactRoot, "index.html"), "same artifact", "utf8");
      },
    });
    const first = await publish();
    const second = await publish();
    assert.notEqual(first.reservationToken, second.reservationToken);
    assert.equal(await finalizeWebArtifactReservation({
      worktree, artifactId, reservationToken: first.reservationToken,
    }), true);
    assert.equal(await finalizeWebArtifactReservation({
      worktree, artifactId, reservationToken: second.reservationToken,
    }), true);
  });
});

test("an unconfirmed Windows process tree fences later artifact builds for manual recovery", async () => {
  await withArtifactRoot(async ({ worktree, artifactRoot }) => {
    const processTreeError = new Error("Windows process tree termination could not be confirmed");
    processTreeError.code = "EPROCESSTREE";
    processTreeError.treeIdentity = {
      pid: 999_999_999,
      pidBirth: "2026-08-29T00:00:00.000Z",
      command: "node fake-build.mjs",
      worktreeId: createHash("sha256").update(path.resolve(worktree)).digest("hex"),
    };
    let laterBuilds = 0;
    await assert.rejects(publishImmutableWebArtifact({
      worktree,
      artifactId: "8".repeat(64),
      jobId,
      jobVersion,
      stageContentHashes,
      build: async () => { throw new Error("build failed", { cause: processTreeError }); },
    }), /build failed/);
    const marker = JSON.parse(await readFile(path.join(
      worktree, "data", "web-runtime-artifacts", "manual-recovery.json",
    ), "utf8"));
    assert.equal(marker.reason, "process-tree-termination-unconfirmed");
    assert.deepEqual(marker.treeIdentity, processTreeError.treeIdentity);

    await assert.rejects(publishImmutableWebArtifact({
      worktree,
      artifactId: "9".repeat(64),
      jobId,
      jobVersion: jobVersion + 1,
      stageContentHashes,
      build: async () => { laterBuilds += 1; },
    }), /manual recovery/);
    assert.equal(laterBuilds, 0);
    assert.equal(await readdir(path.join(worktree, "data", "web-runtime-artifacts", ".reservations")).then(
      (names) => names.filter((name) => name.endsWith(".json")).length,
    ), 0);
    await assert.rejects(createWebArtifactStore({ worktree, artifactRoot }).prune(), /manual recovery/);
    assert.equal(clearWebArtifactManualRecoverySync({ worktree, confirmQuiescent: true }), true);
  });
});

test("orphan publication temps consume quota until prune removes them", async () => {
  await withArtifactRoot(async ({ worktree, artifactRoot }) => {
    const runtimeDir = path.join(worktree, "data", "web-runtime-artifacts");
    await mkdir(runtimeDir, { recursive: true });
    for (let index = 0; index < 8; index += 1) {
      await mkdir(path.join(runtimeDir, `.publication-${String(index).padStart(64, "0")}.tmp-00000000-0000-4000-8000-${String(index).padStart(12, "0")}`));
    }
    let buildCalls = 0;
    await assert.rejects(publishImmutableWebArtifact({
      worktree,
      artifactId: "7".repeat(64),
      jobId,
      jobVersion,
      stageContentHashes,
      build: async () => { buildCalls += 1; },
    }), /quota exceeded/);
    assert.equal(buildCalls, 0);

    await createWebArtifactStore({ worktree, artifactRoot }).prune();
    assert.deepEqual((await readdir(runtimeDir)).filter((name) => name.startsWith(".publication-")), []);

    await mkdir(artifactRoot, { recursive: true });
    await writeFile(path.join(artifactRoot, "index.html"), "source", "utf8");
    for (let index = 0; index < 8; index += 1) {
      await mkdir(path.join(runtimeDir, `.snapshot-1-00000000-0000-4000-8000-${String(index).padStart(12, "0")}.tmp-10000000-0000-4000-8000-${String(index).padStart(12, "0")}`));
    }
    await assert.rejects(publishImmutableWebArtifact({
      worktree,
      artifactId: "5".repeat(64),
      jobId,
      jobVersion,
      stageContentHashes,
      build: async () => { throw new Error("quota must be checked before build"); },
    }), /quota exceeded/);
    await createWebArtifactStore({ worktree, artifactRoot }).prune();
    assert.deepEqual((await readdir(runtimeDir)).filter((name) => name.startsWith(".snapshot-")), []);
  });
});

test("snapshot refuses to exceed the unified quota when all runtime artifacts are referenced", async () => {
  await withArtifactRoot(async ({ worktree, artifactRoot }) => {
    await mkdir(artifactRoot, { recursive: true });
    await writeFile(path.join(artifactRoot, "index.html"), "source", "utf8");
    await writeCurrentWebArtifact({ worktree, artifactId: "6".repeat(64), jobId, jobVersion, stageContentHashes });
    const runtimeDir = path.join(worktree, "data", "web-runtime-artifacts");
    const pendingDir = path.join(worktree, "data", "web-reload-requests", "pending");
    await mkdir(pendingDir, { recursive: true });
    for (let index = 0; index < 8; index += 1) {
      const artifactId = index.toString(16).padStart(64, "0");
      await mkdir(path.join(runtimeDir, `publication-${artifactId}`), { recursive: true });
      await writeFile(path.join(pendingDir, `${index}.json`), JSON.stringify({ artifactId }), "utf8");
    }
    await assert.rejects(
      createWebArtifactStore({ worktree, artifactRoot, maxSnapshots: 5 }).snapshot(),
      /quota exceeded/,
    );
    assert.equal((await readdir(runtimeDir)).filter((name) => /^(?:publication-|snapshot-)/.test(name)).length, 8);
  });
});
