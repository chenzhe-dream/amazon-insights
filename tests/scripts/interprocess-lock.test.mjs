import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  acquireInterprocessLock,
  quarantineInterprocessLockOwnersSync,
} from "../../scripts/lib/interprocess-lock.mjs";

async function withLock(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "identity-lock-"));
  const lockPath = path.join(directory, "token.lock");
  try { await run({ directory, lockPath }); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test("an alive reused PID with a mismatched v2 birth identity is safely stale", async () => {
  await withLock(async ({ lockPath }) => {
    const token = randomUUID();
    const owners = `${lockPath}.owners`;
    fs.mkdirSync(owners, { recursive: true });
    await writeFile(path.join(owners, `${process.pid}-${token}.owner.json`), JSON.stringify({
      version: 2,
      pid: process.pid,
      token,
      ticket: 1,
      pidBirth: "old-process-birth",
      command: "old-command",
      worktreeId: "a".repeat(64),
    }));
    const release = await acquireInterprocessLock(lockPath, {
      attempts: 5,
      retryMs: 1,
      currentProcessIdentity: {
        pidBirth: "new-process-birth", command: "new-command", worktreeId: "b".repeat(64),
      },
      inspectProcessIdentity: () => ({
        alive: true, pidBirth: "new-process-birth", command: "new-command", worktreeId: "b".repeat(64),
      }),
    });
    release();
    assert.deepEqual(await readdir(owners), []);
  });
});

test("a legacy owner without process identity remains conservatively live", async () => {
  await withLock(async ({ lockPath }) => {
    const token = randomUUID();
    const owners = `${lockPath}.owners`;
    fs.mkdirSync(owners, { recursive: true });
    await writeFile(path.join(owners, `${process.pid}-${token}.owner.json`), JSON.stringify({
      version: 1, pid: process.pid, token, ticket: 1,
    }));
    await assert.rejects(acquireInterprocessLock(lockPath, {
      attempts: 2, retryMs: 1,
    }), /Timed out/);
  });
});

test("explicit global quiescence quarantines malformed token-lock owners", async () => {
  await withLock(async ({ lockPath, directory }) => {
    const token = randomUUID();
    const owners = `${lockPath}.owners`;
    fs.mkdirSync(owners, { recursive: true });
    await writeFile(path.join(owners, `${process.pid}-${token}.owner.json`), "{truncated");
    assert.throws(() => quarantineInterprocessLockOwnersSync(lockPath), /global quiescent/i);
    assert.equal(quarantineInterprocessLockOwnersSync(lockPath, { confirmGlobalQuiescent: true }), true);
    assert.deepEqual(await readdir(owners), []);
    assert.ok((await readdir(directory)).some((name) => name.includes("manual-quarantine")));
  });
});

test("manual recovery CLI requires global quiescence for token-lock quarantine", async () => {
  const source = await readFile(path.resolve("scripts/clear-web-artifact-manual-recovery.mjs"), "utf8");
  assert.match(source, /--quarantine-token-lock-owners/);
  assert.match(source, /Token-lock quarantine requires --confirm-global-quiescent/);
  assert.match(source, /quarantineTokenLockOwners: flags\.has\("--quarantine-token-lock-owners"\)/);
});

test("Windows owner records use the OS CreationDate instead of an uptime estimate", {
  skip: process.platform !== "win32" && "Windows CIM identity",
}, async () => {
  await withLock(async ({ lockPath }) => {
    const release = await acquireInterprocessLock(lockPath);
    try {
      const ownerName = (await readdir(`${lockPath}.owners`)).find((name) => name.endsWith(".owner.json"));
      const owner = JSON.parse(await readFile(path.join(`${lockPath}.owners`, ownerName), "utf8"));
      const query = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", [
        `$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${process.pid}'`,
        "$p.CreationDate.ToUniversalTime().ToString('o')",
      ].join(";")], { encoding: "utf8", shell: false, windowsHide: true, timeout: 2_000 });
      assert.equal(query.status, 0);
      assert.equal(Date.parse(owner.pidBirth), Date.parse(query.stdout.trim()));
    } finally { release(); }
  });
});

