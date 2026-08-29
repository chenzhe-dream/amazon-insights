import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { acquireInterprocessLockSync } from "./interprocess-lock.mjs";

export const ALEXA_PUBLICATION_LEASE_MS = 20 * 60 * 1_000;
export const ALEXA_LEGACY_HANDOFF_MS = 35 * 60 * 1_000;
export const ALEXA_SNAPSHOT_MAX_BYTES = 8 * 1024 * 1024;
export const ALEXA_SNAPSHOT_SINGLE_MAX_BYTES = ALEXA_SNAPSHOT_MAX_BYTES / 2;
export const ALEXA_SNAPSHOT_RETENTION = 4;
const STATE_VERSION = 2;
const JOURNAL_VERSION = 1;
const SNAPSHOT_PATTERN = /^generation-(\d+)-([a-f0-9]{64})\.ts$/;
const TRANSACTION_ORPHAN = /\.(tmp|bak)-[a-f0-9-]{36}$/i;
const CORRUPT_ORPHAN = /\.corrupt-[a-f0-9-]{36}$/i;
const CORRUPT_JOURNAL_PREFIX = "alexa-publication-transaction.json.corrupt-";

function pathsFor(worktree) {
  const root = path.resolve(worktree);
  const data = path.join(root, "data");
  const state = path.join(data, "alexa-publication-state.json");
  return {
    root,
    data,
    state,
    journal: path.join(data, "alexa-publication-transaction.json"),
    journalManifest: path.join(data, "alexa-publication-transaction.manifest.json"),
    mutex: `${state}.lock`,
    snapshots: path.join(data, "alexa-publication-snapshots"),
    projection: path.join(root, "app", "rufus-voc-data.ts"),
    legacyLock: path.join(data, ".rebuild-lock.json"),
  };
}

export function alexaPublicationTransactionPath(worktree) {
  return pathsFor(worktree).journal;
}

export function alexaPublicationTransactionManifestPath(worktree) {
  return pathsFor(worktree).journalManifest;
}

function sourceHash(source) {
  return createHash("sha256").update(source).digest("hex");
}

