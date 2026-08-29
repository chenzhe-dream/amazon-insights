import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { acquireInterprocessLockSync } from "./interprocess-lock.mjs";

export const ALEXA_PUBLICATION_LEASE_MS = 20 * 60 * 1_000;
const STATE_VERSION = 1;

function pathsFor(worktree) {
  const data = path.join(path.resolve(worktree), "data");
  const state = path.join(data, "alexa-publication-state.json");
  return {
    data,
    state,
    mutex: `${state}.lock`,
    snapshots: path.join(data, "alexa-publication-snapshots"),
    projection: path.join(path.resolve(worktree), "app", "rufus-voc-data.ts"),
    legacyLock: path.join(data, ".rebuild-lock.json"),
  };
}

function sourceHash(source) {
  return createHash("sha256").update(source).digest("hex");
}

function validToken(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function validState(value) {
  if (
    value?.version !== STATE_VERSION
    || !Number.isSafeInteger(value.generation)
    || value.generation < 0
    || typeof value.dirty !== "boolean"
  ) return false;
  if (value.generation === 0) {
    if (value.sourceHash !== null || value.snapshotFile !== null) return false;
  } else if (
    typeof value.sourceHash !== "string"
    || !/^[a-f0-9]{64}$/.test(value.sourceHash)
    || typeof value.snapshotFile !== "string"
    || !/^generation-\d+-[a-f0-9]{64}\.ts$/.test(value.snapshotFile)
  ) return false;
  if (value.buildingGeneration !== null && (!Number.isSafeInteger(value.buildingGeneration) || value.buildingGeneration < 1)) {
    return false;
  }
  if (value.worker !== null) {
    if (
      !validToken(value.worker?.token)
      || !Number.isSafeInteger(value.worker?.pid)
      || value.worker.pid < 1
      || typeof value.worker.heartbeatAt !== "string"
      || Number.isNaN(Date.parse(value.worker.heartbeatAt))
      || typeof value.worker.leaseExpiresAt !== "string"
      || Number.isNaN(Date.parse(value.worker.leaseExpiresAt))
    ) return false;
  }
  return true;
}

function emptyState() {
  return {
    version: STATE_VERSION,
    generation: 0,
    dirty: false,
    sourceHash: null,
    snapshotFile: null,
    buildingGeneration: null,
    worker: null,
  };
}

function snapshotCandidates(paths) {
  let names = [];
  try { names = fs.readdirSync(paths.snapshots); }
  catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return names.flatMap((name) => {
    const match = /^generation-(\d+)-([a-f0-9]{64})\.ts$/.exec(name);
    if (!match) return [];
    const generation = Number(match[1]);
    if (!Number.isSafeInteger(generation) || generation < 1) return [];
    const file = path.join(paths.snapshots, name);
    try {
      const source = fs.readFileSync(file, "utf8");
      return sourceHash(source) === match[2] ? [{ generation, sourceHash: match[2], snapshotFile: name }] : [];
    } catch { return []; }
  }).sort((left, right) => right.generation - left.generation);
}

function readStateUnlocked(paths) {
  try {
    const value = JSON.parse(fs.readFileSync(paths.state, "utf8"));
    if (validState(value)) return value;
  } catch {}
  const recovered = snapshotCandidates(paths)[0];
  return recovered
    ? { ...emptyState(), ...recovered, dirty: true }
    : emptyState();
}

function atomicWrite(file, value) {
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(temporary, JSON.stringify(value), { encoding: "utf8", flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, file);
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch {}
    throw error;
  }
}

function atomicReplaceMany(entries, fileOps = fs) {
  const prepared = entries.map(({ target, content, mode = 0o600 }) => ({
    target,
    temporary: `${target}.tmp-${process.pid}-${randomUUID()}`,
    backup: `${target}.bak-${process.pid}-${randomUUID()}`,
    content,
    mode,
    hadOriginal: false,
    installed: false,
  }));
  try {
    for (const entry of prepared) {
      fileOps.mkdirSync(path.dirname(entry.target), { recursive: true });
      fileOps.writeFileSync(entry.temporary, entry.content, {
        encoding: "utf8", flag: "wx", mode: entry.mode,
      });
    }
    for (const entry of prepared) {
      entry.hadOriginal = fileOps.existsSync(entry.target);
      if (entry.hadOriginal) fileOps.renameSync(entry.target, entry.backup);
      fileOps.renameSync(entry.temporary, entry.target);
      entry.installed = true;
    }
    for (const entry of prepared) {
      if (entry.hadOriginal) fileOps.rmSync(entry.backup, { force: true });
    }
  } catch (error) {
    for (const entry of [...prepared].reverse()) {
      try { if (entry.installed) fileOps.rmSync(entry.target, { force: true }); } catch {}
      try {
        if (entry.hadOriginal && fileOps.existsSync(entry.backup)) {
          fileOps.renameSync(entry.backup, entry.target);
        }
      } catch {}
      try { fileOps.rmSync(entry.temporary, { force: true }); } catch {}
      try { fileOps.rmSync(entry.backup, { force: true }); } catch {}
    }
    throw error;
  }
}

function resolvedFileOps(overrides = {}) {
  return Object.freeze({
    mkdirSync: overrides.mkdirSync ?? fs.mkdirSync,
    writeFileSync: overrides.writeFileSync ?? fs.writeFileSync,
    existsSync: overrides.existsSync ?? fs.existsSync,
    renameSync: overrides.renameSync ?? fs.renameSync,
    rmSync: overrides.rmSync ?? fs.rmSync,
    readFileSync: overrides.readFileSync ?? fs.readFileSync,
  });
}

function mutate(worktree, updater) {
  const paths = pathsFor(worktree);
  fs.mkdirSync(paths.data, { recursive: true });
  const release = acquireInterprocessLockSync(paths.mutex);
  try {
    fs.rmSync(paths.legacyLock, { force: true });
    const current = readStateUnlocked(paths);
    const result = updater(current, paths);
    if (!validState(result.state)) throw new Error("Invalid Alexa publication state");
    atomicWrite(paths.state, result.state);
    return result.value;
  } finally {
    release();
  }
}

function writeSnapshot(paths, generation, source) {
  const hash = sourceHash(source);
  const snapshotFile = `generation-${generation}-${hash}.ts`;
  const destination = path.join(paths.snapshots, snapshotFile);
  fs.mkdirSync(paths.snapshots, { recursive: true });
  try {
    fs.writeFileSync(destination, source, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error?.code !== "EEXIST" || fs.readFileSync(destination, "utf8") !== source) throw error;
  }
  return { generation, sourceHash: hash, snapshotFile, snapshotPath: destination };
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code !== "ESRCH"; }
}

