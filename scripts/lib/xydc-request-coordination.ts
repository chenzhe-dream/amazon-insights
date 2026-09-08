import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { acquireInterprocessLock } from "./interprocess-lock.mjs";
import { XydcProviderError } from "./xydc-provider-error";

export const XYDC_HTTP_SPACING_MS = 2_000;
type State = { version: 1; nextAllowedAt: number; cooldownUntil: number; blocked: boolean };
export type CoordinationOptions = {
  env?: NodeJS.ProcessEnv;
  signal: AbortSignal;
  remaining: () => number;
  beforeRequest?: () => void | Promise<void>;
  onRateWait?: (retryAt: string | undefined) => void | Promise<void>;
  wallNow?: () => number;
  delay?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
};

export function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

async function untilAbort<T>(work: Promise<T> | T, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason;
  let abort: () => void = () => {};
  try {
    return await Promise.race([Promise.resolve(work), new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
    })]);
  } finally { signal.removeEventListener("abort", abort); }
}

export async function acquireXydcCoordination(token: string, endpoint: URL, options: CoordinationOptions) {
  const root = (options.env ?? process.env).XYDC_COORDINATION_ROOT?.trim();
  if (!root || !path.isAbsolute(root) || path.parse(root).root === path.resolve(root)) throw new XydcProviderError("NOT_CONFIGURED");
  if (!token.trim() || !["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new XydcProviderError("NOT_CONFIGURED");
  endpoint.hash = "";
  const key = createHash("sha256").update(JSON.stringify([endpoint.href, token.trim()])).digest("hex");
  const statePath = path.join(root, `${key}.json`);
  const wallNow = options.wallNow ?? Date.now;
  const delay = options.delay ?? abortableDelay;
  const check = () => {
    if (options.signal.aborted) throw options.signal.reason;
    if (options.remaining() <= 0) throw new XydcProviderError("BUDGET_EXHAUSTED");
  };
  let release: (() => void) | undefined;
  let state: State = { version: 1, nextAllowedAt: 0, cooldownUntil: 0, blocked: false };
  try {
    check();
    await fs.mkdir(root, { recursive: true });
    if (!(await fs.stat(root)).isDirectory()) throw new Error("invalid directory");
    // The shared JS implementation accepts signal; its existing declaration predates that option.
    const lockOptions = { waitMs: options.remaining(), signal: options.signal };
    release = await acquireInterprocessLock(path.join(root, `${key}.lock`), lockOptions);
    try {
      const value = JSON.parse(await fs.readFile(statePath, "utf8"));
      if (value.version !== 1 || !Number.isSafeInteger(value.nextAllowedAt) || value.nextAllowedAt < 0
        || !Number.isSafeInteger(value.cooldownUntil) || value.cooldownUntil < 0 || typeof value.blocked !== "boolean"
        || Object.keys(value).sort().join() !== "blocked,cooldownUntil,nextAllowedAt,version") throw new Error("invalid state");
      state = value;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  } catch (error) {
    release?.();
    if (options.signal.aborted) throw options.signal.reason;
    if (error instanceof XydcProviderError) throw error;
    if (["EEXIST", "ENOTDIR", "EINVAL"].includes((error as NodeJS.ErrnoException).code ?? "")) throw new XydcProviderError("NOT_CONFIGURED");
    throw new XydcProviderError(options.remaining() <= 0 ? "BUDGET_EXHAUSTED" : "RPC_ERROR");
  }
  let writes = Promise.resolve();
  const persist = () => {
    const write = writes.then(async () => {
      const temporary = `${statePath}.${randomUUID()}.tmp`;
      let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
      try {
        handle = await fs.open(temporary, "wx", 0o600);
        await handle.writeFile(JSON.stringify(state));
        await handle.sync();
        await handle.close(); handle = undefined;
        await fs.rename(temporary, statePath);
      } catch {
        await handle?.close().catch(() => {});
        await fs.unlink(temporary).catch(() => {});
        throw new XydcProviderError("RPC_ERROR");
      }
      });
    writes = write;
    return write;
  };
  let queue = Promise.resolve();
  let rateCount = 0;
  let released = false;
  const dispatch = <T>(send: () => T): Promise<{ response: T }> => {
    const next = queue.then(async () => {
      if (released) throw new XydcProviderError("RPC_ERROR");
      const previousAllowedAt = state.nextAllowedAt;
      for (;;) {
        check();
        if (state.blocked) throw new XydcProviderError("BUDGET_EXHAUSTED");
        // Ignore this turn's own reservation when re-entering after a newly observed cooldown.
        while (Math.max(previousAllowedAt, state.cooldownUntil) > wallNow()) {
          const wait = Math.max(previousAllowedAt, state.cooldownUntil) - wallNow();
          if (state.cooldownUntil > wallNow()) await untilAbort(options.onRateWait?.(new Date(state.cooldownUntil).toISOString()), options.signal);
          if (wait >= options.remaining()) throw new XydcProviderError("BUDGET_EXHAUSTED");
          await untilAbort(delay(wait, options.signal), options.signal);
          check();
          if (state.blocked) throw new XydcProviderError("BUDGET_EXHAUSTED");
        }
        state.nextAllowedAt = wallNow() + XYDC_HTTP_SPACING_MS;
        await persist();
        check();
        if (state.blocked) throw new XydcProviderError("BUDGET_EXHAUSTED");
        // Authority is the final asynchronous operation, including after slow reservation I/O.
        await untilAbort(options.beforeRequest?.(), options.signal);
        check();
        if (state.blocked) throw new XydcProviderError("BUDGET_EXHAUSTED");
        if (state.cooldownUntil > wallNow()) continue;
        // No await between the final cooldown/authority checks and synchronous fetch invocation.
        const response = send();
        state.nextAllowedAt = wallNow() + XYDC_HTTP_SPACING_MS;
        await persist();
        return { response };
      }
    });
    queue = next.then(() => {}, () => {});
    return next;
  };
  return {
    async release() {
      await queue;
      try { await writes; } finally { if (!released) { released = true; release!(); } }
    },
    dispatch,
    async rateLimited(error: XydcProviderError) {
      rateCount += 1;
      const milliseconds = error.retryAfterMs ?? (rateCount === 1 ? 30_000 : 60_000);
      if (error.retryAfterUnbounded || !Number.isSafeInteger(wallNow() + milliseconds) || !Number.isFinite(new Date(wallNow() + milliseconds).getTime())) state.blocked = true;
      else state.cooldownUntil = Math.max(state.cooldownUntil, wallNow() + milliseconds);
      await persist();
      return state.blocked ? undefined : state.cooldownUntil;
    },
  };
}
