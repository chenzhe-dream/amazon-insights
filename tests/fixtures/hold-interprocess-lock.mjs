import { acquireInterprocessLock } from "../../scripts/lib/interprocess-lock.mjs";

const lockPath = process.argv[2];
if (!lockPath) throw new Error("lock path is required");

await acquireInterprocessLock(lockPath);
process.stdout.write("LOCKED\n");
setInterval(() => undefined, 1_000);
