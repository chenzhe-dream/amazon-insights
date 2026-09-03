import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  FORMAL_WORKTREE_ENV,
  resolveFormalWorktreeRoot,
  resolveFormalWorktreeRunner,
} from "../../scripts/lib/formal-worktree-root.mjs";

async function withFormalWorktree(run) {
  const worktree = await fs.mkdtemp(path.join(os.tmpdir(), "formal-worktree-"));
  const artifact = await fs.mkdtemp(path.join(os.tmpdir(), "immutable-artifact-"));
  try {
    await fs.mkdir(path.join(worktree, "app"), { recursive: true });
    await fs.mkdir(path.join(worktree, "scripts"), { recursive: true });
    await fs.writeFile(path.join(worktree, "app", "rufus-voc-data.ts"), "export const voc = {};", "utf8");
    await fs.writeFile(path.join(worktree, "scripts", "run-background-rebuild.mjs"), "export {};", "utf8");
    await fs.writeFile(path.join(worktree, "package.json"), "{}", "utf8");
    await run({ worktree, artifact });
  } finally {
    await fs.rm(worktree, { recursive: true, force: true });
    await fs.rm(artifact, { recursive: true, force: true });
  }
}

test("immutable artifact runtime resolves the explicit formal worktree instead of module or artifact paths", async () => {
  await withFormalWorktree(async ({ worktree, artifact }) => {
    const env = { [FORMAL_WORKTREE_ENV]: worktree };
    assert.equal(resolveFormalWorktreeRoot({ env, cwd: artifact }), path.resolve(worktree));
    assert.equal(
      resolveFormalWorktreeRunner({ env, cwd: artifact }),
      path.join(path.resolve(worktree), "scripts", "run-background-rebuild.mjs"),
    );
  });
});

test("formal worktree resolution fails closed for guesses and conflicting explicit roots", async () => {
  await withFormalWorktree(async ({ worktree, artifact }) => {
    assert.throws(() => resolveFormalWorktreeRoot({ env: {}, cwd: artifact }), /Formal worktree/);
    assert.throws(
      () => resolveFormalWorktreeRoot({
        env: { [FORMAL_WORKTREE_ENV]: worktree },
        cwd: artifact,
        worktree: artifact,
      }),
      /Formal worktree/,
    );
  });
});
