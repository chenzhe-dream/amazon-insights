import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const DEFAULT_ATTEMPTS = 1_000;
const DEFAULT_RETRY_MS = 5;
const OWNER_FILE = /^(\d+)-([a-f0-9-]{36})\.(choosing|owner)\.json$/;

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

function parseEntry(directory, name) {
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
  const valid = value?.version === 1 && value.pid === pid && value.token === token;
  if (!ownerIsAlive(pid) && valid) {
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

function readElection(lockPath) {
  const directory = ownerDirectory(lockPath);
  let names = [];
  try {
    names = fs.readdirSync(directory);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const entries = names.flatMap((name) => {
    const entry = parseEntry(directory, name);
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

function beginElection(lockPath) {
  const token = randomUUID();
  const owned = ownerPaths(lockPath, token);
  fs.mkdirSync(owned.directory, { recursive: true });
  atomicPublish(owned.choosing, { version: 1, pid: process.pid, token });
  try {
    const election = readElection(lockPath);
    const tickets = election.owners.filter((owner) => owner.valid).map((owner) => owner.ticket);
    const ticket = (tickets.length ? Math.max(...tickets) : 0) + 1;
    atomicPublish(owned.owner, { version: 1, pid: process.pid, token, ticket });
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

function ownsElection(lockPath, owned) {
  const election = readElection(lockPath);
  if (election.choosing.length || election.owners.some((owner) => !owner.valid)) return false;
  const winner = [...election.owners].sort(compareOwners)[0];
  return winner?.pid === process.pid && winner.token === owned.token && winner.ticket === owned.ticket;
}

function heldByCurrentProcess(lockPath, owned) {
  const election = readElection(lockPath);
  return [...election.choosing, ...election.owners].some((entry) =>
    entry.pid === process.pid && entry.token !== owned.token
  );
}

export function acquireInterprocessLockSync(
  lockPath,
  { attempts = DEFAULT_ATTEMPTS, retryMs = DEFAULT_RETRY_MS } = {},
) {
  const owned = beginElection(lockPath);
  try {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (ownsElection(lockPath, owned)) return () => releaseOwner(owned);
      if (heldByCurrentProcess(lockPath, owned)) {
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
  { attempts = DEFAULT_ATTEMPTS, retryMs = DEFAULT_RETRY_MS } = {},
) {
  const owned = beginElection(lockPath);
  try {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (ownsElection(lockPath, owned)) return () => releaseOwner(owned);
      await new Promise((resolve) => setTimeout(resolve, retryMs));
    }
  } catch (error) {
    releaseOwner(owned);
    throw error;
  }
  releaseOwner(owned);
  throw new Error("Timed out acquiring interprocess lock");
}
