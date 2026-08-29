import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

const DEFAULT_ATTEMPTS = 1_000;
const DEFAULT_RETRY_MS = 5;
const OWNER_FILE = /^(\d+)-([a-f0-9-]{36})\.(choosing|owner)\.json$/;
const HASH = /^[a-f0-9]{64}$/;
const PROCESS_IDENTITY_CACHE_MS = 2_000;
const processIdentityCache = new Map();
let defaultCurrentProcessIdentity;

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function abortableDelay(milliseconds, signal) {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, milliseconds));
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

function ownerDirectory(lockPath) {
  return `${lockPath}.owners`;
}

function ownerPaths(lockPath, token) {
  const directory = ownerDirectory(lockPath);
  const prefix = `${process.pid}-${token}`;
  return {
    directory,
    choosing: path.join(directory, `${prefix}.choosing.json`),
    owner: path.join(directory, `${prefix}.owner.json`),
  };
}

function ownerIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function worktreeIdentity(directory) {
  return createHash("sha256").update(path.resolve(directory)).digest("hex");
}

function inspectProcfsProcess(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    const fields = stat.slice(close + 2).split(" ");
    const pidBirth = fields[19];
    const command = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean).join("\0");
    const cwd = fs.realpathSync(`/proc/${pid}/cwd`);
    return Object.freeze({ alive: true, pidBirth, command, worktreeId: worktreeIdentity(cwd) });
  } catch (error) {
    if (error?.code === "ENOENT" || !ownerIsAlive(pid)) return Object.freeze({ alive: false });
    return Object.freeze({ alive: true });
  }
}

function hashCommand(command) {
  return `sha256:${createHash("sha256").update(command).digest("hex")}`;
}

function inspectWindowsProcess(pid, { timeoutMs = 2_000 } = {}) {
  if (!ownerIsAlive(pid)) return Object.freeze({ alive: false });
  if (Number.isNaN(timeoutMs) || timeoutMs < 1) return Object.freeze({ alive: true });
  const source = [
    `$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' -ErrorAction SilentlyContinue`,
    "if($null -eq $p){exit 3}",
    "$o=[ordered]@{created=$p.CreationDate.ToUniversalTime().ToString('o');command=[string]$p.CommandLine}",
    "$o|ConvertTo-Json -Compress",
  ].join(";");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", source], {
    encoding: "utf8", shell: false, windowsHide: true, timeout: Math.min(2_000, Math.ceil(timeoutMs)),
  });
  if (result.status === 3 || !ownerIsAlive(pid)) return Object.freeze({ alive: false });
  if (result.status !== 0) return Object.freeze({ alive: true });
  try {
    const parsed = JSON.parse(result.stdout);
    return Object.freeze({
      alive: true,
      ...(typeof parsed.created === "string" && parsed.created ? { pidBirth: parsed.created } : {}),
      ...(typeof parsed.command === "string" && parsed.command ? { command: hashCommand(parsed.command) } : {}),
    });
  } catch { return Object.freeze({ alive: true }); }
}

function defaultInspectProcessIdentity(pid, expectedIdentity, { deadline = Number.POSITIVE_INFINITY } = {}) {
  if (pid === process.pid) return Object.freeze({ alive: true, ...getDefaultCurrentProcessIdentity() });
  const now = Date.now();
  const cacheKey = `${pid}:${expectedIdentity?.pidBirth ?? "unknown"}:${expectedIdentity?.command ?? "unknown"}:${expectedIdentity?.worktreeId ?? "unknown"}`;
  const cached = processIdentityCache.get(cacheKey);
  if (cached && now - cached.observedAt < PROCESS_IDENTITY_CACHE_MS) return cached.identity;
  let identity;
  if (process.platform === "linux") identity = inspectProcfsProcess(pid);
  else if (process.platform === "win32") identity = inspectWindowsProcess(pid, {
    timeoutMs: deadline - performance.now(),
  });
  else identity = Object.freeze({ alive: ownerIsAlive(pid) });
  if (identity.alive === true) {
    if (processIdentityCache.size >= 256 && !processIdentityCache.has(cacheKey)) {
      processIdentityCache.delete(processIdentityCache.keys().next().value);
    }
    processIdentityCache.set(cacheKey, Object.freeze({ identity, observedAt: Date.now() }));
  }
  else processIdentityCache.delete(cacheKey);
  return identity;
}

