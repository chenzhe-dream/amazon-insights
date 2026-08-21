import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertWithin(parent, candidate) {
  if (!isWithin(parent, candidate)) throw new Error("Invalid Web artifact path");
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
    return Object.freeze({ id: "current", root: resolvedArtifactRoot });
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
    return Object.freeze({ id, root: destination });
  }

  return Object.freeze({ current, resolveArtifactPath, snapshot });
}
