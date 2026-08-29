import fs from "node:fs/promises";
import path from "node:path";

import { createBuildSourceFingerprint } from "./lib/build-fingerprint.mjs";

const worktree = path.resolve(".");
const target = path.join(worktree, "dist", "build-fingerprint.json");
await fs.mkdir(path.dirname(target), { recursive: true });
await fs.writeFile(target, `${JSON.stringify({
  version: 1,
  sourceHash: await createBuildSourceFingerprint(worktree),
})}\n`, "utf8");