function workerActive(worker, now) {
  return Boolean(worker && Date.parse(worker.leaseExpiresAt) > now.getTime() && pidAlive(worker.pid));
}

function workerRecord(token, pid, now) {
  return {
    token,
    pid,
    heartbeatAt: now.toISOString(),
    leaseExpiresAt: new Date(now.getTime() + ALEXA_PUBLICATION_LEASE_MS).toISOString(),
  };
}

export function readAlexaPublicationState(worktree) {
  const paths = pathsFor(worktree);
  return readStateUnlocked(paths);
}

export function recordAlexaVocGeneration({ worktree, source }) {
  if (typeof source !== "string") throw new Error("Invalid Alexa VOC source");
  return mutate(worktree, (current, paths) => {
    const snapshot = writeSnapshot(paths, current.generation + 1, source);
    return {
      state: {
        ...current,
        generation: snapshot.generation,
        dirty: true,
        sourceHash: snapshot.sourceHash,
        snapshotFile: snapshot.snapshotFile,
      },
      value: Object.freeze(snapshot),
    };
  });
}

export function commitAlexaVocUpdateSync({
  worktree,
  asin,
  cacheContent,
  render,
  fileOps: fileOpsOverrides,
}) {
  if (!/^[A-Z0-9]{10}$/.test(asin) || typeof cacheContent !== "string" || typeof render !== "function") {
    throw new Error("Invalid Alexa VOC update");
  }
  const fileOps = resolvedFileOps(fileOpsOverrides);
  const paths = pathsFor(worktree);
  fileOps.mkdirSync(paths.data, { recursive: true });
  const release = acquireInterprocessLockSync(paths.mutex);
  try {
    fileOps.rmSync(paths.legacyLock, { force: true });
    const current = readStateUnlocked(paths);
    const baseSource = current.generation > 0 && current.snapshotFile
      ? fileOps.readFileSync(path.join(paths.snapshots, current.snapshotFile), "utf8")
      : fileOps.readFileSync(paths.projection, "utf8");
    const nextSource = render(baseSource);
    if (typeof nextSource !== "string" || !nextSource) throw new Error("Invalid Alexa VOC projection");
    const generation = current.generation + 1;
    const hash = sourceHash(nextSource);
    const snapshotFile = `generation-${generation}-${hash}.ts`;
    const snapshotPath = path.join(paths.snapshots, snapshotFile);
    const nextState = {
      ...current,
      generation,
      dirty: true,
      sourceHash: hash,
      snapshotFile,
    };
    const entries = [
      { target: path.join(paths.data, "alexa-voc-cache", `${asin}.txt`), content: cacheContent },
      { target: snapshotPath, content: nextSource },
      ...(current.buildingGeneration === null ? [{ target: paths.projection, content: nextSource }] : []),
      { target: paths.state, content: JSON.stringify(nextState) },
    ];
    atomicReplaceMany(entries, fileOps);
    return Object.freeze({ generation, sourceHash: hash, snapshotPath });
  } finally {
    release();
  }
}

