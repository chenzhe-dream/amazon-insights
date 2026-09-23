import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createBuildSourceFingerprint } from "./build-fingerprint.mjs";
import { boundedCodeSource } from "./code-publication-identity.mjs";

export async function readCodeSourceIdentity(worktree) {
  const git = process.platform === "win32" && fsSync.existsSync("D:/Git/cmd/git.exe") ? "D:/Git/cmd/git.exe" : "git";
  let sourceCommit;
  try { sourceCommit = execFileSync(git, ["-C", path.resolve(worktree), "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 }).trim(); }
  catch { throw new Error("Code source commit is unavailable"); }
  if (!/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error("Invalid code source commit");
  return Object.freeze({ sourceCommit, sourceHash: await createBuildSourceFingerprint(worktree) });
}

export async function assertBuiltCodeSource(worktree, expected) {
  const actual = await readCodeSourceIdentity(worktree);
  let built;
  try { built = JSON.parse(await fs.readFile(path.join(worktree, "dist", "build-fingerprint.json"), "utf8")); }
  catch { throw new Error("Code build source fingerprint is unavailable"); }
  if (!boundedCodeSource(expected?.sourceCommit, expected?.sourceHash)
    || actual.sourceCommit !== expected.sourceCommit || actual.sourceHash !== expected.sourceHash
    || built.version !== 1 || built.sourceHash !== expected.sourceHash) {
    throw new Error("Code source changed or build fingerprint mismatched");
  }
  return actual;
}
