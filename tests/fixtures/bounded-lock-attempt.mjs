import { acquireInterprocessLock } from "../../scripts/lib/interprocess-lock.mjs";

const [lockPath, waitText] = process.argv.slice(2);
const waitMs = Number(waitText);
if (!lockPath || !Number.isSafeInteger(waitMs) || waitMs < 1) throw new Error("Invalid bounded lock fixture input");

try {
  const release = await acquireInterprocessLock(lockPath, { waitMs, retryMs: 1 });
  release();
  process.stdout.write("acquired\n");
} catch (error) {
  process.stdout.write(`${error instanceof Error ? error.message : "lock failed"}\n`);
}
