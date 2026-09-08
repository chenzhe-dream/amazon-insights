import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { syncXydcOrderFamilies, projectXydcOrderChild } from "../../scripts/lib/xydc-order-sync";
import { readXydcOrderCheckpoint, writeXydcOrderCheckpoint } from "../../scripts/lib/xydc-order-checkpoint";
import { readXydcOrderSnapshot, writeXydcOrderSnapshot, xydcOrderCachePath } from "../../scripts/lib/xydc-order-cache";
import { getXydcOrderWindow } from "../../shared/xydc-order-summary";
import { fixtureFamily, fixtureNow, fixtureOrders, httpFixture } from "../helpers/xydc-http-fixture";
const fast = { delay: async () => {}, timeout: async () => new Promise<never>(() => {}) };

test("forced partial refresh preserves old family and resumes newer successful checkpoints only", async () => {
  const fixture = await httpFixture();
  const family = fixtureFamily();
  try {
    const [old] = await syncXydcOrderFamilies({ families: [family], token: "fixture-token", now: fixtureNow, dataRoot: fixture.root,
      callTool: async ({ args }) => fixtureOrders(args.asin as string),
    }, fast);
    const later = new Date(fixtureNow.getTime() + 60_000);
    const [partial] = await syncXydcOrderFamilies({ families: [family], token: "fixture-token", now: later, dataRoot: fixture.root, force: true,
      callTool: async ({ args }) => { if (args.asin === "B0CHILD002") throw new Error("fixture failed"); return fixtureOrders(args.asin as string, "US", 200); },
    }, fast);
    assert.deepEqual(partial?.children, old?.children); assert.equal(partial?.cacheState, "stale");
    const calls: string[] = [];
    const [resumed] = await syncXydcOrderFamilies({ families: [family], token: "fixture-token", now: new Date(later.getTime() + 60_000), dataRoot: fixture.root,
      callTool: async ({ args }) => { calls.push(args.asin as string); return fixtureOrders(args.asin as string, "US", 300); },
    }, fast);
    assert.deepEqual(calls, ["B0CHILD002"]);
    assert.deepEqual(resumed?.children.map(child => child.trends[0]!.orders), [200, 300]);
    assert.equal(resumed?.children[0]?.fetchedAt, later.toISOString());
  } finally { await fixture.close(); }
});

test("checkpoint identity binds all children, country, parent and window and rejects older or future observations", async () => {
  const fixture = await httpFixture();
  const family = fixtureFamily();
  const window = getXydcOrderWindow(fixtureNow);
  const later = new Date(fixtureNow.getTime() + 60_000);
  const child = projectXydcOrderChild({ raw: fixtureOrders("B0CHILD001"), asin: "B0CHILD001", country: "US", window, fetchedAt: later.toISOString() });
  try {
    await writeXydcOrderCheckpoint(fixture.root, family, window, child);
    await writeXydcOrderCheckpoint(fixture.root, family, window, { ...child, fetchedAt: fixtureNow.toISOString(), trends: child.trends.map(trend => ({ ...trend, orders: 1 })) });
    assert.deepEqual(await readXydcOrderCheckpoint(fixture.root, family, window, child.asin, later), child);
    assert.equal(await readXydcOrderCheckpoint(fixture.root, family, window, child.asin, fixtureNow), undefined);
    assert.equal(await readXydcOrderCheckpoint(fixture.root, family, window, child.asin, new Date(later.getTime() + 86_400_001)), undefined);
    for (const changed of [fixtureFamily(["B0CHILD001"]), fixtureFamily(undefined, "UK"), { ...family, parentAsin: "B0PARENT02" }]) {
      assert.equal(await readXydcOrderCheckpoint(fixture.root, changed, window, child.asin, later), undefined);
    }
    assert.equal(await readXydcOrderCheckpoint(fixture.root, family, getXydcOrderWindow(new Date("2026-10-01")), child.asin, later), undefined);
    const files = (await readdir(fixture.root, { recursive: true })).filter(file => file.endsWith(".checkpoint.json"));
    const value = await readFile(path.join(fixture.root, files[0]!), "utf8");
    assert.equal(value.includes("fixture-token"), false);
  } finally { await fixture.close(); }
});

