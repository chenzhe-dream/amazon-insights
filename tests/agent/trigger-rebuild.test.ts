import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createTriggerBackgroundRebuild } from "../../app/lib/trigger-rebuild";

async function withFormalWorktree(run: (input: { worktree: string; artifact: string }) => Promise<void>) {
  const worktree = await fsp.mkdtemp(path.join(os.tmpdir(), "trigger-formal-"));
  const artifact = await fsp.mkdtemp(path.join(os.tmpdir(), "trigger-artifact-"));
  try {
    await fsp.mkdir(path.join(worktree, "app"), { recursive: true });
    await fsp.mkdir(path.join(worktree, "scripts"), { recursive: true });
    await fsp.writeFile(path.join(worktree, "package.json"), "{}", "utf8");
    await fsp.writeFile(path.join(worktree, "app", "rufus-voc-data.ts"), "export const voc = {};", "utf8");
    await fsp.writeFile(path.join(worktree, "scripts", "run-background-rebuild.mjs"), "export {};", "utf8");
    await run({ worktree, artifact });
  } finally {
    await fsp.rm(worktree, { recursive: true, force: true });
    await fsp.rm(artifact, { recursive: true, force: true });
  }
}

test("packaged Web runtime spawns the validated formal runner with formal cwd and owned lock", async () => {
  await withFormalWorktree(async ({ worktree, artifact }) => {
    const calls: Array<{ command: string; args: readonly string[]; options: Record<string, unknown> }> = [];
    const child = { once() { return child; }, unref() {} };
    const trigger = createTriggerBackgroundRebuild({
      env: { AGENT_FORMAL_WORKTREE_ROOT: worktree, WEB_PORT: "31900" },
      cwd: artifact,
      randomOwner: () => "owned-job",
      spawn: ((command, args, options) => {
        calls.push({ command, args, options: options as Record<string, unknown> });
        return child;
      }) as never,
    });

    assert.equal(trigger().started, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, process.execPath);
    assert.deepEqual(calls[0].args, [path.join(worktree, "scripts", "run-background-rebuild.mjs")]);
    assert.equal(calls[0].options.cwd, path.resolve(worktree));
    assert.equal((calls[0].options.env as NodeJS.ProcessEnv).AGENT_FORMAL_WORKTREE_ROOT, path.resolve(worktree));
    assert.equal((calls[0].options.env as NodeJS.ProcessEnv).ALEXA_REBUILD_LOCK_OWNER, "owned-job");
    const lock = JSON.parse(fs.readFileSync(path.join(worktree, "data", ".rebuild-lock.json"), "utf8"));
    assert.equal(lock.owner, "owned-job");
  });
});

test("spawn failure and pre-runner exit release only the parent's owned lock", async () => {
  await withFormalWorktree(async ({ worktree }) => {
    const common = {
      env: { AGENT_FORMAL_WORKTREE_ROOT: worktree },
      cwd: worktree,
      randomOwner: () => "failed-job",
    };
    const throws = createTriggerBackgroundRebuild({
      ...common,
      spawn: (() => { throw new Error("spawn failed"); }) as never,
    });
    assert.throws(() => throws(), /spawn failed/);
    assert.equal(fs.existsSync(path.join(worktree, "data", ".rebuild-lock.json")), false);

    const handlers = new Map<string, () => void>();
    const child = {
      once(event: string, handler: () => void) { handlers.set(event, handler); return child; },
      unref() {},
    };
    const exits = createTriggerBackgroundRebuild({ ...common, spawn: (() => child) as never });
    assert.equal(exits().started, true);
    handlers.get("exit")?.();
    assert.equal(fs.existsSync(path.join(worktree, "data", ".rebuild-lock.json")), false);
  });
});

test("a second request queues a follower instead of silently losing publication", async () => {
  await withFormalWorktree(async ({ worktree }) => {
    const calls: NodeJS.ProcessEnv[] = [];
    const child = { once() { return child; }, unref() {} };
    let sequence = 0;
    const trigger = createTriggerBackgroundRebuild({
      env: { AGENT_FORMAL_WORKTREE_ROOT: worktree },
      cwd: worktree,
      randomOwner: () => `owner-${++sequence}`,
      spawn: ((_command, _args, options) => {
        calls.push(options.env as NodeJS.ProcessEnv);
        return child;
      }) as never,
    });
    assert.equal(trigger().started, true);
    const second = trigger();
    assert.equal(second.started, true);
    assert.match(second.message, /排队/);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].ALEXA_REBUILD_WAIT_FOR_LOCK, "1");
    assert.equal(calls[1].ALEXA_REBUILD_LOCK_OWNER, "owner-2");
  });
});
