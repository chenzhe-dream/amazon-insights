import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const WEB_RELOAD_REQUEST_VERSION = 1;
const MAX_JOB_ID_LENGTH = 128;
const MAX_HOST_LENGTH = 255;
const MAX_REQUEST_AGE_MS = 24 * 60 * 60 * 1_000;

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

function validateTarget(target) {
  if (!target || typeof target !== "object" || Array.isArray(target)) throw new Error("Invalid reload target");
  if (Object.keys(target).sort().join(",") !== "webHost,webPort,worktreeId") throw new Error("Invalid reload target");
  if (!/^[a-f0-9]{64}$/.test(target.worktreeId)) throw new Error("Invalid reload target");
  if (typeof target.webHost !== "string" || !target.webHost || target.webHost.length > MAX_HOST_LENGTH) {
    throw new Error("Invalid reload target");
  }
  assertPort(target.webPort);
}

function validatePayload(candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("Invalid reload request");
  if (Object.keys(candidate).sort().join(",") !== "buildCompletedAt,jobId,target,version") {
    throw new Error("Invalid reload request");
  }
  if (candidate.version !== WEB_RELOAD_REQUEST_VERSION) throw new Error("Invalid reload request");
  if (typeof candidate.jobId !== "string" || !/^[A-Za-z0-9_-]+$/.test(candidate.jobId) || candidate.jobId.length > MAX_JOB_ID_LENGTH) {
    throw new Error("Invalid reload request");
  }
  if (typeof candidate.buildCompletedAt !== "string" || Number.isNaN(Date.parse(candidate.buildCompletedAt))) {
    throw new Error("Invalid reload request");
  }
  validateTarget(candidate.target);
  return Object.freeze({
    version: WEB_RELOAD_REQUEST_VERSION,
    jobId: candidate.jobId,
    buildCompletedAt: candidate.buildCompletedAt,
    target: Object.freeze({ ...candidate.target }),
  });
}

function spoolPaths(spoolDir) {
  return {
    pending: path.join(spoolDir, "pending"),
    processing: path.join(spoolDir, "processing"),
    applied: path.join(spoolDir, "applied"),
    failed: path.join(spoolDir, "failed"),
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

export async function writeWebReloadRequest(
  { jobId, buildCompletedAt, target },
  { spoolDir = path.join(process.cwd(), "data", "web-reload-requests") } = {},
) {
  const payload = validatePayload({ version: WEB_RELOAD_REQUEST_VERSION, jobId, buildCompletedAt, target });
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
  return Object.freeze({ id, path: requestPath, payload });
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

export async function consumeWebReloadRequest({
  spoolDir = path.join(process.cwd(), "data", "web-reload-requests"),
  expectedTarget,
  apply,
  now = () => new Date(),
  maxAgeMs = MAX_REQUEST_AGE_MS,
} = {}) {
  validateTarget(expectedTarget);
  if (typeof apply !== "function") throw new Error("Reload apply callback is required");
  const paths = await ensureSpool(spoolDir);
  const pending = await readPendingWebReloadRequests({ spoolDir });
  const next = pending[0];
  if (!next) return Object.freeze({ status: "none" });

  const claimPath = path.join(paths.processing, `${path.basename(next.path, ".json")}-${randomUUID()}.json`);
  try {
    await fs.rename(next.path, claimPath);
  } catch (error) {
    if (error?.code === "ENOENT") return Object.freeze({ status: "none" });
    throw error;
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

  try {
    await apply(payload);
    await archive(claimPath, appliedPath);
    return Object.freeze({ status: "applied", payload });
  } catch {
    await archive(claimPath, failedPath);
    return Object.freeze({ status: "failed" });
  }
}
