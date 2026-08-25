import { createHash, randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

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

function parseManifest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Web artifact manifest");
  }
  if (Object.keys(value).sort().join(",") !== "artifactId,version" || value.version !== 1) {
    throw new Error("Invalid Web artifact manifest");
  }
  try {
    assertArtifactId(value.artifactId);
  } catch {
    throw new Error("Invalid Web artifact manifest");
  }
  return value.artifactId;
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

export async function writeCurrentWebArtifact({ worktree, artifactId }) {
  assertArtifactId(artifactId);
  const artifactRoot = await resolveWritableArtifactRoot(worktree);
  const destination = path.join(artifactRoot, "web-artifact.json");
  const temporary = `${destination}.tmp-${randomUUID()}`;
  await fs.mkdir(artifactRoot, { recursive: true });
  try {
    await fs.writeFile(temporary, JSON.stringify({ version: 1, artifactId }), {
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
      return Object.freeze({ id: parseManifest(JSON.parse(serialized)), root: resolvedArtifactRoot });
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
    });
  }

  return Object.freeze({ current, resolveArtifactPath, snapshot });
}