test("older family writers cannot roll back a newer complete snapshot", async () => {
  const fixture = await httpFixture();
  const family = fixtureFamily(["B0CHILD001"]);
  try {
    const [old] = await syncXydcOrderFamilies({ families: [family], token: "fixture-token", now: fixtureNow, dataRoot: fixture.root,
      callTool: async () => fixtureOrders("B0CHILD001"),
    }, fast);
    const [fresh] = await syncXydcOrderFamilies({ families: [family], token: "fixture-token", now: new Date(fixtureNow.getTime() + 60_000), dataRoot: fixture.root, force: true,
      callTool: async () => fixtureOrders("B0CHILD001", "US", 200),
    }, fast);
    await writeXydcOrderSnapshot(fixture.root, family, old!);
    assert.deepEqual(await readXydcOrderSnapshot(fixture.root, family, getXydcOrderWindow(fixtureNow)), fresh);
    await writeXydcOrderSnapshot(fixture.root, family, { ...fresh!, fetchedAt: new Date(fixtureNow.getTime() + 120_000).toISOString(), reasonCode: "RPC_ERROR",
      children: fresh!.children.map(child => ({ ...child, trends: [], reasonCode: "RPC_ERROR" })),
    });
    assert.deepEqual(await readXydcOrderSnapshot(fixture.root, family, getXydcOrderWindow(fixtureNow)), fresh);
  } finally { await fixture.close(); }
});

test("response wall clock is captured after business completion and cached responses retain it", async () => {
  const fixture = await httpFixture();
  let wall = fixtureNow;
  const family = fixtureFamily(["B0CHILD001"]);
  try {
    const [first] = await syncXydcOrderFamilies({ families: [family], token: "fixture-token", now: fixtureNow, dataRoot: fixture.root,
      callTool: async () => { wall = new Date(fixtureNow.getTime() + 8_000); return fixtureOrders("B0CHILD001"); },
    }, { ...fast, wallNow: () => wall });
    assert.equal(first?.children[0]?.fetchedAt, wall.toISOString());
    const [cached] = await syncXydcOrderFamilies({ families: [family], token: "fixture-token", now: fixtureNow, dataRoot: fixture.root,
      callTool: async () => { assert.fail("no billed call for cache"); },
    }, { ...fast, wallNow: () => new Date(wall.getTime() + 10_000) });
    assert.deepEqual(cached, first);
  } finally { await fixture.close(); }
});

test("a future cache is repaired by current success and the following collection reuses it", async () => {
  const fixture = await httpFixture();
  const family = fixtureFamily(["B0CHILD001"]);
  const future = new Date("2099-09-08T09:00:00Z");
  try {
    const [first] = await syncXydcOrderFamilies({ families: [family], token: "fixture-token", now: fixtureNow, dataRoot: fixture.root,
      callTool: async () => fixtureOrders("B0CHILD001"),
    }, fast);
    const files = await readdir(fixture.root, { recursive: true });
    for (const file of files.filter(file => file.endsWith(".json"))) {
      const full = path.join(fixture.root, file);
      const value = JSON.parse(await readFile(full, "utf8"));
      if (value.child) value.child.fetchedAt = future.toISOString();
      else { value.fetchedAt = future.toISOString(); value.children[0].fetchedAt = future.toISOString(); }
      await (await import("node:fs/promises")).writeFile(full, JSON.stringify(value));
    }
    let calls = 0;
    const collect = () => syncXydcOrderFamilies({ families: [family], token: "fixture-token", now: fixtureNow, dataRoot: fixture.root,
      callTool: async () => { calls++; return fixtureOrders("B0CHILD001", "US", 200); },
    }, fast);
    await collect(); const [cached] = await collect();
    assert.equal(calls, 1);
    assert.equal(cached?.children[0]?.trends[0]?.orders, 200);
    assert.notDeepEqual(cached, first);
  } finally { await fixture.close(); }
});

