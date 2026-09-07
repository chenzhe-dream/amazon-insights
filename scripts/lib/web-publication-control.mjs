import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { assertCodeOnly, validateCodeRelease } from "./code-publication-identity.mjs";

const HASH = /^[a-f0-9]{64}$/;
const JOB_ID = /^[A-Za-z0-9_-]{1,200}$/;
const STAGES = new Set([
  "keywords", "reviews", "sales_trend", "child_sales", "price_strategy",
  "fba", "listing", "image_remarks", "category", "traffic", "alexa_voc",
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
  if (value?.kind === "code") {
    if (Object.keys(value).sort().join(",") !== "artifactId,codeRelease,kind,storageName"
      || !HASH.test(value.artifactId) || value.storageName !== `publication-${value.artifactId}`) throw new Error();
    return Object.freeze({ ...value, codeRelease: validateCodeRelease(value.codeRelease) });
  }
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
      || Object.keys(value).sort().join(",") !== (value.version === 2
        ? "committedAt,committedRequestId,current,dataCurrent,streams,target,version"
        : "committedAt,committedRequestId,current,streams,target,version")
      || ![1, 2].includes(value.version)
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
    if ((current.kind === "code") !== (value.version === 2)) throw new Error();
    const dataCurrent = value.version === 2 ? currentArtifact(value.dataCurrent) : null;
    if (dataCurrent?.kind === "code") throw new Error();
    const streams = Object.freeze({
      ...(value.streams.alexa_voc ? { alexa_voc: alexaStream(value.streams.alexa_voc) } : {}),
    });
    return Object.freeze({
      version: value.version,
      target: Object.freeze({ ...value.target }),
      current,
      ...(dataCurrent ? { dataCurrent } : {}),
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
  const isCode = payload.kind === "code";
  if (isCode) assertCodeOnly(payload);
  else if (payload.kind !== undefined || payload.codeRelease !== undefined) throw new Error("Invalid durable Web publication current");
  const current = currentArtifact(isCode ? {
    artifactId: payload.artifactId, kind: "code", codeRelease: payload.codeRelease,
    storageName: payload.storageName ?? `publication-${payload.artifactId}`,
  } : {
    artifactId: payload.artifactId,
    jobId: payload.jobId,
    jobVersion: payload.jobVersion,
    stageContentHashes: payload.stageContentHashes,
    storageName: payload.storageName ?? `publication-${payload.artifactId}`,
  });
  const previous = await readWebPublicationControl({ controlPath, expectedTarget: payload.target });
  if (isCode && previous?.current.artifactId !== current.codeRelease.baseArtifactId) throw new Error("Code publication base changed");
  const dataCurrent = isCode ? (previous.current.kind === "code" ? previous.dataCurrent : previous.current) : null;
  const streams = { ...(previous?.streams ?? {}) };
  let retainCodeCurrent = false;
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
    // An epoch-only retry acknowledges content already present beneath the code
    // release. It must not repoint current to that older business package.
    retainCodeCurrent = previous?.current.kind === "code"
      && streams.alexa_voc?.generation === nextStream.generation;
    streams.alexa_voc = streams.alexa_voc && streams.alexa_voc.generation === nextStream.generation
      ? alexaStream({ ...nextStream, epoch: Math.max(streams.alexa_voc.epoch, nextStream.epoch) })
      : nextStream;
  }
  const record = parseControl({
    version: isCode || retainCodeCurrent ? 2 : 1,
    target: payload.target,
    current: retainCodeCurrent ? previous.current : current,
    ...(retainCodeCurrent ? { dataCurrent: previous.dataCurrent } : dataCurrent ? { dataCurrent } : {}),
    streams,
    committedRequestId: retainCodeCurrent ? previous.committedRequestId : requestId,
    committedAt: retainCodeCurrent ? previous.committedAt : now().toISOString(),
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
        if (JSON.stringify(observed) === JSON.stringify(record)) return observed;
      } catch {}
    }
    throw error;
  }
}
