import { createHash } from "node:crypto";
import path from "node:path";

import { createWebArtifactStore } from "../../scripts/lib/web-artifact-store.mjs";

const [mode, worktree, token, pidText, command, crashPhase] = process.argv.slice(2);
const pid = Number(pidText);
const treeIdentity = {
  pid,
  pidBirth: `fixture-${pid}`,
  command,
  worktreeId: createHash("sha256").update(path.resolve(worktree)).digest("hex"),
};
const error = Object.assign(new Error(command), { code: "EPROCESSTREE", treeIdentity });

try {
  const store = createWebArtifactStore({
    worktree,
    manualRecoveryIntentCheckpoint: mode === "crash"
      ? async (phase) => {
          if (phase !== crashPhase) return;
          process.stdout.write(`${phase}\n`);
          await new Promise(() => undefined);
        }
      : undefined,
    manualRecoveryIntentRecoveryCheckpoint: mode === "recover-crash"
      ? (phase) => {
          if (phase !== crashPhase) return;
          process.stdout.write(`${phase}\n`);
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
        }
      : undefined,
  });
  if (mode === "persist") await store.persistManualRecoveryIntent(error, { token });
  else if (mode === "mark") await store.markManualRecovery(error, { token });
  else if (mode === "crash") await store.persistManualRecoveryIntent(error, { token });
  else if (mode === "recover-crash") await store.recoverManualRecovery();
  else throw new Error("Invalid fixture mode");
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : "manual recovery contender failed");
  process.exitCode = 2;
}
