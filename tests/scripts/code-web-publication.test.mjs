import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import fsSync from "node:fs";
import { createBuildSourceFingerprint } from "../../scripts/lib/build-fingerprint.mjs";
import { publishImmutableWebArtifact, createWebArtifactStore } from "../../scripts/lib/web-artifact-store.mjs";
import { commitWebPublicationControl, readWebPublicationControl, webPublicationControlPath } from "../../scripts/lib/web-publication-control.mjs";
import { createWebReloadTarget, writeWebReloadRequest, consumeWebReloadRequest } from "../../scripts/lib/web-reload-request.mjs";

const A = "a".repeat(64), B = "b".repeat(64);
const codeRelease = { sourceCommit: "c".repeat(40), sourceHash: "d".repeat(64), baseArtifactId: A };
const git = process.platform === "win32" && fsSync.existsSync("D:/Git/cmd/git.exe") ? "D:/Git/cmd/git.exe" : "git";
async function fixture(run) {
  const worktree = await fs.mkdtemp(path.join(os.tmpdir(), "code-web-publication-"));
  try {
    const target = createWebReloadTarget({ worktree, webHost: "127.0.0.1", webPort: 43123 });
    const spoolDir = path.join(worktree, "data", "web-reload-requests");
    const controlPath = webPublicationControlPath(worktree);
    const business = { artifactId: A, jobId: "real-business", jobVersion: 2, stageContentHashes: { alexa_voc: A } };
    const build = async () => {
      await fs.mkdir(path.join(worktree, "dist"), { recursive: true });
      await fs.writeFile(path.join(worktree, "dist", "index.html"), "built code");
    };
    await publishImmutableWebArtifact({ worktree, ...business, build });
    await commitWebPublicationControl({ controlPath, requestId: A, payload: { ...business, target, stream: { id: "alexa_voc", generation: 2, epoch: 1 } } });
    const previous = await readWebPublicationControl({ controlPath });
    await run({ worktree, target, spoolDir, controlPath, previous, build });
  } finally { await fs.rm(worktree, { recursive: true, force: true }); }
}

test("code artifact activation preserves business provenance and streams across restart", async () => {
  await fixture(async ({ worktree, target, spoolDir, controlPath, previous, build }) => {
    await publishImmutableWebArtifact({ worktree, artifactId: B, kind: "code", codeRelease, build });
    await writeWebReloadRequest({ artifactId: B, kind: "code", codeRelease, target, buildCompletedAt: new Date().toISOString() }, { spoolDir });
    const store = createWebArtifactStore({ worktree });
    const result = await consumeWebReloadRequest({ spoolDir, expectedTarget: target, apply: async (request, control) => {
      assert.deepEqual(store.candidate(request).codeRelease, codeRelease);
      await control.commitHighWater();
    } });
    assert.equal(result.status, "applied");
    const control = await readWebPublicationControl({ controlPath });
    assert.equal(store.current(target).id, B);
    assert.deepEqual(control.streams, previous.streams);
    assert.deepEqual(control.dataCurrent, previous.current);
    assert.equal(control.current.kind, "code");
    assert.equal(control.current.codeRelease.sourceHash, codeRelease.sourceHash);
    assert.equal("jobId" in control.current, false);
    await store.prune();
    assert.equal(createWebArtifactStore({ worktree }).current(target).id, B);
    assert.equal(store.candidate({ artifactId: A }).id, A);
  });
});

