import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  isFreshXydcOrderCache,
  readXydcOrderSnapshot,
  writeXydcOrderSnapshot,
  xydcOrderCachePath,
} from "../../scripts/lib/xydc-order-cache";
import {
  projectXydcOrderChild,
  syncXydcOrderFamilies,
  type XydcOrderSyncDependencies,
} from "../../scripts/lib/xydc-order-sync";
import { XydcProviderError } from "../../scripts/lib/xydc-mcp-client";
import { getXydcOrderWindow } from "../../shared/xydc-order-summary";
import type { XydcOrderSnapshot } from "../../shared/xydc-order-contract";
import type { XydcVariantFamily } from "../../shared/xydc-variant-contract";

const now = new Date("2026-09-08T09:00:00.000Z");
const months = getXydcOrderWindow(now).months;

function family(parentAsin: string, childAsins: readonly string[], inputAsin = childAsins[0]!): XydcVariantFamily {
  return {
    inputAsin,
    country: "US",
    parentAsin,
    dimensions: ["Color"],
    children: childAsins.map(asin => ({
      asin, attributes: [], title: null, imageUrl: null, price: null, currency: null,
      stars: null, productPageRatings: null, listingDate: null, infoStatus: "pending",
    })),
    sourceUpdatedAt: null,
    fetchedAt: now.toISOString(),
    status: "partial",
    reasonCode: "PARTIAL_CHILD_INFO",
    cacheState: "fresh",
  };
}

function response(asin: string, selectedMonths: readonly string[] = months, orders = 100) {
  return {
    status: 200,
    cost_credits: 2,
    data: {
      asin,
      country: "US",
      dateRangeNotice: "provider availability notice",
      trends: selectedMonths.map(date => ({ date, orders })),
    },
  };
}

function fakeTime(initial = 0) {
  let elapsed = initial;
  const delays: number[] = [];
  const dependencies: XydcOrderSyncDependencies = {
    monotonicNow: () => elapsed,
    delay: async milliseconds => {
      delays.push(milliseconds);
      elapsed += milliseconds;
    },
    timeout: async () => new Promise<never>(() => undefined),
  };
  return { dependencies, delays, advance: (milliseconds: number) => { elapsed += milliseconds; } };
}

async function scratch(run: (dataRoot: string) => Promise<void>) {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "xydc-order-"));
  try {
    await run(dataRoot);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
}

test("projects the observed monthly response with exact identity and no provider-only fields", () => {
  const projected = projectXydcOrderChild({
    raw: response("B07R56PTMS", months.slice(0, 2), 400),
    asin: "B07R56PTMS",
    country: "US",
    window: getXydcOrderWindow(now),
    fetchedAt: now.toISOString(),
  });

  assert.equal(projected.reasonCode, "PARTIAL_DATA");
  assert.deepEqual(projected.trends, [
    { date: "2025-09", orders: 400 },
    { date: "2025-10", orders: 400 },
  ]);
  assert.equal(JSON.stringify(projected).includes("cost_credits"), false);
  assert.equal(JSON.stringify(projected).includes("dateRangeNotice"), false);
  assert.throws(() => projectXydcOrderChild({
    raw: response("B07R56PTM0"), asin: "B07R56PTMS", country: "US",
    window: getXydcOrderWindow(now), fetchedAt: now.toISOString(),
  }), /SCHEMA_INVALID/);
});

test("collects every child sequentially and deduplicates shared children globally", async () => scratch(async dataRoot => {
  const first = family("B0PARENT01", ["B0CHILD001", "B0CHILD002", "B0CHILD003", "B0CHILD004"]);
  const second = family("B0PARENT02", ["B0CHILD004", "B0CHILD005"]);
  const timing = fakeTime();
  const calls: Array<{ asin: string; args: Record<string, unknown>; startedAt: number }> = [];

  const snapshots = await syncXydcOrderFamilies({
    families: [first, second], token: "fixture-token", now, dataRoot,
    callTool: async ({ toolName, args, signal }) => {
      assert.equal(toolName, "get_asin_order_trends");
      assert.equal(signal.aborted, false);
      calls.push({ asin: args.asin as string, args, startedAt: timing.dependencies.monotonicNow!() });
      return response(args.asin as string);
    },
  }, timing.dependencies);

  assert.deepEqual(calls.map(call => call.asin), [
    "B0CHILD001", "B0CHILD002", "B0CHILD003", "B0CHILD004", "B0CHILD005",
  ]);
  assert.equal(calls.slice(1).every((call, index) => call.startedAt - calls[index]!.startedAt >= 2_000), true);
  assert.deepEqual(calls[0]?.args, {
    asin: "B0CHILD001", country: "US", start_month: "2025-09", end_month: "2026-08",
  });
  assert.deepEqual(snapshots.map(snapshot => snapshot.children.length), [4, 2]);
  assert.equal(snapshots.every(snapshot => snapshot.reasonCode === null && snapshot.cacheState === "fresh"), true);
  assert.deepEqual(snapshots[0]?.children[3], snapshots[1]?.children[0]);
}));