test("a newer forced child checkpoint survives a process stopping before family finalization", async () => {
  const fixture = await httpFixture();
  const family = fixtureFamily();
  const window = getXydcOrderWindow(fixtureNow);
  const later = new Date(fixtureNow.getTime() + 60_000);
  try {
    await syncXydcOrderFamilies({ families: [family], token: "fixture-token", now: fixtureNow, dataRoot: fixture.root,
      callTool: async ({ args }) => fixtureOrders(args.asin as string),
    }, fast);
    // Equivalent durable state to death after the first force checkpoint and before the family write.
    await writeXydcOrderCheckpoint(fixture.root, family, window, projectXydcOrderChild({
      raw: fixtureOrders("B0CHILD001", "US", 200), asin: "B0CHILD001", country: "US", window, fetchedAt: later.toISOString(),
    }));
    const calls: string[] = [];
    const [resumed] = await syncXydcOrderFamilies({ families: [family], token: "fixture-token", now: later, dataRoot: fixture.root,
      callTool: async ({ args }) => { calls.push(args.asin as string); return fixtureOrders(args.asin as string, "US", 300); },
    }, fast);
    assert.deepEqual(calls, ["B0CHILD002"]);
    assert.deepEqual(resumed?.children.map(child => child.trends[0]!.orders), [200, 300]);
  } finally { await fixture.close(); }
});

test("a failed checkpoint write stops later paid calls and retains the already returned child", async () => {
  const fixture = await httpFixture();
  const blockedFile = xydcOrderCachePath(fixture.root, fixtureFamily(), getXydcOrderWindow(fixtureNow)).replace(/\.json$/, ".B0CHILD001.checkpoint.json");
  await mkdir(blockedFile, { recursive: true });
  let calls = 0;
  try {
    const [result] = await syncXydcOrderFamilies({ families: [fixtureFamily()], token: "fixture-token", now: fixtureNow, dataRoot: fixture.root,
      callTool: async ({ args }) => { calls++; return fixtureOrders(args.asin as string); },
    }, fast);
    assert.equal(calls, 1); assert.equal(result?.children[0]?.trends.length, 12);
    assert.equal(result?.reasonCode, "RPC_ERROR");
  } finally { await fixture.close(); }
});

for (const mode of ["queued", "collecting", "after-child", "terminal", "cached-queued", "cached-terminal"] as const) {
  test(`cancellation drains a hung ${mode} progress observer without losing completed work`, async () => {
    const fixture = await httpFixture();
    const target = fixtureFamily(mode === "after-child" ? undefined : ["B0CHILD001"]);
    const controller = new AbortController();
    let entered!: () => void;
    let resume!: () => void;
    const observed = new Promise<void>(resolve => { entered = resolve; });
    const suspended = new Promise<void>(resolve => { resume = resolve; });
    let calls = 0;
    let observerCalls = 0;
    const observerSignals: AbortSignal[] = [];
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let pending: ReturnType<typeof syncXydcOrderFamilies> | undefined;
    try {
      if (mode.startsWith("cached")) await syncXydcOrderFamilies({ families: [target], token: "fixture-token", now: fixtureNow, dataRoot: fixture.root,
        callTool: async () => fixtureOrders("B0CHILD001"),
      }, fast);
      pending = syncXydcOrderFamilies({ families: [target], token: "fixture-token", now: fixtureNow, dataRoot: fixture.root, env: fixture.env, signal: controller.signal,
        ...(mode === "after-child" || mode === "terminal" ? { callTool: async ({ args }: { args: Record<string, unknown> }) => { calls++; return fixtureOrders(args.asin as string); } } : {}),
        onProgress: (facts, context) => {
          observerCalls++; observerSignals.push(context.signal);
          const match = mode.endsWith("queued") ? facts.state === "queued"
            : mode.endsWith("terminal") ? facts.state === "completed"
              : facts.state === "collecting" && (mode !== "after-child" || facts.children.some(child => child.state === "ready"));
          if (match) { entered(); return suspended; }
        },
      }, { ...fast, wallNow: () => fixtureNow });
      await observed; controller.abort();
      const result = await Promise.race([pending, new Promise<never>((_, reject) => { watchdog = setTimeout(() => reject(new Error("observer ignored cancellation")), 300); })]);
      assert.equal(fixture.requests.length, 0);
      if (mode === "after-child") { assert.equal(calls, 1); assert.equal(result[0]?.children[0]?.trends.length, 12); assert.equal(result[0]?.reasonCode, "CANCELLED"); }
      else if (mode === "terminal" || mode.startsWith("cached")) assert.equal(result[0]?.children[0]?.trends.length, 12);
      else assert.equal(result[0]?.reasonCode, "CANCELLED");
      const saved = await readXydcOrderSnapshot(fixture.root, target, getXydcOrderWindow(fixtureNow));
      assert.equal(observerSignals.at(-1)?.aborted, true);
      const stoppedAt = observerCalls;
      resume(); await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(observerCalls, stoppedAt);
      assert.deepEqual(await readXydcOrderSnapshot(fixture.root, target, getXydcOrderWindow(fixtureNow)), saved);
    } finally { resume(); controller.abort(); if (watchdog) clearTimeout(watchdog); await pending; await fixture.close(); }
  });
}

