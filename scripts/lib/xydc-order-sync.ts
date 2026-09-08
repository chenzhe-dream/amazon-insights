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
  isFreshXydcOrderCache,
  readXydcOrderSnapshot,
  writeXydcOrderSnapshot,
} from "./xydc-order-cache";
import { callXydcTool, XydcProviderError } from "./xydc-mcp-client";

const REQUEST_SPACING_MS = 2_000;
const REQUEST_TIMEOUT_MS = 15_000;
const PHASE_BUDGET_MS = 300_000;
const MAX_RETRY_AFTER_MS = 30_000;

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
};

export interface XydcOrderSyncDependencies {
  monotonicNow?: () => number;
  delay?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  timeout?: (milliseconds: number, signal: AbortSignal) => Promise<never>;
}

const defaultDependencies: Required<XydcOrderSyncDependencies> = {
  monotonicNow: () => performance.now(),
  delay: (milliseconds, signal) => new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  }),
  timeout: (milliseconds, signal) => new Promise((_, reject) => {
    if (signal.aborted) {
      reject(new XydcProviderError("CANCELLED"));
      return;
    }
    const timer = setTimeout(() => reject(new XydcProviderError("TIMEOUT")), milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new XydcProviderError("CANCELLED"));
    }, { once: true });
  }),
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

export async function syncXydcOrderFamilies(
  input: SyncXydcOrderFamiliesInput,
  injected: XydcOrderSyncDependencies = {},
): Promise<XydcOrderSnapshot[]> {
  if (!Number.isFinite(input.now.getTime())) throw new TypeError("A valid collection date is required");
  const dependencies = { ...defaultDependencies, ...injected };
  const outerSignal = input.signal ?? new AbortController().signal;
  const phaseStart = dependencies.monotonicNow();
  const window = getXydcOrderWindow(input.now);
  const fetchedAt = input.now.toISOString();
  const families = input.families.map(canonicalFamily).filter(family => family.children.length > 0);
  const cached = await Promise.all(families.map(family => readXydcOrderSnapshot(input.dataRoot, family, window)));
  const records = new Map<string, XydcOrderChild>();
  const freshIndexes = new Set<number>();

  for (let index = 0; index < families.length; index += 1) {
    const prior = cached[index];
    if (!input.force && isFreshXydcOrderCache(prior, input.now)) freshIndexes.add(index);
    if (!input.force && prior) {
      for (const child of prior.children) {
        if (completeChild(child, window) && !records.has(child.asin)) records.set(child.asin, child);
      }
    }
  }

  const orderedAsins = [...new Set(families.flatMap(family => family.children.map(child => child.asin)))];
  const requiredAsins = new Set(families.flatMap((family, index) => freshIndexes.has(index)
    ? []
    : family.children.map(child => child.asin)));
  let lastRequestStart: number | undefined;
  let stopReason: XydcOrderReason | undefined;
  const request: ToolCall = input.callTool ?? (async ({ toolName, args, signal }) => callXydcTool(
    input.token,
    toolName,
    args,
    { signal, timeoutMs: REQUEST_TIMEOUT_MS },
  ));

  const remaining = () => PHASE_BUDGET_MS - (dependencies.monotonicNow() - phaseStart);
  const wait = async (milliseconds: number) => {
    if (outerSignal.aborted) throw new XydcProviderError("CANCELLED");
    if (milliseconds > remaining()) throw new XydcProviderError("BUDGET_EXHAUSTED");
    await dependencies.delay(milliseconds, outerSignal);
    if (outerSignal.aborted) throw new XydcProviderError("CANCELLED");
    if (remaining() <= 0) throw new XydcProviderError("BUDGET_EXHAUSTED");
  };

  const oneRequest = async (asin: string) => {
    if (outerSignal.aborted) throw new XydcProviderError("CANCELLED");
    const budget = remaining();
    if (budget <= 0) throw new XydcProviderError("BUDGET_EXHAUSTED");
    if (lastRequestStart !== undefined) {
      const spacing = REQUEST_SPACING_MS - (dependencies.monotonicNow() - lastRequestStart);
      if (spacing > 0) await wait(spacing);
    }
    const timeoutMs = Math.min(REQUEST_TIMEOUT_MS, remaining());
    if (timeoutMs <= 0) throw new XydcProviderError("BUDGET_EXHAUSTED");
    lastRequestStart = dependencies.monotonicNow();
    const controller = new AbortController();
    const signal = boundedSignal(outerSignal, controller);
    try {
      return await Promise.race([
        request({
          toolName: "get_asin_order_trends",
          args: { asin, country: families[0]?.country ?? "US", start_month: window.startMonth, end_month: window.endMonth },
          signal,
        }),
        dependencies.timeout(timeoutMs, signal),
      ]);
    } finally {
      controller.abort();
    }
  };

  for (const asin of orderedAsins) {
    if (!requiredAsins.has(asin) || (!input.force && records.has(asin))) continue;
    if (stopReason) {
      records.set(asin, failureChild(asin, fetchedAt, stopReason));
      continue;
    }
    if (!input.token.trim()) {
      stopReason = "NOT_CONFIGURED";
      records.set(asin, failureChild(asin, fetchedAt, stopReason));
      continue;
    }
    if (outerSignal.aborted) {
      stopReason = "CANCELLED";
      records.set(asin, failureChild(asin, fetchedAt, stopReason));
      continue;
    }

    let result: unknown;
    let reason: XydcOrderReason | undefined;
    try {
      result = await oneRequest(asin);
    } catch (error) {
      reason = reasonForError(error, outerSignal);
      const retryAfterMs = error instanceof XydcProviderError ? error.retryAfterMs : undefined;
      if (reason === "RATE_LIMITED" && retryAfterMs !== undefined && retryAfterMs <= MAX_RETRY_AFTER_MS
        && retryAfterMs < remaining() && !outerSignal.aborted) {
        try {
          await wait(retryAfterMs);
          result = await oneRequest(asin);
          reason = undefined;
        } catch (retryError) {
          reason = reasonForError(retryError, outerSignal);
        }
      }
    }

    if (reason === undefined) {
      try {
        records.set(asin, projectXydcOrderChild({
          raw: result,
          asin,
          country: families[0]?.country ?? "US",
          window,
          fetchedAt,
        }));
      } catch (error) {
        reason = reasonForError(error, outerSignal);
      }
    }
    if (reason !== undefined) records.set(asin, failureChild(asin, fetchedAt, reason));
    if (reason === "AUTH_FAILED" || reason === "QUOTA_EXCEEDED" || reason === "CANCELLED" || reason === "BUDGET_EXHAUSTED") {
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
    const children = family.children.map(child => records.get(child.asin)
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
        fetchedAt,
        cacheState: "fresh",
        reasonCode,
      });
    await writeXydcOrderSnapshot(input.dataRoot, family, snapshot);
    snapshots.push(snapshot);
  }
  return snapshots;
}