async function operatorFixture(run) {
  await fixture(async (context) => {
    const { worktree, build } = context;
    await fs.mkdir(path.join(worktree, "app"));
    await fs.writeFile(path.join(worktree, "app", "source.js"), "original");
    for (const args of [["init"], ["add", "app"], ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture"]]) execFileSync(git, args, { cwd: worktree, stdio: "pipe" });
    const env = { WEB_HOST: "127.0.0.1", WEB_PORT: "43123" };
    const built = async () => {
      await build();
      await fs.writeFile(path.join(worktree, "dist", "build-fingerprint.json"), JSON.stringify({ version: 1, sourceHash: await createBuildSourceFingerprint(worktree) }));
    };
    const publication = await import("../../scripts/lib/code-web-publication.mjs").catch(() => ({}));
    assert.equal(typeof publication.prepareCodeWebPublication, "function", "operator prepare contract is required");
    await run({ ...context, env, built, ...publication });
  });
}

test("prepare reserves without submitting; submit and exact ack reconcile code activation", async () => {
  await operatorFixture(async ({ worktree, env, built, target, spoolDir, prepareCodeWebPublication, submitCodeWebPublication, readCodeWebPublicationStatus }) => {
    const prepared = await prepareCodeWebPublication({ worktree, env, build: built });
    assert.equal(prepared.status, "prepared");
    assert.equal(prepared.codeRelease.sourceCommit, execFileSync(git, ["rev-parse", "HEAD"], { cwd: worktree, encoding: "utf8" }).trim());
    assert.deepEqual(await fs.readdir(path.join(spoolDir, "pending")).catch(() => []), []);
    await createWebArtifactStore({ worktree, maxSnapshots: 1 }).prune();
    assert.equal(createWebArtifactStore({ worktree }).candidate(prepared).id, prepared.artifactId);
    const submitted = await submitCodeWebPublication({ worktree, env, artifactId: prepared.artifactId });
    assert.equal(submitted.status, "pending");
    assert.equal((await consumeWebReloadRequest({ spoolDir, expectedTarget: target, apply: async (_, c) => c.commitHighWater() })).status, "applied");
    const status = await readCodeWebPublicationStatus({ worktree, env, artifactId: prepared.artifactId });
    assert.equal(status.status, "applied");
    assert.deepEqual(status.codeRelease, prepared.codeRelease);
    assert.equal(status.requestId, submitted.requestId);
    await fs.writeFile(path.join(spoolDir, "applied", `${status.requestId}.json`), "{}");
    assert.equal((await readCodeWebPublicationStatus({ worktree, env, artifactId: prepared.artifactId })).status, "failed");
  });
});

test("a later business artifact keeps its own exact build source across restart", async () => {
  await operatorFixture(async ({ worktree, env, built, target, spoolDir, controlPath, prepareCodeWebPublication, submitCodeWebPublication }) => {
    const prepared = await prepareCodeWebPublication({ worktree, env, build: built });
    await submitCodeWebPublication({ worktree, env, artifactId: prepared.artifactId });
    assert.equal((await consumeWebReloadRequest({ spoolDir, expectedTarget: target,
      apply: async (_, control) => control.commitHighWater() })).status, "applied");
    const codeControl = await readWebPublicationControl({ controlPath });
    await fs.writeFile(path.join(worktree, "app", "source.js"), "business data changed");
    const businessId = "e".repeat(64);
    const business = { artifactId: businessId, jobId: "new-business", jobVersion: 3, stageContentHashes: { keywords: "f".repeat(64) } };
    await publishImmutableWebArtifact({ worktree, ...business, build: built, captureSourceIdentity: true });
    await writeWebReloadRequest({ ...business, target, buildCompletedAt: new Date().toISOString() }, { spoolDir });
    assert.equal((await consumeWebReloadRequest({ spoolDir, expectedTarget: target,
      apply: async (_, control) => control.commitHighWater() })).status, "applied");
    const control = await readWebPublicationControl({ controlPath });
    const restarted = createWebArtifactStore({ worktree }).current(target);
    assert.equal(control.current.artifactId, businessId);
    assert.equal(control.current.kind, undefined);
    assert.equal(restarted.id, businessId);
    assert.equal(restarted.codeSource.sourceCommit, prepared.codeRelease.sourceCommit);
    assert.notEqual(restarted.codeSource.sourceHash, prepared.codeRelease.sourceHash);
    assert.equal(restarted.codeSource.sourceHash,
      JSON.parse(await fs.readFile(path.join(restarted.root, "build-fingerprint.json"), "utf8")).sourceHash);
    assert.deepEqual(control.streams, codeControl.streams);
    await fs.writeFile(path.join(restarted.root, "build-fingerprint.json"),
      JSON.stringify({ version: 1, sourceHash: "0".repeat(64) }));
    assert.throws(() => createWebArtifactStore({ worktree }).current(target), /manifest/i);
  });
});

test("operator rejects source drift, target mismatch and build failure without changing current", async () => {
  await operatorFixture(async ({ worktree, env, built, controlPath, previous, prepareCodeWebPublication, submitCodeWebPublication }) => {
    await assert.rejects(prepareCodeWebPublication({ worktree, env, build: async () => { throw new Error("build failed"); } }), /build failed/);
    const prepared = await prepareCodeWebPublication({ worktree, env, build: built });
    await assert.rejects(submitCodeWebPublication({ worktree, env: { ...env, WEB_PORT: "43124" }, artifactId: prepared.artifactId }), /target/);
    await fs.writeFile(path.join(worktree, "app", "source.js"), "changed");
    await assert.rejects(submitCodeWebPublication({ worktree, env, artifactId: prepared.artifactId }), /source/);
    assert.deepEqual(await readWebPublicationControl({ controlPath }), previous);
  });
});

test("expired reservations and corrupted immutable build identity cannot be submitted", async () => {
  await operatorFixture(async ({ worktree, env, built, controlPath, previous, prepareCodeWebPublication, submitCodeWebPublication }) => {
    const prepared = await prepareCodeWebPublication({ worktree, env, build: built });
    const dir = path.join(worktree, "data", "web-runtime-artifacts", ".reservations");
    const reservation = path.join(dir, (await fs.readdir(dir)).find((name) => name.startsWith(prepared.artifactId)));
    const record = JSON.parse(await fs.readFile(reservation));
    await fs.writeFile(reservation, JSON.stringify({ ...record, leaseExpiresAt: new Date(0).toISOString() }));
    await assert.rejects(submitCodeWebPublication({ worktree, env, artifactId: prepared.artifactId }), /reservation/i);
    await fs.writeFile(reservation, JSON.stringify(record));
    const artifact = createWebArtifactStore({ worktree }).candidate(prepared);
    await fs.writeFile(path.join(artifact.root, "build-fingerprint.json"), JSON.stringify({ version: 1, sourceHash: A }));
    await assert.rejects(submitCodeWebPublication({ worktree, env, artifactId: prepared.artifactId }), /fingerprint/i);
    assert.deepEqual(await readWebPublicationControl({ controlPath }), previous);
  });
});

test("CLI prepare keeps build logs out of its JSON output and reports sanitized failure", async () => {
  await operatorFixture(async ({ worktree, env }) => {
    const cli = path.resolve(import.meta.dirname, "../../scripts/publish-code-web.mjs");
    const fakeBuilder = path.join(worktree, "node_modules", "vinext", "dist");
    await fs.mkdir(fakeBuilder, { recursive: true });
    await fs.writeFile(path.join(fakeBuilder, "cli.js"), "console.log('build log');");
    const output = execFileSync(process.execPath, [cli, "prepare"], { cwd: worktree, env: { ...process.env, ...env, AGENT_FORMAL_WORKTREE_ROOT: worktree }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    assert.equal(JSON.parse(output.trim()).status, "prepared");
    try { execFileSync(process.execPath, [cli, "submit", "secret-invalid-input"], { cwd: worktree, env: { ...process.env, ...env, AGENT_FORMAL_WORKTREE_ROOT: worktree }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); assert.fail("must fail"); }
    catch (error) { assert.equal(error.status, 1); assert.doesNotMatch(error.stderr, /secret-invalid-input|postgresql:|code-web-publications/); }
  });
});

test("a later business publication replaces code current and preserves actual Alexa stream", async () => {
  await fixture(async ({ worktree, target, spoolDir, controlPath, previous, build }) => {
    await publishImmutableWebArtifact({ worktree, artifactId: B, kind: "code", codeRelease, build });
    await writeWebReloadRequest({ artifactId: B, kind: "code", codeRelease, target, buildCompletedAt: new Date().toISOString() }, { spoolDir });
    await consumeWebReloadRequest({ spoolDir, expectedTarget: target, apply: async () => {} });
    const payload = { artifactId: "e".repeat(64), jobId: "real-later-job", jobVersion: 3, stageContentHashes: { keywords: A }, target };
    await publishImmutableWebArtifact({ worktree, ...payload, build });
    await writeWebReloadRequest({ ...payload, buildCompletedAt: new Date().toISOString() }, { spoolDir });
    assert.equal((await consumeWebReloadRequest({ spoolDir, expectedTarget: target, apply: async () => {} })).status, "applied");
    const current = await readWebPublicationControl({ controlPath });
    assert.equal(current.current.jobId, "real-later-job");
    assert.equal(current.version, 1);
    assert.deepEqual(current.streams, previous.streams);
    assert.equal(createWebArtifactStore({ worktree }).current(target).id, payload.artifactId);
  });
});

test("a higher Alexa retry epoch preserves already activated code current and exact code ack", async () => {
  await fixture(async ({ worktree, target, spoolDir, controlPath, build }) => {
    await publishImmutableWebArtifact({ worktree, artifactId: B, kind: "code", codeRelease, build });
    await writeWebReloadRequest({ artifactId: B, kind: "code", codeRelease, target, buildCompletedAt: new Date().toISOString() }, { spoolDir });
    await consumeWebReloadRequest({ spoolDir, expectedTarget: target, apply: async () => {} });
    const before = await readWebPublicationControl({ controlPath });
    await writeWebReloadRequest({ artifactId: A, jobId: `manual-alexa-voc-g2-${A.slice(0, 24)}`, jobVersion: 2, stageContentHashes: { alexa_voc: A }, stream: { id: "alexa_voc", generation: 2, epoch: 3 }, target, buildCompletedAt: new Date().toISOString() }, { spoolDir });
    assert.equal((await consumeWebReloadRequest({ spoolDir, expectedTarget: target, apply: async () => assert.fail("duplicate generation must not spawn") })).status, "duplicate");
    const after = await readWebPublicationControl({ controlPath });
    assert.deepEqual(after.current, before.current);
    assert.deepEqual(after.dataCurrent, before.dataCurrent);
    assert.equal(after.committedRequestId, before.committedRequestId);
    assert.deepEqual(after.streams.alexa_voc, { ...before.streams.alexa_voc, epoch: 3 });
    assert.equal(createWebArtifactStore({ worktree }).current(target).id, B);
  });
});

test("code rejects mixed business fields and malformed identity without changing durable current", async () => {
  await fixture(async ({ worktree, target, spoolDir, controlPath, previous, build }) => {
    for (const identity of [{ ...codeRelease, sourceCommit: "bad" }, { ...codeRelease, sourceHash: "bad" }, { ...codeRelease, baseArtifactId: "bad" }]) {
      await assert.rejects(publishImmutableWebArtifact({ worktree, artifactId: B, kind: "code", codeRelease: identity, build }));
    }
    await assert.rejects(publishImmutableWebArtifact({ worktree, artifactId: B, kind: "code", codeRelease, jobId: "fake", build }));
    await assert.rejects(writeWebReloadRequest({ artifactId: B, kind: "code", codeRelease, jobId: "fake", target, buildCompletedAt: new Date().toISOString() }, { spoolDir }));
    assert.deepEqual(await readWebPublicationControl({ controlPath }), previous);
  });
});

test("code stale base is rejected before application and rechecked at durable commit", async () => {
  await fixture(async ({ target, spoolDir, controlPath, previous }) => {
    await writeWebReloadRequest({ artifactId: B, kind: "code", codeRelease: { ...codeRelease, baseArtifactId: B }, target, buildCompletedAt: new Date().toISOString() }, { spoolDir });
    assert.equal((await consumeWebReloadRequest({ spoolDir, expectedTarget: target, apply: async () => assert.fail("stale code must not spawn") })).status, "failed");
    assert.deepEqual(await readWebPublicationControl({ controlPath }), previous);
    await assert.rejects(commitWebPublicationControl({ controlPath, requestId: B, payload: { artifactId: B, kind: "code", codeRelease: { ...codeRelease, baseArtifactId: B }, target } }), /base changed/);
    assert.deepEqual(await readWebPublicationControl({ controlPath }), previous);
  });
});