test("a complete fresh cache hit makes no request, while a changed UTC window refetches", async () => scratch(async dataRoot => {
  const target = family("B0PARENT01", ["B0CHILD001"]);
  const firstTiming = fakeTime();
  await syncXydcOrderFamilies({
    families: [target], token: "fixture-token", now, dataRoot,
    callTool: async ({ args }) => response(args.asin as string),
  }, firstTiming.dependencies);

  let calls = 0;
  const cached = await syncXydcOrderFamilies({
    families: [target], token: "fixture-token", now: new Date("2026-09-09T08:59:59.999Z"), dataRoot,
    callTool: async () => { calls += 1; throw new Error("must not request"); },
  }, fakeTime().dependencies);
  assert.equal(calls, 0);
  assert.equal(cached[0]?.fetchedAt, now.toISOString());

  await syncXydcOrderFamilies({
    families: [target], token: "fixture-token", now: new Date("2026-10-01T00:00:00.000Z"), dataRoot,
    callTool: async ({ args }) => { calls += 1; return response(args.asin as string, getXydcOrderWindow(new Date("2026-10-01T00:00:00.000Z")).months); },
  }, fakeTime().dependencies);
  assert.equal(calls, 1);
}));

test("partial cache resumes only missing child histories and preserves reused fetchedAt", async () => scratch(async dataRoot => {
  const target = family("B0PARENT01", ["B0CHILD001", "B0CHILD002"]);
  await syncXydcOrderFamilies({
    families: [target], token: "fixture-token", now, dataRoot,
    callTool: async ({ args }) => args.asin === "B0CHILD001"
      ? response("B0CHILD001", months.slice(0, 2))
      : response("B0CHILD002"),
  }, fakeTime().dependencies);

  const calls: string[] = [];
  const later = new Date("2026-09-08T10:00:00.000Z");
  const resumed = await syncXydcOrderFamilies({
    families: [target], token: "fixture-token", now: later, dataRoot,
    callTool: async ({ args }) => { calls.push(args.asin as string); return response(args.asin as string); },
  }, fakeTime().dependencies);

  assert.deepEqual(calls, ["B0CHILD001"]);
  assert.equal(resumed[0]?.reasonCode, null);
  assert.equal(resumed[0]?.children.find(child => child.asin === "B0CHILD001")?.fetchedAt, later.toISOString());
  assert.equal(resumed[0]?.children.find(child => child.asin === "B0CHILD002")?.fetchedAt, now.toISOString());
}));

test("failed forced refresh preserves an intact complete same-window snapshot as stale", async () => scratch(async dataRoot => {
  const target = family("B0PARENT01", ["B0CHILD001", "B0CHILD002"]);
  await syncXydcOrderFamilies({
    families: [target], token: "fixture-token", now, dataRoot,
    callTool: async ({ args }) => response(args.asin as string),
  }, fakeTime().dependencies);
  const refreshedAt = new Date("2026-09-08T10:00:00.000Z");
  const stale = await syncXydcOrderFamilies({
    families: [target], token: "fixture-token", now: refreshedAt, dataRoot, force: true,
    callTool: async () => { throw new XydcProviderError("RPC_ERROR"); },
  }, fakeTime().dependencies);

  assert.equal(stale[0]?.cacheState, "stale");
  assert.equal(stale[0]?.reasonCode, "RPC_ERROR");
  assert.equal(stale[0]?.fetchedAt, now.toISOString());
  assert.equal(stale[0]?.children.every(child => child.fetchedAt === now.toISOString()), true);
}));

test("a forced partial response also preserves the intact complete snapshot as stale", async () => scratch(async dataRoot => {
  const target = family("B0PARENT01", ["B0CHILD001"]);
  await syncXydcOrderFamilies({
    families: [target], token: "fixture-token", now, dataRoot,
    callTool: async ({ args }) => response(args.asin as string),
  }, fakeTime().dependencies);

  const [fallback] = await syncXydcOrderFamilies({
    families: [target], token: "fixture-token", now: new Date("2026-09-08T10:00:00.000Z"), dataRoot, force: true,
    callTool: async ({ args }) => response(args.asin as string, months.slice(0, 2)),
  }, fakeTime().dependencies);

  assert.equal(fallback?.cacheState, "stale");
  assert.equal(fallback?.reasonCode, "PARTIAL_DATA");
  assert.equal(fallback?.children[0]?.trends.length, 12);
  assert.equal(fallback?.fetchedAt, now.toISOString());
}));

