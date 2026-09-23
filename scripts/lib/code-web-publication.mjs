import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { runStableBuild } from "../run-stable-build.mjs";
import { readCodeSourceIdentity, assertBuiltCodeSource as assertBuiltSource } from "./code-source-identity.mjs";
import { acquireInterprocessLock } from "./interprocess-lock.mjs";
import { runBoundedProcess } from "./bounded-process.mjs";
import { codeReleasesMatch } from "./code-publication-identity.mjs";
import { createWebArtifactStore, createWebPublicationArtifactId, publishImmutableWebArtifact, finalizeWebArtifactReservation, writeWebArtifactPrivateRecordSync } from "./web-artifact-store.mjs";
import { readWebPublicationControl, webPublicationControlPath } from "./web-publication-control.mjs";
import { configuredWebReloadTarget, createWebReloadRequestPayload, webReloadRequestId, writeWebReloadRequestSync, readWebReloadPublication } from "./web-reload-request.mjs";

export { readCodeSourceIdentity } from "./code-source-identity.mjs";

function spool(worktree) { return path.join(path.resolve(worktree), "data", "web-reload-requests"); }
function recordPath(worktree, artifactId) {
  if (typeof artifactId !== "string" || !/^[a-f0-9]{64}$/.test(artifactId)) throw new Error("Invalid code artifact identity");
  return path.join(path.resolve(worktree), ".runtime", "code-web-publications", `${artifactId}.json`);
}
function sameTarget(left, right) { return left.worktreeId === right.worktreeId && left.webHost === right.webHost && left.webPort === right.webPort; }
function summary(record, status, extras = {}) {
  return Object.freeze({ status, artifactId: record.payload.artifactId, kind: "code", codeRelease: record.payload.codeRelease, target: record.payload.target, requestId: record.requestId, ...extras });
}

export async function assertCodePublicationIdle(worktree) {
  for (const dir of ["pending", "processing"]) {
    let files;
    try { files = await fs.readdir(path.join(spool(worktree), dir)); }
    catch (error) { if (error?.code === "ENOENT") continue; throw error; }
    if (files.some((name) => name.endsWith(".json"))) throw new Error("Web publication is active");
  }
}

async function readPrepared(worktree, env, artifactId) {
  let record;
  try {
    record = JSON.parse(await fs.readFile(recordPath(worktree, artifactId), "utf8"));
    if (Object.keys(record).sort().join(",") !== "payload,requestId,reservationToken,version" || record.version !== 1
      || !/^[a-f0-9-]{36}$/.test(record.reservationToken)) throw new Error();
    const payload = createWebReloadRequestPayload(record.payload);
    if (payload.kind !== "code" || payload.artifactId !== artifactId || webReloadRequestId(payload) !== record.requestId
      || JSON.stringify(payload) !== JSON.stringify(record.payload)) throw new Error();
  } catch { throw new Error("Invalid prepared code publication"); }
  if (!sameTarget(record.payload.target, configuredWebReloadTarget(env, worktree))) throw new Error("Code publication target changed");
  const artifact = createWebArtifactStore({ worktree }).candidate(record.payload);
  if (artifact.id !== artifactId || artifact.kind !== "code" || !codeReleasesMatch(artifact.codeRelease, record.payload.codeRelease)) throw new Error("Code artifact identity mismatch");
  const fingerprint = JSON.parse(await fs.readFile(path.join(artifact.root, "build-fingerprint.json"), "utf8"));
  if (fingerprint.version !== 1 || fingerprint.sourceHash !== record.payload.codeRelease.sourceHash) throw new Error("Code artifact fingerprint mismatch");
  return record;
}

async function buildCodeWeb({ worktree }) {
  return runStableBuild({ worktree, runProcess: (options) => runBoundedProcess({
    ...options,
    spawnImplementation: (command, args, spawnOptions) => spawn(command, args, {
      ...spawnOptions, stdio: ["ignore", process.stderr, process.stderr],
    }),
  }) });
}

