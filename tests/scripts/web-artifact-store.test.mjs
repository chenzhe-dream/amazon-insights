import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import fsSync from "node:fs";
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
      const contentionStarted = performance.now();
      await assert.rejects(publishImmutableWebArtifact({
        worktree, artifactId: second, jobId, jobVersion: jobVersion + 1, stageContentHashes,
        buildLockWaitMs: 3,
        buildLockRetryMs: 1,
        build: async () => undefined,
      }), /Timed out acquiring interprocess lock/);
      assert.ok(performance.now() - contentionStarted < 1_500, "foreign owner inspection must stay bounded");
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
    assert.deepEqual(marker.treeIdentities, [processTreeError.treeIdentity]);

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

    await writeFile(path.join(worktree, "data", "web-runtime-artifacts", "manual-recovery.json"), JSON.stringify({
      version: 1,
      reason: "process-tree-termination-unconfirmed",
      pid: process.pid,
      treeIdentity: {
        pid: 999_999_998,
        pidBirth: "legacy-tree-birth",
        command: "legacy tree",
        worktreeId: createHash("sha256").update(path.resolve(worktree)).digest("hex"),
      },
      createdAt: new Date().toISOString(),
    }), "utf8");
    assert.equal(clearWebArtifactManualRecoverySync({ worktree, confirmQuiescent: true }), true);

    await writeFile(path.join(worktree, "data", "web-runtime-artifacts", "manual-recovery.json"), JSON.stringify({
      version: 1,
      reason: "process-tree-termination-unconfirmed",
      pid: 999_999_999,
      createdAt: new Date().toISOString(),
    }), "utf8");
    assert.throws(
      () => clearWebArtifactManualRecoverySync({ worktree, confirmQuiescent: true }),
      /global quiescent/i,
    );
    assert.equal(clearWebArtifactManualRecoverySync({
      worktree, confirmQuiescent: true, confirmGlobalQuiescent: true,
    }), true);
  });
});

test("manual-recovery mark and clear serialize under the artifact lock without deleting a new fence", async () => {
  await withArtifactRoot(async ({ worktree }) => {
    const store = createWebArtifactStore({ worktree });
    const identity = (pid, command) => ({
      pid, pidBirth: `birth-${pid}`, command, worktreeId: createHash("sha256").update(path.resolve(worktree)).digest("hex"),
    });
    await store.markManualRecovery(Object.assign(new Error("first"), {
      code: "EPROCESSTREE", treeIdentity: identity(999_999_991, "first"),
    }));
    let secondSettled = false;
    let secondMark;
    assert.equal(clearWebArtifactManualRecoverySync({
      worktree,
      confirmQuiescent: true,
      beforeRemove() {
        secondMark = store.markManualRecovery(Object.assign(new Error("second"), {
          code: "EPROCESSTREE", treeIdentity: identity(999_999_992, "second"),
        })).finally(() => { secondSettled = true; });
        assert.equal(secondSettled, false);
      },
    }), true);
    await secondMark;
    const marker = JSON.parse(await readFile(path.join(
      worktree, "data", "web-runtime-artifacts", "manual-recovery.json",
    ), "utf8"));
    assert.equal(marker.version, 2);
    assert.equal(marker.treeIdentities.at(-1).command, "second");
  });
});

