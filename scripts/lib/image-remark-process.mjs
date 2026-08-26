import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const PROGRESS_PREFIX = "IMAGE_REMARK_PROGRESS ";
const OUTCOME_PREFIX = "IMAGE_REMARK_OUTCOME ";
const ALLOWED_STATUS = new Set(["ready", "upstream-empty", "timeout", "connector-failed"]);
const ALLOWED_OUTCOME = new Set(["completed", "completed-with-gaps", "integrity-failed"]);

export function parseImageRemarkProgress(line) {
  if (!line.startsWith(PROGRESS_PREFIX)) return null;
  try {
    const value = JSON.parse(line.slice(PROGRESS_PREFIX.length));
    if (Object.keys(value).sort().join(",") !== "completed,status,total") return null;
    if (!Number.isSafeInteger(value.completed) || !Number.isSafeInteger(value.total)) return null;
    if (value.completed < 0 || value.total < 0 || value.completed > value.total) return null;
    if (!ALLOWED_STATUS.has(value.status)) return null;
    return Object.freeze({ completed: value.completed, total: value.total, status: value.status });
  } catch {
    return null;
  }
}

function parseImageRemarkOutcome(line) {
  if (!line.startsWith(OUTCOME_PREFIX)) return null;
  try {
    const value = JSON.parse(line.slice(OUTCOME_PREFIX.length));
    if (Object.keys(value).join(",") !== "status") return null;
    return ALLOWED_OUTCOME.has(value.status) ? value.status : null;
  } catch {
    return null;
  }
}

export function runImageRemarkProcess({
  command,
  args = [],
  cwd,
  env,
  onProgress = () => {},
  onOutput = () => {},
  spawnProcess = spawn,
}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnProcess(command, args, {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        shell: process.platform === "win32" && /^(?:npm|npm\.cmd|npm\.bat)$/i.test(command),
      });
    } catch {
      resolve({ succeeded: false, exitCode: null });
      return;
    }

    let settled = false;
    let callbackError = null;
    let childOutcome = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const fail = (error) => {
      if (settled || callbackError) return;
      callbackError = error;
      child.kill();
    };

    const stdout = createInterface({ input: child.stdout });
    stdout.on("line", (line) => {
      if (settled || callbackError) return;
      try {
        if (line.startsWith(PROGRESS_PREFIX)) {
          const event = parseImageRemarkProgress(line);
          if (event) onProgress(event);
          return;
        }
        if (line.startsWith(OUTCOME_PREFIX)) {
          const outcome = parseImageRemarkOutcome(line);
          if (outcome) childOutcome = outcome;
          return;
        }
        onOutput(`${line}\n`);
      } catch (error) {
        fail(error);
      }
    });
    child.stderr.on("data", (chunk) => {
      if (settled || callbackError) return;
      try {
        onOutput(String(chunk));
      } catch (error) {
        fail(error);
      }
    });

    child.once("error", () => callbackError
      ? rejectOnce(callbackError)
      : finish({ succeeded: false, exitCode: null }));
    child.once("close", (code) => {
      if (callbackError) rejectOnce(callbackError);
      else if (childOutcome === "integrity-failed") {
        rejectOnce(new Error("Image remark child reported integrity failure"));
      } else if (code !== 0 && childOutcome !== "completed-with-gaps") {
        rejectOnce(new Error("Image remark child exited without a trusted outcome"));
      } else finish({ succeeded: code === 0, exitCode: code });
    });
  });
}
