import { createHash, randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { acquireInterprocessLock } from "./interprocess-lock.mjs";

const PROJECTABLE_SYNC_STAGES = new Set([
  "keywords", "reviews", "sales_trend", "fba", "listing", "category", "traffic",
]);

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
  writeManifest = writeCurrentWebArtifact,
  lockOptions,
}) {
  assertArtifactId(artifactId);
  const resolvedWorktree = path.resolve(worktree);
  const runtimeDir = path.join(resolvedWorktree, "data", "web-runtime-artifacts");
  const release = await acquireInterprocessLock(path.join(runtimeDir, ".build-artifact.lock"), lockOptions);
  const destination = path.join(runtimeDir, `publication-${artifactId}`);
  const temporary = path.join(runtimeDir, `.publication-${artifactId}.tmp-${randomUUID()}`);
  try {
    await build();
    await writeManifest({ worktree, artifactId, jobId, jobVersion, stageContentHashes });
    const artifactRoot = await resolveWritableArtifactRoot(resolvedWorktree);
    try {
      await fs.access(destination);
      throw new Error("Web publication artifact already exists");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await fs.cp(artifactRoot, temporary, { recursive: true, errorOnExist: true });
    await fs.rename(temporary, destination);
    return Object.freeze({
      id: artifactId,
      root: destination,
      jobId,
      jobVersion,
      stageContentHashes: validateStageContentHashes(stageContentHashes, "Invalid Web artifact manifest"),
    });
  } catch (error) {
    await fs.rm(temporary, { recursive: true, force: true });
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

  function current() {
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
      const parsed = parseManifest(JSON.parse(serialized));
      return Object.freeze({
        id: parsed.artifactId,
        root: resolvedArtifactRoot,
        jobId: parsed.jobId,
        jobVersion: parsed.jobVersion,
        stageContentHashes: parsed.stageContentHashes,
      });
    } catch {
      throw new Error("Invalid Web artifact manifest");
    }
  }

  function candidate(request) {
    assertArtifactId(request?.artifactId);
    const root = path.join(resolvedRuntimeDir, `publication-${request.artifactId}`);
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

  async function prune() {
    const names = (await fs.readdir(resolvedRuntimeDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && /^snapshot-\d+-[a-f0-9-]+$/.test(entry.name))
      .map((entry) => entry.name)
      .sort()
      .reverse();
    await Promise.all(names.slice(maxSnapshots).map(async (name) => {
      const snapshotPath = path.join(resolvedRuntimeDir, name);
      assertWithin(resolvedRuntimeDir, snapshotPath);
      await fs.rm(snapshotPath, { recursive: true, force: true });
    }));
  }

  async function snapshot(artifact = current()) {
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
    await prune();
    return Object.freeze({
      id,
      root: destination,
      ...(publicationArtifactId ? { publicationArtifactId } : {}),
      ...(reconciliation ? {
        jobId: reconciliation.jobId,
        jobVersion: reconciliation.jobVersion,
        stageContentHashes: reconciliation.stageContentHashes,
      } : {}),
    });
  }

  return Object.freeze({ current, candidate, resolveArtifactPath, snapshot });
}
