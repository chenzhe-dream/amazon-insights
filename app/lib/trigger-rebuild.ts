import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const lockFile = path.join(root, "data", ".rebuild-lock.json");

export type RebuildResult = {
  started: boolean;
  message: string;
};

function readLock() {
  if (!fs.existsSync(lockFile)) return null;
  try {
    return JSON.parse(fs.readFileSync(lockFile, "utf8")) as { startedAt: string };
  } catch {
    return null;
  }
}

function writeLock() {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(lockFile, JSON.stringify({ startedAt: new Date().toISOString() }), "utf8");
}

function clearLock() {
  if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
}

export function triggerBackgroundRebuild(): RebuildResult {
  const existing = readLock();
  if (existing) {
    const ageMs = Date.now() - new Date(existing.startedAt).getTime();
    if (ageMs < 8 * 60 * 1000) {
      return { started: false, message: "构建任务已在进行中" };
    }
  }

  writeLock();
  const runner = path.join(root, "scripts", "run-background-rebuild.mjs");
  const child = spawn(process.execPath, [runner], {
    cwd: root,
    detached: true,
    stdio: "ignore",
    env: { ...process.env },
  });
  child.unref();

  return { started: true, message: "已启动后台构建与正式页面发布" };
}

export function markRebuildComplete() {
  clearLock();
}
