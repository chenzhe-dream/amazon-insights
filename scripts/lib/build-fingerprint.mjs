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

export function stableBuildFingerprintMarker(worktree, invocationId) {
  if (typeof invocationId !== "string" || !/^[a-f0-9-]{36}$/i.test(invocationId)) {
    throw new Error("Invalid build invocation identity");
  }
  return path.join(path.resolve(worktree), ".runtime", "build-fingerprints", `${invocationId}.json`);
}

export async function beginStableBuildFingerprint(worktree, marker) {
  const sourceHash = await createBuildSourceFingerprint(worktree);
  await fs.mkdir(path.dirname(marker), { recursive: true });
  const temporary = `${marker}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(temporary, JSON.stringify({ version: 1, sourceHash }), { encoding: "utf8", flag: "wx" });
  await fs.rename(temporary, marker);
  return sourceHash;
}

export async function completeStableBuildFingerprint(worktree, marker, target) {
  let before;
  try {
    before = JSON.parse(await fs.readFile(marker, "utf8"));
    if (before?.version !== 1 || !/^[a-f0-9]{64}$/.test(before.sourceHash)) throw new Error();
  } catch {
    throw new Error("Build source fingerprint marker is invalid");
  }
  const afterHash = await createBuildSourceFingerprint(worktree);
  await fs.rm(marker, { force: true });
  if (afterHash !== before.sourceHash) throw new Error("Build inputs changed during build");
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify({ version: 1, sourceHash: afterHash })}\n`, "utf8");
  return afterHash;
}