export async function prepareCodeWebPublication({ worktree = process.cwd(), env = process.env, build = buildCodeWeb } = {}) {
  worktree = path.resolve(worktree);
  const target = configuredWebReloadTarget(env, worktree);
  await assertCodePublicationIdle(worktree);
  const previous = await readWebPublicationControl({ controlPath: webPublicationControlPath(worktree), expectedTarget: target });
  if (!previous) throw new Error("Code publication requires durable business current");
  createWebArtifactStore({ worktree }).current(target);
  const source = await readCodeSourceIdentity(worktree);
  const codeRelease = { ...source, baseArtifactId: previous.current.artifactId };
  const artifactId = createWebPublicationArtifactId();
  const artifact = await publishImmutableWebArtifact({ worktree, artifactId, kind: "code", codeRelease, build: async () => {
    const before = await readCodeSourceIdentity(worktree);
    if (JSON.stringify(before) !== JSON.stringify(source)) throw new Error("Code source changed before build");
    await build({ worktree, env });
    await assertBuiltSource(worktree, source);
  } });
  try {
    await assertCodePublicationIdle(worktree);
    const current = await readWebPublicationControl({ controlPath: webPublicationControlPath(worktree), expectedTarget: target });
    if (current?.current.artifactId !== codeRelease.baseArtifactId) throw new Error("Code publication base changed");
    const payload = createWebReloadRequestPayload({ artifactId, kind: "code", codeRelease, target, buildCompletedAt: new Date().toISOString() });
    const record = { version: 1, payload, requestId: webReloadRequestId(payload), reservationToken: artifact.reservationToken };
    writeWebArtifactPrivateRecordSync(recordPath(worktree, artifactId), record);
    return summary(record, "prepared");
  } catch (error) {
    await finalizeWebArtifactReservation({ worktree, artifactId, reservationToken: artifact.reservationToken });
    throw error;
  }
}

export async function submitCodeWebPublication({ worktree = process.cwd(), env = process.env, artifactId } = {}) {
  worktree = path.resolve(worktree);
  const record = await readPrepared(worktree, env, artifactId);
  await assertBuiltSource(worktree, record.payload.codeRelease);
  const release = await acquireInterprocessLock(path.join(spool(worktree), ".consume.lock"));
  try {
    const status = await readCodeWebPublicationStatus({ worktree, env, artifactId });
    if (status.status === "applied" || status.status === "failed") return status;
    const current = await readWebPublicationControl({ controlPath: webPublicationControlPath(worktree), expectedTarget: record.payload.target });
    if (current?.current.artifactId !== record.payload.codeRelease.baseArtifactId) throw new Error("Code publication base changed");
    const pending = path.join(spool(worktree), "pending", `${record.requestId}.json`);
    // A retry after durable handoff already has a queue reference; no reservation is needed.
    try { await fs.access(pending); return summary(record, "pending"); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
    await assertCodePublicationIdle(worktree);
    await assertBuiltSource(worktree, record.payload.codeRelease);
    writeWebReloadRequestSync(record.payload, { spoolDir: spool(worktree), reservation: { worktree, reservationToken: record.reservationToken, requireActive: true } });
    return summary(record, "pending");
  } finally { release(); }
}

export async function readCodeWebPublicationStatus({ worktree = process.cwd(), env = process.env, artifactId } = {}) {
  worktree = path.resolve(worktree);
  const record = await readPrepared(worktree, env, artifactId);
  const { payload } = record;
  const publication = await readWebReloadPublication({ kind: "code", artifactId, codeRelease: payload.codeRelease, target: payload.target, requestId: record.requestId, requestedAt: payload.buildCompletedAt }, { spoolDir: spool(worktree) });
  const control = await readWebPublicationControl({ controlPath: webPublicationControlPath(worktree), expectedTarget: payload.target });
  const exactCurrent = control?.committedRequestId === record.requestId && control.current.kind === "code"
    && control.current.artifactId === artifactId && codeReleasesMatch(control.current.codeRelease, payload.codeRelease);
  return summary(record, publication.status === "applied" && !exactCurrent ? "failed" : publication.status);
}
