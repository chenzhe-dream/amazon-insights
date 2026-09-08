import {
  XydcOrderChildSchema,
  XydcOrderSnapshotSchema,
  type XydcOrderChild,
  type XydcOrderReason,
  type XydcOrderSnapshot,
  type XydcOrderWindow,
} from "../../shared/xydc-order-contract";
import { getXydcOrderWindow } from "../../shared/xydc-order-summary";
import { XydcVariantFamilySchema, type XydcVariantFamily } from "../../shared/xydc-variant-contract";
import {
  isCurrentXydcOrderTimestamp,
  isFreshXydcOrderCache,
  readXydcOrderSnapshot,
  writeXydcOrderSnapshot,
} from "./xydc-order-cache";
import { withXydcSession, XydcProviderError } from "./xydc-mcp-client";
import { readXydcOrderCheckpoint, writeXydcOrderCheckpoint } from "./xydc-order-checkpoint";
import { abortableDelay } from "./xydc-request-coordination";

const REQUEST_SPACING_MS = 2_000;
const REQUEST_TIMEOUT_MS = 15_000;
const PHASE_BUDGET_MS = 300_000;

type ToolCall = (input: {
  toolName: "get_asin_order_trends";
  args: Record<string, unknown>;
  signal: AbortSignal;
}) => Promise<unknown>;

export type SyncXydcOrderFamiliesInput = {
  families: readonly XydcVariantFamily[];
  token: string;
  now: Date;
  dataRoot: string;
  force?: boolean;
  signal?: AbortSignal;
  callTool?: ToolCall;
  env?: NodeJS.ProcessEnv;
  beforeRequest?: () => void | Promise<void>;
  onProgress?: (facts: XydcOrderProgress) => void | Promise<void>;
};

export type XydcOrderProgress = {
  window: XydcOrderWindow;
  state: "queued" | "collecting" | "rate-wait" | "completed" | "partial" | "failed" | "cancelled";
  children: Array<{ country: string; asin: string; state: "ready" | "cached" | "failed" | "pending"; reasonCode: XydcOrderReason | null }>;
  retryAt?: string;
};

export interface XydcOrderSyncDependencies {
  monotonicNow?: () => number;
  delay?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  timeout?: (milliseconds: number, signal: AbortSignal) => Promise<never>;
  wallNow?: () => Date;
}

const defaultDependencies = {
  monotonicNow: () => performance.now(),
  delay: abortableDelay,
};

function schemaInvalid(): never {
  throw new XydcProviderError("SCHEMA_INVALID");
}

function rawRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) schemaInvalid();
  return value as Record<string, unknown>;
}

export function projectXydcOrderChild({
  raw,
  asin,
  country,
  window,
  fetchedAt,
}: {
  raw: unknown;
  asin: string;
  country: string;
  window: XydcOrderWindow;
  fetchedAt: string;
}): XydcOrderChild {
  const root = rawRecord(raw);
  if (root.status !== 200) schemaInvalid();
  const data = rawRecord(root.data);
  if (data.asin !== asin || data.country !== country || !Array.isArray(data.trends)) schemaInvalid();
  const expectedMonths = new Set(window.months);
  const seen = new Set<string>();
  const trends = data.trends.map(value => {
    const trend = rawRecord(value);
    if (typeof trend.date !== "string" || !expectedMonths.has(trend.date) || seen.has(trend.date)
      || typeof trend.orders !== "number" || !Number.isSafeInteger(trend.orders) || trend.orders < 0) {
      schemaInvalid();
    }
    seen.add(trend.date);
    return { date: trend.date, orders: trend.orders };
  }).sort((left, right) => window.months.indexOf(left.date) - window.months.indexOf(right.date));
  return XydcOrderChildSchema.parse({
    asin,
    trends,
    fetchedAt,
    reasonCode: trends.length === window.months.length ? null : "PARTIAL_DATA",
  });
}