test("retries a structured 429 once after a bounded Retry-After wait", async () => scratch(async dataRoot => {
  const timing = fakeTime();
  let calls = 0;
  const [snapshot] = await syncXydcOrderFamilies({
    families: [family("B0PARENT01", ["B0CHILD001"])], token: "fixture-token", now, dataRoot,
    callTool: async ({ args }) => {
      calls += 1;
      if (calls === 1) throw new XydcProviderError("RATE_LIMITED", { statusCode: 429, retryAfterMs: 30_000, providerReason: "RateLimitExceeded" });
      return response(args.asin as string);
    },
  }, timing.dependencies);

  assert.equal(calls, 2);
  assert.deepEqual(timing.delays, [30_000]);
  assert.equal(snapshot?.reasonCode, null);
}));

test("does not retry 429 without a valid bounded delay and stops later children on auth or quota", async () => scratch(async dataRoot => {
  for (const providerError of [
    new XydcProviderError("RATE_LIMITED", { statusCode: 429 }),
    new XydcProviderError("RATE_LIMITED", { statusCode: 429, retryAfterMs: 30_001 }),
  ]) {
    let calls = 0;
    const [snapshot] = await syncXydcOrderFamilies({
      families: [family("B0PARENT01", ["B0CHILD001"])], token: "fixture-token", now, dataRoot: path.join(dataRoot, String(calls), String(providerError.retryAfterMs)), force: true,
      callTool: async () => { calls += 1; throw providerError; },
    }, fakeTime().dependencies);
    assert.equal(calls, 1);
    assert.equal(snapshot?.reasonCode, "RATE_LIMITED");
  }

  for (const reasonCode of ["AUTH_FAILED", "QUOTA_EXCEEDED"] as const) {
    const calls: string[] = [];
    const [snapshot] = await syncXydcOrderFamilies({
      families: [family("B0PARENT02", ["B0CHILD001", "B0CHILD002", "B0CHILD003"])],
      token: "fixture-token", now, dataRoot: path.join(dataRoot, reasonCode), force: true,
      callTool: async ({ args }) => {
        calls.push(args.asin as string);
        throw new XydcProviderError(reasonCode);
      },
    }, fakeTime().dependencies);
    assert.deepEqual(calls, ["B0CHILD001"]);
    assert.equal(snapshot?.children.every(child => child.reasonCode === reasonCode), true);
  }
}));

test("outer cancellation wins and an injected request ignoring cancellation cannot hang the phase", async () => scratch(async dataRoot => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const [cancelled] = await syncXydcOrderFamilies({
    families: [family("B0PARENT01", ["B0CHILD001"])], token: "fixture-token", now, dataRoot,
    signal: controller.signal,
    callTool: async () => { calls += 1; return response("B0CHILD001"); },
  }, fakeTime().dependencies);
  assert.equal(calls, 0);
  assert.equal(cancelled?.reasonCode, "CANCELLED");

  const timing = fakeTime();
  timing.dependencies.timeout = async milliseconds => {
    timing.advance(milliseconds);
    throw new XydcProviderError("TIMEOUT");
  };
  const result = await Promise.race([
    syncXydcOrderFamilies({
      families: [family("B0PARENT02", ["B0CHILD002"])], token: "fixture-token", now,
      dataRoot: path.join(dataRoot, "timeout"),
      callTool: async () => new Promise<never>(() => undefined),
    }, timing.dependencies),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("collector hung")), 250)),
  ]);
  assert.equal(result[0]?.reasonCode, "TIMEOUT");
}));

test("cache path binds country parent window and complete child set, validates content and rejects future freshness", async () => scratch(async dataRoot => {
  const target = family("B0PARENT01", ["B0CHILD001", "B0CHILD002"]);
  const window = getXydcOrderWindow(now);
  const snapshot: XydcOrderSnapshot = {
    version: 1, source: "xydc", aggregation: "children", country: "US", parentAsin: target.parentAsin,
    childAsins: target.children.map(child => child.asin), window,
    children: target.children.map(child => ({ asin: child.asin, trends: response(child.asin).data.trends, fetchedAt: now.toISOString(), reasonCode: null })),
    sourceUpdatedAt: null, fetchedAt: now.toISOString(), cacheState: "fresh", reasonCode: null,
  };
  const cachePath = xydcOrderCachePath(dataRoot, target, window);
  assert.match(cachePath.replaceAll("\\", "/"), /xydc-orders\/v1\/US\/B0PARENT01-2025-09-2026-08-[a-f0-9]+\.json$/);
  await writeXydcOrderSnapshot(dataRoot, target, snapshot);
  assert.deepEqual(await readXydcOrderSnapshot(dataRoot, target, window), snapshot);
  assert.equal(isFreshXydcOrderCache(snapshot, now), true);
  assert.equal(isFreshXydcOrderCache(snapshot, new Date("2026-09-08T08:59:59.999Z")), false);

  await writeFile(cachePath, JSON.stringify({ ...snapshot, parentAsin: "B0PARENT99" }));
  assert.equal(await readXydcOrderSnapshot(dataRoot, target, window), undefined);
  assert.equal((await readFile(cachePath, "utf8")).includes("cost_credits"), false);
}));
