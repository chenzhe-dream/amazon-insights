import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const HASH = /^[a-f0-9]{64}$/;
const JOB_ID = /^[A-Za-z0-9_-]{1,200}$/;
const STAGES = new Set([
  "keywords", "reviews", "sales_trend", "fba", "listing", "category", "traffic", "alexa_voc",
]);

export function webPublicationControlPath(worktree) {
  return path.join(path.resolve(worktree), "data", "web-reload-requests", "current-known-good.json");
}

function validTarget(value) {
  return value
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === "webHost,webPort,worktreeId"
    && HASH.test(value.worktreeId)
    && typeof value.webHost === "string"
    && value.webHost.length > 0
    && value.webHost.length <= 255
    && Number.isSafeInteger(value.webPort)
    && value.webPort >= 1
    && value.webPort <= 65_535
    && value.webPort !== 3000;
}

function targetsMatch(left, right) {
  return left.worktreeId === right.worktreeId && left.webHost === right.webHost && left.webPort === right.webPort;
}

function stageHashes(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
  const entries = Object.entries(value);
  if (!entries.length || entries.some(([stage, hash]) => !STAGES.has(stage) || typeof hash !== "string" || !HASH.test(hash))) {
    throw new Error();
  }
  return Object.freeze(Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right))));
}

function currentArtifact(value) {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "artifactId,jobId,jobVersion,stageContentHashes,storageName"
    || !HASH.test(value.artifactId)
    || typeof value.jobId !== "string"
    || !JOB_ID.test(value.jobId)
    || !Number.isSafeInteger(value.jobVersion)
    || value.jobVersion < 1
    || typeof value.storageName !== "string"
    || !(/^(?:publication-[a-f0-9]{64}|snapshot-\d+-[a-f0-9-]+)$/.test(value.storageName))
  ) throw new Error();
  return Object.freeze({ ...value, stageContentHashes: stageHashes(value.stageContentHashes) });
}

function alexaStream(value) {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "artifactId,epoch,generation,stageContentHash"
    || !HASH.test(value.artifactId)
    || !HASH.test(value.stageContentHash)
    || !Number.isSafeInteger(value.generation)
    || value.generation < 1
    || !Number.isSafeInteger(value.epoch)
    || value.epoch < 1
  ) throw new Error();
  return Object.freeze({ ...value });
}

function parseControl(value, expectedTarget) {
  try {
    if (
      !value
      || typeof value !== "object"
      || Array.isArray(value)
      || Object.keys(value).sort().join(",") !== "committedAt,committedRequestId,current,streams,target,version"
      || value.version !== 1
      || !validTarget(value.target)
      || (expectedTarget && !targetsMatch(value.target, expectedTarget))
      || typeof value.committedAt !== "string"
      || Number.isNaN(Date.parse(value.committedAt))
      || typeof value.committedRequestId !== "string"
      || !HASH.test(value.committedRequestId)
      || !value.streams
      || typeof value.streams !== "object"
      || Array.isArray(value.streams)
      || Object.keys(value.streams).some((key) => key !== "alexa_voc")
    ) throw new Error();
    const current = currentArtifact(value.current);
    const streams = Object.freeze({
      ...(value.streams.alexa_voc ? { alexa_voc: alexaStream(value.streams.alexa_voc) } : {}),
    });
    return Object.freeze({
      version: 1,
      target: Object.freeze({ ...value.target }),
      current,
      streams,
      committedRequestId: value.committedRequestId,
      committedAt: value.committedAt,
    });
  } catch {
    throw new Error("Invalid durable Web publication current");
  }
}

export function readWebPublicationControlSync({ controlPath, expectedTarget } = {}) {
  let serialized;
  try { serialized = fsSync.readFileSync(controlPath, "utf8"); }
  catch (error) { if (error?.code === "ENOENT") return null; throw new Error("Invalid durable Web publication current"); }
  try { return parseControl(JSON.parse(serialized), expectedTarget); }
  catch { throw new Error("Invalid durable Web publication current"); }
}

export async function readWebPublicationControl({ controlPath, expectedTarget } = {}) {
  let serialized;
  try { serialized = await fs.readFile(controlPath, "utf8"); }
  catch (error) { if (error?.code === "ENOENT") return null; throw new Error("Invalid durable Web publication current"); }
  try { return parseControl(JSON.parse(serialized), expectedTarget); }
  catch { throw new Error("Invalid durable Web publication current"); }
}

export async function commitWebPublicationControl({ controlPath, payload, requestId, now = () => new Date() } = {}) {
  if (!validTarget(payload?.target)) throw new Error("Invalid durable Web publication current");
  if (typeof requestId !== "string" || !HASH.test(requestId)) throw new Error("Invalid durable Web publication current");
  const current = currentArtifact({
    artifactId: payload.artifactId,
    jobId: payload.jobId,
    jobVersion: payload.jobVersion,
    stageContentHashes: payload.stageContentHashes,
    storageName: payload.storageName ?? `publication-${payload.artifactId}`,
  });
  const previous = await readWebPublicationControl({ controlPath, expectedTarget: payload.target });
  const streams = { ...(previous?.streams ?? {}) };
  if (payload.stream) {
    if (
      payload.stream.id !== "alexa_voc"
      || payload.jobVersion !== payload.stream.generation
      || Object.keys(current.stageContentHashes).join(",") !== "alexa_voc"
    ) throw new Error("Invalid durable Web publication current");
    const nextStream = alexaStream({
      generation: payload.stream.generation,
      epoch: payload.stream.epoch,
      artifactId: payload.artifactId,
      stageContentHash: current.stageContentHashes.alexa_voc,
    });
    if (streams.alexa_voc && nextStream.generation < streams.alexa_voc.generation) {
      throw new Error("Durable Web publication generation would regress");
    }
    if (streams.alexa_voc && nextStream.generation === streams.alexa_voc.generation && (
      nextStream.artifactId !== streams.alexa_voc.artifactId
      || nextStream.stageContentHash !== streams.alexa_voc.stageContentHash
    )) throw new Error("Durable Web publication generation conflicts");
    streams.alexa_voc = nextStream;
  }
  const record = parseControl({
    version: 1,
    target: payload.target,
    current,
    streams,
    committedRequestId: requestId,
    committedAt: now().toISOString(),
  }, payload.target);
  await fs.mkdir(path.dirname(controlPath), { recursive: true });
  const temporary = `${controlPath}.tmp-${randomUUID()}`;
  let handle;
  let renamed = false;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(JSON.stringify(record), "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, controlPath);
    renamed = true;
    try {
      const directory = await fs.open(path.dirname(controlPath), "r");
      try { await directory.sync(); } finally { await directory.close(); }
    } catch (error) {
      if (!new Set(["EINVAL", "ENOTSUP", "EPERM", "EACCES", "EISDIR"]).has(error?.code)) throw error;
    }
    return record;
  } catch (error) {
    try { await handle?.close(); } catch {}
    await fs.rm(temporary, { force: true });
    if (renamed) {
      try {
        const observed = await readWebPublicationControl({ controlPath, expectedTarget: payload.target });
        if (observed?.committedRequestId === requestId) return observed;
      } catch {}
    }
    throw error;
  }
}
