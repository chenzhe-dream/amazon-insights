import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { runBoundedProcess } from "../../scripts/lib/bounded-process.mjs";

function child(pid) {
  const value = new EventEmitter();
  value.pid = pid;
  value.exitCode = null;
  value.signalCode = null;
  value.stdout = null;
  value.stderr = null;
  value.kill = () => true;
  return value;
}

test("a hung taskkill helper has its own short timeout and explicit failure", async () => {
  const parent = child(12345);
  const killer = child(12346);
  let calls = 0;
  const execution = runBoundedProcess({
    command: "fake-build",
    timeout: 5,
    treeKillTimeoutMs: 20,
    platform: "win32",
    spawnImplementation() {
      calls += 1;
      return calls === 1 ? parent : killer;
    },
  });
  await assert.rejects(Promise.race([
    execution,
    new Promise((_, reject) => setTimeout(() => reject(new Error("test deadline")), 250)),
  ]), /taskkill timed out/);
});
