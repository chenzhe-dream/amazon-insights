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

async function waitForExitWithin(child, milliseconds) {
  let timer;
  try {
    return await Promise.race([
      waitForExit(child).then(() => true),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), milliseconds); }),
    ]);
  } finally { clearTimeout(timer); }
}

async function runWindowsTreeKiller(child, spawnImplementation, helperTimeoutMs) {
  const killer = spawnImplementation("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
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

async function killWindowsTree(child, spawnImplementation, helperTimeoutMs) {
  if (!child.pid || !isRunning(child)) return;
  for (let attempt = 0; attempt < 2 && isRunning(child); attempt += 1) {
    const helperSucceeded = await runWindowsTreeKiller(child, spawnImplementation, helperTimeoutMs);
    if (helperSucceeded && await waitForExitWithin(child, helperTimeoutMs)) return;
  }
  if (!isRunning(child)) return;
  const error = new Error("Windows process tree termination could not be confirmed");
  error.code = "EPROCESSTREE";
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
}) {
  if (platform === "win32") return killWindowsTree(child, spawnImplementation, helperTimeoutMs);
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
  const treeIdentity = Object.freeze({
    pid: child.pid,
    pidBirth: new Date().toISOString(),
    command: JSON.stringify([command, ...args]),
    worktreeId: createHash("sha256").update(path.resolve(cwd ?? ".")).digest("hex"),
  });
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
    await terminateBoundedProcessTree({ child, platform, spawnImplementation, helperTimeoutMs: treeKillTimeoutMs });
  } catch (error) {
    if (error?.code === "EPROCESSTREE") error.treeIdentity = treeIdentity;
    throw error;
  }
  if (isRunning(child)) throw new Error("Timed out process tree did not exit");
  const error = new Error(`Process timed out after ${timeout}ms`);
  error.code = "ETIMEDOUT";
  throw error;
}
