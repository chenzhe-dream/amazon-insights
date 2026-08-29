import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

const DEFAULT_ATTEMPTS = 1_000;
const DEFAULT_RETRY_MS = 5;
const OWNER_FILE = /^(\d+)-([a-f0-9-]{36})\.(choosing|owner)\.json$/;
const HASH = /^[a-f0-9]{64}$/;
const PROCESS_STARTED_AT = new Date(Date.now() - process.uptime() * 1_000).toISOString();
const PROCESS_IDENTITY_CACHE_MS = 250;
const processIdentityCache = new Map();

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

function inspectWindowsProcess(pid) {
  if (pid === process.pid) return DEFAULT_CURRENT_PROCESS_IDENTITY;
  if (!ownerIsAlive(pid)) return Object.freeze({ alive: false });
  const source = [
    `$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' -ErrorAction SilentlyContinue`,
    "if($null -eq $p){exit 3}",
    "$o=[ordered]@{created=$p.CreationDate.ToUniversalTime().ToString('o');command=[string]$p.CommandLine}",
    "$o|ConvertTo-Json -Compress",
  ].join(";");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", source], {
    encoding: "utf8", shell: false, windowsHide: true, timeout: 2_000,
  });
  if (result.status === 3 || !ownerIsAlive(pid)) return Object.freeze({ alive: false });
  if (result.status !== 0) return Object.freeze({ alive: true });
  try {
    const parsed = JSON.parse(result.stdout);
    return Object.freeze({ alive: true, pidBirth: parsed.created, command: parsed.command });
  } catch { return Object.freeze({ alive: true }); }
}

function defaultInspectProcessIdentity(pid, expectedIdentity) {
  const now = Date.now();
  const cacheKey = `${pid}:${expectedIdentity?.pidBirth ?? "unknown"}:${expectedIdentity?.command ?? "unknown"}:${expectedIdentity?.worktreeId ?? "unknown"}`;
  const cached = processIdentityCache.get(cacheKey);
  if (cached && now - cached.observedAt < PROCESS_IDENTITY_CACHE_MS) return cached.identity;
  let identity;
  if (process.platform === "linux") identity = inspectProcfsProcess(pid);
  else if (process.platform === "win32") identity = inspectWindowsProcess(pid);
  else identity = Object.freeze({ alive: ownerIsAlive(pid) });
  if (identity.alive === true) {
    if (processIdentityCache.size >= 256 && !processIdentityCache.has(cacheKey)) {
      processIdentityCache.delete(processIdentityCache.keys().next().value);
    }
    processIdentityCache.set(cacheKey, Object.freeze({ identity, observedAt: now }));
  }
  else processIdentityCache.delete(cacheKey);
  return identity;
}

function currentProcessIdentity() {
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
  const command = JSON.stringify(
    [process.execPath, ...process.execArgv, ...process.argv.slice(1, 5)].slice(0, 8)
      .map((argument) => argument.slice(0, 240)),
  );
  return Object.freeze({
    pidBirth: PROCESS_STARTED_AT,
    command,
    worktreeId: worktreeIdentity(process.cwd()),
  });
}

const DEFAULT_CURRENT_PROCESS_IDENTITY = currentProcessIdentity();

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

