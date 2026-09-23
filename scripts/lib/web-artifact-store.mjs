import { createHash, randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { assertCodeOnly, boundedCodeSource, codeReleasesMatch, validateCodeRelease } from "./code-publication-identity.mjs";
import { assertBuiltCodeSource, readCodeSourceIdentity } from "./code-source-identity.mjs";
import {
  acquireInterprocessLock,
  acquireInterprocessLockSync,
  quarantineInterprocessLockOwnersSync,
} from "./interprocess-lock.mjs";
import {
  commitWebPublicationControl,
  readWebPublicationControlSync,
  webPublicationControlPath,
} from "./web-publication-control.mjs";

const PROJECTABLE_SYNC_STAGES = new Set([
  "keywords", "reviews", "sales_trend", "child_sales", "price_strategy",
  "fba", "listing", "image_remarks", "category", "traffic", "alexa_voc",
]);
export const DEFAULT_WEB_BUILD_LOCK_WAIT_MS = 15 * 60 * 1_000;
export const MAX_WEB_RUNTIME_ARTIFACTS = 8;
export const MAX_WEB_RUNTIME_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_WEB_BUILD_LOCK_RETRY_MS = 100;
const WEB_ARTIFACT_RESERVATION_LEASE_MS = 35 * 60 * 1_000;
const MANUAL_RECOVERY_LOCK_WAIT_MS = 35 * 60 * 1_000;
const MANUAL_RECOVERY_LOCK_RETRY_MS = 100;
const STRICT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_LEGACY_MANUAL_RECOVERY_IDENTITIES = 256;
const INTENT_TEMP = /^\.intent-([0-9a-f-]{36})\.tmp-([0-9a-f-]{36})\.json$/;

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

function manualRecoveryIntentDirectory(worktree) {
  return path.join(path.resolve(worktree), "data", "web-runtime-artifacts", ".manual-recovery-intents");
}

function manualRecoveryClearanceDirectory(worktree) {
  return path.join(path.resolve(worktree), "data", "web-runtime-artifacts", ".manual-recovery-clearances");
}

function manualRecoveryIntentPath(worktree, token) {
  if (!STRICT_UUID.test(token)) throw new Error("Invalid Web artifact manual recovery token");
  return path.join(manualRecoveryIntentDirectory(worktree), `${token}.json`);
}

function manualRecoveryClearancePath(worktree, token) {
  if (!STRICT_UUID.test(token)) throw new Error("Invalid Web artifact manual recovery token");
  return path.join(manualRecoveryClearanceDirectory(worktree), `${token}.json`);
}

function manualRecoveryIntentLockPath(worktree, token) {
  if (!STRICT_UUID.test(token)) throw new Error("Invalid Web artifact manual recovery token");
  return path.join(
    path.resolve(worktree), "data", "web-runtime-artifacts", ".manual-recovery-intent-locks", `${token}.lock`,
  );
}

function manualRecoveryIntentTempPath(worktree, token) {
  if (!STRICT_UUID.test(token)) throw new Error("Invalid Web artifact manual recovery token");
  return path.join(manualRecoveryIntentDirectory(worktree), `.intent-${token}.tmp-${randomUUID()}.json`);
}

function parseIntentTempName(name) {
  const match = INTENT_TEMP.exec(name);
  if (!match || !STRICT_UUID.test(match[1]) || !STRICT_UUID.test(match[2])) return null;
  return Object.freeze({ token: match[1], nonce: match[2] });
}

function syncDirectorySync(directory) {
  let descriptor;
  try { descriptor = fsSync.openSync(directory, "r"); fsSync.fsyncSync(descriptor); }
  catch (error) { if (!new Set(["EISDIR", "EINVAL", "EPERM", "EACCES"]).has(error?.code)) throw error; }
  finally { if (descriptor !== undefined) fsSync.closeSync(descriptor); }
}

function durablePublishSync(file, value) {
  fsSync.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${randomUUID()}`;
  let descriptor;
  try {
    descriptor = fsSync.openSync(temporary, "wx", 0o600);
    fsSync.writeFileSync(descriptor, JSON.stringify(value), "utf8");
    fsSync.fsyncSync(descriptor);
    fsSync.closeSync(descriptor);
    descriptor = undefined;
    fsSync.renameSync(temporary, file);
    syncDirectorySync(path.dirname(file));
  } catch (error) {
    if (descriptor !== undefined) fsSync.closeSync(descriptor);
    try { fsSync.rmSync(temporary, { force: true }); } catch {}
    throw error;
  }
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
  let names = [];
  try { names = fsSync.readdirSync(manualRecoveryIntentDirectory(worktree)); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  if (names.some((name) => STRICT_UUID.test(name.slice(0, -5)) && name.endsWith(".json") || parseIntentTempName(name))) {
    throw new Error("Web artifact store requires manual recovery");
  }
}

function parseTreeIdentity(value, worktree) {
  if (
    !Number.isSafeInteger(value?.pid) || value.pid < 1
    || typeof value.pidBirth !== "string" || value.pidBirth.length < 1 || value.pidBirth.length > 128
    || typeof value.command !== "string" || value.command.length < 1 || value.command.length > 2_048
    || value.worktreeId !== createHash("sha256").update(path.resolve(worktree)).digest("hex")
  ) throw new Error("Invalid Web artifact manual recovery marker");
  return Object.freeze({
    pid: value.pid, pidBirth: value.pidBirth, command: value.command, worktreeId: value.worktreeId,
  });
}

function markerIdentities(marker, worktree) {
  if (marker?.version !== 2 || marker.reason !== "process-tree-termination-unconfirmed") {
    throw new Error("Invalid Web artifact manual recovery marker");
  }
  if (Array.isArray(marker.treeIdentities)) {
    const legacy = marker.fences === undefined;
    if (
      !STRICT_UUID.test(marker.token)
      || marker.treeIdentities.length > (legacy ? MAX_LEGACY_MANUAL_RECOVERY_IDENTITIES : 32)
      || (marker.treeIdentities.length === 0 && marker.globalQuiescenceRequired !== true)
      || !new Set([undefined, true, false]).has(marker.globalQuiescenceRequired)
    ) {
      throw new Error("Invalid Web artifact manual recovery marker");
    }
    const identities = marker.treeIdentities.map((identity) => parseTreeIdentity(identity, worktree));
    if (legacy) {
      return Object.freeze({
        identities,
        fences: identities.length
          ? [Object.freeze({ token: marker.token, treeIdentity: identities[0] })]
          : [],
        globalQuiescenceRequired: marker.globalQuiescenceRequired === true || identities.length !== 1,
      });
    }
    const fences = marker.fences.map((fence) => {
          if (!STRICT_UUID.test(fence?.token)) throw new Error("Invalid Web artifact manual recovery marker");
          return Object.freeze({ token: fence.token, treeIdentity: parseTreeIdentity(fence.treeIdentity, worktree) });
        });
    const identityKeys = new Set(identities.map((identity) => JSON.stringify(identity)));
    const fenceIdentityKeys = new Set(fences.map((fence) => JSON.stringify(fence.treeIdentity)));
    if (
      fences.length > 32
      || new Set(fences.map((fence) => fence.token)).size !== fences.length
      || fences.some((fence) => !identityKeys.has(JSON.stringify(fence.treeIdentity)))
      || identities.some((identity) => !fenceIdentityKeys.has(JSON.stringify(identity)))
    ) throw new Error("Invalid Web artifact manual recovery marker");
    return Object.freeze({
      identities,
      fences,
      globalQuiescenceRequired: marker.globalQuiescenceRequired === true,
    });
  }
  if (marker.treeIdentity === null) {
    return Object.freeze({ identities: [], fences: [], globalQuiescenceRequired: true });
  }
  const treeIdentity = parseTreeIdentity(marker.treeIdentity, worktree);
  return Object.freeze({
    identities: [treeIdentity],
    fences: STRICT_UUID.test(marker.token) ? [Object.freeze({ token: marker.token, treeIdentity })] : [],
    globalQuiescenceRequired: false,
  });
}

function parseManualRecoveryIntent(value, worktree, expectedToken) {
  if (
    value?.version !== 1
    || value.reason !== "process-tree-termination-unconfirmed"
    || value.token !== expectedToken
    || !STRICT_UUID.test(value.token)
    || Number.isNaN(Date.parse(value.createdAt))
  ) throw new Error("Invalid Web artifact emergency recovery intent");
  return Object.freeze({
    token: value.token,
    treeIdentity: parseTreeIdentity(value.treeIdentity, worktree),
    createdAt: value.createdAt,
  });
}

function readManualRecoveryIntentsSync(worktree) {
  const directory = manualRecoveryIntentDirectory(worktree);
  let names = [];
  try { names = fsSync.readdirSync(directory); }
  catch (error) { if (error?.code === "ENOENT") return []; throw error; }
  return names.filter((name) => name.endsWith(".json") && STRICT_UUID.test(name.slice(0, -5))).map((name) => {
    const token = name.slice(0, -5);
    if (!STRICT_UUID.test(token)) throw new Error("Invalid Web artifact emergency recovery intent");
    return parseManualRecoveryIntent(JSON.parse(fsSync.readFileSync(path.join(directory, name), "utf8")), worktree, token);
  });
}

function readManualRecoveryIntentTempsSync(worktree, expectedToken) {
  const directory = manualRecoveryIntentDirectory(worktree);
  let names = [];
  try { names = fsSync.readdirSync(directory); }
  catch (error) { if (error?.code === "ENOENT") return []; throw error; }
  return names.flatMap((name) => {
    const parsed = parseIntentTempName(name);
    if (!parsed || expectedToken && parsed.token !== expectedToken) return [];
    return [Object.freeze({ ...parsed, file: path.join(directory, name) })];
  });
}

function parseManualRecoveryClearance(value, expectedToken) {
  if (
    value?.version !== 1
    || value.token !== expectedToken
    || !STRICT_UUID.test(value.token)
    || Number.isNaN(Date.parse(value.clearedAt))
  ) throw new Error("Invalid Web artifact manual recovery clearance");
  return Object.freeze({ token: value.token, clearedAt: value.clearedAt });
}

async function readManualRecoveryClearance(worktree, token) {
  try {
    return parseManualRecoveryClearance(
      JSON.parse(await fs.readFile(manualRecoveryClearancePath(worktree, token), "utf8")),
      token,
    );
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function readCompletedManualRecoveryIntent(worktree, token) {
  const file = manualRecoveryIntentPath(worktree, token);
  let lastError;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return parseManualRecoveryIntent(JSON.parse(await fs.readFile(file, "utf8")), worktree, token);
    } catch (error) {
      lastError = error;
      if (error?.code === "ENOENT") throw error;
      if (attempt < 99) await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError;
}

function flushRecoveryIntentTempSync(file) {
  let descriptor;
  try {
    descriptor = fsSync.openSync(file, "r+");
    fsSync.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fsSync.closeSync(descriptor);
  }
}

function recoverManualRecoveryIntentTempsUnlocked(worktree, token, {
  flush = flushRecoveryIntentTempSync,
  checkpoint = () => undefined,
} = {}) {
  const finalPath = manualRecoveryIntentPath(worktree, token);
  const temps = readManualRecoveryIntentTempsSync(worktree, token);
  if (temps.length === 0) return Object.freeze({ recovered: false, incomplete: false });
  let finalExists = false;
  try { fsSync.accessSync(finalPath); finalExists = true; }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  if (finalExists) {
    for (const temp of temps) fsSync.rmSync(temp.file, { force: true });
    syncDirectorySync(path.dirname(finalPath));
    return Object.freeze({ recovered: false, incomplete: false });
  }
  const valid = [];
  let incomplete = false;
  for (const temp of temps) {
    try {
      valid.push(Object.freeze({
        ...temp,
        intent: parseManualRecoveryIntent(JSON.parse(fsSync.readFileSync(temp.file, "utf8")), worktree, token),
      }));
    } catch { incomplete = true; }
  }
  const identities = new Set(valid.map(({ intent }) => JSON.stringify(intent.treeIdentity)));
  if (incomplete || identities.size > 1 || valid.length === 0) {
    return Object.freeze({ recovered: false, incomplete: true });
  }
  flush(valid[0].file);
  checkpoint("after-recovery-fsync");
  try { fsSync.linkSync(valid[0].file, finalPath); }
  catch (error) { if (error?.code !== "EEXIST") throw error; }
  syncDirectorySync(path.dirname(finalPath));
  for (const temp of temps) fsSync.rmSync(temp.file, { force: true });
  syncDirectorySync(path.dirname(finalPath));
  return Object.freeze({ recovered: true, incomplete: false });
}

async function recoverManualRecoveryIntentTemps(worktree, options) {
  const tokens = [...new Set(readManualRecoveryIntentTempsSync(worktree).map((temp) => temp.token))].sort();
  for (const token of tokens) {
    const release = await acquireInterprocessLock(manualRecoveryIntentLockPath(worktree, token));
    try { recoverManualRecoveryIntentTempsUnlocked(worktree, token, options); }
    finally { release(); }
  }
}

async function writeAll(handle, buffer, start, end) {
  let offset = start;
  while (offset < end) {
    const { bytesWritten } = await handle.write(buffer, offset, end - offset, offset);
    if (bytesWritten < 1) throw new Error("Unable to write Web artifact emergency recovery intent");
    offset += bytesWritten;
  }
}

async function persistManualRecoveryIntent(worktree, error, {
  token = randomUUID(),
  checkpoint = async () => undefined,
} = {}) {
  if (!STRICT_UUID.test(token)) throw new Error("Invalid Web artifact manual recovery token");
  const treeIdentity = parseTreeIdentity(error?.treeIdentity, worktree);
  const file = manualRecoveryIntentPath(worktree, token);
  const record = Object.freeze({
    version: 1,
    token,
    reason: "process-tree-termination-unconfirmed",
    treeIdentity,
    createdAt: new Date().toISOString(),
  });
  const release = await acquireInterprocessLock(manualRecoveryIntentLockPath(worktree, token));
  try {
    const recovery = recoverManualRecoveryIntentTempsUnlocked(worktree, token);
    if (recovery.incomplete) throw new Error("Incomplete Web artifact emergency recovery intent requires manual recovery");
    if (await readManualRecoveryClearance(worktree, token)) {
      const cleared = new Error("Web artifact manual recovery token was already cleared");
      cleared.code = "EMANUALRECOVERYCLEARED";
      throw cleared;
    }
    let persisted = null;
    try { persisted = await readCompletedManualRecoveryIntent(worktree, token); }
    catch (readError) { if (readError?.code !== "ENOENT") throw readError; }
    if (!persisted) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      const temporary = manualRecoveryIntentTempPath(worktree, token);
      let handle;
      try {
        handle = await fs.open(temporary, "wx", 0o600);
        await checkpoint("after-open");
        const serialized = Buffer.from(JSON.stringify(record));
        const midpoint = Math.max(1, Math.floor(serialized.length / 2));
        await writeAll(handle, serialized, 0, midpoint);
        await checkpoint("after-partial-write");
        await writeAll(handle, serialized, midpoint, serialized.length);
        await checkpoint("before-fsync");
        await handle.sync();
        await checkpoint("after-fsync");
        await handle.close();
        handle = null;
        try { await fs.link(temporary, file); }
        catch (linkError) { if (linkError?.code !== "EEXIST") throw linkError; }
        syncDirectorySync(path.dirname(file));
        await fs.rm(temporary, { force: true });
        syncDirectorySync(path.dirname(file));
      } catch (writeError) {
        await handle?.close().catch(() => undefined);
        throw writeError;
      }
      persisted = await readCompletedManualRecoveryIntent(worktree, token);
    }
    if (JSON.stringify(persisted.treeIdentity) !== JSON.stringify(treeIdentity)) {
      throw new Error("Conflicting Web artifact emergency recovery intent");
    }
    if (await readManualRecoveryClearance(worktree, token)) {
      await fs.rm(file, { force: true });
      const cleared = new Error("Web artifact manual recovery token was already cleared");
      cleared.code = "EMANUALRECOVERYCLEARED";
      throw cleared;
    }
    return persisted;
  } finally { release(); }
}

async function markManualRecoveryUnlocked(worktree, error, { token = randomUUID() } = {}) {
  if (!STRICT_UUID.test(token)) throw new Error("Invalid Web artifact manual recovery token");
  const intentFile = manualRecoveryIntentPath(worktree, token);
  if (await readManualRecoveryClearance(worktree, token)) {
    await fs.rm(intentFile, { force: true });
    return Object.freeze({ merged: false, cleared: true });
  }
  let intent;
  try { intent = await readCompletedManualRecoveryIntent(worktree, token); }
  catch (readError) {
    if (readError?.code === "ENOENT") return Object.freeze({ merged: false, cleared: false });
    throw readError;
  }
  const file = manualRecoveryPath(worktree);
  const temporary = `${file}.tmp-${randomUUID()}`;
  const incoming = parseTreeIdentity(error?.treeIdentity, worktree);
  if (JSON.stringify(intent.treeIdentity) !== JSON.stringify(incoming)) {
    throw new Error("Conflicting Web artifact emergency recovery intent");
  }
  let identities = [];
  let fences = [];
  let globalQuiescenceRequired = false;
  try {
    const existing = markerIdentities(JSON.parse(await fs.readFile(file, "utf8")), worktree);
    identities = existing.identities;
    fences = existing.fences;
    globalQuiescenceRequired = existing.globalQuiescenceRequired;
  } catch (readError) {
    if (readError?.code !== "ENOENT") throw readError;
  }
  if (!fences.some((fence) => fence.token === token)) {
    if (fences.length < 32) {
      fences.push(Object.freeze({ token, treeIdentity: incoming }));
      if (!identities.some((identity) => JSON.stringify(identity) === JSON.stringify(incoming))) {
        if (identities.length < 32) identities.push(incoming);
        else globalQuiescenceRequired = true;
      }
    } else globalQuiescenceRequired = true;
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(temporary, JSON.stringify({
    version: 2,
    token: randomUUID(),
    reason: "process-tree-termination-unconfirmed",
    pid: process.pid,
    treeIdentities: identities,
    fences,
    globalQuiescenceRequired,
    createdAt: new Date().toISOString(),
  }), { encoding: "utf8", flag: "wx", mode: 0o600 });
  try { await fs.rename(temporary, file); }
  catch (error) { await fs.rm(temporary, { force: true }); throw error; }
  return Object.freeze({ merged: true, cleared: false });
}

async function markManualRecovery(worktree, error, {
  waitMs = MANUAL_RECOVERY_LOCK_WAIT_MS,
  retryMs = MANUAL_RECOVERY_LOCK_RETRY_MS,
  token = randomUUID(),
  signal,
} = {}) {
  try { await persistManualRecoveryIntent(worktree, error, { token }); }
  catch (error) {
    if (error?.code === "EMANUALRECOVERYCLEARED") return Object.freeze({ merged: false, cleared: true });
    throw error;
  }
  const release = await acquireInterprocessLock(artifactLockPath(worktree), {
    attempts: Math.ceil(waitMs / retryMs), retryMs, signal,
  });
  try { return await markManualRecoveryUnlocked(path.resolve(worktree), error, { token }); }
  finally { release(); }
}

export function clearWebArtifactManualRecoverySync({
  worktree,
  confirmQuiescent = false,
  confirmGlobalQuiescent = false,
  quarantineTokenLockOwners = false,
  beforeRemove,
} = {}) {
  if (confirmQuiescent !== true) throw new Error("Explicit quiescent confirmation is required");
  if (quarantineTokenLockOwners && confirmGlobalQuiescent !== true) {
    throw new Error("Explicit global quiescent confirmation is required");
  }
  const resolvedWorktree = path.resolve(worktree);
  const release = acquireInterprocessLockSync(artifactLockPath(resolvedWorktree));
  const intentLockReleases = [];
  try {
    const file = manualRecoveryPath(resolvedWorktree);
    let marker = null;
    let parsedMarker = null;
    let serialized = null;
    try { serialized = fsSync.readFileSync(file, "utf8"); marker = JSON.parse(serialized); }
    catch (error) { if (error?.code !== "ENOENT") throw new Error("Invalid Web artifact manual recovery marker"); }
    if (marker && marker.reason !== "process-tree-termination-unconfirmed") {
      throw new Error("Invalid Web artifact manual recovery marker");
    }
    if (marker?.version === 2) parsedMarker = markerIdentities(marker, resolvedWorktree);
    const initialIntents = readManualRecoveryIntentsSync(resolvedWorktree);
    const initialTemps = readManualRecoveryIntentTempsSync(resolvedWorktree);
    const intentTokens = [...new Set([
      ...initialIntents.map((intent) => intent.token),
      ...initialTemps.map((temp) => temp.token),
      ...(parsedMarker?.fences.map((fence) => fence.token) ?? []),
    ])].sort();
    for (const token of intentTokens) {
      if (quarantineTokenLockOwners) {
        quarantineInterprocessLockOwnersSync(manualRecoveryIntentLockPath(resolvedWorktree, token), {
          confirmGlobalQuiescent: true,
        });
      }
      intentLockReleases.push(acquireInterprocessLockSync(manualRecoveryIntentLockPath(resolvedWorktree, token)));
      recoverManualRecoveryIntentTempsUnlocked(resolvedWorktree, token);
    }
    const intents = readManualRecoveryIntentsSync(resolvedWorktree);
    const incompleteTemps = readManualRecoveryIntentTempsSync(resolvedWorktree);
    if (!marker && intents.length === 0 && incompleteTemps.length === 0) return false;
    let identities = [];
    let fenceTokens = [];
    if (marker?.version === 2) {
      identities = parsedMarker.identities;
      fenceTokens = parsedMarker.fences.map((fence) => fence.token);
      if (parsedMarker.globalQuiescenceRequired && confirmGlobalQuiescent !== true) {
        throw new Error("Explicit global quiescent confirmation is required");
      }
    } else if (marker?.version === 1 && marker.treeIdentity) {
      identities = [parseTreeIdentity(marker.treeIdentity, resolvedWorktree)];
    } else if (marker?.version === 1 && Number.isSafeInteger(marker.pid) && marker.pid > 0) {
      if (confirmGlobalQuiescent !== true) throw new Error("Explicit global quiescent confirmation is required");
      identities = [{ pid: marker.pid }];
    } else if (marker) {
      throw new Error("Invalid Web artifact manual recovery marker");
    }
    if (incompleteTemps.length > 0 && confirmGlobalQuiescent !== true) {
      throw new Error("Explicit global quiescent confirmation is required");
    }
    identities.push(...intents.map((intent) => intent.treeIdentity));
    fenceTokens.push(...intents.map((intent) => intent.token));
    fenceTokens.push(...incompleteTemps.map((temp) => temp.token));
    identities = [...new Map(identities.map((identity) => [JSON.stringify(identity), identity])).values()];
    fenceTokens = [...new Set(fenceTokens)];
    for (const identity of identities) {
      try {
        process.kill(identity.pid, 0);
        throw new Error("Web artifact process tree is still alive");
      } catch (error) {
        if (error?.message === "Web artifact process tree is still alive" || error?.code !== "ESRCH") throw error;
      }
    }
    beforeRemove?.(Object.freeze({ marker, serialized }));
    if (serialized !== null && fsSync.readFileSync(file, "utf8") !== serialized) {
      throw new Error("Web artifact manual recovery marker changed");
    }
    for (const token of fenceTokens) {
      durablePublishSync(manualRecoveryClearancePath(resolvedWorktree, token), {
        version: 1, token, clearedAt: new Date().toISOString(),
      });
    }
    for (const intent of intents) fsSync.rmSync(manualRecoveryIntentPath(resolvedWorktree, intent.token), { force: true });
    for (const temp of incompleteTemps) fsSync.rmSync(temp.file, { force: true });
    if (serialized !== null) fsSync.rmSync(file, { force: true });
    syncDirectorySync(path.dirname(file));
    return true;
  } finally {
    for (const releaseIntentLock of intentLockReleases.reverse()) releaseIntentLock();
    release();
  }
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

export async function finalizeWebArtifactReservation({ worktree, artifactId, reservationToken, lockOptions }) {
  const release = await acquireInterprocessLock(artifactLockPath(worktree), lockOptions);
  try { return finalizeReservationUnlocked({ worktree, artifactId, reservationToken }); }
  finally { release(); }
}

export function finalizeWebArtifactReservationSync({ worktree, artifactId, reservationToken }) {
  const release = acquireInterprocessLockSync(artifactLockPath(worktree));
  try { return finalizeReservationUnlocked({ worktree, artifactId, reservationToken }); }
  finally { release(); }
}

export function establishWebArtifactReferenceSync({ worktree, artifactId, reservationToken, requireActive = false, write }) {
  if (typeof write !== "function") throw new Error("Web artifact reference writer is required");
  const release = acquireInterprocessLockSync(artifactLockPath(worktree));
  try {
    if (requireActive) {
      if (!STRICT_UUID.test(reservationToken)) throw new Error("Invalid Web artifact reservation");
      let record;
      try { record = parseReservation(JSON.parse(fsSync.readFileSync(reservationPath(worktree, artifactId, reservationToken), "utf8")), worktree, artifactId); }
      catch { throw new Error("Invalid Web artifact reservation"); }
      if (record.token !== reservationToken || Date.parse(record.leaseExpiresAt) <= Date.now()) throw new Error("Web artifact reservation expired");
    }
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
  if (value.version === 3) {
    if (Object.keys(value).sort().join(",") !== "artifactId,codeRelease,kind,version" || value.kind !== "code") throw new Error("Invalid Web artifact manifest");
    assertArtifactId(value.artifactId);
    return Object.freeze({ artifactId: value.artifactId, kind: "code", codeRelease: validateCodeRelease(value.codeRelease) });
  }
  const hasCodeSource = value.version === 4;
  if (
    Object.keys(value).sort().join(",") !== (hasCodeSource
      ? "artifactId,codeSource,jobId,jobVersion,stageContentHashes,version"
      : "artifactId,jobId,jobVersion,stageContentHashes,version") ||
    ![2, 4].includes(value.version)
  ) {
    throw new Error("Invalid Web artifact manifest");
  }
  try {
    assertArtifactId(value.artifactId);
    if (typeof value.jobId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(value.jobId)) throw new Error();
    if (!Number.isSafeInteger(value.jobVersion) || value.jobVersion < 1) throw new Error();
    const stageContentHashes = validateStageContentHashes(value.stageContentHashes, "Invalid Web artifact manifest");
    const codeSource = hasCodeSource
      ? boundedCodeSource(value.codeSource?.sourceCommit, value.codeSource?.sourceHash)
      : null;
    if (hasCodeSource && (!codeSource || Object.keys(value.codeSource).sort().join(",") !== "sourceCommit,sourceHash")) throw new Error();
    return Object.freeze({
      artifactId: value.artifactId,
      jobId: value.jobId,
      jobVersion: value.jobVersion,
      stageContentHashes,
      ...(codeSource ? { codeSource } : {}),
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
      || manifest.kind !== expected.kind
      || (expected.kind === "code" && !codeReleasesMatch(manifest.codeRelease, expected.codeRelease))
      || manifest.jobId !== expected.jobId
      || manifest.jobVersion !== expected.jobVersion
      || JSON.stringify(manifest.stageContentHashes) !== JSON.stringify(expected.stageContentHashes)
      || JSON.stringify(manifest.codeSource) !== JSON.stringify(expected.codeSource)
    ) throw new Error("Web publication artifact already exists with different content");
    return Object.freeze({
      id: expected.artifactId,
      root: resolvedRoot,
      ...artifactMetadata(expected),
    });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function artifactMetadata(value) {
  return value.kind === "code" ? { kind: "code", codeRelease: value.codeRelease }
    : { jobId: value.jobId, jobVersion: value.jobVersion, stageContentHashes: value.stageContentHashes,
      ...(value.codeSource ? { codeSource: value.codeSource } : {}) };
}

export { durablePublishSync as writeWebArtifactPrivateRecordSync };

export async function writeCurrentWebArtifact({ worktree, artifactId, jobId, jobVersion, stageContentHashes, kind, codeRelease, codeSource }) {
  assertArtifactId(artifactId);
  if (kind !== undefined || codeRelease !== undefined) assertCodeOnly({ kind, codeRelease, jobId, jobVersion, stageContentHashes });
  const version = kind === "code" ? 3 : codeSource ? 4 : 2;
  const manifest = parseManifest({ version, artifactId, ...artifactMetadata({ kind, codeRelease, codeSource, jobId, jobVersion, stageContentHashes }) });
  const artifactRoot = await resolveWritableArtifactRoot(worktree);
  const destination = path.join(artifactRoot, "web-artifact.json");
  const temporary = `${destination}.tmp-${randomUUID()}`;
  await fs.mkdir(artifactRoot, { recursive: true });
  try {
    await fs.writeFile(temporary, JSON.stringify({ version, ...manifest }), {
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
  kind,
  codeRelease,
  captureSourceIdentity = false,
  stream,
  generation,
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
  if (kind === "code" && captureSourceIdentity) throw new Error("Code artifact identity is already explicit");
  if (kind !== undefined || codeRelease !== undefined) assertCodeOnly({ kind, codeRelease, jobId, jobVersion, stageContentHashes, stream, generation });
  const release = await acquireInterprocessLock(artifactLockPath(resolvedWorktree), {
    attempts: Math.ceil(buildLockWaitMs / buildLockRetryMs),
    retryMs: buildLockRetryMs,
  });
  const destination = path.join(runtimeDir, `publication-${artifactId}`);
  const temporary = path.join(runtimeDir, `.publication-${artifactId}.tmp-${randomUUID()}`);
  let reservationToken = null;
  try {
    assertNoManualRecovery(resolvedWorktree);
    const codeSource = captureSourceIdentity ? await readCodeSourceIdentity(resolvedWorktree) : null;
    const expected = parseManifest(kind === "code"
      ? { version: 3, artifactId, kind, codeRelease }
      : { version: codeSource ? 4 : 2, artifactId, jobId, jobVersion, stageContentHashes,
        ...(codeSource ? { codeSource } : {}) });
    reservationToken = await createReservation(resolvedWorktree, artifactId, path.basename(temporary));
    const existing = await existingExactArtifact(runtimeDir, destination, expected);
    if (existing) return Object.freeze({ ...existing, reservationToken });
    await fs.mkdir(runtimeDir, { recursive: true });
    const runtimeArtifacts = await managedRuntimeArtifacts(runtimeDir);
    if (runtimeArtifacts.length >= MAX_WEB_RUNTIME_ARTIFACTS) throw new Error("Web runtime artifact quota exceeded");
    await build();
    if (codeSource) await assertBuiltCodeSource(resolvedWorktree, codeSource);
    const artifactRoot = await resolveWritableArtifactRoot(resolvedWorktree);
    const existingBytes = (await Promise.all(runtimeArtifacts.map((entry) => directoryBytes(entry.root))))
      .reduce((sum, size) => sum + size, 0);
    const candidateBytes = await directoryBytes(artifactRoot);
    if (existingBytes + candidateBytes > MAX_WEB_RUNTIME_ARTIFACT_BYTES) {
      throw new Error("Web runtime artifact quota exceeded");
    }
    await writeManifest({ worktree, ...expected });
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
      ...artifactMetadata(expected),
      reservationToken,
    });
  } catch (error) {
    if (hasErrorCode(error, "EPROCESSTREE")) {
      let treeError = error;
      while (treeError && treeError.code !== "EPROCESSTREE") treeError = treeError.cause;
      const token = randomUUID();
      await persistManualRecoveryIntent(resolvedWorktree, treeError, { token });
      await markManualRecoveryUnlocked(resolvedWorktree, treeError, { token });
    }
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
  manualRecoveryLockWaitMs = MANUAL_RECOVERY_LOCK_WAIT_MS,
  manualRecoveryLockRetryMs = MANUAL_RECOVERY_LOCK_RETRY_MS,
  manualRecoveryIntentCheckpoint = async () => undefined,
  manualRecoveryIntentRecoveryFlush = flushRecoveryIntentTempSync,
  manualRecoveryIntentRecoveryCheckpoint = () => undefined,
} = {}) {
  const resolvedWorktree = path.resolve(worktree);
  const resolvedArtifactRoot = path.resolve(artifactRoot);
  const resolvedRuntimeDir = path.resolve(runtimeDir);
  assertWithin(resolvedWorktree, resolvedArtifactRoot);
  assertWithin(resolvedWorktree, resolvedRuntimeDir);
  if (!Number.isSafeInteger(maxSnapshots) || maxSnapshots < 1 || maxSnapshots > 5) {
    throw new Error("Invalid Web artifact retention");
  }
  if (!Number.isSafeInteger(manualRecoveryLockWaitMs) || manualRecoveryLockWaitMs < 1
    || !Number.isSafeInteger(manualRecoveryLockRetryMs) || manualRecoveryLockRetryMs < 1) {
    throw new Error("Invalid Web manual recovery lock budget");
  }
  if (typeof manualRecoveryIntentCheckpoint !== "function") {
    throw new Error("Invalid Web manual recovery intent checkpoint");
  }
  if (typeof manualRecoveryIntentRecoveryFlush !== "function"
    || typeof manualRecoveryIntentRecoveryCheckpoint !== "function") {
    throw new Error("Invalid Web manual recovery intent recovery seam");
  }

  function current(expectedTarget) {
    const durable = readWebPublicationControlSync({
      controlPath: webPublicationControlPath(resolvedWorktree),
      expectedTarget,
    });
    if (durable) {
      const persisted = storedArtifact(durable.current.storageName);
      if (
        persisted.id !== durable.current.artifactId
        || persisted.kind !== durable.current.kind
        || (persisted.kind === "code" && !codeReleasesMatch(persisted.codeRelease, durable.current.codeRelease))
        || (durable.current.storageName.startsWith("publication-")
          && durable.current.storageName !== `publication-${durable.current.artifactId}`)
        || persisted.jobId !== durable.current.jobId
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
        ...(parsed.kind === "code" ? artifactMetadata(parsed) : {}),
        ...(parsed.codeSource ? { codeSource: parsed.codeSource } : {}),
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

  async function manualRecoveryStatus({ tokens = [] } = {}) {
    if (!Array.isArray(tokens) || tokens.some((token) => !STRICT_UUID.test(token))) {
      throw new Error("Invalid Web artifact manual recovery tokens");
    }
    const active = new Set(readManualRecoveryIntentsSync(resolvedWorktree).map((intent) => intent.token));
    for (const temp of readManualRecoveryIntentTempsSync(resolvedWorktree)) active.add(temp.token);
    try {
      const marker = markerIdentities(JSON.parse(await fs.readFile(manualRecoveryPath(resolvedWorktree), "utf8")), resolvedWorktree);
      for (const fence of marker.fences) active.add(fence.token);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const cleared = new Set();
    for (const token of tokens) {
      try {
        const value = JSON.parse(await fs.readFile(manualRecoveryClearancePath(resolvedWorktree, token), "utf8"));
        if (value?.version !== 1 || value.token !== token || Number.isNaN(Date.parse(value.clearedAt))) {
          throw new Error("Invalid Web artifact manual recovery clearance");
        }
        if (!active.has(token)) cleared.add(token);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    return Object.freeze({
      activeTokens: Object.freeze(tokens.filter((token) => active.has(token))),
      clearedTokens: Object.freeze(tokens.filter((token) => cleared.has(token))),
    });
  }

  async function recoverManualRecovery({ signal } = {}) {
    await recoverManualRecoveryIntentTemps(resolvedWorktree, {
      flush: manualRecoveryIntentRecoveryFlush,
      checkpoint: manualRecoveryIntentRecoveryCheckpoint,
    });
    for (const intent of readManualRecoveryIntentsSync(resolvedWorktree)) {
      const error = Object.assign(new Error("Recovered unconfirmed process tree"), {
        code: "EPROCESSTREE", treeIdentity: intent.treeIdentity,
      });
      await markManualRecovery(resolvedWorktree, error, {
        token: intent.token,
        waitMs: manualRecoveryLockWaitMs,
        retryMs: manualRecoveryLockRetryMs,
        signal,
      });
    }
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
      if (parsed.codeSource) {
        const fingerprint = JSON.parse(fsSync.readFileSync(path.join(resolvedRoot, "build-fingerprint.json"), "utf8"));
        if (fingerprint.version !== 1 || fingerprint.sourceHash !== parsed.codeSource.sourceHash) throw new Error();
      }
      return Object.freeze({
        id: parsed.artifactId,
        root: resolvedRoot,
        ...artifactMetadata(parsed),
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

  function isImmutable(artifact) {
    const resolved = resolveArtifactPath(artifact);
    return resolved !== resolvedArtifactRoot && isWithin(resolvedRuntimeDir, resolved);
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
    if (durable?.dataCurrent) protectedRoots.add(path.join(resolvedRuntimeDir, durable.dataCurrent.storageName));
    for (const stream of Object.values(durable?.streams ?? {})) protectedRoots.add(path.join(resolvedRuntimeDir, `publication-${stream.artifactId}`));
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

  return Object.freeze({
    current,
    candidate,
    bootstrapCurrent,
    isImmutable,
    resolveArtifactPath,
    prune,
    snapshot,
    assertOperational: () => assertNoManualRecovery(resolvedWorktree),
    persistManualRecoveryIntent: (error, options = {}) => persistManualRecoveryIntent(resolvedWorktree, error, {
      checkpoint: manualRecoveryIntentCheckpoint,
      ...options,
    }),
    manualRecoveryStatus,
    recoverManualRecovery,
    markManualRecovery: (error, options = {}) => markManualRecovery(resolvedWorktree, error, {
      waitMs: manualRecoveryLockWaitMs,
      retryMs: manualRecoveryLockRetryMs,
      ...options,
    }),
  });
}
