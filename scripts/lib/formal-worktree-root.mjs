import fs from "node:fs";
import path from "node:path";

export const FORMAL_WORKTREE_ENV = "AGENT_FORMAL_WORKTREE_ROOT";

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function validateWorktree(candidate) {
  if (typeof candidate !== "string" || !candidate.trim() || !path.isAbsolute(candidate)) {
    throw new Error("Formal worktree root is not configured");
  }
  const resolved = path.resolve(candidate);
  const required = [
    path.join(resolved, "package.json"),
    path.join(resolved, "app", "rufus-voc-data.ts"),
    path.join(resolved, "scripts", "run-background-rebuild.mjs"),
  ];
  if (required.some((file) => !fs.existsSync(file) || !fs.statSync(file).isFile())) {
    throw new Error("Formal worktree root is invalid");
  }
  return resolved;
}

/**
 * @typedef {object} FormalWorktreeOptions
 * @property {Readonly<Record<string, string | undefined>>} [env]
 * @property {string} [cwd]
 * @property {string} [worktree]
 */

/** @param {FormalWorktreeOptions} [options] */
export function resolveFormalWorktreeRoot(options = {}) {
  const { env = process.env, cwd = process.cwd(), worktree } = options;
  const configured = env?.[FORMAL_WORKTREE_ENV];
  if (configured && worktree && path.resolve(configured) !== path.resolve(worktree)) {
    throw new Error("Formal worktree root conflicts with the requested worktree");
  }
  return validateWorktree(configured ?? worktree ?? cwd);
}

/** @param {FormalWorktreeOptions} [options] */
export function resolveFormalWorktreeRunner(options = {}) {
  return resolveFormalWorktreeScript("run-background-rebuild.mjs", options);
}

/** @param {FormalWorktreeOptions} [options] */
export function resolveFormalWorktreeScript(scriptName, options = {}) {
  if (typeof scriptName !== "string" || !/^[a-z0-9-]+\.mjs$/.test(scriptName)) {
    throw new Error("Formal runner name is invalid");
  }
  const worktree = resolveFormalWorktreeRoot(options);
  const runner = path.join(worktree, "scripts", scriptName);
  const resolvedRunner = fs.realpathSync(runner);
  if (!isWithin(fs.realpathSync(worktree), resolvedRunner) || !fs.statSync(resolvedRunner).isFile()) {
    throw new Error("Formal rebuild runner is invalid");
  }
  return resolvedRunner;
}