function validToken(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolvedFileOps(overrides = {}) {
  return Object.freeze({
    mkdirSync: overrides.mkdirSync ?? fs.mkdirSync,
    writeFileSync: overrides.writeFileSync ?? fs.writeFileSync,
    existsSync: overrides.existsSync ?? fs.existsSync,
    renameSync: overrides.renameSync ?? fs.renameSync,
    rmSync: overrides.rmSync ?? fs.rmSync,
    readFileSync: overrides.readFileSync ?? fs.readFileSync,
    readdirSync: overrides.readdirSync ?? fs.readdirSync,
    statSync: overrides.statSync ?? fs.statSync,
    openSync: overrides.openSync ?? fs.openSync,
    fsyncSync: overrides.fsyncSync ?? fs.fsyncSync,
    closeSync: overrides.closeSync ?? fs.closeSync,
  });
}

function fsyncPath(fileOps, target) {
  let descriptor;
  try {
    descriptor = fileOps.openSync(target, "r");
    fileOps.fsyncSync(descriptor);
  } catch (error) {
    if (!new Set(["EINVAL", "ENOTSUP", "EPERM", "EACCES", "EISDIR"]).has(error?.code)) throw error;
  } finally {
    if (descriptor !== undefined) {
      try { fileOps.closeSync(descriptor); } catch {}
    }
  }
}

function durableWrite(fileOps, target, content, { flag = "wx", mode = 0o600 } = {}) {
  fileOps.mkdirSync(path.dirname(target), { recursive: true });
  fileOps.writeFileSync(target, content, { encoding: "utf8", flag, mode });
  fsyncPath(fileOps, target);
  fsyncPath(fileOps, path.dirname(target));
}

function atomicWrite(fileOps, target, value) {
  const temporary = `${target}.tmp-${randomUUID()}`;
  try {
    durableWrite(fileOps, temporary, JSON.stringify(value));
    fileOps.renameSync(temporary, target);
    fsyncPath(fileOps, path.dirname(target));
  } catch (error) {
    try { fileOps.rmSync(temporary, { force: true }); } catch {}
    throw error;
  }
}

function validJournal(value, paths) {
  if (
    value?.version !== JOURNAL_VERSION
    || typeof value.transactionId !== "string"
    || !/^[a-f0-9-]{36}$/i.test(value.transactionId)
    || !["prepared", "installing", "committed"].includes(value.phase)
    || !Array.isArray(value.entries)
    || value.entries.length < 1
  ) return false;
  return value.entries.every((entry) =>
    typeof entry?.target === "string"
    && typeof entry.temporary === "string"
    && typeof entry.backup === "string"
    && typeof entry.hadOriginal === "boolean"
    && isWithin(paths.root, path.resolve(entry.target))
    && entry.temporary === `${entry.target}.tmp-${value.transactionId}`
    && entry.backup === `${entry.target}.bak-${value.transactionId}`
  );
}

function readJournal(paths, fileOps) {
  let serialized;
  try {
    serialized = fileOps.readFileSync(paths.journal, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return readJournalManifest(paths, fileOps);
    throw error;
  }
  try {
    const value = JSON.parse(serialized);
    if (!validJournal(value, paths)) throw new Error("Invalid Alexa publication transaction journal");
    return value;
  } catch {
    const quarantine = `${paths.journal}.corrupt-${randomUUID()}`;
    try { fileOps.renameSync(paths.journal, quarantine); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
    fsyncPath(fileOps, path.dirname(paths.journal));
    return readJournalManifest(paths, fileOps) ?? { corrupt: true };
  }
}

function readJournalManifest(paths, fileOps) {
  let value;
  try { value = JSON.parse(fileOps.readFileSync(paths.journalManifest, "utf8")); }
  catch (error) { if (error?.code === "ENOENT") return null; return null; }
  const serialized = JSON.stringify(value?.journal);
  if (
    value?.version !== 1
    || typeof value.checksum !== "string"
    || sourceHash(serialized) !== value.checksum
    || !validJournal(value.journal, paths)
  ) return null;
  return value.journal;
}

function writeJournal(paths, fileOps, journal) {
  atomicWrite(fileOps, paths.journal, journal);
  atomicWrite(fileOps, paths.journalManifest, {
    version: 1,
    journal,
    checksum: sourceHash(JSON.stringify(journal)),
  });
}

function finishCommittedCleanup(paths, fileOps, journal) {
  let clean = true;
  for (const entry of journal.entries) {
    try { fileOps.rmSync(entry.temporary, { force: true }); } catch { clean = false; }
    if (fileOps.existsSync(entry.backup)) {
      if (!fileOps.existsSync(entry.target)) {
        try { fileOps.renameSync(entry.backup, entry.target); } catch { clean = false; }
      } else {
        try { fileOps.rmSync(entry.backup, { force: true }); } catch { clean = false; }
      }
    }
  }
  if (clean) {
    try { fileOps.rmSync(paths.journal, { force: true }); }
    catch { clean = false; }
    try { fileOps.rmSync(paths.journalManifest, { force: true }); }
    catch { clean = false; }
  }
  return clean;
}

function rollbackJournal(paths, fileOps, journal) {
  const failures = [];
  for (const entry of [...journal.entries].reverse()) {
    if (entry.hadOriginal && fileOps.existsSync(entry.backup)) {
      try {
        if (fileOps.existsSync(entry.target)) fileOps.rmSync(entry.target, { force: true });
        fileOps.renameSync(entry.backup, entry.target);
      } catch (error) {
        failures.push({ target: entry.target, error });
        continue;
      }
    } else if (!entry.hadOriginal) {
      try { fileOps.rmSync(entry.target, { force: true }); }
      catch (error) { failures.push({ target: entry.target, error }); continue; }
    }
    try { fileOps.rmSync(entry.temporary, { force: true }); }
    catch (error) { failures.push({ target: entry.temporary, error }); }
  }
  if (failures.length) throw new Error("Alexa publication transaction recovery pending");
  fileOps.rmSync(paths.journal, { force: true });
  fileOps.rmSync(paths.journalManifest, { force: true });
  return true;
}

function cleanupOrphanFiles(paths, fileOps) {
  const directories = [
    path.dirname(paths.projection),
    paths.data,
    paths.snapshots,
    path.join(paths.data, "alexa-voc-cache"),
  ];
  for (const directory of directories) {
    let names;
    try { names = fileOps.readdirSync(directory); }
    catch (error) { if (error?.code === "ENOENT") continue; throw error; }
    for (const name of names) {
      const orphan = path.join(directory, name);
      const match = TRANSACTION_ORPHAN.exec(name);
      if (match) {
        const target = orphan.slice(0, -(match[0].length));
        if (match[1] === "bak" && !fileOps.existsSync(target)) {
          try { fileOps.renameSync(orphan, target); } catch {}
        } else {
          try { fileOps.rmSync(orphan, { force: true }); } catch {}
        }
        continue;
      }
      if (directory === paths.snapshots && CORRUPT_ORPHAN.test(name)) {
        try { fileOps.rmSync(orphan, { force: true }); } catch {}
      }
    }
  }
}

function corruptJournalHasTransactionOrphans(paths, fileOps) {
  let dataNames = [];
  try { dataNames = fileOps.readdirSync(paths.data); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  if (!dataNames.some((name) => name.startsWith(CORRUPT_JOURNAL_PREFIX))) return false;
  for (const directory of [
    path.dirname(paths.projection),
    paths.data,
    paths.snapshots,
    path.join(paths.data, "alexa-voc-cache"),
  ]) {
    let names = [];
    try { names = fileOps.readdirSync(directory); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
    if (names.some((name) => TRANSACTION_ORPHAN.test(name))) return true;
  }
  return false;
}

function recoverTransactionUnlocked(paths, fileOps, decision) {
  const journal = readJournal(paths, fileOps);
  if (journal?.corrupt || (!journal && corruptJournalHasTransactionOrphans(paths, fileOps))) {
    throw new Error("Alexa publication transaction recovery pending");
  }
  let recovered = false;
  if (journal && decision === "commit" && journal.phase !== "committed") {
    const installStates = journal.entries.map((entry) => {
      const target = fileOps.existsSync(entry.target);
      const temporary = fileOps.existsSync(entry.temporary);
      const backup = fileOps.existsSync(entry.backup);
      if (entry.hadOriginal) {
        if (target && temporary && !backup) return "prepared";
        if (!target && temporary && backup) return "backed-up";
        if (target && !temporary && backup) return "installed";
      } else {
        if (!target && temporary && !backup) return "prepared";
        if (target && !temporary && !backup) return "installed";
      }
      throw new Error("Alexa publication transaction cannot be committed");
    });
    writeJournal(paths, fileOps, { ...journal, phase: "installing" });
    for (const [index, entry] of journal.entries.entries()) {
      const state = installStates[index];
      if (state === "installed") continue;
      if (state === "prepared" && entry.hadOriginal) {
        fileOps.renameSync(entry.target, entry.backup);
        fsyncPath(fileOps, path.dirname(entry.target));
      }
      fileOps.renameSync(entry.temporary, entry.target);
      fsyncPath(fileOps, path.dirname(entry.target));
    }
    const committed = { ...journal, phase: "committed" };
    writeJournal(paths, fileOps, committed);
    finishCommittedCleanup(paths, fileOps, committed);
    recovered = true;
  } else if (journal && decision === "rollback") {
    rollbackJournal(paths, fileOps, journal);
    recovered = true;
  } else if (journal?.phase === "committed") {
    finishCommittedCleanup(paths, fileOps, journal);
    recovered = true;
  } else if (journal) {
    rollbackJournal(paths, fileOps, journal);
    recovered = true;
  }
  cleanupOrphanFiles(paths, fileOps);
  return recovered;
}

export function recoverAlexaPublicationTransactionSync(worktree, { fileOps: overrides, decision } = {}) {
  if (decision !== undefined && !["commit", "rollback"].includes(decision)) {
    throw new Error("Invalid Alexa publication recovery decision");
  }
  const paths = pathsFor(worktree);
  const fileOps = resolvedFileOps(overrides);
  fileOps.mkdirSync(paths.data, { recursive: true });
  const release = acquireInterprocessLockSync(paths.mutex);
  try { return recoverTransactionUnlocked(paths, fileOps, decision); }
  finally { release(); }
}

function atomicReplaceMany(paths, entries, fileOps) {
  recoverTransactionUnlocked(paths, fileOps);
  const transactionId = randomUUID();
  const prepared = entries.map(({ target, content, mode = 0o600 }) => ({
    target: path.resolve(target),
    temporary: `${path.resolve(target)}.tmp-${transactionId}`,
    backup: `${path.resolve(target)}.bak-${transactionId}`,
    content,
    mode,
    hadOriginal: fileOps.existsSync(target),
  }));
  if (prepared.some((entry) => !isWithin(paths.root, entry.target))) {
    throw new Error("Invalid Alexa publication transaction path");
  }
  const journal = {
    version: JOURNAL_VERSION,
    transactionId,
    phase: "prepared",
    entries: prepared.map(({ target, temporary, backup, hadOriginal }) => ({ target, temporary, backup, hadOriginal })),
  };
  try {
    for (const entry of prepared) durableWrite(fileOps, entry.temporary, entry.content, { mode: entry.mode });
    writeJournal(paths, fileOps, journal);
    writeJournal(paths, fileOps, { ...journal, phase: "installing" });
    for (const entry of prepared) {
      if (entry.hadOriginal) fileOps.renameSync(entry.target, entry.backup);
      fileOps.renameSync(entry.temporary, entry.target);
      fsyncPath(fileOps, path.dirname(entry.target));
    }
    const committed = { ...journal, phase: "committed" };
    writeJournal(paths, fileOps, committed);
    finishCommittedCleanup(paths, fileOps, committed);
  } catch (error) {
    try {
      const observed = readJournal(paths, fileOps) ?? journal;
      if (observed.phase === "committed") {
        finishCommittedCleanup(paths, fileOps, observed);
        return;
      }
      rollbackJournal(paths, fileOps, observed);
    }
    catch { throw new Error("Alexa publication transaction recovery pending", { cause: error }); }
    throw error;
  }
}

function emptyState(generation = 0, epoch = 0) {
  return {
    version: STATE_VERSION,
    generation,
    epoch,
    dirty: false,
    sourceHash: null,
    snapshotFile: null,
    buildingGeneration: null,
    worker: null,
    failure: null,
  };
}

function validStateShape(value) {
  if (
    value?.version !== STATE_VERSION
    || !Number.isSafeInteger(value.generation)
    || value.generation < 0
    || !Number.isSafeInteger(value.epoch)
    || value.epoch < 0
    || typeof value.dirty !== "boolean"
  ) return false;
  if (value.generation === 0) {
    if (value.sourceHash !== null || value.snapshotFile !== null || value.dirty) return false;
  } else if (
    typeof value.sourceHash !== "string"
    || !/^[a-f0-9]{64}$/.test(value.sourceHash)
    || typeof value.snapshotFile !== "string"
    || !SNAPSHOT_PATTERN.test(value.snapshotFile)
  ) return false;
  if (
    value.buildingGeneration !== null
    && (!Number.isSafeInteger(value.buildingGeneration)
      || value.buildingGeneration < 1
      || value.buildingGeneration > value.generation
      || value.worker === null)
  ) return false;
  if (value.worker !== null) {
    if (
      !validToken(value.worker?.token)
      || !Number.isSafeInteger(value.worker?.pid)
      || value.worker.pid < 1
      || !Number.isSafeInteger(value.worker?.epoch)
      || value.worker.epoch < 1
      || value.worker.epoch !== value.epoch
      || typeof value.worker.heartbeatAt !== "string"
      || Number.isNaN(Date.parse(value.worker.heartbeatAt))
      || typeof value.worker.leaseExpiresAt !== "string"
      || Number.isNaN(Date.parse(value.worker.leaseExpiresAt))
    ) return false;
    if (
      !value.dirty
      || value.generation < 1
      || Date.parse(value.worker.leaseExpiresAt) <= Date.parse(value.worker.heartbeatAt)
      || Date.parse(value.worker.leaseExpiresAt) - Date.parse(value.worker.heartbeatAt) > ALEXA_PUBLICATION_LEASE_MS
    ) return false;
  }
  if (!value.dirty && (value.worker !== null || value.buildingGeneration !== null)) return false;
  if (value.buildingGeneration !== null && !value.dirty) return false;
  if (value.failure !== null) {
    if (
      !value.dirty
      || value.worker !== null
      || value.buildingGeneration !== null
      || typeof value.failure !== "object"
      || typeof value.failure.message !== "string"
      || value.failure.message.length < 1
      || value.failure.message.length > 200
      || !Number.isSafeInteger(value.failure.attempts)
      || value.failure.attempts < 1
      || typeof value.failure.at !== "string"
      || Number.isNaN(Date.parse(value.failure.at))
    ) return false;
  }
  return true;
}

function snapshotCandidates(paths, fileOps = fs) {
  let names = [];
  try { names = fileOps.readdirSync(paths.snapshots); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  return names.flatMap((name) => {
    const match = SNAPSHOT_PATTERN.exec(name);
    if (!match) return [];
    const generation = Number(match[1]);
    const file = path.join(paths.snapshots, name);
    try {
      const source = fileOps.readFileSync(file, "utf8");
      const size = Buffer.byteLength(source);
      return sourceHash(source) === match[2]
        ? [{ generation, sourceHash: match[2], snapshotFile: name, source, size }]
        : [];
    } catch { return []; }
  }).sort((left, right) => right.generation - left.generation);
}

function stateSnapshotValid(value, paths, fileOps) {
  if (value.generation === 0) return true;
  const match = SNAPSHOT_PATTERN.exec(value.snapshotFile);
  if (!match || Number(match[1]) !== value.generation || match[2] !== value.sourceHash) return false;
  try {
    if (sourceHash(fileOps.readFileSync(path.join(paths.snapshots, value.snapshotFile), "utf8")) !== value.sourceHash) return false;
    return value.buildingGeneration === null
      || snapshotCandidates(paths, fileOps).some((candidate) => candidate.generation === value.buildingGeneration);
  }
  catch { return false; }
}

function writeSnapshotFile(paths, generation, source, fileOps) {
  if (Buffer.byteLength(source) > ALEXA_SNAPSHOT_SINGLE_MAX_BYTES) {
    throw new Error("Alexa publication snapshot source exceeds quota");
  }
  const hash = sourceHash(source);
  const snapshotFile = `generation-${generation}-${hash}.ts`;
  const snapshotPath = path.join(paths.snapshots, snapshotFile);
  fileOps.mkdirSync(paths.snapshots, { recursive: true });
  try { durableWrite(fileOps, snapshotPath, source); }
  catch (error) {
    if (error?.code !== "EEXIST") throw error;
    if (fileOps.readFileSync(snapshotPath, "utf8") !== source) {
      fileOps.renameSync(snapshotPath, `${snapshotPath}.corrupt-${randomUUID()}`);
      durableWrite(fileOps, snapshotPath, source);
    }
  }
  return { generation, sourceHash: hash, snapshotFile, snapshotPath };
}

function recoverStateUnlocked(paths, fileOps) {
  let parsed = null;
  try { parsed = JSON.parse(fileOps.readFileSync(paths.state, "utf8")); } catch {}
  if (validStateShape(parsed) && stateSnapshotValid(parsed, paths, fileOps)) return { state: parsed, recovered: false };

  const candidates = snapshotCandidates(paths, fileOps);
  const parsedGeneration = Number.isSafeInteger(parsed?.generation) && parsed.generation >= 0 ? parsed.generation : 0;
  const generation = Math.max(parsedGeneration, candidates[0]?.generation ?? 0);
  const epoch = Math.max(
    Number.isSafeInteger(parsed?.epoch) ? parsed.epoch : 0,
    Number.isSafeInteger(parsed?.worker?.epoch) ? parsed.worker.epoch : 0,
  );
  if (generation === 0) return { state: emptyState(0, epoch), recovered: parsed !== null };
  const snapshot = candidates.find((candidate) => candidate.generation === generation);
  if (!snapshot) throw new Error("Alexa publication state recovery needed");
  return {
    state: {
      ...emptyState(generation, epoch),
      dirty: true,
      sourceHash: snapshot.sourceHash,
      snapshotFile: snapshot.snapshotFile,
    },
    recovered: true,
  };
}

function gcSnapshots(paths, state, fileOps) {
  const candidates = snapshotCandidates(paths, fileOps);
  const protectedNames = new Set([state.snapshotFile].filter(Boolean));
  if (state.buildingGeneration !== null) {
    for (const candidate of candidates) {
      if (candidate.generation === state.buildingGeneration) protectedNames.add(candidate.snapshotFile);
    }
  }
  const unique = new Map();
  let total = 0;
  for (const candidate of candidates.filter((item) => protectedNames.has(item.snapshotFile))) {
    unique.set(candidate.snapshotFile, candidate);
    total += candidate.size;
  }
  if (total > ALEXA_SNAPSHOT_MAX_BYTES) throw new Error("Alexa publication snapshot quota exceeded");
  for (const candidate of candidates) {
    if (unique.has(candidate.snapshotFile) || unique.size >= ALEXA_SNAPSHOT_RETENTION) continue;
    if (total + candidate.size > ALEXA_SNAPSHOT_MAX_BYTES) continue;
    unique.set(candidate.snapshotFile, candidate);
    total += candidate.size;
  }
  for (const candidate of candidates) {
    if (unique.has(candidate.snapshotFile)) continue;
    try { fileOps.rmSync(path.join(paths.snapshots, candidate.snapshotFile), { force: true }); }
    catch (error) {
      if (!new Set(["EPERM", "EACCES", "EBUSY"]).has(error?.code)) throw error;
    }
  }
}

function readCurrentUnlocked(paths, fileOps) {
  recoverTransactionUnlocked(paths, fileOps);
  const recovered = recoverStateUnlocked(paths, fileOps);
  if (recovered.recovered) atomicWrite(fileOps, paths.state, recovered.state);
  gcSnapshots(paths, recovered.state, fileOps);
  return recovered.state;
}

function mutate(worktree, updater, { fileOps: overrides } = {}) {
  const paths = pathsFor(worktree);
  const fileOps = resolvedFileOps(overrides);
  fileOps.mkdirSync(paths.data, { recursive: true });
  const release = acquireInterprocessLockSync(paths.mutex);
  try {
    const current = readCurrentUnlocked(paths, fileOps);
    const result = updater(current, paths, fileOps);
    if (!validStateShape(result.state) || !stateSnapshotValid(result.state, paths, fileOps)) {
      throw new Error("Invalid Alexa publication state");
    }
    atomicWrite(fileOps, paths.state, result.state);
    gcSnapshots(paths, result.state, fileOps);
    return result.value;
  } finally { release(); }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code !== "ESRCH"; }
}

export function legacyAlexaPublicationWorktreeIdentity(worktree) {
  return createHash("sha256").update(path.resolve(worktree)).digest("hex");
}

export function createLegacyAlexaPublicationLockRecord({ worktree, pid, pidBirth, command, now = () => new Date() }) {
  const timestamp = now();
  if (
    !Number.isSafeInteger(pid) || pid < 1
    || typeof pidBirth !== "string" || !pidBirth || pidBirth.length > 128
    || typeof command !== "string" || !command || command.length > 2_048
    || !(timestamp instanceof Date) || Number.isNaN(timestamp.getTime())
  ) throw new Error("Invalid legacy Alexa publication lock");
  return Object.freeze({
    version: 2,
    pid,
    pidBirth,
    command,
    worktreeId: legacyAlexaPublicationWorktreeIdentity(worktree),
    startedAt: timestamp.toISOString(),
  });
}

function defaultInspectLegacyProcess(pid) {
  return Object.freeze({ alive: pidAlive(pid) });
}

function workerActive(worker, now) {
  return Boolean(worker && Date.parse(worker.leaseExpiresAt) > now.getTime() && pidAlive(worker.pid));
}

function workerRecord(token, pid, epoch, now) {
  return {
    token,
    pid,
    epoch,
    heartbeatAt: now.toISOString(),
    leaseExpiresAt: new Date(now.getTime() + ALEXA_PUBLICATION_LEASE_MS).toISOString(),
  };
}

function matchingEpoch(current, epoch) {
  const expected = epoch ?? current.worker?.epoch;
  if (!Number.isSafeInteger(expected) || current.worker?.epoch !== expected) {
    throw new Error("Alexa publication worker was fenced");
  }
  return expected;
}

function quarantineLegacyLock(paths, fileOps, kind = "quarantine") {
  const quarantine = `${paths.legacyLock}.${kind}-${randomUUID()}`;
  try { fileOps.renameSync(paths.legacyLock, quarantine); }
  catch (error) { if (error?.code !== "ENOENT") return false; }
  return true;
}

function legacyHandoff(paths, fileOps, inspectLegacyProcess) {
  let source;
  try { source = fileOps.readFileSync(paths.legacyLock, "utf8"); }
  catch (error) { if (error?.code === "ENOENT") return false; throw error; }
  let record;
  try { record = JSON.parse(source); }
  catch { return Object.freeze({ busy: true, manualRecovery: true }); }
  if (!Number.isSafeInteger(record?.pid) || record.pid < 1) {
    return Object.freeze({ busy: true, manualRecovery: true });
  }
  if (record.version === 2) {
    const valid = Object.keys(record).sort().join(",") === "command,pid,pidBirth,startedAt,version,worktreeId"
      && typeof record.pidBirth === "string" && record.pidBirth.length <= 128
      && typeof record.command === "string" && record.command.length <= 2_048
      && record.worktreeId === legacyAlexaPublicationWorktreeIdentity(paths.root)
      && typeof record.startedAt === "string" && !Number.isNaN(Date.parse(record.startedAt));
    if (!valid) return Object.freeze({ busy: true, manualRecovery: true });
    let observed;
    try { observed = inspectLegacyProcess(record.pid, { worktree: paths.root }); }
    catch { return Object.freeze({ busy: true, manualRecovery: true }); }
    if (observed?.alive === false) {
      return Object.freeze({ busy: !quarantineLegacyLock(paths, fileOps), manualRecovery: false });
    }
    if (observed?.alive !== true) return Object.freeze({ busy: true, manualRecovery: true });
    const fullyIdentified = typeof observed.pidBirth === "string"
      && typeof observed.command === "string"
      && typeof observed.worktreeId === "string";
    if (!fullyIdentified) return Object.freeze({ busy: true, manualRecovery: true });
    const sameProcess = observed.pidBirth === record.pidBirth
      && observed.command === record.command
      && observed.worktreeId === record.worktreeId;
    if (sameProcess) return Object.freeze({ busy: true, manualRecovery: false });
    return Object.freeze({ busy: !quarantineLegacyLock(paths, fileOps), manualRecovery: false });
  }
  if (pidAlive(record.pid)) return Object.freeze({ busy: true, manualRecovery: true });
  return Object.freeze({ busy: !quarantineLegacyLock(paths, fileOps), manualRecovery: false });
}

export function quarantineLegacyAlexaPublicationLockSync(worktree, { confirmQuiescent = false } = {}) {
  if (confirmQuiescent !== true) throw new Error("Explicit quiescent confirmation is required");
  const paths = pathsFor(worktree);
  fs.mkdirSync(paths.data, { recursive: true });
  const release = acquireInterprocessLockSync(paths.mutex);
  try {
    try { fs.accessSync(paths.legacyLock); }
    catch (error) { if (error?.code === "ENOENT") return false; throw error; }
    if (!quarantineLegacyLock(paths, fs, "manual-quarantine")) {
      throw new Error("Legacy Alexa publication lock could not be quarantined");
    }
    return true;
  } finally { release(); }
}

export function readAlexaPublicationState(worktree) {
  const paths = pathsFor(worktree);
  fs.mkdirSync(paths.data, { recursive: true });
  const release = acquireInterprocessLockSync(paths.mutex);
  try { return readCurrentUnlocked(paths, fs); }
  finally { release(); }
}

export function recordAlexaVocGeneration({ worktree, source }) {
  if (typeof source !== "string") throw new Error("Invalid Alexa VOC source");
  if (Buffer.byteLength(source) > ALEXA_SNAPSHOT_SINGLE_MAX_BYTES) {
    throw new Error("Alexa publication snapshot source exceeds quota");
  }
  const paths = pathsFor(worktree);
  const fileOps = resolvedFileOps();
  fileOps.mkdirSync(paths.data, { recursive: true });
  const release = acquireInterprocessLockSync(paths.mutex);
  try {
    const current = readCurrentUnlocked(paths, fileOps);
    const hash = sourceHash(source);
    if (current.generation > 0 && current.sourceHash === hash) {
      return Object.freeze({
        generation: current.generation,
        sourceHash: hash,
        snapshotFile: current.snapshotFile,
        snapshotPath: path.join(paths.snapshots, current.snapshotFile),
        deduplicated: true,
      });
    }
    const generation = current.generation + 1;
    const snapshotFile = `generation-${generation}-${hash}.ts`;
    const snapshotPath = path.join(paths.snapshots, snapshotFile);
    const nextState = { ...current, generation, dirty: true, sourceHash: hash, snapshotFile };
    atomicReplaceMany(paths, [
      { target: snapshotPath, content: source },
      { target: paths.state, content: JSON.stringify(nextState) },
    ], fileOps);
    gcSnapshots(paths, nextState, fileOps);
    return Object.freeze({ generation, sourceHash: hash, snapshotFile, snapshotPath, deduplicated: false });
  } finally { release(); }
}

export function commitAlexaVocUpdateSync({ worktree, asin, cacheContent, render, fileOps: overrides }) {
  if (!/^[A-Z0-9]{10}$/.test(asin) || typeof cacheContent !== "string" || typeof render !== "function") {
    throw new Error("Invalid Alexa VOC update");
  }
  const paths = pathsFor(worktree);
  const fileOps = resolvedFileOps(overrides);
  fileOps.mkdirSync(paths.data, { recursive: true });
  const release = acquireInterprocessLockSync(paths.mutex);
  try {
    const current = readCurrentUnlocked(paths, fileOps);
    const baseSource = current.generation > 0
      ? fileOps.readFileSync(path.join(paths.snapshots, current.snapshotFile), "utf8")
      : fileOps.readFileSync(paths.projection, "utf8");
    const nextSource = render(baseSource);
    if (typeof nextSource !== "string" || !nextSource) throw new Error("Invalid Alexa VOC projection");
    if (Buffer.byteLength(nextSource) > ALEXA_SNAPSHOT_SINGLE_MAX_BYTES) {
      throw new Error("Alexa publication snapshot source exceeds quota");
    }
    const hash = sourceHash(nextSource);
    const cacheTarget = path.join(paths.data, "alexa-voc-cache", `${asin}.txt`);
    if (current.generation > 0 && current.sourceHash === hash) {
      let cacheMatches = false;
      try { cacheMatches = fileOps.readFileSync(cacheTarget, "utf8") === cacheContent; } catch {}
      if (!cacheMatches) atomicReplaceMany(paths, [{ target: cacheTarget, content: cacheContent }], fileOps);
      return Object.freeze({
        generation: current.generation,
        sourceHash: hash,
        snapshotPath: path.join(paths.snapshots, current.snapshotFile),
        deduplicated: true,
      });
    }
    const generation = current.generation + 1;
    const snapshotFile = `generation-${generation}-${hash}.ts`;
    const snapshotPath = path.join(paths.snapshots, snapshotFile);
    const nextState = { ...current, generation, dirty: true, sourceHash: hash, snapshotFile };
    atomicReplaceMany(paths, [
      { target: cacheTarget, content: cacheContent },
      { target: snapshotPath, content: nextSource },
      ...(current.buildingGeneration === null ? [{ target: paths.projection, content: nextSource }] : []),
      { target: paths.state, content: JSON.stringify(nextState) },
    ], fileOps);
    gcSnapshots(paths, nextState, fileOps);
    return Object.freeze({ generation, sourceHash: hash, snapshotPath, deduplicated: false });
  } finally { release(); }
}

export function claimAlexaPublicationWorker(worktree, {
  token,
  pid = process.pid,
  now = () => new Date(),
  inspectLegacyProcess = defaultInspectLegacyProcess,
} = {}) {
  if (!validToken(token) || !Number.isSafeInteger(pid) || pid < 1) throw new Error("Invalid Alexa publication worker");
  if (typeof inspectLegacyProcess !== "function") throw new Error("Invalid Alexa publication worker");
  return mutate(worktree, (current, paths, fileOps) => {
    let state = current;
    if (!state.dirty) {
      const source = fileOps.readFileSync(paths.projection, "utf8");
      const snapshot = writeSnapshotFile(paths, state.generation + 1, source, fileOps);
      state = { ...state, generation: snapshot.generation, dirty: true, sourceHash: snapshot.sourceHash, snapshotFile: snapshot.snapshotFile };
    }
    const timestamp = now();
    if (workerActive(state.worker, timestamp)) {
      return { state, value: Object.freeze({ spawnNeeded: false, token: state.worker.token, epoch: state.worker.epoch, generation: state.generation }) };
    }
    const legacy = legacyHandoff(paths, fileOps, inspectLegacyProcess);
    if (legacy.busy) {
      return { state, value: Object.freeze({
        spawnNeeded: false,
        legacyBusy: true,
        manualRecovery: legacy.manualRecovery,
        generation: state.generation,
      }) };
    }
    const epoch = state.epoch + 1;
    return {
      state: {
        ...state,
        epoch,
        worker: workerRecord(token, pid, epoch, timestamp),
        buildingGeneration: null,
        failure: null,
      },
      value: Object.freeze({ spawnNeeded: true, token, epoch, generation: state.generation }),
    };
  });
}

export function beginAlexaPublicationGeneration(worktree, { token, epoch, pid = process.pid, now = () => new Date() } = {}) {
  return mutate(worktree, (current, paths, fileOps) => {
    const ownedEpoch = matchingEpoch(current, epoch);
    if (current.worker?.token !== token) throw new Error("Alexa publication worker was fenced");
    if (!current.dirty || !current.snapshotFile) throw new Error("Alexa publication is not dirty");
    const snapshotPath = path.join(paths.snapshots, current.snapshotFile);
    const source = fileOps.readFileSync(snapshotPath, "utf8");
    if (sourceHash(source) !== current.sourceHash) throw new Error("Alexa publication snapshot mismatch");
    atomicReplaceMany(paths, [{ target: paths.projection, content: source }], fileOps);
    const timestamp = now();
    return {
      state: { ...current, buildingGeneration: current.generation, worker: workerRecord(token, pid, ownedEpoch, timestamp) },
      value: Object.freeze({ generation: current.generation, sourceHash: current.sourceHash, snapshotPath, epoch: ownedEpoch }),
    };
  });
}

export function completeAlexaPublicationGeneration(worktree, { token, epoch, generation }) {
  return mutate(worktree, (current) => {
    matchingEpoch(current, epoch);
    if (current.worker?.token !== token || current.buildingGeneration !== generation) throw new Error("Alexa publication worker was fenced");
    const needsMore = current.generation !== generation;
    return {
      state: needsMore
        ? { ...current, buildingGeneration: null, failure: null }
        : { ...current, dirty: false, buildingGeneration: null, worker: null, failure: null },
      value: Object.freeze({ continue: needsMore, generation: current.generation }),
    };
  });
}

export function failAlexaPublicationWorker(worktree, { token, epoch, failure, now = () => new Date() }) {
  return mutate(worktree, (current) => {
    const owned = current.worker?.token === token && (epoch === undefined || current.worker?.epoch === epoch);
    const observedFailure = failure && Number.isSafeInteger(failure.attempts) && failure.attempts > 0
      ? {
          message: String(failure.message ?? "publication failed").slice(0, 200),
          attempts: failure.attempts,
          at: now().toISOString(),
        }
      : current.failure;
    return {
      state: owned
        ? { ...current, dirty: current.generation > 0, buildingGeneration: null, worker: null, failure: observedFailure }
        : current,
      value: Object.freeze({ cleared: owned, generation: current.generation }),
    };
  });
}

export function heartbeatAlexaPublicationWorker(worktree, { token, epoch, pid = process.pid, now = () => new Date() }) {
  return mutate(worktree, (current) => {
    const ownedEpoch = matchingEpoch(current, epoch);
    if (current.worker?.token !== token) throw new Error("Alexa publication worker was fenced");
    return { state: { ...current, worker: workerRecord(token, pid, ownedEpoch, now()) }, value: true };
  });
}

export function adoptAlexaPublicationWorker(worktree, { token, epoch, pid, now = () => new Date() }) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Invalid Alexa publication worker");
  return mutate(worktree, (current) => {
    const ownedEpoch = matchingEpoch(current, epoch);
    if (current.worker?.token !== token) throw new Error("Alexa publication worker was fenced");
    return { state: { ...current, worker: workerRecord(token, pid, ownedEpoch, now()) }, value: true };
  });
}

export function writeFencedAlexaPublicationReloadSync({
  worktree,
  token,
  epoch,
  generation,
  sourceHash: expectedHash,
  write,
  now = () => new Date(),
}) {
  if (typeof write !== "function") throw new Error("Alexa publication reload writer is required");
  const paths = pathsFor(worktree);
  fs.mkdirSync(paths.data, { recursive: true });
  const release = acquireInterprocessLockSync(paths.mutex);
  try {
    const current = readCurrentUnlocked(paths, fs);
    matchingEpoch(current, epoch);
    if (
      current.worker?.token !== token
      || current.buildingGeneration !== generation
      || Date.parse(current.worker.leaseExpiresAt) <= now().getTime()
    ) throw new Error("Alexa publication worker was fenced");
    const snapshot = snapshotCandidates(paths).find((candidate) => candidate.generation === generation);
    if (!snapshot || snapshot.sourceHash !== expectedHash) throw new Error("Alexa publication snapshot mismatch");
    const result = write();
    if (result && typeof result.then === "function") throw new Error("Alexa publication reload writer must be synchronous");
    return result;
  } finally { release(); }
}