function canonicalFamily(family: XydcVariantFamily) {
  const parsed = XydcVariantFamilySchema.parse(family);
  const seen = new Set<string>();
  return {
    ...parsed,
    country: parsed.country.trim().toUpperCase(),
    children: parsed.children.filter(child => {
      if (seen.has(child.asin)) return false;
      seen.add(child.asin);
      return true;
    }),
  };
}

function completeChild(child: XydcOrderChild, window: XydcOrderWindow) {
  const months = new Set(child.trends.map(trend => trend.date));
  return child.reasonCode === null
    && child.trends.length === window.months.length
    && window.months.every(month => months.has(month));
}

function completeSnapshot(snapshot: XydcOrderSnapshot | undefined) {
  return Boolean(snapshot
    && snapshot.children.length === snapshot.childAsins.length
    && snapshot.children.every(child => completeChild(child, snapshot.window)));
}

function reusableChild(
  snapshot: XydcOrderSnapshot,
  child: XydcOrderChild,
  window: XydcOrderWindow,
  now: Date,
) {
  return snapshot.cacheState === "fresh"
    && isCurrentXydcOrderTimestamp(snapshot.fetchedAt, now)
    && isCurrentXydcOrderTimestamp(child.fetchedAt, now)
    && completeChild(child, window);
}

type ChildWork = { key: string; country: string; asin: string };

function childWorkKey(country: string, asin: string) {
  return `${country}:${asin}`;
}

function failureChild(asin: string, fetchedAt: string, reasonCode: XydcOrderReason): XydcOrderChild {
  return { asin, trends: [], fetchedAt, reasonCode };
}

function reasonForError(error: unknown, outerSignal: AbortSignal): XydcOrderReason {
  if (outerSignal.aborted) return "CANCELLED";
  if (error instanceof XydcProviderError) {
    const allowed = new Set<XydcOrderReason>([
      "NOT_CONFIGURED", "AUTH_FAILED", "QUOTA_EXCEEDED", "RATE_LIMITED", "TIMEOUT",
      "CANCELLED", "BUDGET_EXHAUSTED", "RPC_ERROR", "SCHEMA_INVALID", "NOT_FOUND", "PARTIAL_DATA",
    ]);
    return allowed.has(error.reasonCode as XydcOrderReason) ? error.reasonCode as XydcOrderReason : "RPC_ERROR";
  }
  return error instanceof Error && error.name === "AbortError" ? "TIMEOUT" : "RPC_ERROR";
}

function familyReason(children: readonly XydcOrderChild[]): XydcOrderReason | null {
  return children.find(child => child.reasonCode !== null)?.reasonCode ?? null;
}

function boundedSignal(outerSignal: AbortSignal, controller: AbortController) {
  return AbortSignal.any([outerSignal, controller.signal]);
}

async function loadReusableWork(input: SyncXydcOrderFamiliesInput, families: XydcVariantFamily[], window: XydcOrderWindow, now: Date) {
  const cached = await Promise.all(families.map(family => readXydcOrderSnapshot(input.dataRoot, family, window)));
  const records = new Map<string, XydcOrderChild>();
  const freshIndexes = new Set<number>();
  if (input.force) return { cached, records, freshIndexes };
  for (let index = 0; index < families.length; index++) {
    const family = families[index]!;
    const prior = cached[index];
    const checkpoints = await Promise.all(family.children.map(child => readXydcOrderCheckpoint(input.dataRoot, family, window, child.asin, now)));
    const interruptedRefresh = completeSnapshot(prior) && checkpoints.some(child => child && Date.parse(child.fetchedAt) > Date.parse(prior!.fetchedAt));
    if (!interruptedRefresh && isFreshXydcOrderCache(prior, now)) freshIndexes.add(index);
    for (const child of family.children) {
      const previous = prior?.children.find(candidate => candidate.asin === child.asin);
      const checkpoint = checkpoints.find(candidate => candidate?.asin === child.asin);
      const checkpointEligible = checkpoint && (prior?.cacheState !== "stale" && !interruptedRefresh || Date.parse(checkpoint.fetchedAt) > Date.parse(prior!.fetchedAt));
      const oldEligible = previous && prior && !interruptedRefresh && reusableChild(prior, previous, window, now);
      const candidate = checkpointEligible && (!oldEligible || Date.parse(checkpoint.fetchedAt) >= Date.parse(previous.fetchedAt)) ? checkpoint : oldEligible ? previous : undefined;
      const key = childWorkKey(family.country, child.asin);
      if (candidate && (!records.has(key) || Date.parse(candidate.fetchedAt) > Date.parse(records.get(key)!.fetchedAt))) records.set(key, candidate);
    }
  }
  return { cached, records, freshIndexes };
}

