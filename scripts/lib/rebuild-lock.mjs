import fs from "node:fs";
import path from "node:path";

export const REBUILD_LOCK_STALE_MS = 60 * 60 * 1_000;

export function rebuildLockPath(worktree) {
  return path.join(path.resolve(worktree), "data", ".rebuild-lock.json");
}

function validOwner(owner) {
  return typeof owner === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(owner);
}

function parseLock(serialized) {
  try {
    const value = JSON.parse(serialized);
    if (
      value?.version !== 1
      || !validOwner(value.owner)
      || typeof value.startedAt !== "string"
      || Number.isNaN(Date.parse(value.startedAt))
    ) return null;
    return Object.freeze({ version: 1, owner: value.owner, startedAt: value.startedAt });
  } catch {
    return null;
  }
}

export function readRebuildLockSync(worktree) {
  try { return parseLock(fs.readFileSync(rebuildLockPath(worktree), "utf8")); }
  catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function readRebuildLock(worktree) {
  return readRebuildLockSync(worktree);
}

export function releaseRebuildLockSync(worktree, owner) {
  if (!validOwner(owner)) return false;
  const lockFile = rebuildLockPath(worktree);
  let current;
  try { current = parseLock(fs.readFileSync(lockFile, "utf8")); }
  catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  if (current?.owner !== owner) return false;
  try {
    fs.unlinkSync(lockFile);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function releaseRebuildLock(worktree, owner) {
  return releaseRebuildLockSync(worktree, owner);
}

function tryCreate(worktree, owner, now) {
  const lockFile = rebuildLockPath(worktree);
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const startedAt = now().toISOString();
  try {
    fs.writeFileSync(lockFile, JSON.stringify({ version: 1, owner, startedAt }), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    return Object.freeze({ acquired: true, owner, startedAt, lockFile });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    return null;
  }
}

export function claimRebuildLockSync(worktree, {
  owner,
  now = () => new Date(),
  staleMs = REBUILD_LOCK_STALE_MS,
} = {}) {
  if (!validOwner(owner)) throw new Error("Invalid rebuild lock owner");
  if (!Number.isSafeInteger(staleMs) || staleMs < 30 * 60 * 1_000) {
    throw new Error("Invalid rebuild lock stale threshold");
  }
  const created = tryCreate(worktree, owner, now);
  if (created) return created;
  const existing = readRebuildLockSync(worktree);
  const age = existing ? now().getTime() - Date.parse(existing.startedAt) : 0;
  if (existing && age > staleMs && releaseRebuildLockSync(worktree, existing.owner)) {
    const reclaimed = tryCreate(worktree, owner, now);
    if (reclaimed) return reclaimed;
  }
  return Object.freeze({
    acquired: false,
    owner: existing?.owner ?? null,
    startedAt: existing?.startedAt ?? null,
    lockFile: rebuildLockPath(worktree),
  });
}

export async function claimRebuildLock(worktree, options) {
  return claimRebuildLockSync(worktree, options);
}