function processIdentityMismatch(expected, observed) {
  if (observed?.alive !== true) return observed?.alive === false;
  if (typeof observed.pidBirth === "string") {
    const expectedTime = Date.parse(expected.pidBirth);
    const observedTime = Date.parse(observed.pidBirth);
    if (Number.isNaN(expectedTime) || Number.isNaN(observedTime)) {
      if (observed.pidBirth !== expected.pidBirth) return true;
    } else if (Math.abs(expectedTime - observedTime) > 2_000) return true;
  }
  if (typeof observed.command === "string" && observed.command !== expected.command) {
    let expectedArguments = [];
    try {
      const parsed = JSON.parse(expected.command);
      if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string")) expectedArguments = parsed;
    } catch {}
    const normalizedObserved = observed.command.replaceAll("/", "\\").toLowerCase();
    const commandMatches = expectedArguments.length > 0 && expectedArguments.every((argument) =>
      normalizedObserved.includes(argument.replaceAll("/", "\\").toLowerCase())
    );
    if (!commandMatches) return true;
  }
  return typeof observed.worktreeId === "string" && observed.worktreeId !== expected.worktreeId;
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

function parseEntry(directory, name, inspectProcessIdentity = defaultInspectProcessIdentity) {
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
    let observed;
    try { observed = inspectProcessIdentity(pid, identity); } catch { observed = Object.freeze({ alive: true }); }
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

function readElection(lockPath, inspectProcessIdentity) {
  const directory = ownerDirectory(lockPath);
  let names = [];
  try {
    names = fs.readdirSync(directory);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const entries = names.flatMap((name) => {
    const entry = parseEntry(directory, name, inspectProcessIdentity);
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

function beginElection(lockPath, { currentProcessIdentity: suppliedIdentity, inspectProcessIdentity } = {}) {
  const token = randomUUID();
  const owned = ownerPaths(lockPath, token);
  const identity = validateProcessIdentity(suppliedIdentity ?? DEFAULT_CURRENT_PROCESS_IDENTITY);
  fs.mkdirSync(owned.directory, { recursive: true });
  atomicPublish(owned.choosing, { version: 2, pid: process.pid, token, ...identity });
  try {
    const election = readElection(lockPath, inspectProcessIdentity);
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

function ownsElection(lockPath, owned, inspectProcessIdentity) {
  const election = readElection(lockPath, inspectProcessIdentity);
  if (election.choosing.length || election.owners.some((owner) => !owner.valid)) return false;
  const winner = [...election.owners].sort(compareOwners)[0];
  return winner?.pid === process.pid && winner.token === owned.token && winner.ticket === owned.ticket;
}

function heldByCurrentProcess(lockPath, owned, inspectProcessIdentity) {
  const election = readElection(lockPath, inspectProcessIdentity);
  return [...election.choosing, ...election.owners].some((entry) =>
    entry.pid === process.pid && entry.token !== owned.token
  );
}

export function acquireInterprocessLockSync(
  lockPath,
  {
    attempts = DEFAULT_ATTEMPTS,
    retryMs = DEFAULT_RETRY_MS,
    currentProcessIdentity,
    inspectProcessIdentity,
  } = {},
) {
  const owned = beginElection(lockPath, { currentProcessIdentity, inspectProcessIdentity });
  try {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (ownsElection(lockPath, owned, inspectProcessIdentity)) return () => releaseOwner(owned);
      if (heldByCurrentProcess(lockPath, owned, inspectProcessIdentity)) {
        throw new Error("Cannot synchronously wait for an interprocess lock held by this process");
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, retryMs);
    }
  } catch (error) {
    releaseOwner(owned);
    throw error;
  }
  releaseOwner(owned);
  throw new Error("Timed out acquiring interprocess lock");
}

export async function acquireInterprocessLock(
  lockPath,
  {
    attempts = DEFAULT_ATTEMPTS,
    retryMs = DEFAULT_RETRY_MS,
    signal,
    currentProcessIdentity,
    inspectProcessIdentity,
  } = {},
) {
  throwIfAborted(signal);
  const owned = beginElection(lockPath, { currentProcessIdentity, inspectProcessIdentity });
  try {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      throwIfAborted(signal);
      if (ownsElection(lockPath, owned, inspectProcessIdentity)) return () => releaseOwner(owned);
      await abortableDelay(retryMs, signal);
    }
  } catch (error) {
    releaseOwner(owned);
    throw error;
  }
  releaseOwner(owned);
  throw new Error("Timed out acquiring interprocess lock");
}

export function quarantineInterprocessLockOwnersSync(
  lockPath,
  { confirmGlobalQuiescent = false, inspectProcessIdentity } = {},
) {
  if (confirmGlobalQuiescent !== true) throw new Error("Explicit global quiescent confirmation is required");
  const directory = ownerDirectory(lockPath);
  let names = [];
  try { names = fs.readdirSync(directory); }
  catch (error) { if (error?.code === "ENOENT") return false; throw error; }
  let quarantined = false;
  for (const name of names) {
    if (!OWNER_FILE.test(name)) continue;
    const entry = parseEntry(directory, name, inspectProcessIdentity);
    if (!entry || entry.valid) continue;
    const source = path.join(directory, name);
    const target = path.join(path.dirname(directory), `${path.basename(lockPath)}.manual-quarantine-${randomUUID()}-${name}`);
    try { fs.renameSync(source, target); quarantined = true; }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
  return quarantined;
}
