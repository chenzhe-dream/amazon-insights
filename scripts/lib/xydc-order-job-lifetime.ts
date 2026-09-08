import type { XydcVariantFamily } from "../../shared/xydc-variant-contract";
import { isXydcOrderProgressTerminal, type XydcOrderProgressRecord } from "../../shared/xydc-order-progress";
import type { XydcOrderProgress } from "./xydc-order-sync";
import { XydcProviderError } from "./xydc-provider-error";
import { cleanupXydcOrderProgress, createXydcJobAuthority, createXydcProgressPool, parseXydcJobIdentity, writeXydcOrderProgress } from "./xydc-order-job-progress";

export function createXydcOrderProgressWriter(runtimeRoot: string, authorize: () => Promise<void>, jobSignal: AbortSignal) {
  let writes: Promise<void> = Promise.resolve();
  let latest: { record: XydcOrderProgressRecord; signal: AbortSignal } | null = null;
  const queue = (record: XydcOrderProgressRecord, phaseSignal: AbortSignal) => {
    const signal = AbortSignal.any([jobSignal, phaseSignal]);
    const work = writes.then(() => writeXydcOrderProgress(runtimeRoot, record, authorize, signal));
    writes = work.catch(() => {});
    return work;
  };
  return {
    async publish(record: XydcOrderProgressRecord, signal: AbortSignal) {
      latest = { record, signal };
      await queue(record, signal);
    },
    async heartbeat() {
      if (!latest || isXydcOrderProgressTerminal(latest.record.state) || latest.signal.aborted || jobSignal.aborted) return;
      await queue({ ...latest.record, updatedAt: new Date().toISOString() }, latest.signal);
    },
    async close() { latest = null; await writes; },
  };
}

/** One process owns this lifetime, its bounded read-only DB fence, and serialized sidecar writes. */
export async function createXydcOrderJobLifetime(env: NodeJS.ProcessEnv, runtimeRoot: string, asins: readonly string[], country: string) {
  const identity = parseXydcJobIdentity(env);
  if (identity && (env.AGENT_XYDC_PARENT_IPC !== "1" || !process.connected)) throw new Error("XYDC_JOB_PARENT_IPC_REQUIRED");
  const controller = new AbortController();
  const abort = () => controller.abort(new XydcProviderError("CANCELLED"));
  const pool = identity ? createXydcProgressPool(env) : null;
  const authority = pool ? createXydcJobAuthority(pool) : null;
  const scope = identity ? { organizationId: identity.organizationId, projectId: identity.projectId, currentRunId: identity.runId, country, asins } : null;
  const beforeRequest = async () => {
    controller.signal.throwIfAborted();
    try { if (identity && authority && scope) await authority.assert(identity, scope, controller.signal); }
    catch { abort(); throw new XydcProviderError("CANCELLED"); }
    controller.signal.throwIfAborted();
  };
  let checking = false;
  let check: Promise<void> = Promise.resolve();
  const writer = createXydcOrderProgressWriter(runtimeRoot, beforeRequest, controller.signal);
  process.on("SIGINT", abort);
  process.on("SIGTERM", abort);
  process.on("disconnect", abort);
  pool?.on("error", abort);
  const fence = identity ? setInterval(() => {
    if (checking || controller.signal.aborted) return;
    checking = true;
    check = beforeRequest().catch(abort).finally(() => { checking = false; });
  }, 1_000) : null;
  const heartbeat = identity ? setInterval(() => {
    void writer.heartbeat().catch(abort);
  }, 15_000) : null;
  async function close() {
    if (fence) clearInterval(fence);
    if (heartbeat) clearInterval(heartbeat);
    await check;
    await writer.close();
    await pool?.end();
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
    process.off("disconnect", abort);
    if (identity && process.connected) process.disconnect();
  }
  try {
    await beforeRequest();
    if (identity) cleanupXydcOrderProgress(runtimeRoot);
  } catch (error) { await close(); throw error; }
  return {
    signal: controller.signal, beforeRequest, close,
    async progress(families: readonly XydcVariantFamily[], facts: XydcOrderProgress, context: { signal: AbortSignal }) {
      if (!identity) return;
      context.signal.throwIfAborted();
      const record: XydcOrderProgressRecord = {
        version: 1, ...identity, country, window: facts.window,
        families: families.filter(family => family.children.length && family.country === country).map(family => ({
          parentAsin: family.parentAsin, childAsins: family.children.map(child => child.asin),
        })),
        children: facts.children.map(({ asin, state, reasonCode, country: childCountry }) => {
          if (childCountry !== country) throw new Error("XYDC_PROGRESS_SCOPE_INVALID");
          return { asin, state, reasonCode };
        }),
        state: facts.state, updatedAt: new Date().toISOString(), retryAt: facts.retryAt ?? null,
        safeReason: facts.children.find(child => child.reasonCode)?.reasonCode ?? null,
      };
      if (!record.families.length) return;
      await writer.publish(record, context.signal);
    },
  };
}
