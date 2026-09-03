import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";

function isRunning(child) {
  return child.exitCode === null && child.signalCode === null;
}

function waitForExit(child) {
  if (!isRunning(child)) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", resolve));
}

export function createProcessTreeIdentity({ pid, command, args = [], cwd, pidBirth = new Date().toISOString() }) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Invalid process tree identity");
  return Object.freeze({
    pid,
    pidBirth,
    command: JSON.stringify([command, ...args]),
    worktreeId: createHash("sha256").update(path.resolve(cwd ?? ".")).digest("hex"),
  });
}

async function waitForExitWithin(child, milliseconds) {
  let timer;
  try {
    return await Promise.race([
      waitForExit(child).then(() => true),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), milliseconds); }),
    ]);
  } finally { clearTimeout(timer); }
}

async function runWindowsTreeKiller(child, spawnImplementation, helperTimeoutMs, force) {
  const args = ["/pid", String(child.pid), "/t", ...(force ? ["/f"] : [])];
  const killer = spawnImplementation("taskkill", args, {
    stdio: "ignore",
    windowsHide: true,
    shell: false,
  });
  let helperTimer;
  const helperCompleted = await Promise.race([
    new Promise((resolve) => {
      killer.once("error", () => resolve(false));
      killer.once("exit", (code) => resolve(code === 0));
    }),
    new Promise((resolve) => { helperTimer = setTimeout(() => resolve(false), helperTimeoutMs); }),
  ]);
  clearTimeout(helperTimer);
  if (!helperCompleted) {
    try { killer.kill("SIGKILL"); } catch {}
  }
  return helperCompleted;
}

async function killWindowsTree(child, spawnImplementation, helperTimeoutMs, mode, treeIdentity) {
  if (!child.pid || !isRunning(child)) return;
  const force = mode === "force";
  const attempts = force ? 2 : 1;
  for (let attempt = 0; attempt < attempts && isRunning(child); attempt += 1) {
    const helperSucceeded = await runWindowsTreeKiller(child, spawnImplementation, helperTimeoutMs, force);
    if (helperSucceeded && await waitForExitWithin(child, helperTimeoutMs)) return;
  }
  if (!force) return;
  if (!isRunning(child)) return;
  const error = new Error("Windows process tree termination could not be confirmed");
  error.code = "EPROCESSTREE";
  if (treeIdentity) error.treeIdentity = treeIdentity;
  throw error;
}

async function killPosixTree(child) {
  if (!isRunning(child)) return;
  child.kill("SIGTERM");
  if (await waitForExitWithin(child, 2_000)) return;
  child.kill("SIGKILL");
  await waitForExitWithin(child, 5_000);
}

export async function terminateBoundedProcessTree({
  child,
  platform = process.platform,
  spawnImplementation = spawn,
  helperTimeoutMs = 5_000,
  mode = "force",
  treeIdentity,
}) {
  if (!new Set(["graceful", "force"]).has(mode)) throw new Error("Invalid process tree termination mode");
  if (platform === "win32") return killWindowsTree(child, spawnImplementation, helperTimeoutMs, mode, treeIdentity);
  return killPosixTree(child);
}

export async function runBoundedProcess({
  command,
  args = [],
  cwd,
  env,
  timeout,
  treeKillTimeoutMs = 5_000,
  shell = false,
  spawnImplementation = spawn,
  platform = process.platform,
}) {
  if (!Number.isSafeInteger(timeout) || timeout < 1) throw new Error("Invalid process timeout");
  if (!Number.isSafeInteger(treeKillTimeoutMs) || treeKillTimeoutMs < 1) throw new Error("Invalid tree kill timeout");
  const child = spawnImplementation(command, args, {
    cwd,
    env,
    shell,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const treeIdentity = createProcessTreeIdentity({ pid: child.pid, command, args, cwd });
  child.stdout?.pipe(process.stdout);
  child.stderr?.pipe(process.stderr);

  let timer;
  let timedOut = false;
  const exit = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const timeoutReached = new Promise((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve(null);
    }, timeout);
    timer.unref?.();
  });

  let result;
  try { result = await Promise.race([exit, timeoutReached]); }
  catch (error) { clearTimeout(timer); throw error; }
  if (!timedOut) {
    clearTimeout(timer);
    return result;
  }

  clearTimeout(timer);
  try {
    await terminateBoundedProcessTree({
      child, platform, spawnImplementation, helperTimeoutMs: treeKillTimeoutMs, mode: "force", treeIdentity,
    });
  } catch (error) {
    if (error?.code === "EPROCESSTREE") error.treeIdentity = treeIdentity;
    throw error;
  }
  if (isRunning(child)) throw new Error("Timed out process tree did not exit");
  const error = new Error(`Process timed out after ${timeout}ms`);
  error.code = "ETIMEDOUT";
  throw error;
}
