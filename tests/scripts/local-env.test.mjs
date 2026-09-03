import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { loadLocalEnv } from "../../scripts/lib/local-env.mjs";

test("formal mode never reads credentials from the selected code root", () => {
  const previousFormalRoot = process.env.AGENT_FORMAL_WORKTREE_ROOT;
  const originalExistsSync = fs.existsSync;
  const originalReadFileSync = fs.readFileSync;
  const reads = [];
  process.env.AGENT_FORMAL_WORKTREE_ROOT = path.resolve(import.meta.dirname, "../..");
  fs.existsSync = (filePath) => {
    reads.push(String(filePath));
    throw new Error("formal mode attempted a worktree credential read");
  };
  fs.readFileSync = (filePath) => {
    reads.push(String(filePath));
    throw new Error("formal mode attempted a worktree credential read");
  };

  try {
    assert.doesNotThrow(() => loadLocalEnv());
    assert.deepEqual(reads, []);
  } finally {
    fs.existsSync = originalExistsSync;
    fs.readFileSync = originalReadFileSync;
    if (previousFormalRoot === undefined) delete process.env.AGENT_FORMAL_WORKTREE_ROOT;
    else process.env.AGENT_FORMAL_WORKTREE_ROOT = previousFormalRoot;
  }
});

test("development mode keeps loading worktree-local env files", () => {
  const key = "LOCAL_ENV_TDD_VALUE";
  const previousFormalRoot = process.env.AGENT_FORMAL_WORKTREE_ROOT;
  const previousValue = process.env[key];
  const originalExistsSync = fs.existsSync;
  const originalReadFileSync = fs.readFileSync;
  delete process.env.AGENT_FORMAL_WORKTREE_ROOT;
  delete process.env[key];
  fs.existsSync = (filePath) => String(filePath).endsWith(`${path.sep}.env.local`);
  fs.readFileSync = () => `${key}=from-worktree`;

  try {
    loadLocalEnv();
    assert.equal(process.env[key], "from-worktree");
  } finally {
    fs.existsSync = originalExistsSync;
    fs.readFileSync = originalReadFileSync;
    if (previousFormalRoot === undefined) delete process.env.AGENT_FORMAL_WORKTREE_ROOT;
    else process.env.AGENT_FORMAL_WORKTREE_ROOT = previousFormalRoot;
    if (previousValue === undefined) delete process.env[key];
    else process.env[key] = previousValue;
  }
});
