import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runBoundedProcess, terminateBoundedProcessTree } from "../../scripts/lib/bounded-process.mjs";

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

test("two hung taskkill helpers keep process-tree termination explicitly unconfirmed", async () => {
  const parent = child(12345);
  let calls = 0;
  const execution = runBoundedProcess({
    command: "fake-build",
    timeout: 5,
    treeKillTimeoutMs: 20,
    platform: "win32",
    spawnImplementation() {
      calls += 1;
      return calls === 1 ? parent : child(12345 + calls);
    },
  });
  await assert.rejects(Promise.race([
    execution,
    new Promise((_, reject) => setTimeout(() => reject(new Error("test deadline")), 250)),
  ]), /process tree termination could not be confirmed/);
  assert.equal(calls, 3);
});

test("a bounded second taskkill confirms the original tree exit after the first helper times out", async () => {
  const parent = child(22345);
  let calls = 0;
  const execution = runBoundedProcess({
    command: "fake-build",
    timeout: 5,
    treeKillTimeoutMs: 20,
    platform: "win32",
    spawnImplementation() {
      calls += 1;
      if (calls === 1) return parent;
      const killer = child(22345 + calls);
      if (calls === 3) setImmediate(() => {
        killer.exitCode = 0;
        killer.emit("exit", 0, null);
        parent.exitCode = 1;
        parent.emit("exit", 1, null);
      });
      return killer;
    },
  });
  await assert.rejects(execution, (error) => error?.code === "ETIMEDOUT");
  assert.equal(calls, 3);
});

test("Windows graceful tree termination omits force and forced escalation uses force with identity", async () => {
  const parent = child(32345);
  const calls = [];
  const identity = { pid: 32345, pidBirth: "birth", command: "cmd", worktreeId: "a".repeat(64) };
  const spawnImplementation = (command, args) => {
    calls.push({ command, args });
    const killer = child(40000 + calls.length);
    setImmediate(() => { killer.exitCode = 1; killer.emit("exit", 1, null); });
    return killer;
  };
  await terminateBoundedProcessTree({
    child: parent, platform: "win32", spawnImplementation, helperTimeoutMs: 20, mode: "graceful", treeIdentity: identity,
  });
  assert.deepEqual(calls[0].args, ["/pid", "32345", "/t"]);
  await assert.rejects(terminateBoundedProcessTree({
    child: parent, platform: "win32", spawnImplementation, helperTimeoutMs: 20, mode: "force", treeIdentity: identity,
  }), (error) => error?.code === "EPROCESSTREE" && error.treeIdentity === identity);
  assert.deepEqual(calls.slice(1).map(({ args }) => args), [
    ["/pid", "32345", "/t", "/f"],
    ["/pid", "32345", "/t", "/f"],
  ]);
});

test("a real Windows fallback taskkill removes the grandchild after the first helper hangs", {
  skip: process.platform !== "win32" && "Windows taskkill tree semantics",
}, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bounded-process-fallback-"));
  const pidFile = path.join(directory, "pids.json");
  const source = [
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    `fs.writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify([process.pid, child.pid]));`,
    "setInterval(() => {}, 1000);",
  ].join("\n");
  let taskkillCalls = 0;
  try {
    await assert.rejects(runBoundedProcess({
      command: process.execPath,
      args: ["-e", source],
      timeout: 500,
      treeKillTimeoutMs: 500,
      platform: "win32",
      spawnImplementation(command, args, options) {
        if (command === "taskkill" && taskkillCalls++ === 0) return child(91_001);
        return spawn(command, args, options);
      },
    }), (error) => error?.code === "ETIMEDOUT");
    const pids = JSON.parse(await fs.readFile(pidFile, "utf8"));
    for (const pid of pids) {
      assert.throws(() => process.kill(pid, 0), (error) => error?.code === "ESRCH");
    }
    assert.equal(taskkillCalls, 2);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