function currentProcessIdentity({ deadline = Number.POSITIVE_INFINITY } = {}) {
  if (process.platform === "linux") {
    const observed = inspectProcfsProcess(process.pid);
    if (observed.alive && observed.pidBirth && observed.command && observed.worktreeId) {
      return Object.freeze({
        pidBirth: observed.pidBirth,
        command: observed.command.slice(0, 2_048),
        worktreeId: observed.worktreeId,
      });
    }
  }
  if (process.platform === "win32") {
    const observed = inspectWindowsProcess(process.pid, { timeoutMs: deadline - performance.now() });
    if (observed.alive && observed.pidBirth && observed.command) {
      return Object.freeze({
        pidBirth: observed.pidBirth,
        command: observed.command,
        worktreeId: worktreeIdentity(process.cwd()),
      });
    }
    throw new Error("Unable to establish Windows interprocess lock owner identity");
  }
  const command = JSON.stringify(
    [process.execPath, ...process.execArgv, ...process.argv.slice(1, 5)].slice(0, 8)
      .map((argument) => argument.slice(0, 240)),
  );
  return Object.freeze({
    pidBirth: `${process.pid}:${process.uptime()}`,
    command,
    worktreeId: worktreeIdentity(process.cwd()),
  });
}

function getDefaultCurrentProcessIdentity(options) {
  defaultCurrentProcessIdentity ??= currentProcessIdentity(options);
  return defaultCurrentProcessIdentity;
}

function validateProcessIdentity(value) {
  if (
    typeof value?.pidBirth !== "string" || value.pidBirth.length < 1 || value.pidBirth.length > 128
    || typeof value.command !== "string" || value.command.length < 1 || value.command.length > 2_048
    || typeof value.worktreeId !== "string" || !HASH.test(value.worktreeId)
  ) throw new Error("Invalid interprocess lock process identity");
  return Object.freeze({
    pidBirth: value.pidBirth, command: value.command, worktreeId: value.worktreeId,
  });
}

function processIdentityStatus(expected, observed) {
  if (observed?.alive === false) return "stale";
  if (observed?.alive !== true) return "unknown";
  if (typeof observed.pidBirth === "string") {
    if (observed.pidBirth !== expected.pidBirth) return "stale";
    const conflicts = ["command", "worktreeId"].some((field) =>
      typeof observed[field] === "string" && observed[field] !== expected[field]
    );
    return conflicts ? "unknown" : "live";
  }
  const comparisons = ["command", "worktreeId"].flatMap((field) =>
    typeof observed[field] === "string" ? [observed[field] === expected[field]] : []
  );
  if (comparisons.length === 0) return "unknown";
  if (comparisons.every(Boolean)) return "live";
  if (comparisons.every((matches) => matches === false)) return "stale";
  return "unknown";
}

function processIdentityMismatch(expected, observed) {
  return processIdentityStatus(expected, observed) === "stale";
}

function atomicPublish(file, value) {
  const temporary = `${file}.tmp-${randomUUID()}`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value), { encoding: "utf8", flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, file);
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch {}
    throw error;
  }
}

function inspectProcessOnce(context, pid, identity, serialized) {
  const key = `${pid}:${createHash("sha256").update(serialized ?? "").digest("hex")}`;
  if (context.observations.has(key)) return context.observations.get(key);
  let observed;
  try { observed = context.inspectProcessIdentity(pid, identity, { deadline: context.deadline }); }
  catch { observed = Object.freeze({ alive: true }); }
  context.observations.set(key, observed);
  return observed;
}

