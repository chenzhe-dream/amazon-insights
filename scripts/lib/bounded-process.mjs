import { spawn } from "node:child_process";

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

async function killWindowsTree(child, spawnImplementation, helperTimeoutMs) {
  if (!child.pid || !isRunning(child)) return;
  const killer = spawnImplementation("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
    stdio: "ignore",
    windowsHide: true,
    shell: false,
  });
  let helperTimer;
  const helperCompleted = await Promise.race([
    new Promise((resolve) => {
      killer.once("error", () => resolve(true));
      killer.once("exit", () => resolve(true));
    }),
    new Promise((resolve) => { helperTimer = setTimeout(() => resolve(false), helperTimeoutMs); }),
  ]);
  clearTimeout(helperTimer);
  if (!helperCompleted) {
    try { killer.kill("SIGKILL"); } catch {}
    throw new Error("Windows taskkill timed out");
  }
  await waitForExitWithin(child, 5_000);
}

async function killPosixTree(child) {
  if (!isRunning(child)) return;
  child.kill("SIGTERM");
  if (await waitForExitWithin(child, 2_000)) return;
  child.kill("SIGKILL");
  await waitForExitWithin(child, 5_000);
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
  if (platform === "win32") await killWindowsTree(child, spawnImplementation, treeKillTimeoutMs);
  else await killPosixTree(child);
  if (isRunning(child)) throw new Error("Timed out process tree did not exit");
  const error = new Error(`Process timed out after ${timeout}ms`);
  error.code = "ETIMEDOUT";
  throw error;
}