export async function syncXydcOrderFamilies(
  input: SyncXydcOrderFamiliesInput,
  injected: XydcOrderSyncDependencies = {},
): Promise<XydcOrderSnapshot[]> {
  const start = performance.now();
  if (input.callTool) return collectXydcOrderFamilies(input, injected, false);
  const window = getXydcOrderWindow(input.now);
  const families = input.families.map(canonicalFamily).filter(family => family.children.length);
  if (!families.length) return [];
  const reusable = await loadReusableWork(input, families, window, injected.wallNow?.() ?? new Date());
  if (!input.force && families.every(family => family.children.every(child => reusable.records.has(childWorkKey(family.country, child.asin))))) {
    return collectXydcOrderFamilies({ ...input, callTool: async () => { throw new XydcProviderError("RPC_ERROR"); } }, injected, true);
  }
  let collection: Promise<XydcOrderSnapshot[]> | undefined;
  let progress: XydcOrderProgress | undefined;
  const onProgress = async (facts: XydcOrderProgress) => { progress = facts; await input.onProgress?.(facts); };
  try {
    return await withXydcSession(input.token, session => {
      collection = collectXydcOrderFamilies({ ...input, onProgress,
        callTool: ({ toolName, args }) => session.callTool(toolName, args),
      }, { ...injected, monotonicNow: () => performance.now() - start }, true);
      return collection;
    }, { env: input.env, signal: input.signal, timeoutMs: PHASE_BUDGET_MS - (performance.now() - start), budgetReason: "BUDGET_EXHAUSTED",
      beforeRequest: input.beforeRequest,
      onRateWait: async retryAt => { if (progress) await input.onProgress?.({ ...progress, state: "rate-wait", ...(retryAt ? { retryAt } : {}) }); },
    });
  } catch (error) {
    if (collection) return collection;
    return collectXydcOrderFamilies({ ...input, callTool: async () => { throw error; } }, injected, true);
  }
}

