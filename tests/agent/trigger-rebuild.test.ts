import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createTriggerBackgroundRebuild } from "../../app/lib/trigger-rebuild";
import { readAlexaPublicationState } from "../../scripts/lib/alexa-publication-state.mjs";

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
    const child = { pid: process.pid, once() { return child; }, unref() {} };
    const trigger = createTriggerBackgroundRebuild({
      env: { NODE_ENV: "test" as const, AGENT_FORMAL_WORKTREE_ROOT: worktree, WEB_PORT: "31900" },
      cwd: artifact,
      randomOwner: () => "owned-job",
      spawn: ((command: string, args: readonly string[], options: import("node:child_process").SpawnOptions) => {
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
    const state = await readAlexaPublicationState(worktree);
    assert.equal(state.worker.token, "owned-job");
    assert.equal(state.dirty, true);
  });
});

test("spawn failure and pre-runner exit release only the parent's owned lock", async () => {
  await withFormalWorktree(async ({ worktree }) => {
    const common = {
      env: { NODE_ENV: "test" as const, AGENT_FORMAL_WORKTREE_ROOT: worktree },
      cwd: worktree,
      randomOwner: () => "failed-job",
    };
    const throws = createTriggerBackgroundRebuild({
      ...common,
      spawn: (() => { throw new Error("spawn failed"); }) as never,
    });
    assert.throws(() => throws(), /spawn failed/);
    assert.equal((await readAlexaPublicationState(worktree)).worker, null);

    const handlers = new Map<string, () => void>();
    const child = {
      pid: process.pid,
      once(event: string, handler: () => void) { handlers.set(event, handler); return child; },
      unref() {},
    };
    const exits = createTriggerBackgroundRebuild({ ...common, spawn: (() => child) as never });
    assert.equal(exits().started, true);
    handlers.get("exit")?.();
    assert.equal((await readAlexaPublicationState(worktree)).worker, null);
    assert.equal((await readAlexaPublicationState(worktree)).dirty, true);
  });
});

test("N busy requests merge into one durable generation and never spawn detached followers", async () => {
  await withFormalWorktree(async ({ worktree }) => {
    const calls: NodeJS.ProcessEnv[] = [];
    const child = { pid: process.pid, once() { return child; }, unref() {} };
    let sequence = 0;
    const trigger = createTriggerBackgroundRebuild({
      env: { NODE_ENV: "test" as const, AGENT_FORMAL_WORKTREE_ROOT: worktree },
      cwd: worktree,
      randomOwner: () => `owner-${++sequence}`,
      spawn: ((_command: string, _args: readonly string[], options: import("node:child_process").SpawnOptions) => {
        calls.push(options.env as NodeJS.ProcessEnv);
        return child;
      }) as never,
    });
    const results = Array.from({ length: 25 }, () => trigger());
    assert.equal(results.filter((result) => result.started).length, 1);
    assert.ok(results.slice(1).every((result) => /合并/.test(result.message)));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].ALEXA_REBUILD_LOCK_OWNER, "owner-1");
    const state = await readAlexaPublicationState(worktree);
    assert.equal(state.generation, 1);
    assert.equal(state.dirty, true);
  });
});