function fsyncDirectory(directory) {
  let descriptor;
  try {
    descriptor = fs.openSync(directory, "r");
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (!new Set(["EINVAL", "EPERM"]).has(error?.code)) throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function parseEntry(directory, name, context) {
  const match = OWNER_FILE.exec(name);
  if (!match) return null;
  const pid = Number(match[1]);
  const token = match[2];
  const kind = match[3];
  const file = path.join(directory, name);
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  let serialized = null;
  let value = null;
  try {
    serialized = fs.readFileSync(file, "utf8");
    value = JSON.parse(serialized);
  } catch {}
  const legacyValid = value?.version === 1 && value.pid === pid && value.token === token;
  const identity = value?.version === 2 ? (() => {
    try { return validateProcessIdentity(value); } catch { return null; }
  })() : null;
  const valid = legacyValid || Boolean(identity && value.pid === pid && value.token === token);
  let stale = valid && !ownerIsAlive(pid);
  if (!stale && identity) {
    const observed = inspectProcessOnce(context, pid, identity, serialized);
    stale = processIdentityMismatch(identity, observed);
  }
  if (stale && valid) {
    let confirmed = null;
    try { confirmed = fs.readFileSync(file, "utf8"); } catch {}
    if (confirmed === serialized) {
      try { fs.rmSync(file); } catch (error) {
        if (error?.code !== "ENOENT") return { pid, token, kind, valid: false };
      }
      return null;
    }
  }
  if (kind === "choosing") return { pid, token, kind, valid };
  return {
    pid,
    token,
    kind,
    valid: valid && Number.isSafeInteger(value.ticket) && value.ticket >= 1,
    ticket: value?.ticket,
  };
}

function readElection(lockPath, context) {
  const directory = ownerDirectory(lockPath);
  let names = [];
  try {
    names = fs.readdirSync(directory);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const entries = names.flatMap((name) => {
    const entry = parseEntry(directory, name, context);
    return entry ? [entry] : [];
  });
  return {
    choosing: entries.filter((entry) => entry.kind === "choosing"),
    owners: entries.filter((entry) => entry.kind === "owner"),
  };
}

function compareOwners(left, right) {
  if (left.ticket !== right.ticket) return left.ticket - right.ticket;
  return left.token.localeCompare(right.token);
}

function beginElection(lockPath, { currentProcessIdentity: suppliedIdentity, context } = {}) {
  const token = randomUUID();
  const owned = ownerPaths(lockPath, token);
  const identity = validateProcessIdentity(suppliedIdentity);
  fs.mkdirSync(owned.directory, { recursive: true });
  atomicPublish(owned.choosing, { version: 2, pid: process.pid, token, ...identity });
  try {
    const election = readElection(lockPath, context);
    const tickets = election.owners.filter((owner) => owner.valid).map((owner) => owner.ticket);
    const ticket = (tickets.length ? Math.max(...tickets) : 0) + 1;
    atomicPublish(owned.owner, { version: 2, pid: process.pid, token, ticket, ...identity });
    fs.rmSync(owned.choosing, { force: true });
    return { ...owned, token, ticket };
  } catch (error) {
    fs.rmSync(owned.choosing, { force: true });
    fs.rmSync(owned.owner, { force: true });
    throw error;
  }
}

function releaseOwner(owned) {
  fs.rmSync(owned.choosing, { force: true });
  fs.rmSync(owned.owner, { force: true });
}

function ownsElection(lockPath, owned, context) {
  const election = readElection(lockPath, context);
  if (election.choosing.length || election.owners.some((owner) => !owner.valid)) return false;
  const winner = [...election.owners].sort(compareOwners)[0];
  return winner?.pid === process.pid && winner.token === owned.token && winner.ticket === owned.ticket;
}

function heldByCurrentProcess(lockPath, owned, context) {
  const election = readElection(lockPath, context);
  return [...election.choosing, ...election.owners].some((entry) =>
    entry.pid === process.pid && entry.token !== owned.token
  );
}

export function acquireInterprocessLockSync(
  lockPath,
  {
    attempts = DEFAULT_ATTEMPTS,
    retryMs = DEFAULT_RETRY_MS,
    waitMs = attempts * retryMs,
    currentProcessIdentity,
    inspectProcessIdentity,
  } = {},
) {
  if (!Number.isFinite(waitMs) || waitMs < 0) throw new Error("Invalid interprocess lock deadline");
  const deadline = performance.now() + waitMs;
  const identity = resolveCurrentProcessIdentity(currentProcessIdentity, deadline);
  const context = {
    deadline,
    inspectProcessIdentity: inspectProcessIdentity ?? defaultInspectProcessIdentity,
    observations: new Map(),
  };
  const owned = beginElection(lockPath, { currentProcessIdentity: identity, context });
  try {
    while (true) {
      if (ownsElection(lockPath, owned, context)) return () => releaseOwner(owned);
      if (heldByCurrentProcess(lockPath, owned, context)) {
        throw new Error("Cannot synchronously wait for an interprocess lock held by this process");
      }
      const remaining = context.deadline - performance.now();
      if (remaining <= 0) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(retryMs, remaining));
    }
  } catch (error) {
    releaseOwner(owned);
    throw error;
  }
  releaseOwner(owned);
  throw lockTimeoutError();
}

export async function acquireInterprocessLock(
  lockPath,
  {
    attempts = DEFAULT_ATTEMPTS,
    retryMs = DEFAULT_RETRY_MS,
    waitMs = attempts * retryMs,
    signal,
    currentProcessIdentity,
    inspectProcessIdentity,
  } = {},
) {
  throwIfAborted(signal);
  if (!Number.isFinite(waitMs) || waitMs < 0) throw new Error("Invalid interprocess lock deadline");
  const deadline = performance.now() + waitMs;
  const identity = resolveCurrentProcessIdentity(currentProcessIdentity, deadline);
  const context = {
    deadline,
    inspectProcessIdentity: inspectProcessIdentity ?? defaultInspectProcessIdentity,
    observations: new Map(),
  };
  const owned = beginElection(lockPath, { currentProcessIdentity: identity, context });
  try {
    while (true) {
      throwIfAborted(signal);
      if (ownsElection(lockPath, owned, context)) return () => releaseOwner(owned);
      const remaining = context.deadline - performance.now();
      if (remaining <= 0) break;
      await abortableDelay(Math.min(retryMs, remaining), signal);
    }
  } catch (error) {
    releaseOwner(owned);
    throw error;
  }
  releaseOwner(owned);
  throw lockTimeoutError();
}

function lockTimeoutError() {
  return new Error("Timed out acquiring interprocess lock");
}

function resolveCurrentProcessIdentity(suppliedIdentity, deadline) {
  let identity;
  try { identity = validateProcessIdentity(suppliedIdentity ?? getDefaultCurrentProcessIdentity({ deadline })); }
  catch (error) {
    if (performance.now() >= deadline) throw lockTimeoutError();
    throw error;
  }
  if (performance.now() >= deadline) throw lockTimeoutError();
  return identity;
}

export function quarantineInterprocessLockOwnersSync(
  lockPath,
  { confirmGlobalQuiescent = false, inspectProcessIdentity, beforeRename } = {},
) {
  if (confirmGlobalQuiescent !== true) throw new Error("Explicit global quiescent confirmation is required");
  if (beforeRename !== undefined && typeof beforeRename !== "function") {
    throw new Error("Invalid interprocess lock quarantine seam");
  }
  const directory = ownerDirectory(lockPath);
  let names = [];
  try { names = fs.readdirSync(directory); }
  catch (error) { if (error?.code === "ENOENT") return false; throw error; }
  let quarantined = false;
  const context = {
    deadline: performance.now() + 2_000,
    inspectProcessIdentity: inspectProcessIdentity ?? defaultInspectProcessIdentity,
    observations: new Map(),
  };
  for (const name of names) {
    const match = OWNER_FILE.exec(name);
    if (!match) continue;
    const source = path.join(directory, name);
    let serialized;
    try { serialized = fs.readFileSync(source, "utf8"); }
    catch (error) { if (error?.code === "ENOENT") continue; throw error; }
    let value;
    try { value = JSON.parse(serialized); } catch {}
    const pid = Number(match[1]);
    const token = match[2];
    const kind = match[3];
    const validTicket = kind === "choosing" || Number.isSafeInteger(value?.ticket) && value.ticket >= 1;
    let identity = null;
    if (value?.version === 2 && value.pid === pid && value.token === token && validTicket) {
      try { identity = validateProcessIdentity(value); } catch {}
    }
    if (identity) {
      const observed = inspectProcessOnce(context, pid, identity, serialized);
      if (processIdentityStatus(identity, observed) === "live") continue;
    }
    beforeRename?.({ source, serialized });
    let confirmed;
    try { confirmed = fs.readFileSync(source, "utf8"); }
    catch (error) { if (error?.code === "ENOENT") continue; throw error; }
    if (confirmed !== serialized) continue;
    const target = path.join(path.dirname(directory), `${path.basename(lockPath)}.manual-quarantine-${randomUUID()}-${name}`);
    try { fs.renameSync(source, target); quarantined = true; }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
    fsyncDirectory(directory);
    fsyncDirectory(path.dirname(directory));
  }
  return quarantined;
}