async function collectXydcOrderFamilies(input: SyncXydcOrderFamiliesInput, injected: XydcOrderSyncDependencies, realSession: boolean): Promise<XydcOrderSnapshot[]> {
  if (!Number.isFinite(input.now.getTime())) throw new TypeError("A valid collection date is required");
  const dependencies = { ...defaultDependencies, ...injected };
  const outerSignal = input.signal ?? new AbortController().signal;
  const phaseStart = dependencies.monotonicNow();
  const window = getXydcOrderWindow(input.now);
  const wallNow = injected.wallNow ?? (realSession ? () => new Date() : () => input.now);
  const fetchedAt = wallNow().toISOString();
  const families = input.families.map(canonicalFamily).filter(family => family.children.length > 0);
  const { cached, records, freshIndexes } = await loadReusableWork(input, families, window, wallNow());

  const orderedWork = new Map<string, ChildWork>();
  for (const family of families) {
    for (const child of family.children) {
      const key = childWorkKey(family.country, child.asin);
      if (!orderedWork.has(key)) orderedWork.set(key, { key, country: family.country, asin: child.asin });
    }
  }
  const requiredWork = new Set(families.flatMap((family, index) => freshIndexes.has(index)
    ? []
    : family.children.map(child => childWorkKey(family.country, child.asin))));
  let lastRequestStart: number | undefined;
  let stopReason: XydcOrderReason | undefined;
  const request = input.callTool!;
  const reused = new Set(records.keys());
  let rateCount = 0;
  const emit = async (state: XydcOrderProgress["state"], retryAt?: string) => {
    try { await input.onProgress?.({ window, state, ...(retryAt ? { retryAt } : {}), children: [...orderedWork.values()].map(work => {
      const child = records.get(work.key);
      return { country: work.country, asin: work.asin,
        state: child && completeChild(child, window) ? reused.has(work.key) ? "cached" : "ready" : child ? "failed" : "pending",
        reasonCode: child?.reasonCode ?? null };
    }) }); } catch { throw new XydcProviderError("RPC_ERROR"); }
  };

  const remaining = () => PHASE_BUDGET_MS - (dependencies.monotonicNow() - phaseStart);
  const wait = async (milliseconds: number) => {
    if (outerSignal.aborted) throw new XydcProviderError("CANCELLED");
    if (milliseconds > remaining()) throw new XydcProviderError("BUDGET_EXHAUSTED");
    await dependencies.delay(milliseconds, outerSignal);
    if (outerSignal.aborted) throw new XydcProviderError("CANCELLED");
    if (remaining() <= 0) throw new XydcProviderError("BUDGET_EXHAUSTED");
  };

  const oneRequest = async (work: ChildWork) => {
    if (outerSignal.aborted) throw new XydcProviderError("CANCELLED");
    const budget = remaining();
    if (budget <= 0) throw new XydcProviderError("BUDGET_EXHAUSTED");
    if (!realSession && lastRequestStart !== undefined) {
      const spacing = REQUEST_SPACING_MS - (dependencies.monotonicNow() - lastRequestStart);
      if (spacing > 0) await wait(spacing);
    }
    const timeoutMs = Math.min(REQUEST_TIMEOUT_MS, remaining());
    if (timeoutMs <= 0) throw new XydcProviderError("BUDGET_EXHAUSTED");
    lastRequestStart = dependencies.monotonicNow();
    await emit("collecting");
    if (!realSession) await input.beforeRequest?.();
    if (outerSignal.aborted) throw new XydcProviderError("CANCELLED");
    const args = { asin: work.asin, country: work.country, start_month: window.startMonth, end_month: window.endMonth };
    if (realSession) return request({ toolName: "get_asin_order_trends", args, signal: outerSignal });
    const controller = new AbortController();
    const signal = boundedSignal(outerSignal, controller);
    const timeoutController = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: () => void = () => {};
    try {
      return await Promise.race([
        request({
          toolName: "get_asin_order_trends",
          args,
          signal,
        }),
        injected.timeout ? injected.timeout(timeoutMs, timeoutController.signal) : new Promise<never>((_, reject) => {
          abort = () => reject(new XydcProviderError("CANCELLED"));
          outerSignal.addEventListener("abort", abort, { once: true });
          timer = setTimeout(() => reject(new XydcProviderError("TIMEOUT")), timeoutMs);
        }),
      ]);
    } catch (error) {
      controller.abort();
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      outerSignal.removeEventListener("abort", abort);
      timeoutController.abort();
    }
  };

  try { await emit("queued"); } catch { stopReason = "RPC_ERROR"; }
  for (const work of orderedWork.values()) {
    if (!requiredWork.has(work.key) || (!input.force && records.has(work.key))) continue;
    if (stopReason) {
      records.set(work.key, failureChild(work.asin, fetchedAt, stopReason));
      continue;
    }
    if (!input.token.trim()) {
      stopReason = "NOT_CONFIGURED";
      records.set(work.key, failureChild(work.asin, fetchedAt, stopReason));
      continue;
    }
    if (outerSignal.aborted) {
      stopReason = "CANCELLED";
      records.set(work.key, failureChild(work.asin, fetchedAt, stopReason));
      continue;
    }

    let result: unknown;
    let reason: XydcOrderReason | undefined;
    try {
      result = await oneRequest(work);
    } catch (error) {
      reason = reasonForError(error, outerSignal);
      const retryAfterMs = error instanceof XydcProviderError ? error.retryAfterMs ?? 30_000 : 30_000;
      if (reason === "RATE_LIMITED") rateCount += 1;
      if (reason === "RATE_LIMITED" && rateCount === 1 && !outerSignal.aborted) {
        try {
          if (error instanceof XydcProviderError && error.retryAfterUnbounded) throw new XydcProviderError("BUDGET_EXHAUSTED");
          if (!realSession) {
            await emit("rate-wait", new Date(wallNow().getTime() + retryAfterMs).toISOString());
            await wait(retryAfterMs);
          }
          result = await oneRequest(work);
          reason = undefined;
        } catch (retryError) {
          reason = reasonForError(retryError, outerSignal);
        }
      }
    }

    if (reason === undefined) {
      try {
        const child = projectXydcOrderChild({
          raw: result,
          asin: work.asin,
          country: work.country,
          window,
          fetchedAt: wallNow().toISOString(),
        });
        records.set(work.key, child);
        if (completeChild(child, window)) {
          try {
            for (const family of families.filter(family => family.country === work.country && family.children.some(candidate => candidate.asin === work.asin))) {
              await writeXydcOrderCheckpoint(input.dataRoot, family, window, child, wallNow());
            }
          } catch { stopReason = "RPC_ERROR"; }
        }
      } catch (error) {
        reason = reasonForError(error, outerSignal);
      }
    }
    if (reason !== undefined) records.set(work.key, failureChild(work.asin, fetchedAt, reason));
    if (reason === "AUTH_FAILED" || reason === "QUOTA_EXCEEDED" || reason === "CANCELLED" || reason === "BUDGET_EXHAUSTED" || reason === "RATE_LIMITED") {
      stopReason = reason;
    }
  }

  const snapshots: XydcOrderSnapshot[] = [];
  for (let index = 0; index < families.length; index += 1) {
    const family = families[index]!;
    const prior = cached[index];
    if (freshIndexes.has(index) && prior) {
      snapshots.push(prior);
      continue;
    }
    const children = family.children.map(child => records.get(childWorkKey(family.country, child.asin))
      ?? failureChild(child.asin, fetchedAt, stopReason ?? (outerSignal.aborted ? "CANCELLED" : "BUDGET_EXHAUSTED")));
    const reasonCode = familyReason(children);
    const attemptedRefreshFailed = reasonCode !== null;
    const snapshot = attemptedRefreshFailed && completeSnapshot(prior)
      ? XydcOrderSnapshotSchema.parse({ ...prior, cacheState: "stale", reasonCode })
      : XydcOrderSnapshotSchema.parse({
        version: 1,
        source: "xydc",
        aggregation: "children",
        country: family.country,
        parentAsin: family.parentAsin,
        childAsins: family.children.map(child => child.asin),
        window,
        children,
        sourceUpdatedAt: null,
        fetchedAt: wallNow().toISOString(),
        cacheState: "fresh",
        reasonCode,
      });
    await writeXydcOrderSnapshot(input.dataRoot, family, snapshot, undefined, wallNow());
    snapshots.push(snapshot);
  }
  const ready = [...records.values()].filter(child => completeChild(child, window)).length;
  try { await emit(outerSignal.aborted || stopReason === "CANCELLED" ? "cancelled" : ready === orderedWork.size ? "completed" : ready ? "partial" : "failed"); } catch { /* Observation failure must never replay provider work. */ }
  return snapshots;
}
