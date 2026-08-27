import fs from "node:fs";
import { createHash } from "node:crypto";

import {
  compareAndSwapSyncJobMirror,
  mutateSyncJobMirror,
  mutateSyncJobMirrorSync,
} from "../../scripts/lib/sync-job-store.mjs";

const [mode, mirrorPath, field, serializedValue] = process.argv.slice(2);
if (!mode || !mirrorPath || !field || serializedValue === undefined) {
  throw new TypeError("mode, mirrorPath, field, and serializedValue are required");
}
const value = JSON.parse(serializedValue);
const attempts = () => globalThis[Symbol.for("test.mirrorRenameAttempts")]?.() ?? 0;
const waits = () => globalThis[Symbol.for("test.mirrorRenameWaits")]?.() ?? [];

try {
  let result = null;
  if (mode === "sync") {
    mutateSyncJobMirrorSync(mirrorPath, (current) => ({
      ...(current ?? {}),
      [field]: value,
    }));
    result = "mutated";
  } else if (mode === "async") {
    await mutateSyncJobMirror(mirrorPath, (current) => ({
      ...(current ?? {}),
      [field]: value,
    }));
    result = "mutated";
  } else if (mode === "cas") {
    const raw = fs.readFileSync(mirrorPath);
    const current = JSON.parse(raw.toString("utf8"));
    const nextJob = { ...current, [field]: value };
    result = await compareAndSwapSyncJobMirror(mirrorPath, {
      expectedDigest: digest(raw),
      nextJob,
      nextDigest: digest(Buffer.from(JSON.stringify(nextJob))),
    });
  } else {
    throw new TypeError(`unsupported fixture mode: ${mode}`);
  }
  process.stdout.write(`${JSON.stringify({ ok: true, attempts: attempts(), waits: waits(), result })}\n`);
} catch (error) {
  let lockRecovered = null;
  if (process.env.TEST_MIRROR_RECOVER_LOCK === "1") {
    try {
      await mutateSyncJobMirror(mirrorPath, () => null, { attempts: 3, retryMs: 1 });
      lockRecovered = true;
    } catch {
      lockRecovered = false;
    }
  }
  process.stdout.write(`${JSON.stringify({
    ok: false,
    attempts: attempts(),
    waits: waits(),
    code: error?.code ?? null,
    lockRecovered,
  })}\n`);
  process.exitCode = 1;
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}