export function claimAlexaPublicationWorker(worktree, {
  token,
  pid = process.pid,
  now = () => new Date(),
} = {}) {
  if (!validToken(token) || !Number.isSafeInteger(pid) || pid < 1) throw new Error("Invalid Alexa publication worker");
  return mutate(worktree, (current, paths) => {
    let state = current;
    if (!state.dirty) {
      const source = fs.readFileSync(paths.projection, "utf8");
      const snapshot = writeSnapshot(paths, state.generation + 1, source);
      state = {
        ...state,
        generation: snapshot.generation,
        dirty: true,
        sourceHash: snapshot.sourceHash,
        snapshotFile: snapshot.snapshotFile,
      };
    }
    const timestamp = now();
    if (workerActive(state.worker, timestamp)) {
      return { state, value: Object.freeze({ spawnNeeded: false, token: state.worker.token, generation: state.generation }) };
    }
    return {
      state: { ...state, worker: workerRecord(token, pid, timestamp), buildingGeneration: null },
      value: Object.freeze({ spawnNeeded: true, token, generation: state.generation }),
    };
  });
}

export function beginAlexaPublicationGeneration(worktree, {
  token,
  pid = process.pid,
  now = () => new Date(),
} = {}) {
  return mutate(worktree, (current, paths) => {
    if (current.worker?.token !== token) throw new Error("Alexa publication worker was fenced");
    if (!current.dirty || !current.snapshotFile) throw new Error("Alexa publication is not dirty");
    const snapshotPath = path.join(paths.snapshots, current.snapshotFile);
    const source = fs.readFileSync(snapshotPath, "utf8");
    if (sourceHash(source) !== current.sourceHash) throw new Error("Alexa publication snapshot mismatch");
    const projectionTemporary = `${paths.projection}.tmp-${process.pid}-${randomUUID()}`;
    fs.writeFileSync(projectionTemporary, source, { encoding: "utf8", flag: "wx" });
    fs.renameSync(projectionTemporary, paths.projection);
    const timestamp = now();
    return {
      state: {
        ...current,
        buildingGeneration: current.generation,
        worker: workerRecord(token, pid, timestamp),
      },
      value: Object.freeze({
        generation: current.generation,
        sourceHash: current.sourceHash,
        snapshotPath,
      }),
    };
  });
}

export function completeAlexaPublicationGeneration(worktree, { token, generation }) {
  return mutate(worktree, (current) => {
    if (current.worker?.token !== token || current.buildingGeneration !== generation) {
      throw new Error("Alexa publication worker was fenced");
    }
    const needsMore = current.generation !== generation;
    return {
      state: needsMore
        ? { ...current, buildingGeneration: null }
        : { ...current, dirty: false, buildingGeneration: null, worker: null },
      value: Object.freeze({ continue: needsMore, generation: current.generation }),
    };
  });
}

export function failAlexaPublicationWorker(worktree, { token }) {
  return mutate(worktree, (current) => ({
    state: current.worker?.token === token
      ? { ...current, dirty: current.generation > 0, buildingGeneration: null, worker: null }
      : current,
    value: Object.freeze({ cleared: current.worker?.token === token, generation: current.generation }),
  }));
}

export function heartbeatAlexaPublicationWorker(worktree, { token, pid = process.pid, now = () => new Date() }) {
  return mutate(worktree, (current) => {
    if (current.worker?.token !== token) throw new Error("Alexa publication worker was fenced");
    return { state: { ...current, worker: workerRecord(token, pid, now()) }, value: true };
  });
}

export function adoptAlexaPublicationWorker(worktree, { token, pid, now = () => new Date() }) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Invalid Alexa publication worker");
  return mutate(worktree, (current) => {
    if (current.worker?.token !== token) throw new Error("Alexa publication worker was fenced");
    return { state: { ...current, worker: workerRecord(token, pid, now()) }, value: true };
  });
}