for (const mode of ["queued", "after-child", "terminal", "cached-terminal"] as const) {
  test(`phase deadline bounds a hung ${mode} observer with BUDGET_EXHAUSTED`, async () => {
    const fixture = await httpFixture();
    const target = fixtureFamily(mode === "after-child" ? undefined : ["B0CHILD001"]);
    let resume!: () => void;
    const suspended = new Promise<void>(resolve => { resume = resolve; });
    let calls = 0;
    let observed = false;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let pending: ReturnType<typeof syncXydcOrderFamilies> | undefined;
    try {
      if (mode.startsWith("cached")) await syncXydcOrderFamilies({ families: [target], token: "fixture-token", now: fixtureNow, dataRoot: fixture.root,
        callTool: async () => fixtureOrders("B0CHILD001"),
      }, fast);
      pending = syncXydcOrderFamilies({ families: [target], token: "fixture-token", now: fixtureNow, dataRoot: fixture.root, env: fixture.env,
        ...(mode === "cached-terminal" ? {} : { callTool: async ({ args }: { args: Record<string, unknown> }) => { calls++; return fixtureOrders(args.asin as string); } }),
        onProgress: facts => {
          const match = mode === "queued" ? facts.state === "queued" : mode.endsWith("terminal") ? facts.state === "completed"
            : facts.state === "collecting" && facts.children.some(child => child.state === "ready");
          if (match) { observed = true; return suspended; }
        },
      }, { ...fast, wallNow: () => fixtureNow, phaseBudgetMs: mode === "after-child" ? 2_500 : 100 });
      const result = await Promise.race([pending, new Promise<never>((_, reject) => { watchdog = setTimeout(() => reject(new Error("observer ignored phase deadline")), mode === "after-child" ? 3_000 : 400); })]);
      assert.equal(observed, true);
      assert.equal(fixture.requests.length, 0);
      if (mode === "queued") { assert.equal(calls, 0); assert.equal(result[0]?.reasonCode, "BUDGET_EXHAUSTED"); }
      if (mode === "after-child") { assert.equal(calls, 1); assert.equal(result[0]?.children[0]?.trends.length, 12); assert.equal(result[0]?.reasonCode, "BUDGET_EXHAUSTED"); }
      if (mode.endsWith("terminal")) assert.equal(result[0]?.children[0]?.trends.length, 12);
    } finally { resume(); if (watchdog) clearTimeout(watchdog); await pending; await fixture.close(); }
  });
}
