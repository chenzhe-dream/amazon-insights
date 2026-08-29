import { createHash, randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { acquireInterprocessLock, acquireInterprocessLockSync } from "./interprocess-lock.mjs";
import {
  commitWebPublicationControl,
  readWebPublicationControlSync,
  webPublicationControlPath,
} from "./web-publication-control.mjs";

const PROJECTABLE_SYNC_STAGES = new Set([
  "keywords", "reviews", "sales_trend", "fba", "listing", "category", "traffic", "alexa_voc",
]);
export const DEFAULT_WEB_BUILD_LOCK_WAIT_MS = 15 * 60 * 1_000;
export const MAX_WEB_RUNTIME_ARTIFACTS = 8;
export const MAX_WEB_RUNTIME_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_WEB_BUILD_LOCK_RETRY_MS = 100;
const WEB_ARTIFACT_RESERVATION_LEASE_MS = 35 * 60 * 1_000;

function artifactLockPath(worktree) {
  return path.join(path.resolve(worktree), "data", "web-runtime-artifacts", ".build-artifact.lock");
}

function reservationPath(worktree, artifactId, token) {
  return path.join(
    path.resolve(worktree),
    "data",
    "web-runtime-artifacts",
    ".reservations",
    `${artifactId}-${token}.json`,
  );
}

function manualRecoveryPath(worktree) {
  return path.join(path.resolve(worktree), "data", "web-runtime-artifacts", "manual-recovery.json");
}

function hasErrorCode(error, code) {
  for (let current = error; current; current = current.cause) {
    if (current.code === code) return true;
  }
  return false;
}

function assertNoManualRecovery(worktree) {
  try {
    fsSync.accessSync(manualRecoveryPath(worktree));
    throw new Error("Web artifact store requires manual recovery");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function markManualRecovery(worktree) {
  const file = manualRecoveryPath(worktree);
  const temporary = `${file}.tmp-${randomUUID()}`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(temporary, JSON.stringify({
    version: 1,
    reason: "process-tree-termination-unconfirmed",
    pid: process.pid,
    createdAt: new Date().toISOString(),
  }), { encoding: "utf8", flag: "wx", mode: 0o600 });
  try { await fs.rename(temporary, file); }
  catch (error) { await fs.rm(temporary, { force: true }); throw error; }
}

function reservationRecord(worktree, artifactId, token, temporaryName, now = new Date()) {
  return {
    version: 1,
    artifactId,
    token,
    pid: process.pid,
    worktree: path.resolve(worktree),
    temporaryName,
    createdAt: now.toISOString(),
    leaseExpiresAt: new Date(now.getTime() + WEB_ARTIFACT_RESERVATION_LEASE_MS).toISOString(),
  };
}

function parseReservation(value, worktree, artifactId) {
  if (
    value?.version !== 1
    || value.artifactId !== artifactId
    || typeof value.token !== "string"
    || !/^[a-f0-9-]{36}$/.test(value.token)
    || !Number.isSafeInteger(value.pid)
    || value.pid < 1
    || value.worktree !== path.resolve(worktree)
    || (value.temporaryName !== null && !/^\.publication-[a-f0-9]{64}\.tmp-[a-f0-9-]{36}$/.test(value.temporaryName))
    || Number.isNaN(Date.parse(value.createdAt))
    || Number.isNaN(Date.parse(value.leaseExpiresAt))
  ) throw new Error("Invalid Web artifact reservation");
  return value;
}

async function createReservation(worktree, artifactId, temporaryName) {
  const token = randomUUID();
  const file = reservationPath(worktree, artifactId, token);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${randomUUID()}`;
  await fs.writeFile(temporary, JSON.stringify(reservationRecord(worktree, artifactId, token, temporaryName)), {
    encoding: "utf8", flag: "wx", mode: 0o600,
  });
  try { await fs.rename(temporary, file); }
  catch (error) { await fs.rm(temporary, { force: true }); throw error; }
  return token;
}

function finalizeReservationUnlocked({ worktree, artifactId, reservationToken }) {
  assertArtifactId(artifactId);
  const file = reservationPath(worktree, artifactId, reservationToken);
  let value;
  try { value = parseReservation(JSON.parse(fsSync.readFileSync(file, "utf8")), worktree, artifactId); }
  catch (error) { if (error?.code === "ENOENT") return false; throw error; }
  if (value.token !== reservationToken) throw new Error("Web artifact reservation was fenced");
  fsSync.rmSync(file, { force: true });
  return true;
}

export async function finalizeWebArtifactReservation({ worktree, artifactId, reservationToken }) {
  const release = await acquireInterprocessLock(artifactLockPath(worktree));
  try { return finalizeReservationUnlocked({ worktree, artifactId, reservationToken }); }
  finally { release(); }
}

export function finalizeWebArtifactReservationSync({ worktree, artifactId, reservationToken }) {
  const release = acquireInterprocessLockSync(artifactLockPath(worktree));
  try { return finalizeReservationUnlocked({ worktree, artifactId, reservationToken }); }
  finally { release(); }
}

export function establishWebArtifactReferenceSync({ worktree, artifactId, reservationToken, write }) {
  if (typeof write !== "function") throw new Error("Web artifact reference writer is required");
  const release = acquireInterprocessLockSync(artifactLockPath(worktree));
  try {
    const result = write();
    finalizeReservationUnlocked({ worktree, artifactId, reservationToken });
    return result;
  } finally { release(); }
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertWithin(parent, candidate) {
  if (!isWithin(parent, candidate)) throw new Error("Invalid Web artifact path");
}

function assertArtifactId(artifactId) {
  if (typeof artifactId !== "string" || !/^[a-f0-9]{64}$/.test(artifactId)) {
    throw new Error("Invalid Web artifact identity");
  }
}

function validateStageContentHashes(value, message) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  const entries = Object.entries(value);
  if (!entries.length || entries.some(([stage, hash]) =>
    !PROJECTABLE_SYNC_STAGES.has(stage) || typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)
  )) throw new Error(message);
  return Object.freeze(Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right))));
}

function parseManifest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Web artifact manifest");
  }
  if (
    Object.keys(value).sort().join(",") !== "artifactId,jobId,jobVersion,stageContentHashes,version" ||
    value.version !== 2
  ) {
    throw new Error("Invalid Web artifact manifest");
  }
  try {
    assertArtifactId(value.artifactId);
    if (typeof value.jobId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(value.jobId)) throw new Error();
    if (!Number.isSafeInteger(value.jobVersion) || value.jobVersion < 1) throw new Error();
    const stageContentHashes = validateStageContentHashes(value.stageContentHashes, "Invalid Web artifact manifest");
    return Object.freeze({
      artifactId: value.artifactId,
      jobId: value.jobId,
      jobVersion: value.jobVersion,
      stageContentHashes,
    });
  } catch {
    throw new Error("Invalid Web artifact manifest");
  }
}

function parseCurrentManifest(value) {
  if (
    value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === "artifactId,version" &&
    value.version === 1
  ) {
    try {
      assertArtifactId(value.artifactId);
      return Object.freeze({ artifactId: value.artifactId });
    } catch {
      throw new Error("Invalid Web artifact manifest");
    }
  }
  return parseManifest(value);
}

export function createWebPublicationArtifactId() {
  return createHash("sha256").update(randomUUID()).digest("hex");
}

async function resolveWritableArtifactRoot(worktree) {
  const resolvedWorktree = path.resolve(worktree);
  const artifactRoot = path.join(resolvedWorktree, "dist");
  try {
    await fs.lstat(artifactRoot);
  } catch (error) {
    if (error?.code !== "ENOENT") throw new Error("Invalid Web artifact path");
    await fs.mkdir(artifactRoot, { recursive: true });
  }
  try {
    const info = await fs.lstat(artifactRoot);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Invalid Web artifact path");
    assertWithin(await fs.realpath(resolvedWorktree), await fs.realpath(artifactRoot));
  } catch (error) {
    if (error?.message === "Invalid Web artifact path") throw error;
    throw new Error("Invalid Web artifact path");
  }
  return artifactRoot;
}

async function directoryBytes(target, budget = { entries: 100_000, bytes: MAX_WEB_RUNTIME_ARTIFACT_BYTES }) {
  const entries = await fs.readdir(target, { withFileTypes: true });
  let total = 0;
  for (const entry of entries) {
    budget.entries -= 1;
    if (budget.entries < 0 || entry.isSymbolicLink()) throw new Error("Web runtime artifact quota exceeded");
    const child = path.join(target, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(child, budget);
    else if (entry.isFile()) {
      const size = (await fs.stat(child)).size;
      total += size;
      budget.bytes -= size;
      if (budget.bytes < 0) throw new Error("Web runtime artifact quota exceeded");
    } else throw new Error("Invalid Web artifact path");
  }
  return total;
}

function managedRuntimeName(name) {
  return /^(?:snapshot-\d+-[a-f0-9-]+|publication-[a-f0-9]{64}|\.(?:publication-[a-f0-9]{64}|snapshot-\d+-[a-f0-9-]+)\.tmp-[a-f0-9-]{36})$/.test(name);
}

async function managedRuntimeArtifacts(runtimeDir) {
  let entries;
  try { entries = await fs.readdir(runtimeDir, { withFileTypes: true }); }
  catch (error) { if (error?.code === "ENOENT") return []; throw error; }
  return Promise.all(entries.filter((entry) => managedRuntimeName(entry.name)).map(async (entry) => {
    const root = path.join(runtimeDir, entry.name);
    const info = await fs.lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Invalid Web artifact path");
    return Object.freeze({
      root,
      name: entry.name,
      temporary: entry.name.startsWith("."),
      modifiedAt: info.mtimeMs,
    });
  }));
}

async function existingExactArtifact(runtimeDir, destination, expected) {
  try {
    const info = await fs.lstat(destination);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Invalid Web artifact path");
    const resolvedRoot = await fs.realpath(destination);
    assertWithin(await fs.realpath(runtimeDir), resolvedRoot);
    const manifest = parseManifest(JSON.parse(await fs.readFile(path.join(resolvedRoot, "web-artifact.json"), "utf8")));
    if (
      manifest.artifactId !== expected.artifactId
      || manifest.jobId !== expected.jobId
      || manifest.jobVersion !== expected.jobVersion
      || JSON.stringify(manifest.stageContentHashes) !== JSON.stringify(expected.stageContentHashes)
    ) throw new Error("Web publication artifact already exists with different content");
    return Object.freeze({
      id: expected.artifactId,
      root: resolvedRoot,
      jobId: expected.jobId,
      jobVersion: expected.jobVersion,
      stageContentHashes: expected.stageContentHashes,
    });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function writeCurrentWebArtifact({ worktree, artifactId, jobId, jobVersion, stageContentHashes }) {
  assertArtifactId(artifactId);
  const manifest = parseManifest({ version: 2, artifactId, jobId, jobVersion, stageContentHashes });
  const artifactRoot = await resolveWritableArtifactRoot(worktree);
  const destination = path.join(artifactRoot, "web-artifact.json");
  const temporary = `${destination}.tmp-${randomUUID()}`;
  await fs.mkdir(artifactRoot, { recursive: true });
  try {
    await fs.writeFile(temporary, JSON.stringify({ version: 2, ...manifest }), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await fs.rename(temporary, destination);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

export async function publishImmutableWebArtifact({
  worktree,
  artifactId,
  jobId,
  jobVersion,
  stageContentHashes,
  build,
  afterArtifactRename,
  writeManifest = writeCurrentWebArtifact,
  buildLockWaitMs = DEFAULT_WEB_BUILD_LOCK_WAIT_MS,
  buildLockRetryMs = DEFAULT_WEB_BUILD_LOCK_RETRY_MS,
}) {
  assertArtifactId(artifactId);
  if (!Number.isSafeInteger(buildLockWaitMs) || buildLockWaitMs < 1) {
    throw new Error("Invalid Web build lock wait");
  }
  if (!Number.isSafeInteger(buildLockRetryMs) || buildLockRetryMs < 1) {
    throw new Error("Invalid Web build lock retry");
  }
  if (afterArtifactRename !== undefined && typeof afterArtifactRename !== "function") {
    throw new Error("Invalid Web artifact rename hook");
  }
  const resolvedWorktree = path.resolve(worktree);
  const runtimeDir = path.join(resolvedWorktree, "data", "web-runtime-artifacts");
  const release = await acquireInterprocessLock(artifactLockPath(resolvedWorktree), {
    attempts: Math.ceil(buildLockWaitMs / buildLockRetryMs),
    retryMs: buildLockRetryMs,
  });
  const destination = path.join(runtimeDir, `publication-${artifactId}`);
  const temporary = path.join(runtimeDir, `.publication-${artifactId}.tmp-${randomUUID()}`);
  const expected = {
    artifactId,
    jobId,
    jobVersion,
    stageContentHashes: validateStageContentHashes(stageContentHashes, "Invalid Web artifact manifest"),
  };
  let reservationToken = null;
  try {
    assertNoManualRecovery(resolvedWorktree);
    reservationToken = await createReservation(resolvedWorktree, artifactId, path.basename(temporary));
    const existing = await existingExactArtifact(runtimeDir, destination, expected);
    if (existing) return Object.freeze({ ...existing, reservationToken });
    await fs.mkdir(runtimeDir, { recursive: true });
    const runtimeArtifacts = await managedRuntimeArtifacts(runtimeDir);
    if (runtimeArtifacts.length >= MAX_WEB_RUNTIME_ARTIFACTS) throw new Error("Web runtime artifact quota exceeded");
    await build();
    const artifactRoot = await resolveWritableArtifactRoot(resolvedWorktree);
    const existingBytes = (await Promise.all(runtimeArtifacts.map((entry) => directoryBytes(entry.root))))
      .reduce((sum, size) => sum + size, 0);
    const candidateBytes = await directoryBytes(artifactRoot);
    if (existingBytes + candidateBytes > MAX_WEB_RUNTIME_ARTIFACT_BYTES) {
      throw new Error("Web runtime artifact quota exceeded");
    }
    await writeManifest({ worktree, artifactId, jobId, jobVersion, stageContentHashes });
    try {
      await fs.access(destination);
      throw new Error("Web publication artifact already exists");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await fs.cp(artifactRoot, temporary, { recursive: true, errorOnExist: true });
    await fs.rename(temporary, destination);
    await afterArtifactRename?.();
    return Object.freeze({
      id: artifactId,
      root: destination,
      jobId,
      jobVersion,
      stageContentHashes: expected.stageContentHashes,
      reservationToken,
    });
  } catch (error) {
    if (hasErrorCode(error, "EPROCESSTREE")) await markManualRecovery(resolvedWorktree);
    await fs.rm(temporary, { recursive: true, force: true });
    if (reservationToken) {
      try { finalizeReservationUnlocked({ worktree: resolvedWorktree, artifactId, reservationToken }); } catch {}
    }
    throw error;
  } finally {
    release();
  }
}

export function createWebArtifactStore({
  worktree,
  artifactRoot = path.join(worktree, "dist"),
  runtimeDir = path.join(worktree, "data", "web-runtime-artifacts"),
  maxSnapshots = 2,
} = {}) {
  const resolvedWorktree = path.resolve(worktree);
  const resolvedArtifactRoot = path.resolve(artifactRoot);
  const resolvedRuntimeDir = path.resolve(runtimeDir);
  assertWithin(resolvedWorktree, resolvedArtifactRoot);
  assertWithin(resolvedWorktree, resolvedRuntimeDir);
  if (!Number.isSafeInteger(maxSnapshots) || maxSnapshots < 1 || maxSnapshots > 5) {
    throw new Error("Invalid Web artifact retention");
  }

  function current(expectedTarget) {
    const durable = readWebPublicationControlSync({
      controlPath: webPublicationControlPath(resolvedWorktree),
      expectedTarget,
    });
    if (durable) {
      const persisted = storedArtifact(durable.current.storageName);
      if (
        persisted.jobId !== durable.current.jobId
        || persisted.jobVersion !== durable.current.jobVersion
        || JSON.stringify(persisted.stageContentHashes) !== JSON.stringify(durable.current.stageContentHashes)
      ) throw new Error("Invalid durable Web publication current");
      return persisted;
    }
    const manifest = path.join(resolvedArtifactRoot, "web-artifact.json");
    let serialized;
    try {
      fsSync.lstatSync(manifest);
      const resolvedManifest = fsSync.realpathSync(manifest);
      assertWithin(resolvedWorktree, resolvedManifest);
      serialized = fsSync.readFileSync(resolvedManifest, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return Object.freeze({ id: "legacy", root: resolvedArtifactRoot });
      if (error?.message === "Invalid Web artifact path") throw new Error("Invalid Web artifact manifest");
      throw new Error("Invalid Web artifact manifest");
    }
    try {
      const parsed = parseCurrentManifest(JSON.parse(serialized));
      return Object.freeze({
        id: parsed.artifactId,
        root: resolvedArtifactRoot,
        ...(parsed.jobId ? {
          jobId: parsed.jobId,
          jobVersion: parsed.jobVersion,
          stageContentHashes: parsed.stageContentHashes,
        } : {}),
      });
    } catch {
      throw new Error("Invalid Web artifact manifest");
    }
  }

  function candidate(request) {
    assertArtifactId(request?.artifactId);
    return storedArtifact(`publication-${request.artifactId}`);
  }

  function storedArtifact(storageName) {
    if (typeof storageName !== "string" || !(/^(?:publication-[a-f0-9]{64}|snapshot-\d+-[a-f0-9-]+)$/.test(storageName))) {
      throw new Error("Invalid Web artifact manifest");
    }
    const root = path.join(resolvedRuntimeDir, storageName);
    assertWithin(resolvedRuntimeDir, root);
    const manifest = path.join(root, "web-artifact.json");
    try {
      const info = fsSync.lstatSync(root);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error();
      const resolvedRoot = fsSync.realpathSync(root);
      assertWithin(resolvedRuntimeDir, resolvedRoot);
      const parsed = parseManifest(JSON.parse(fsSync.readFileSync(manifest, "utf8")));
      return Object.freeze({
        id: parsed.artifactId,
        root: resolvedRoot,
        jobId: parsed.jobId,
        jobVersion: parsed.jobVersion,
        stageContentHashes: parsed.stageContentHashes,
      });
    } catch {
      throw new Error("Invalid Web artifact manifest");
    }
  }

  function resolveArtifactPath(artifact) {
    if (!artifact || typeof artifact !== "object" || typeof artifact.id !== "string" || typeof artifact.root !== "string") {
      throw new Error("Invalid Web artifact");
    }
    const resolved = path.resolve(artifact.root);
    if (resolved !== resolvedArtifactRoot) assertWithin(resolvedRuntimeDir, resolved);
    return resolved;
  }

  async function bootstrapCurrent(artifact, target) {
    const root = resolveArtifactPath(artifact);
    if (root === resolvedArtifactRoot) throw new Error("Immutable Web bootstrap artifact is required");
    const storageName = path.basename(root);
    const persisted = storedArtifact(storageName);
    const requestId = createHash("sha256").update(JSON.stringify({
      target,
      storageName,
      artifactId: persisted.id,
      jobId: persisted.jobId,
      jobVersion: persisted.jobVersion,
      stageContentHashes: persisted.stageContentHashes,
    })).digest("hex");
    await commitWebPublicationControl({
      controlPath: webPublicationControlPath(resolvedWorktree),
      requestId,
      payload: {
        target,
        storageName,
        artifactId: persisted.id,
        jobId: persisted.jobId,
        jobVersion: persisted.jobVersion,
        stageContentHashes: persisted.stageContentHashes,
      },
    });
    return persisted;
  }

  async function reservedRoots() {
    const roots = new Set();
    const reservations = path.join(resolvedRuntimeDir, ".reservations");
    let names = [];
    try { names = await fs.readdir(reservations); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
    for (const name of names.filter((entry) => /^[a-f0-9]{64}-[a-f0-9-]{36}\.json$/.test(entry))) {
      const artifactId = name.slice(0, 64);
      const file = path.join(reservations, name);
      let record;
      try { record = parseReservation(JSON.parse(await fs.readFile(file, "utf8")), resolvedWorktree, artifactId); }
      catch {
        throw new Error("Invalid Web artifact reservation");
      }
      const active = Date.parse(record.leaseExpiresAt) > Date.now();
      const destination = path.join(resolvedRuntimeDir, `publication-${artifactId}`);
      const temporary = record.temporaryName ? path.join(resolvedRuntimeDir, record.temporaryName) : null;
      if (active) {
        roots.add(destination);
        if (temporary) roots.add(temporary);
      } else {
        await fs.rm(file, { force: true });
        if (temporary) await fs.rm(temporary, { recursive: true, force: true });
      }
    }
    return roots;
  }

  async function queuedArtifactRoots() {
    const roots = new Set();
    const spool = path.join(resolvedWorktree, "data", "web-reload-requests");
    for (const directoryName of ["pending", "processing"]) {
      const directory = path.join(spool, directoryName);
      let names = [];
      try { names = await fs.readdir(directory); }
      catch (error) { if (error?.code !== "ENOENT") throw error; }
      for (const name of names.filter((entry) => entry.endsWith(".json"))) {
        try {
          const value = JSON.parse(await fs.readFile(path.join(directory, name), "utf8"));
          if (typeof value?.artifactId === "string" && /^[a-f0-9]{64}$/.test(value.artifactId)) {
            roots.add(path.join(resolvedRuntimeDir, `publication-${value.artifactId}`));
          }
        } catch {}
      }
    }
    return roots;
  }

  async function pruneUnlocked({ protectedArtifacts = [] } = {}) {
    if (!Array.isArray(protectedArtifacts)) throw new Error("Invalid Web artifact retention");
    const protectedRoots = new Set(protectedArtifacts.map((artifact) => resolveArtifactPath(artifact)));
    const durable = readWebPublicationControlSync({ controlPath: webPublicationControlPath(resolvedWorktree) });
    if (durable) protectedRoots.add(path.join(resolvedRuntimeDir, durable.current.storageName));
    for (const root of await reservedRoots()) protectedRoots.add(root);
    for (const root of await queuedArtifactRoots()) protectedRoots.add(root);
    const candidates = await managedRuntimeArtifacts(resolvedRuntimeDir);
    const protectedCount = candidates.filter(({ root }) => protectedRoots.has(root)).length;
    let unprotectedToKeep = Math.max(0, maxSnapshots - protectedCount);
    const removals = candidates
      .filter(({ root }) => !protectedRoots.has(root))
      .sort((left, right) => right.modifiedAt - left.modifiedAt || right.root.localeCompare(left.root))
      .filter(({ temporary }) => {
        if (temporary) return true;
        if (unprotectedToKeep > 0) {
          unprotectedToKeep -= 1;
          return false;
        }
        return true;
      });
    await Promise.all(removals.map(({ root }) => fs.rm(root, { recursive: true, force: true })));
  }

  async function prune(options = {}) {
    const release = await acquireInterprocessLock(artifactLockPath(resolvedWorktree));
    try {
      assertNoManualRecovery(resolvedWorktree);
      return await pruneUnlocked(options);
    }
    finally { release(); }
  }

  async function snapshot(artifact = current()) {
    const release = await acquireInterprocessLock(artifactLockPath(resolvedWorktree));
    try {
    assertNoManualRecovery(resolvedWorktree);
    const source = resolveArtifactPath(artifact);
    const publicationArtifactId = artifact?.publicationArtifactId;
    if (publicationArtifactId !== undefined) assertArtifactId(publicationArtifactId);
    const hasReconciliation = artifact.jobId !== undefined || artifact.jobVersion !== undefined || artifact.stageContentHashes !== undefined;
    const reconciliation = hasReconciliation
      ? parseManifest({
          version: 2,
          artifactId: publicationArtifactId ?? artifact.id,
          jobId: artifact.jobId,
          jobVersion: artifact.jobVersion,
          stageContentHashes: artifact.stageContentHashes,
        })
      : null;
    await fs.access(source);
    await fs.mkdir(resolvedRuntimeDir, { recursive: true });
    await pruneUnlocked({ protectedArtifacts: [artifact] });
    const runtimeArtifacts = await managedRuntimeArtifacts(resolvedRuntimeDir);
    if (runtimeArtifacts.length >= MAX_WEB_RUNTIME_ARTIFACTS) throw new Error("Web runtime artifact quota exceeded");
    const existingBytes = (await Promise.all(runtimeArtifacts.map(({ root }) => directoryBytes(root))))
      .reduce((sum, size) => sum + size, 0);
    if (existingBytes + await directoryBytes(source) > MAX_WEB_RUNTIME_ARTIFACT_BYTES) {
      throw new Error("Web runtime artifact quota exceeded");
    }
    const id = `snapshot-${Date.now()}-${randomUUID()}`;
    const temporary = path.join(resolvedRuntimeDir, `.${id}.tmp-${randomUUID()}`);
    const destination = path.join(resolvedRuntimeDir, id);
    assertWithin(resolvedRuntimeDir, temporary);
    assertWithin(resolvedRuntimeDir, destination);
    try {
      await fs.cp(source, temporary, { recursive: true, errorOnExist: true });
      await fs.rename(temporary, destination);
    } catch (error) {
      await fs.rm(temporary, { recursive: true, force: true });
      throw error;
    }
    const result = Object.freeze({
      id,
      root: destination,
      ...(publicationArtifactId ? { publicationArtifactId } : {}),
      ...(reconciliation ? {
        jobId: reconciliation.jobId,
        jobVersion: reconciliation.jobVersion,
        stageContentHashes: reconciliation.stageContentHashes,
      } : {}),
    });
    await pruneUnlocked({ protectedArtifacts: [result] });
    return result;
    } finally { release(); }
  }

  return Object.freeze({ current, candidate, bootstrapCurrent, resolveArtifactPath, prune, snapshot });
}