test("one acquisition inspects each foreign owner once and obeys a wall-clock deadline", async () => {
  await withLock(async ({ lockPath }) => {
    const token = randomUUID();
    const owners = `${lockPath}.owners`;
    const oldIdentity = { pidBirth: "old-birth", command: "old-command", worktreeId: "a".repeat(64) };
    const newIdentity = { pidBirth: "new-birth", command: "new-command", worktreeId: "b".repeat(64) };
    fs.mkdirSync(owners, { recursive: true });
    await writeFile(path.join(owners, `${process.pid}-${token}.owner.json`), JSON.stringify({
      version: 2, pid: process.pid, token, ticket: 1, ...oldIdentity,
    }));
    const calls = new Map();
    const started = performance.now();
    await assert.rejects(acquireInterprocessLock(lockPath, {
      attempts: 10,
      retryMs: 5,
      waitMs: 25,
      currentProcessIdentity: newIdentity,
      inspectProcessIdentity(_pid, expected) {
        calls.set(expected.pidBirth, (calls.get(expected.pidBirth) ?? 0) + 1);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        return { alive: true, ...expected };
      },
    }), /Timed out/);
    assert.equal(calls.get("old-birth"), 1);
    assert.ok((calls.get("new-birth") ?? 0) <= 2, "choosing and owner records are each inspected once");
    assert.ok(performance.now() - started < 80);
  });
});

test("an unknown live v2 identity is never deleted", async () => {
  await withLock(async ({ lockPath }) => {
    const token = randomUUID();
    const owners = `${lockPath}.owners`;
    fs.mkdirSync(owners, { recursive: true });
    const ownerFile = path.join(owners, `${process.pid}-${token}.owner.json`);
    await writeFile(ownerFile, JSON.stringify({
      version: 2, pid: process.pid, token, ticket: 1,
      pidBirth: "trusted-birth", command: "trusted-command", worktreeId: "a".repeat(64),
    }));
    await assert.rejects(acquireInterprocessLock(lockPath, {
      attempts: 2, retryMs: 1, inspectProcessIdentity: () => ({ alive: true }),
    }), /Timed out/);
    assert.equal(fs.existsSync(ownerFile), true);
  });
});

test("global quiescence can quarantine an unknown v1 owner after PID reuse", async () => {
  await withLock(async ({ lockPath, directory }) => {
    const token = randomUUID();
    const owners = `${lockPath}.owners`;
    fs.mkdirSync(owners, { recursive: true });
    await writeFile(path.join(owners, `${process.pid}-${token}.owner.json`), JSON.stringify({
      version: 1, pid: process.pid, token, ticket: 1,
    }));
    assert.equal(quarantineInterprocessLockOwnersSync(lockPath, { confirmGlobalQuiescent: true }), true);
    assert.deepEqual(await readdir(owners), []);
    assert.ok((await readdir(directory)).some((name) => name.includes("manual-quarantine")));
  });
});

test("global quarantine refuses to remove a fully identified live v2 owner", async () => {
  await withLock(async ({ lockPath }) => {
    const release = await acquireInterprocessLock(lockPath);
    try {
      assert.equal(quarantineInterprocessLockOwnersSync(lockPath, { confirmGlobalQuiescent: true }), false);
      assert.ok((await readdir(`${lockPath}.owners`)).some((name) => name.endsWith(".owner.json")));
    } finally { release(); }
  });
});

test("quarantine compare-and-set never renames an owner changed after inspection", async () => {
  await withLock(async ({ lockPath }) => {
    const token = randomUUID();
    const owners = `${lockPath}.owners`;
    const ownerFile = path.join(owners, `${process.pid}-${token}.owner.json`);
    fs.mkdirSync(owners, { recursive: true });
    await writeFile(ownerFile, "{malformed");
    assert.equal(quarantineInterprocessLockOwnersSync(lockPath, {
      confirmGlobalQuiescent: true,
      beforeRename: ({ source }) => fs.writeFileSync(source, "{changed"),
    }), false);
    assert.equal(await readFile(ownerFile, "utf8"), "{changed");
  });
});
