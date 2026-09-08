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

function family(
  parentAsin: string,
  childAsins: readonly string[],
  inputAsin = childAsins[0]!,
  country = "US",
): XydcVariantFamily {
  return {
    inputAsin,
    country,
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

function response(asin: string, selectedMonths: readonly string[] = months, orders = 100, country = "US") {
  return {
    status: 200,
    cost_credits: 2,
    data: {
      asin,
      country,
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

test("expired and future-dated complete caches are recollected instead of laundered", async () => scratch(async dataRoot => {
  const target = family("B0PARENT01", ["B0CHILD001"]);
  await syncXydcOrderFamilies({
    families: [target], token: "fixture-token", now, dataRoot,
    callTool: async ({ args }) => response(args.asin as string, months, 100),
  }, fakeTime().dependencies);

  let expiredCalls = 0;
  const expiredNow = new Date("2026-09-10T09:00:00.000Z");
  const [expired] = await syncXydcOrderFamilies({
    families: [target], token: "fixture-token", now: expiredNow, dataRoot,
    callTool: async ({ args }) => {
      expiredCalls += 1;
      return response(args.asin as string, months, 200);
    },
  }, fakeTime().dependencies);
  assert.equal(expiredCalls, 1);
  assert.equal(expired?.children[0]?.trends[0]?.orders, 200);
  assert.equal(expired?.children[0]?.fetchedAt, expiredNow.toISOString());

  const futureRoot = path.join(dataRoot, "future");
  const futureNow = new Date("2026-09-10T09:00:00.000Z");
  await syncXydcOrderFamilies({
    families: [target], token: "fixture-token", now: futureNow, dataRoot: futureRoot,
    callTool: async ({ args }) => response(args.asin as string, months, 300),
  }, fakeTime().dependencies);
  let futureCalls = 0;
  const [recollected] = await syncXydcOrderFamilies({
    families: [target], token: "fixture-token", now, dataRoot: futureRoot,
    callTool: async ({ args }) => {
      futureCalls += 1;
      return response(args.asin as string, months, 400);
    },
  }, fakeTime().dependencies);
  assert.equal(futureCalls, 1);
  assert.equal(recollected?.children[0]?.trends[0]?.orders, 400);
  assert.equal(recollected?.children[0]?.fetchedAt, now.toISOString());
}));

test("a failed-refresh stale fallback is retried and only becomes fresh after collection", async () => scratch(async dataRoot => {
  const target = family("B0PARENT01", ["B0CHILD001"]);
  await syncXydcOrderFamilies({
    families: [target], token: "fixture-token", now, dataRoot,
    callTool: async ({ args }) => response(args.asin as string, months, 100),
  }, fakeTime().dependencies);

  const failedAt = new Date("2026-09-08T10:00:00.000Z");
  const [stale] = await syncXydcOrderFamilies({
    families: [target], token: "fixture-token", now: failedAt, dataRoot, force: true,
    callTool: async () => { throw new XydcProviderError("RPC_ERROR"); },
  }, fakeTime().dependencies);
  assert.equal(stale?.cacheState, "stale");

  let retryCalls = 0;
  const recoveredAt = new Date("2026-09-08T11:00:00.000Z");
  const [recovered] = await syncXydcOrderFamilies({
    families: [target], token: "fixture-token", now: recoveredAt, dataRoot,
    callTool: async ({ args }) => {
      retryCalls += 1;
      return response(args.asin as string, months, 200);
    },
  }, fakeTime().dependencies);
  assert.equal(retryCalls, 1);
  assert.equal(recovered?.cacheState, "fresh");
  assert.equal(recovered?.reasonCode, null);
  assert.equal(recovered?.children[0]?.trends[0]?.orders, 200);
}));

test("partial resume recollects an aged complete child and preserves an eligible sibling", async () => scratch(async dataRoot => {
  const target = family("B0PARENT01", ["B0CHILD001", "B0CHILD002", "B0CHILD003"]);
  const observedAt = new Date("2026-09-09T12:00:00.000Z");
  const eligibleAt = new Date("2026-09-09T11:00:00.000Z").toISOString();
  const agedAt = new Date("2026-09-08T09:00:00.000Z").toISOString();
  const snapshot: XydcOrderSnapshot = {
    version: 1, source: "xydc", aggregation: "children", country: "US", parentAsin: target.parentAsin,
    childAsins: target.children.map(child => child.asin), window: getXydcOrderWindow(observedAt),
    children: [
      { asin: "B0CHILD001", trends: response("B0CHILD001").data.trends, fetchedAt: agedAt, reasonCode: null },
      { asin: "B0CHILD002", trends: response("B0CHILD002").data.trends, fetchedAt: eligibleAt, reasonCode: null },
      { asin: "B0CHILD003", trends: response("B0CHILD003", months.slice(0, 2)).data.trends, fetchedAt: eligibleAt, reasonCode: "PARTIAL_DATA" },
    ],
    sourceUpdatedAt: null, fetchedAt: eligibleAt, cacheState: "fresh", reasonCode: "PARTIAL_DATA",
  };
  await writeXydcOrderSnapshot(dataRoot, target, snapshot);

  const calls: string[] = [];
  const [resumed] = await syncXydcOrderFamilies({
    families: [target], token: "fixture-token", now: observedAt, dataRoot,
    callTool: async ({ args }) => {
      calls.push(args.asin as string);
      return response(args.asin as string, months, 200);
    },
  }, fakeTime().dependencies);
  assert.deepEqual(calls, ["B0CHILD001", "B0CHILD003"]);
  assert.equal(resumed?.children.find(child => child.asin === "B0CHILD001")?.fetchedAt, observedAt.toISOString());
  assert.equal(resumed?.children.find(child => child.asin === "B0CHILD002")?.fetchedAt, eligibleAt);
}));

test("mixed-age assembled snapshots expire when their oldest child reaches 24 hours", async () => scratch(async dataRoot => {
  const target = family("B0PARENT01", ["B0CHILD001", "B0CHILD002"]);
  await syncXydcOrderFamilies({
    families: [target], token: "fixture-token", now, dataRoot,
    callTool: async ({ args }) => args.asin === "B0CHILD001"
      ? response("B0CHILD001")
      : response("B0CHILD002", months.slice(0, 2)),
  }, fakeTime().dependencies);

  const resumedAt = new Date("2026-09-09T08:00:00.000Z");
  const [assembled] = await syncXydcOrderFamilies({
    families: [target], token: "fixture-token", now: resumedAt, dataRoot,
    callTool: async ({ args }) => response(args.asin as string, months, 200),
  }, fakeTime().dependencies);
  assert.equal(assembled?.fetchedAt, resumedAt.toISOString());
  assert.equal(assembled?.children.find(child => child.asin === "B0CHILD001")?.fetchedAt, now.toISOString());
  assert.equal(isFreshXydcOrderCache(assembled, new Date("2026-09-09T08:59:59.999Z")), true);
  assert.equal(isFreshXydcOrderCache(assembled, new Date("2026-09-09T09:00:00.001Z")), false);

  const calls: string[] = [];
  await syncXydcOrderFamilies({
    families: [target], token: "fixture-token", now: new Date("2026-09-09T09:00:00.001Z"), dataRoot,
    callTool: async ({ args }) => {
      calls.push(args.asin as string);
      return response(args.asin as string, months, 300);
    },
  }, fakeTime().dependencies);
  assert.deepEqual(calls, ["B0CHILD001"]);
}));

test("shared ASIN work is deduplicated per market and rejects a response from the wrong market", async () => scratch(async dataRoot => {
  const us = family("B0PARENT01", ["B0CHILD001"], "B0CHILD001", "US");
  const uk = family("B0PARENT02", ["B0CHILD001"], "B0CHILD001", "UK");
  const calls: Record<string, unknown>[] = [];
  const snapshots = await syncXydcOrderFamilies({
    families: [us, uk], token: "fixture-token", now, dataRoot,
    callTool: async ({ args }) => {
      calls.push(args);
      const country = args.country as string;
      return response(args.asin as string, months, country === "US" ? 100 : 200, country);
    },
  }, fakeTime().dependencies);
  assert.deepEqual(calls, [
    { asin: "B0CHILD001", country: "US", start_month: "2025-09", end_month: "2026-08" },
    { asin: "B0CHILD001", country: "UK", start_month: "2025-09", end_month: "2026-08" },
  ]);
  assert.deepEqual(snapshots.map(snapshot => [snapshot.country, snapshot.children[0]?.trends[0]?.orders]), [
    ["US", 100], ["UK", 200],
  ]);

  const mismatchCalls: string[] = [];
  const mismatched = await syncXydcOrderFamilies({
    families: [us, uk], token: "fixture-token", now, dataRoot: path.join(dataRoot, "mismatch"),
    callTool: async ({ args }) => {
      const country = args.country as string;
      mismatchCalls.push(country);
      return response(args.asin as string, months, 100, country === "UK" ? "US" : country);
    },
  }, fakeTime().dependencies);
  assert.deepEqual(mismatchCalls, ["US", "UK"]);
  assert.equal(mismatched[0]?.reasonCode, null);
  assert.equal(mismatched[1]?.reasonCode, "SCHEMA_INVALID");
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

test("retries explicit 429 at most twice with fallback delay and stops later children on auth or quota", async () => scratch(async dataRoot => {
  for (const providerError of [
    new XydcProviderError("RATE_LIMITED", { statusCode: 429 }),
    new XydcProviderError("RATE_LIMITED", { statusCode: 429, retryAfterMs: 30_001 }),
  ]) {
    let calls = 0;
    const [snapshot] = await syncXydcOrderFamilies({
      families: [family("B0PARENT01", ["B0CHILD001"])], token: "fixture-token", now, dataRoot: path.join(dataRoot, String(calls), String(providerError.retryAfterMs)), force: true,
      callTool: async () => { calls += 1; throw providerError; },
    }, fakeTime().dependencies);
    assert.equal(calls, 2);
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
