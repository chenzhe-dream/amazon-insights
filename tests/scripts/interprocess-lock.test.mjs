import assert from "node:assert/strict";
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