test("a queued cross-process canonical merge cannot revive a token cleared first under the artifact lock", async () => {
  await withArtifactRoot(async ({ worktree }) => {
    const token = randomUUID();
    const store = createWebArtifactStore({ worktree });
    const worktreeId = createHash("sha256").update(path.resolve(worktree)).digest("hex");
    const identity = {
      pid: 999_999_950, pidBirth: "fixture-999999950", command: "cas-cleared", worktreeId,
    };
    await store.persistManualRecoveryIntent(Object.assign(new Error("cas-cleared"), {
      code: "EPROCESSTREE", treeIdentity: identity,
    }), { token });
    let contender;
    assert.equal(clearWebArtifactManualRecoverySync({
      worktree,
      confirmQuiescent: true,
      beforeRemove() {
        contender = spawn(process.execPath, [
          path.resolve("tests/fixtures/manual-recovery-contender.mjs"),
          "mark", worktree, token, String(identity.pid), identity.command,
        ], { cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
        const owners = path.join(
          worktree, "data", "web-runtime-artifacts", ".manual-recovery-intent-locks", `${token}.lock.owners`,
        );
        for (let attempt = 0; attempt < 300; attempt += 1) {
          const queued = (() => {
            try { return fsSync.readdirSync(owners).some((name) => name.startsWith(`${contender.pid}-`)); }
            catch { return false; }
          })();
          if (queued) return;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
        throw new Error("cross-process merge did not queue behind clear");
      },
    }), true);
    const [exitCode] = await once(contender, "exit");
    assert.equal(exitCode, 0);
    await assert.rejects(readFile(path.join(
      worktree, "data", "web-runtime-artifacts", "manual-recovery.json",
    ), "utf8"), (error) => error?.code === "ENOENT");
    assert.deepEqual(await store.manualRecoveryStatus({ tokens: [token] }), {
      activeTokens: [], clearedTokens: [token],
    });
  });
});

test("legacy v2 multi-identity and overflow markers migrate to explicit global quiescence", async () => {
  await withArtifactRoot(async ({ worktree }) => {
    const markerPath = path.join(worktree, "data", "web-runtime-artifacts", "manual-recovery.json");
    await mkdir(path.dirname(markerPath), { recursive: true });
    const worktreeId = createHash("sha256").update(path.resolve(worktree)).digest("hex");
    const legacyIdentity = (offset) => ({
      pid: 999_999_700 + offset,
      pidBirth: `legacy-${offset}`,
      command: `legacy-${offset}`,
      worktreeId,
    });
    const dualToken = randomUUID();
    await writeFile(markerPath, JSON.stringify({
      version: 2, token: dualToken, reason: "process-tree-termination-unconfirmed",
      treeIdentities: [legacyIdentity(1), legacyIdentity(2)],
      globalQuiescenceRequired: false,
    }), "utf8");
    assert.deepEqual(await createWebArtifactStore({ worktree }).manualRecoveryStatus({ tokens: [dualToken] }), {
      activeTokens: [dualToken], clearedTokens: [],
    });
    assert.throws(() => clearWebArtifactManualRecoverySync({ worktree, confirmQuiescent: true }), /global quiescent/i);
    assert.equal(clearWebArtifactManualRecoverySync({
      worktree, confirmQuiescent: true, confirmGlobalQuiescent: true,
    }), true);

    const overflowToken = randomUUID();
    await writeFile(markerPath, JSON.stringify({
      version: 2, token: overflowToken, reason: "process-tree-termination-unconfirmed",
      treeIdentities: Array.from({ length: 33 }, (_, index) => legacyIdentity(10 + index)),
      globalQuiescenceRequired: false,
    }), "utf8");
    assert.throws(() => clearWebArtifactManualRecoverySync({ worktree, confirmQuiescent: true }), /global quiescent/i);
    assert.equal(clearWebArtifactManualRecoverySync({
      worktree, confirmQuiescent: true, confirmGlobalQuiescent: true,
    }), true);
  });
});

test("cross-process intent create-if-absent is idempotent only for the same token identity", async () => {
  await withArtifactRoot(async ({ worktree }) => {
    const token = randomUUID();
    const fixture = path.resolve("tests/fixtures/manual-recovery-contender.mjs");
    const contenders = [
      spawn(process.execPath, [fixture, "persist", worktree, token, "999999940", "identity-a"], {
        cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe"], windowsHide: true,
      }),
      spawn(process.execPath, [fixture, "persist", worktree, token, "999999939", "identity-b"], {
        cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe"], windowsHide: true,
      }),
    ];
    const exits = await Promise.all(contenders.map((child) => once(child, "exit").then(([code]) => code)));
    assert.deepEqual(exits.sort(), [0, 2]);
    const record = JSON.parse(await readFile(path.join(
      worktree, "data", "web-runtime-artifacts", ".manual-recovery-intents", `${token}.json`,
    ), "utf8"));
    assert.ok(new Set(["identity-a", "identity-b"]).has(record.treeIdentity.command));
    const same = spawn(process.execPath, [
      fixture, "persist", worktree, token, String(record.treeIdentity.pid), record.treeIdentity.command,
    ], { cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    assert.equal((await once(same, "exit"))[0], 0);
  });
});

test("crashed intent writes recover conservatively at open partial-write and fsync boundaries", async () => {
  const fixture = path.resolve("tests/fixtures/manual-recovery-contender.mjs");
  for (const [index, phase] of ["after-open", "after-partial-write", "before-fsync", "after-fsync"].entries()) {
    const worktree = await mkdtemp(path.join(os.tmpdir(), `intent-crash-${index}-`));
    const token = randomUUID();
    const child = spawn(process.execPath, [
      fixture, "crash", worktree, token, String(999_999_930 - index), `crash-${phase}`, phase,
    ], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    try {
      await once(child.stdout, "data", { signal: AbortSignal.timeout(2_000) });
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;

      const restarted = createWebArtifactStore({ worktree });
      await restarted.recoverManualRecovery();
      assert.throws(() => restarted.assertOperational(), /manual recovery/i);
      if (phase === "after-open" || phase === "after-partial-write") {
        assert.throws(
          () => clearWebArtifactManualRecoverySync({ worktree, confirmQuiescent: true }),
          /global quiescent/i,
        );
        assert.equal(clearWebArtifactManualRecoverySync({
          worktree, confirmQuiescent: true, confirmGlobalQuiescent: true,
        }), true);
      } else {
        assert.equal(clearWebArtifactManualRecoverySync({ worktree, confirmQuiescent: true }), true);
      }
      assert.doesNotThrow(() => restarted.assertOperational());
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
      }
      await rm(worktree, { recursive: true, force: true });
    }
  }
});

test("intent temp recovery flushes before publish and survives a second recovery crash", async () => {
  const fixture = path.resolve("tests/fixtures/manual-recovery-contender.mjs");
  const worktree = await mkdtemp(path.join(os.tmpdir(), "intent-recovery-crash-"));
  const token = randomUUID();
  const intentDirectory = path.join(worktree, "data", "web-runtime-artifacts", ".manual-recovery-intents");
  const finalIntent = path.join(intentDirectory, `${token}.json`);
  const spawnAt = (mode, phase) => spawn(process.execPath, [
    fixture, mode, worktree, token, "999999925", "recovery-crash", phase,
  ], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let writer;
  let recovery;
  try {
    writer = spawnAt("crash", "before-fsync");
    await once(writer.stdout, "data", { signal: AbortSignal.timeout(2_000) });
    let exited = once(writer, "exit"); writer.kill("SIGKILL"); await exited;

    const flushFailure = new Error("injected recovery fsync failure");
    const failing = createWebArtifactStore({
      worktree,
      manualRecoveryIntentRecoveryFlush: () => { throw flushFailure; },
    });
    await assert.rejects(failing.recoverManualRecovery(), (error) => error === flushFailure);
    assert.equal(fsSync.existsSync(finalIntent), false);
    assert.ok((await readdir(intentDirectory)).some((name) => name.includes(`.intent-${token}.tmp-`)));

    recovery = spawnAt("recover-crash", "after-recovery-fsync");
    await once(recovery.stdout, "data", { signal: AbortSignal.timeout(2_000) });
    exited = once(recovery, "exit"); recovery.kill("SIGKILL"); await exited;
    assert.equal(fsSync.existsSync(finalIntent), false);

    const restarted = createWebArtifactStore({ worktree });
    await restarted.recoverManualRecovery();
    assert.equal(fsSync.existsSync(finalIntent), true);
    assert.throws(() => restarted.assertOperational(), /manual recovery/i);
    assert.equal(clearWebArtifactManualRecoverySync({ worktree, confirmQuiescent: true }), true);
  } finally {
    for (const child of [writer, recovery]) {
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
      }
    }
    await rm(worktree, { recursive: true, force: true });
  }
});

test("global manual recovery quarantines a malformed token-lock owner under the artifact boundary", async () => {
  await withArtifactRoot(async ({ worktree }) => {
    const token = randomUUID();
    const nonce = randomUUID();
    const runtime = path.join(worktree, "data", "web-runtime-artifacts");
    const intents = path.join(runtime, ".manual-recovery-intents");
    const owners = path.join(runtime, ".manual-recovery-intent-locks", `${token}.lock.owners`);
    await mkdir(intents, { recursive: true });
    await mkdir(owners, { recursive: true });
    await writeFile(path.join(intents, `.intent-${token}.tmp-${nonce}.json`), "{partial");
    await writeFile(path.join(owners, `${process.pid}-${randomUUID()}.owner.json`), "{truncated");
    const legacyToken = randomUUID();
    await writeFile(path.join(owners, `${process.pid}-${legacyToken}.owner.json`), JSON.stringify({
      version: 1, pid: process.pid, token: legacyToken, ticket: 1,
    }));

    assert.equal(clearWebArtifactManualRecoverySync({
      worktree,
      confirmQuiescent: true,
      confirmGlobalQuiescent: true,
      quarantineTokenLockOwners: true,
    }), true);
    assert.deepEqual(await readdir(owners), []);
    assert.ok((await readdir(path.dirname(owners))).some((name) => name.includes("manual-quarantine")));
    assert.doesNotThrow(() => createWebArtifactStore({ worktree }).assertOperational());
  });
});

test("manual-recovery writer outwaits the former five-second artifact-lock default", async () => {
  await withArtifactRoot(async ({ worktree }) => {
    const fixture = path.resolve("tests/fixtures/hold-interprocess-lock.mjs");
    const lockPath = path.join(worktree, "data", "web-runtime-artifacts", ".build-artifact.lock");
    const owner = spawn(process.execPath, [fixture, lockPath], {
      cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    try {
      await once(owner.stdout, "data");
      const store = createWebArtifactStore({ worktree });
      const marking = store.markManualRecovery(Object.assign(new Error("long lock"), {
        code: "EPROCESSTREE",
        treeIdentity: {
          pid: 999_999_981, pidBirth: "long-lock", command: "long-lock-child",
          worktreeId: createHash("sha256").update(path.resolve(worktree)).digest("hex"),
        },
      }));
      await new Promise((resolve) => setTimeout(resolve, 5_200));
      const exited = once(owner, "exit");
      owner.kill("SIGKILL");
      await exited;
      await marking;
      assert.equal(clearWebArtifactManualRecoverySync({ worktree, confirmQuiescent: true }), true);
    } finally {
      if (owner.exitCode === null && owner.signalCode === null) {
        const exited = once(owner, "exit"); owner.kill("SIGKILL"); await exited;
      }
    }
  });
});

test("an emergency manual-recovery intent is durable before the artifact lock is available", async () => {
  await withArtifactRoot(async ({ worktree }) => {
    const fixture = path.resolve("tests/fixtures/hold-interprocess-lock.mjs");
    const lockPath = path.join(worktree, "data", "web-runtime-artifacts", ".build-artifact.lock");
    const owner = spawn(process.execPath, [fixture, lockPath], {
      cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    try {
      await once(owner.stdout, "data");
      const token = randomUUID();
      const store = createWebArtifactStore({ worktree, manualRecoveryLockWaitMs: 50 });
      const persisted = await store.persistManualRecoveryIntent(Object.assign(new Error("tree uncertain"), {
        code: "EPROCESSTREE",
        treeIdentity: {
          pid: 999_999_980, pidBirth: "emergency-lock", command: "blocked-child",
          worktreeId: createHash("sha256").update(path.resolve(worktree)).digest("hex"),
        },
      }), { token });
      assert.equal(persisted.token, token);
      const intent = JSON.parse(await readFile(path.join(
        worktree, "data", "web-runtime-artifacts", ".manual-recovery-intents", `${token}.json`,
      ), "utf8"));
      assert.equal(intent.token, token);
      assert.equal(intent.treeIdentity.command, "blocked-child");
      await assert.rejects(store.markManualRecovery(Object.assign(new Error("tree uncertain"), {
        code: "EPROCESSTREE", treeIdentity: intent.treeIdentity,
      }), { token }), /Timed out acquiring interprocess lock/);
    } finally {
      if (owner.exitCode === null && owner.signalCode === null) {
        const exited = once(owner, "exit"); owner.kill("SIGKILL"); await exited;
      }
    }
  });
});

test("startup merges an emergency intent left by failed canonical writes and clear acknowledges its token", async () => {
  await withArtifactRoot(async ({ worktree }) => {
    const token = randomUUID();
    const first = createWebArtifactStore({ worktree });
    const treeIdentity = {
      pid: 999_999_979, pidBirth: "restart-recovery", command: "orphan-tree",
      worktreeId: createHash("sha256").update(path.resolve(worktree)).digest("hex"),
    };
    await first.persistManualRecoveryIntent(Object.assign(new Error("orphan"), {
      code: "EPROCESSTREE", treeIdentity,
    }), { token });

    const restarted = createWebArtifactStore({ worktree });
    await restarted.recoverManualRecovery();
    const marker = JSON.parse(await readFile(path.join(
      worktree, "data", "web-runtime-artifacts", "manual-recovery.json",
    ), "utf8"));
    assert.equal(marker.fences[0].token, token);
    assert.throws(() => restarted.assertOperational(), /manual recovery/i);

    assert.equal(clearWebArtifactManualRecoverySync({ worktree, confirmQuiescent: true }), true);
    assert.deepEqual(await restarted.manualRecoveryStatus({ tokens: [token] }), {
      activeTokens: [], clearedTokens: [token],
    });

    const nextToken = randomUUID();
    await restarted.persistManualRecoveryIntent(Object.assign(new Error("new tree"), {
      code: "EPROCESSTREE", treeIdentity: { ...treeIdentity, pid: 999_999_978, command: "new-tree" },
    }), { token: nextToken });
    assert.deepEqual(await restarted.manualRecoveryStatus({ tokens: [token, nextToken] }), {
      activeTokens: [nextToken], clearedTokens: [token],
    });
  });
});

test("canonical manual-recovery merge can be aborted without cancelling its durable intent", async () => {
  await withArtifactRoot(async ({ worktree }) => {
    const fixture = path.resolve("tests/fixtures/hold-interprocess-lock.mjs");
    const lockPath = path.join(worktree, "data", "web-runtime-artifacts", ".build-artifact.lock");
    const owner = spawn(process.execPath, [fixture, lockPath], {
      cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    try {
      await once(owner.stdout, "data");
      const token = randomUUID();
      const controller = new AbortController();
      const store = createWebArtifactStore({ worktree });
      const error = Object.assign(new Error("abort merge"), {
        code: "EPROCESSTREE",
        treeIdentity: {
          pid: 999_999_977, pidBirth: "abort-merge", command: "abort-child",
          worktreeId: createHash("sha256").update(path.resolve(worktree)).digest("hex"),
        },
      });
      const marking = store.markManualRecovery(error, { token, signal: controller.signal });
      setTimeout(() => controller.abort(new Error("stop optional merge")), 20);
      await assert.rejects(marking, /stop optional merge/);
      assert.deepEqual(await store.manualRecoveryStatus({ tokens: [token] }), {
        activeTokens: [token], clearedTokens: [],
      });
    } finally {
      if (owner.exitCode === null && owner.signalCode === null) {
        const exited = once(owner, "exit"); owner.kill("SIGKILL"); await exited;
      }
    }
  });
});

test("manual-recovery identity overflow remains parseable and requires global quiescence", async () => {
  await withArtifactRoot(async ({ worktree }) => {
    const store = createWebArtifactStore({ worktree });
    const worktreeId = createHash("sha256").update(path.resolve(worktree)).digest("hex");
    for (let offset = 0; offset < 33; offset += 1) {
      await store.markManualRecovery(Object.assign(new Error("overflow"), {
        code: "EPROCESSTREE",
        treeIdentity: {
          pid: 999_999_800 + offset, pidBirth: `overflow-${offset}`, command: `child-${offset}`, worktreeId,
        },
      }));
    }
    const markerPath = path.join(worktree, "data", "web-runtime-artifacts", "manual-recovery.json");
    const marker = JSON.parse(await readFile(markerPath, "utf8"));
    assert.equal(marker.treeIdentities.length, 32);
    assert.equal(marker.globalQuiescenceRequired, true);
    assert.throws(() => clearWebArtifactManualRecoverySync({ worktree, confirmQuiescent: true }), /global quiescent/i);
    assert.equal(clearWebArtifactManualRecoverySync({
      worktree, confirmQuiescent: true, confirmGlobalQuiescent: true,
    }), true);

    await writeFile(markerPath, JSON.stringify({
      version: 2, token: "invalid", reason: "process-tree-termination-unconfirmed",
      treeIdentities: [], globalQuiescenceRequired: true,
    }), "utf8");
    assert.throws(() => clearWebArtifactManualRecoverySync({
      worktree, confirmQuiescent: true, confirmGlobalQuiescent: true,
    }), /invalid/i);
    const mismatchedToken = randomUUID();
    await writeFile(markerPath, JSON.stringify({
      version: 2, token: randomUUID(), reason: "process-tree-termination-unconfirmed",
      treeIdentities: [{
        pid: 999_999_970, pidBirth: "marker-identity", command: "marker-identity", worktreeId,
      }],
      fences: [{ token: mismatchedToken, treeIdentity: {
        pid: 999_999_969, pidBirth: "different-fence", command: "different-fence", worktreeId,
      } }],
      globalQuiescenceRequired: false,
    }), "utf8");
    assert.throws(() => clearWebArtifactManualRecoverySync({ worktree, confirmQuiescent: true }), /invalid/i);
    await writeFile(markerPath, JSON.stringify({
      version: 2, reason: "process-tree-termination-unconfirmed", treeIdentity: null,
    }), "utf8");
    assert.throws(() => clearWebArtifactManualRecoverySync({ worktree, confirmQuiescent: true }), /global quiescent/i);
    assert.equal(clearWebArtifactManualRecoverySync({
      worktree, confirmQuiescent: true, confirmGlobalQuiescent: true,
    }), true);
  });
});

test("manual-recovery token overflow never installs an identity without its fence token", async () => {
  await withArtifactRoot(async ({ worktree }) => {
    const store = createWebArtifactStore({ worktree });
    const worktreeId = createHash("sha256").update(path.resolve(worktree)).digest("hex");
    const repeatedIdentity = {
      pid: 999_999_960, pidBirth: "repeated-token-tree", command: "repeated-token-tree", worktreeId,
    };
    for (let index = 0; index < 32; index += 1) {
      await store.markManualRecovery(Object.assign(new Error("repeated"), {
        code: "EPROCESSTREE", treeIdentity: repeatedIdentity,
      }), { token: randomUUID() });
    }
    await store.markManualRecovery(Object.assign(new Error("overflow identity"), {
      code: "EPROCESSTREE",
      treeIdentity: {
        pid: 999_999_959, pidBirth: "overflow-identity", command: "overflow-identity", worktreeId,
      },
    }), { token: randomUUID() });
    const marker = JSON.parse(await readFile(path.join(
      worktree, "data", "web-runtime-artifacts", "manual-recovery.json",
    ), "utf8"));
    assert.equal(marker.treeIdentities.length, 1);
    assert.equal(marker.fences.length, 32);
    assert.equal(marker.globalQuiescenceRequired, true);
    assert.equal(clearWebArtifactManualRecoverySync({
      worktree, confirmQuiescent: true, confirmGlobalQuiescent: true,
    }), true);
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
