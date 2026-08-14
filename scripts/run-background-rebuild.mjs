import { spawnSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const lockFile = path.join(root, "data", ".rebuild-lock.json");

function clearLock() {
  if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
}

function run(label, command, args) {
  console.log(`[rebuild] ${label}`);
  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    throw new Error(`${label} failed (exit ${result.status})`);
  }
}

try {
  run("build", "npm", ["run", "build"]);
  const script = path.join(root, "scripts", "start-team-server.ps1");
  if (fs.existsSync(script)) {
    console.log("[rebuild] restarting team server...");
    const child = spawn(
      "powershell",
      ["-ExecutionPolicy", "Bypass", "-File", script, "-SkipBuild"],
      { cwd: root, detached: true, stdio: "ignore", shell: true }
    );
    child.unref();
  }
  console.log("[rebuild] done");
} catch (error) {
  console.error(`[rebuild] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  clearLock();
}
