import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const BUILD_INPUTS = Object.freeze([
  "app",
  "scripts",
  "server",
  "shared",
  "worker",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "vite.config.ts",
  "wrangler.jsonc",
]);

async function filesBelow(target) {
  let stats;
  try { stats = await fs.stat(target); }
  catch (error) { if (error?.code === "ENOENT") return []; throw error; }
  if (stats.isFile()) return [target];
  if (!stats.isDirectory()) return [];
  const entries = await fs.readdir(target, { withFileTypes: true });
  const nested = await Promise.all(entries
    .filter((entry) => !entry.isSymbolicLink())
    .map((entry) => filesBelow(path.join(target, entry.name))));
  return nested.flat();
}

export async function createBuildSourceFingerprint(worktree) {
  const root = path.resolve(worktree);
  const files = (await Promise.all(BUILD_INPUTS.map((entry) => filesBelow(path.join(root, entry)))))
    .flat()
    .sort((left, right) => path.relative(root, left).localeCompare(path.relative(root, right)));
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(path.relative(root, file).replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(await fs.readFile(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}
