import path from "node:path";

import {
  beginStableBuildFingerprint,
  completeStableBuildFingerprint,
} from "./lib/build-fingerprint.mjs";

const worktree = path.resolve(".");
const target = path.join(worktree, "dist", "build-fingerprint.json");
const marker = path.join(worktree, ".runtime", "build-source-before.json");
if (process.argv.includes("--before")) await beginStableBuildFingerprint(worktree, marker);
else await completeStableBuildFingerprint(worktree, marker, target);
