import { createHash, randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { acquireInterprocessLock } from "./interprocess-lock.mjs";
import {
  commitWebPublicationControl,
  readWebPublicationControl,
} from "./web-publication-control.mjs";
import { establishWebArtifactReferenceSync } from "./web-artifact-store.mjs";

export const WEB_RELOAD_REQUEST_VERSION = 3;
const WEB_RELOAD_STREAM_REQUEST_VERSION = 4;
const MAX_JOB_ID_LENGTH = 128;
const MAX_HOST_LENGTH = 255;
const MAX_REQUEST_AGE_MS = 24 * 60 * 60 * 1_000;
const MAX_PUBLICATION_READ_ATTEMPTS = 2;
const PROJECTABLE_SYNC_STAGES = new Set([
  "keywords", "reviews", "sales_trend", "fba", "listing", "category", "traffic", "alexa_voc",
]);

function requestId(payload) {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function worktreeId(worktree) {
  return createHash("sha256").update(path.resolve(worktree)).digest("hex");
}

function assertPort(port) {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535 || port === 3000) {
    throw new Error("Invalid reload target");
  }
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

function stageContentHashesMatch(left, right) {
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  return leftEntries.length === rightEntries.length && leftEntries.every(([stage, hash]) => right[stage] === hash);
}

function validateTarget(target) {
  if (!target || typeof target !== "object" || Array.isArray(target)) throw new Error("Invalid reload target");
  if (Object.keys(target).sort().join(",") !== "webHost,webPort,worktreeId") throw new Error("Invalid reload target");
  if (!/^[a-f0-9]{64}$/.test(target.worktreeId)) throw new Error("Invalid reload target");
  if (typeof target.webHost !== "string" || !target.webHost || target.webHost.length > MAX_HOST_LENGTH) {
    throw new Error("Invalid reload target");
  }
  assertPort(target.webPort);
}

function validateStream(stream) {
  if (
    !stream
    || typeof stream !== "object"
    || Array.isArray(stream)
    || Object.keys(stream).sort().join(",") !== "epoch,generation,id"
    || stream.id !== "alexa_voc"
    || !Number.isSafeInteger(stream.generation)
    || stream.generation < 1
    || !Number.isSafeInteger(stream.epoch)
    || stream.epoch < 1
  ) throw new Error("Invalid reload request stream");
  return Object.freeze({ id: stream.id, generation: stream.generation, epoch: stream.epoch });
}

function validatePayload(candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("Invalid reload request");
  const hasStream = candidate.version === WEB_RELOAD_STREAM_REQUEST_VERSION;
  const expectedKeys = hasStream
    ? "artifactId,buildCompletedAt,jobId,jobVersion,stageContentHashes,stream,target,version"
    : "artifactId,buildCompletedAt,jobId,jobVersion,stageContentHashes,target,version";
  if (Object.keys(candidate).sort().join(",") !== expectedKeys) throw new Error("Invalid reload request");
  if (!hasStream && candidate.version !== WEB_RELOAD_REQUEST_VERSION) throw new Error("Invalid reload request");
  if (typeof candidate.jobId !== "string" || !/^[A-Za-z0-9_-]+$/.test(candidate.jobId) || candidate.jobId.length > MAX_JOB_ID_LENGTH) {
    throw new Error("Invalid reload request");
  }
  assertArtifactId(candidate.artifactId);
  if (!Number.isSafeInteger(candidate.jobVersion) || candidate.jobVersion < 1) throw new Error("Invalid reload request");
  const stageContentHashes = validateStageContentHashes(candidate.stageContentHashes, "Invalid reload request");
  if (typeof candidate.buildCompletedAt !== "string" || Number.isNaN(Date.parse(candidate.buildCompletedAt))) {
    throw new Error("Invalid reload request");
  }
  validateTarget(candidate.target);
  const stream = hasStream ? validateStream(candidate.stream) : null;
  if (stream && (
    candidate.jobVersion !== stream.generation
    || candidate.jobId !== `manual-alexa-voc-g${stream.generation}-${candidate.artifactId.slice(0, 24)}`
    || Object.keys(stageContentHashes).join(",") !== "alexa_voc"
  )) throw new Error("Invalid Alexa reload binding");
  return Object.freeze({
    version: hasStream ? WEB_RELOAD_STREAM_REQUEST_VERSION : WEB_RELOAD_REQUEST_VERSION,
    jobId: candidate.jobId,
    jobVersion: candidate.jobVersion,
    artifactId: candidate.artifactId,
    stageContentHashes,
    buildCompletedAt: candidate.buildCompletedAt,
    target: Object.freeze({ ...candidate.target }),
    ...(stream ? { stream } : {}),
  });
}

function validatePublicationReference(candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("Invalid Web publication reference");
  }
  if (Object.keys(candidate).sort().join(",") !== "artifactId,jobId,jobVersion,requestId,requestedAt,stageContentHashes") {
    throw new Error("Invalid Web publication reference");
  }
  if (typeof candidate.jobId !== "string" || !/^[A-Za-z0-9_-]+$/.test(candidate.jobId) || candidate.jobId.length > MAX_JOB_ID_LENGTH) {
    throw new Error("Invalid Web publication reference");
  }
  if (typeof candidate.requestId !== "string" || !/^[a-f0-9]{64}$/.test(candidate.requestId)) {
    throw new Error("Invalid Web publication reference");
  }
  try {
    assertArtifactId(candidate.artifactId);
    if (!Number.isSafeInteger(candidate.jobVersion) || candidate.jobVersion < 1) throw new Error();
  } catch {
    throw new Error("Invalid Web publication reference");
  }
  if (typeof candidate.requestedAt !== "string" || Number.isNaN(Date.parse(candidate.requestedAt))) {
    throw new Error("Invalid Web publication reference");
  }
  const stageContentHashes = validateStageContentHashes(candidate.stageContentHashes, "Invalid Web publication reference");
  return Object.freeze({ ...candidate, stageContentHashes });
}

function pendingPublication(reference) {
  return Object.freeze({
    status: "pending",
    requestId: reference.requestId,
    artifactId: reference.artifactId,
    requestedAt: reference.requestedAt,
  });
}

function appliedPublication(reference, appliedAt) {
  return Object.freeze({
    status: "applied",
    requestId: reference.requestId,
    artifactId: reference.artifactId,
    requestedAt: reference.requestedAt,
    appliedAt,
  });
}

function failedPublication(reference, failedAt, code = "WEB_PUBLICATION_FAILED") {
  return Object.freeze({
    status: "failed",
    requestId: reference.requestId,
    artifactId: reference.artifactId,
    requestedAt: reference.requestedAt,
    failedAt,
    code,
  });
}

function isMissing(error) {
  return error?.code === "ENOENT";
}

function publicationFailureTime() {
  return new Date().toISOString();
}

async function findExactRequest(directory, requestId) {
  const requestPath = path.join(directory, `${requestId}.json`);
  try {
    const stats = await fs.stat(requestPath);
    return stats.isFile() ? requestPath : null;
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function findProcessingRequests(directory, requestId) {
  const pattern = new RegExp(`^${requestId}(?:-[a-f0-9-]+)?\\.json$`);
  const names = (await fs.readdir(directory)).filter((name) => pattern.test(name)).sort();
  const matches = await Promise.all(names.map(async (name) => {
    const requestPath = path.join(directory, name);
    try {
      return (await fs.stat(requestPath)).isFile() ? requestPath : null;
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }));
  return matches.filter(Boolean);
}

async function fileTime(file) {
  return (await fs.stat(file)).mtime.toISOString();
}

async function findPublicationMatches(paths, requestId) {
  const [applied, failed, processing, pending] = await Promise.all([
    findExactRequest(paths.applied, requestId),
    findExactRequest(paths.failed, requestId),
    findProcessingRequests(paths.processing, requestId),
    findExactRequest(paths.pending, requestId),
  ]);
  return [
    ...(applied ? [{ path: applied, status: "applied" }] : []),
    ...(failed ? [{ path: failed, status: "failed" }] : []),
    ...processing.map((match) => ({ path: match, status: "pending" })),
    ...(pending ? [{ path: pending, status: "pending" }] : []),
  ];
}

async function verifyStableMatches(matches) {
  try {
    await Promise.all(matches.map(async ({ path: requestPath }) => {
      if (!(await fs.stat(requestPath)).isFile()) throw new Error("Missing reload request");
    }));
    return "stable";
  } catch (error) {
    return isMissing(error) ? "moved" : "unreadable";
  }
}

async function readStablePayload(file) {
  let serialized;
  try {
    serialized = await fs.readFile(file, "utf8");
  } catch (error) {
    if (isMissing(error)) return { state: "moved" };
    return { state: "unreadable" };
  }
  let timestamp;
  try {
    timestamp = await fileTime(file);
  } catch (error) {
    if (isMissing(error)) return { state: "moved" };
    return { state: "unreadable" };
  }
  try {
    const stored = JSON.parse(serialized);
    const failureCode = stored?.failureCode;
    const payload = failureCode === undefined
      ? validatePayload(stored)
      : validatePayload(Object.fromEntries(Object.entries(stored).filter(([key]) => key !== "failureCode")));
    if (failureCode !== undefined && failureCode !== "WEB_PUBLICATION_CONTENT_MISMATCH") throw new Error("Invalid acknowledgement");
    return { state: "ready", payload, failureCode, timestamp };
  } catch {
    return { state: "malformed", timestamp };
  }
}

function spoolPaths(spoolDir) {
  return {
    pending: path.join(spoolDir, "pending"),
    processing: path.join(spoolDir, "processing"),
    applied: path.join(spoolDir, "applied"),
    failed: path.join(spoolDir, "failed"),
    appliedGenerations: path.join(spoolDir, "applied-generations"),
  };
}

async function ensureSpool(spoolDir) {
  const directories = spoolPaths(spoolDir);
  await Promise.all(Object.values(directories).map((directory) => fs.mkdir(directory, { recursive: true })));
  return directories;
}

async function archive(claimedPath, destination) {
  try {
    await fs.rename(claimedPath, destination);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    await fs.rm(claimedPath, { force: true });
  }
}

function targetsMatch(actual, expected) {
  return actual.worktreeId === expected.worktreeId
    && actual.webHost === expected.webHost
    && actual.webPort === expected.webPort;
}

export function createWebReloadTarget({ worktree, webHost, webPort }) {
  if (typeof worktree !== "string" || !worktree) throw new Error("Invalid reload target");
  const target = Object.freeze({ worktreeId: worktreeId(worktree), webHost, webPort });
  validateTarget(target);
  return target;
}

export function configuredWebReloadTarget(env = process.env, worktree) {
  const webHost = env.WEB_HOST ?? env.HOST ?? "127.0.0.1";
  const rawPort = env.WEB_PORT ?? env.PORT ?? "3001";
  if (typeof rawPort !== "string" || !/^[1-9]\d*$/.test(rawPort)) throw new Error("Invalid reload target");
  return createWebReloadTarget({ worktree, webHost, webPort: Number(rawPort) });
}

async function coalescePendingStream(directory, payload, ownId) {
  const names = (await fs.readdir(directory)).filter((name) => /^[a-f0-9]{64}\.json$/.test(name));
  await Promise.all(names.map(async (name) => {
    if (name === `${ownId}.json`) return;
    const file = path.join(directory, name);
    try {
      const candidate = validatePayload(JSON.parse(await fs.readFile(file, "utf8")));
      if (
        candidate.stream?.id === payload.stream.id
        && targetsMatch(candidate.target, payload.target)
        && candidate.stream.generation < payload.stream.generation
      ) {
        await fs.rm(file, { force: true });
      }
    } catch {}
  }));
}

function coalescePendingStreamSync(directory, payload, ownId) {
  for (const name of fsSync.readdirSync(directory).filter((entry) => /^[a-f0-9]{64}\.json$/.test(entry))) {
    if (name === `${ownId}.json`) continue;
    const file = path.join(directory, name);
    try {
      const candidate = validatePayload(JSON.parse(fsSync.readFileSync(file, "utf8")));
      if (
        candidate.stream?.id === payload.stream.id
        && targetsMatch(candidate.target, payload.target)
        && candidate.stream.generation < payload.stream.generation
      ) {
        fsSync.rmSync(file, { force: true });
      }
    } catch {}
  }
}

export async function writeWebReloadRequest(
  { jobId, jobVersion, artifactId, stageContentHashes, buildCompletedAt, target, stream },
  { spoolDir = path.join(process.cwd(), "data", "web-reload-requests") } = {},
) {
  const payload = validatePayload({
    version: stream ? WEB_RELOAD_STREAM_REQUEST_VERSION : WEB_RELOAD_REQUEST_VERSION,
    jobId,
    jobVersion,
    artifactId,
    stageContentHashes,
    buildCompletedAt,
    target,
    ...(stream ? { stream } : {}),
  });
  const paths = await ensureSpool(spoolDir);
  const id = requestId(payload);
  const requestPath = path.join(paths.pending, `${id}.json`);
  const temporaryPath = path.join(paths.pending, `.${id}.tmp-${randomUUID()}`);
  await fs.writeFile(temporaryPath, JSON.stringify(payload), { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    await fs.rename(temporaryPath, requestPath);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    await fs.rm(temporaryPath, { force: true });
  }
  if (payload.stream) await coalescePendingStream(paths.pending, payload, id);
  return Object.freeze({ id, path: requestPath, payload });
}

export function writeWebReloadRequestSync(
  { jobId, jobVersion, artifactId, stageContentHashes, buildCompletedAt, target, stream },
  {
    spoolDir = path.join(process.cwd(), "data", "web-reload-requests"),
    reservation,
    referenceEstablished = false,
  } = {},
) {
  if (reservation && !referenceEstablished) {
    return establishWebArtifactReferenceSync({
      ...reservation,
      artifactId,
      write: () => writeWebReloadRequestSync(
        { jobId, jobVersion, artifactId, stageContentHashes, buildCompletedAt, target, stream },
        { spoolDir, referenceEstablished: true },
      ),
    });
  }
  const payload = validatePayload({
    version: stream ? WEB_RELOAD_STREAM_REQUEST_VERSION : WEB_RELOAD_REQUEST_VERSION,
    jobId,
    jobVersion,
    artifactId,
    stageContentHashes,
    buildCompletedAt,
    target,
    ...(stream ? { stream } : {}),
  });
  const paths = spoolPaths(spoolDir);
  for (const directory of Object.values(paths)) fsSync.mkdirSync(directory, { recursive: true });
  const id = requestId(payload);
  const requestPath = path.join(paths.pending, `${id}.json`);
  const temporaryPath = path.join(paths.pending, `.${id}.tmp-${randomUUID()}`);
  fsSync.writeFileSync(temporaryPath, JSON.stringify(payload), { encoding: "utf8", flag: "wx", mode: 0o600 });
  try { fsSync.renameSync(temporaryPath, requestPath); }
  catch (error) {
    if (error?.code !== "EEXIST") throw error;
    fsSync.rmSync(temporaryPath, { force: true });
  }
  if (payload.stream) coalescePendingStreamSync(paths.pending, payload, id);
  return Object.freeze({ id, path: requestPath, payload });
}

export async function readWebReloadPublication(
  reference,
  { spoolDir = path.join(process.cwd(), "data", "web-reload-requests") } = {},
) {
  const safe = validatePublicationReference(reference);
  const paths = await ensureSpool(spoolDir);
  for (let attempt = 0; attempt < MAX_PUBLICATION_READ_ATTEMPTS; attempt += 1) {
    let matches;
    try {
      matches = await findPublicationMatches(paths, safe.requestId);
    } catch {
      return failedPublication(safe, publicationFailureTime());
    }
    const stability = await verifyStableMatches(matches);
    if (stability === "moved") continue;
    if (stability === "unreadable") return failedPublication(safe, publicationFailureTime());
    if (matches.length > 1) return failedPublication(safe, publicationFailureTime(), "WEB_PUBLICATION_CONTENT_MISMATCH");
    if (matches.length === 0) return pendingPublication(safe);

    const [{ path: match, status }] = matches;
    const result = await readStablePayload(match);
    if (result.state === "moved") continue;
    if (result.state === "unreadable") return failedPublication(safe, publicationFailureTime());
    if (result.state === "malformed") {
      return failedPublication(safe, result.timestamp, "WEB_PUBLICATION_CONTENT_MISMATCH");
    }

    const { payload, failureCode, timestamp } = result;
    if (
      requestId(payload) !== safe.requestId
      || payload.artifactId !== safe.artifactId
      || payload.jobId !== safe.jobId
      || payload.jobVersion !== safe.jobVersion
      || !stageContentHashesMatch(payload.stageContentHashes, safe.stageContentHashes)
      || payload.buildCompletedAt !== safe.requestedAt
    ) {
      return failedPublication(safe, timestamp, "WEB_PUBLICATION_CONTENT_MISMATCH");
    }
    if (status === "applied" && failureCode !== undefined) {
      return failedPublication(safe, timestamp, "WEB_PUBLICATION_CONTENT_MISMATCH");
    }
    return status === "applied"
      ? appliedPublication(safe, timestamp)
      : status === "failed"
        ? failedPublication(safe, timestamp, failureCode)
        : pendingPublication(safe);
  }
  return pendingPublication(safe);
}

export async function readPendingWebReloadRequests(
  { spoolDir = path.join(process.cwd(), "data", "web-reload-requests") } = {},
) {
  const paths = await ensureSpool(spoolDir);
  const names = (await fs.readdir(paths.pending)).filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).sort();
  return Promise.all(names.map(async (name) => {
    const requestPath = path.join(paths.pending, name);
    let payload = null;
    try {
      payload = JSON.parse(await fs.readFile(requestPath, "utf8"));
    } catch {}
    return Object.freeze({ path: requestPath, payload });
  }));
}

async function readValidReloadRequests(directory) {
  const names = (await fs.readdir(directory))
    .filter((name) => /^[a-f0-9]{64}(?:-[a-f0-9-]{36})?\.json$/.test(name))
    .sort();
  const requests = await Promise.all(names.map(async (name) => {
    try {
      return validatePayload(JSON.parse(await fs.readFile(path.join(directory, name), "utf8")));
    } catch {
      return null;
    }
  }));
  return requests.filter(Boolean);
}

export async function readActiveWebReloadRequests(
  { spoolDir = path.join(process.cwd(), "data", "web-reload-requests") } = {},
) {
  const paths = await ensureSpool(spoolDir);
  const pending = await readValidReloadRequests(paths.pending);
  const processing = await readValidReloadRequests(paths.processing);
  const unique = new Map();
  for (const payload of [...pending, ...processing]) unique.set(requestId(payload), payload);
  return Object.freeze([...unique.values()]);
}

async function readProcessingWebReloadRequests(paths) {
  const names = (await fs.readdir(paths.processing))
    .filter((name) => /^[a-f0-9]{64}-[a-f0-9-]{36}\.json$/.test(name));
  return Promise.all(names.map(async (name) => {
    const requestPath = path.join(paths.processing, name);
    let payload = null;
    try { payload = JSON.parse(await fs.readFile(requestPath, "utf8")); } catch {}
    return Object.freeze({ path: requestPath, payload, processing: true });
  }));
}

function selectNextReloadRequest(requests) {
  const annotated = requests.map((entry) => {
    try { return { ...entry, valid: validatePayload(entry.payload) }; }
    catch { return { ...entry, valid: null }; }
  });
  const streamHeads = new Map();
  for (const entry of annotated) {
    if (!entry.valid?.stream) continue;
    const key = JSON.stringify({ target: entry.valid.target, id: entry.valid.stream.id });
    streamHeads.set(key, Math.max(streamHeads.get(key) ?? 0, entry.valid.stream.generation));
  }
  const eligible = annotated.filter((entry) => {
    if (!entry.valid?.stream) return true;
    const key = JSON.stringify({ target: entry.valid.target, id: entry.valid.stream.id });
    return entry.valid.stream.generation === streamHeads.get(key);
  });
  eligible.sort((left, right) => {
    if (!left.valid && right.valid) return -1;
    if (left.valid && !right.valid) return 1;
    if (
      left.valid?.stream && right.valid?.stream
      && left.valid.stream.id === right.valid.stream.id
      && left.valid.stream.generation === right.valid.stream.generation
      && targetsMatch(left.valid.target, right.valid.target)
      && streamContentBinding(left.valid) === streamContentBinding(right.valid)
      && left.valid.stream.epoch !== right.valid.stream.epoch
    ) return right.valid.stream.epoch - left.valid.stream.epoch;
    const timeOrder = Date.parse(left.valid?.buildCompletedAt ?? "") - Date.parse(right.valid?.buildCompletedAt ?? "");
    return (Number.isFinite(timeOrder) && timeOrder !== 0) ? timeOrder : left.path.localeCompare(right.path);
  });
  return eligible[0] ?? null;
}

function streamContentBinding(payload) {
  return JSON.stringify({
    artifactId: payload.artifactId,
    jobId: payload.jobId,
    jobVersion: payload.jobVersion,
    stageContentHashes: payload.stageContentHashes,
  });
}

function conflictingAlexaGeneration(requests) {
  const groups = new Map();
  for (const entry of requests) {
    let payload;
    try { payload = validatePayload(entry.payload); } catch { continue; }
    if (!payload.stream) continue;
    const key = JSON.stringify({ target: payload.target, id: payload.stream.id, generation: payload.stream.generation });
    const binding = streamContentBinding(payload);
    const group = groups.get(key) ?? { bindings: new Set(), entries: [] };
    group.bindings.add(binding);
    group.entries.push({ ...entry, payload });
    groups.set(key, group);
  }
  return [...groups.values()].find((group) => group.bindings.size > 1) ?? null;
}

async function quarantineConflict(paths, conflict) {
  for (const entry of conflict.entries) {
    const id = requestId(entry.payload);
    await fs.writeFile(entry.path, JSON.stringify({
      ...entry.payload,
      failureCode: "WEB_PUBLICATION_CONTENT_MISMATCH",
    }), { encoding: "utf8", mode: 0o600 });
    await archive(entry.path, path.join(paths.failed, `${id}.json`));
  }
}

async function readStreamHighWater(spoolDir, payload) {
  const control = await readWebPublicationControl({
    controlPath: path.join(spoolDir, "current-known-good.json"),
    expectedTarget: payload.target,
  });
  const value = control?.streams?.[payload.stream.id];
  if (!value) return null;
  return Object.freeze({
    ...value,
    stageContentHashes: Object.freeze({ alexa_voc: value.stageContentHash }),
  });
}

async function advanceDurableCurrent(spoolDir, payload, id, now) {
  return commitWebPublicationControl({
    controlPath: path.join(spoolDir, "current-known-good.json"),
    payload,
    requestId: id,
    now,
  });
}

async function consumeWebReloadRequestUnlocked({
  spoolDir = path.join(process.cwd(), "data", "web-reload-requests"),
  expectedTarget,
  apply,
  now = () => new Date(),
  maxAgeMs = MAX_REQUEST_AGE_MS,
} = {}) {
  validateTarget(expectedTarget);
  if (typeof apply !== "function") throw new Error("Reload apply callback is required");
  const paths = await ensureSpool(spoolDir);
  const pending = (await readPendingWebReloadRequests({ spoolDir })).map((entry) => ({ ...entry, processing: false }));
  const processing = await readProcessingWebReloadRequests(paths);
  const conflict = conflictingAlexaGeneration([...processing, ...pending]);
  if (conflict) {
    await quarantineConflict(paths, conflict);
    return Object.freeze({ status: "failed" });
  }
  const next = selectNextReloadRequest([...processing, ...pending]);
  if (!next) return Object.freeze({ status: "none" });

  let claimPath = next.path;
  if (!next.processing) {
    claimPath = path.join(paths.processing, `${path.basename(next.path, ".json")}-${randomUUID()}.json`);
    try {
      await fs.rename(next.path, claimPath);
    } catch (error) {
      if (error?.code === "ENOENT") return Object.freeze({ status: "none" });
      throw error;
    }
  }

  let payload;
  let id;
  try {
    payload = validatePayload(JSON.parse(await fs.readFile(claimPath, "utf8")));
    id = requestId(payload);
  } catch {
    await fs.rm(claimPath, { force: true });
    const safeInvalidArchive = {
      version: WEB_RELOAD_REQUEST_VERSION,
      jobId: "invalid",
      jobVersion: 1,
      artifactId: "0".repeat(64),
      stageContentHashes: { keywords: "0".repeat(64) },
      buildCompletedAt: new Date(0).toISOString(),
      target: expectedTarget,
    };
    await fs.writeFile(
      path.join(paths.failed, `${randomUUID()}.json`),
      JSON.stringify(safeInvalidArchive),
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    return Object.freeze({ status: "invalid" });
  }

  const appliedPath = path.join(paths.applied, `${id}.json`);
  const failedPath = path.join(paths.failed, `${id}.json`);
  try {
    await fs.access(appliedPath);
    await fs.rm(claimPath, { force: true });
    return Object.freeze({ status: "duplicate" });
  } catch {}
  try {
    await fs.access(failedPath);
    await fs.rm(claimPath, { force: true });
    return Object.freeze({ status: "duplicate" });
  } catch {}

  const completedAt = Date.parse(payload.buildCompletedAt);
  const expired = !Number.isFinite(completedAt) || completedAt > now().getTime() || now().getTime() - completedAt > maxAgeMs;
  if (!targetsMatch(payload.target, expectedTarget) || expired) {
    await archive(claimPath, failedPath);
    return Object.freeze({ status: "invalid" });
  }

  let durableCurrent;
  try {
    durableCurrent = await readWebPublicationControl({
      controlPath: path.join(spoolDir, "current-known-good.json"),
      expectedTarget: payload.target,
    });
  } catch {
    await archive(claimPath, failedPath);
    return Object.freeze({ status: "failed" });
  }
  if (durableCurrent?.committedRequestId === id) {
    await archive(claimPath, appliedPath);
    return Object.freeze({ status: "duplicate" });
  }

  let highWater = null;
  if (payload.stream) {
    try { highWater = await readStreamHighWater(spoolDir, payload); }
    catch {
      await archive(claimPath, failedPath);
      return Object.freeze({ status: "failed" });
    }
    if (highWater && payload.stream.generation <= highWater.generation) {
      if (
        payload.stream.generation === highWater.generation
        && (payload.artifactId !== highWater.artifactId
          || !stageContentHashesMatch(payload.stageContentHashes, highWater.stageContentHashes))
      ) {
        await fs.writeFile(claimPath, JSON.stringify({ ...payload, failureCode: "WEB_PUBLICATION_CONTENT_MISMATCH" }), "utf8");
        await archive(claimPath, failedPath);
        return Object.freeze({ status: "failed" });
      }
      if (payload.stream.generation === highWater.generation) {
        if (payload.stream.epoch > highWater.epoch) {
          await advanceDurableCurrent(spoolDir, payload, id, now);
        }
        await archive(claimPath, appliedPath);
        return Object.freeze({ status: "duplicate" });
      }
      await archive(claimPath, failedPath);
      return Object.freeze({ status: "superseded" });
    }
  }

  let highWaterCommitted = false;
  try {
    const commitHighWater = async () => {
      if (highWaterCommitted) return;
      await advanceDurableCurrent(spoolDir, payload, id, now);
      highWaterCommitted = true;
    };
    await apply(payload, { commitHighWater });
    await commitHighWater();
    await archive(claimPath, appliedPath);
    return Object.freeze({ status: "applied", payload });
  } catch (error) {
    if (highWaterCommitted) {
      await archive(claimPath, appliedPath);
      return Object.freeze({ status: "applied", payload });
    }
    if (error?.code === "WEB_PUBLICATION_CONTENT_MISMATCH") {
      await fs.writeFile(claimPath, JSON.stringify({
        ...payload,
        failureCode: "WEB_PUBLICATION_CONTENT_MISMATCH",
      }), { encoding: "utf8", mode: 0o600 });
    }
    await archive(claimPath, failedPath);
    return Object.freeze({ status: "failed" });
  }
}

export async function consumeWebReloadRequest(options = {}) {
  const spoolDir = options.spoolDir ?? path.join(process.cwd(), "data", "web-reload-requests");
  await fs.mkdir(spoolDir, { recursive: true });
  const release = await acquireInterprocessLock(path.join(spoolDir, ".consume.lock"));
  try { return await consumeWebReloadRequestUnlocked({ ...options, spoolDir }); }
  finally { release(); }
}
