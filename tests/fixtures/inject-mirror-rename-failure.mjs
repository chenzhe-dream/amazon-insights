import fs from "node:fs";
import path from "node:path";

const target = path.resolve(requiredEnvironment("TEST_MIRROR_RENAME_TARGET"));
const failureCode = requiredEnvironment("TEST_MIRROR_RENAME_FAILURE_CODE");
const failureCount = Number(requiredEnvironment("TEST_MIRROR_RENAME_FAILURE_COUNT"));
if (!Number.isSafeInteger(failureCount) || failureCount < 0) {
  throw new TypeError("TEST_MIRROR_RENAME_FAILURE_COUNT must be a non-negative integer");
}

const originalRenameSync = fs.renameSync;
let attempts = 0;
const waits = [];
fs.renameSync = (source, destination) => {
  if (path.resolve(String(destination)) === target) {
    attempts += 1;
    if (attempts <= failureCount) {
      const error = new Error("injected mirror rename failure");
      error.code = failureCode;
      error.syscall = "rename";
      error.path = String(source);
      error.dest = String(destination);
      throw error;
    }
  }
  return originalRenameSync(source, destination);
};

globalThis[Symbol.for("test.mirrorRenameAttempts")] = () => attempts;
globalThis[Symbol.for("test.mirrorRenameWaits")] = () => [...waits];
if (process.env.TEST_MIRROR_CAPTURE_RENAME_WAITS === "1") {
  Atomics.wait = (_array, _index, _value, timeout) => {
    waits.push(timeout);
    return "timed-out";
  };
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new TypeError(`${name} is required`);
  return value;
}
