import assert from "node:assert/strict";
import test from "node:test";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { callXydcTool, withXydcSession, XydcProviderError } from "../../scripts/lib/xydc-mcp-client";
import { acquireXydcCoordination } from "../../scripts/lib/xydc-request-coordination";
import { syncXydcOrderFamilies } from "../../scripts/lib/xydc-order-sync";
import { fixtureFamily, fixtureNow, fixtureOrders, httpFixture } from "../helpers/xydc-http-fixture";

test("real collector initializes once and spaces every actual HTTP by two seconds", async () => {
  const fixture = await httpFixture();
  const old = process.env.XYDC_MCP_URL;
  process.env.XYDC_MCP_URL = fixture.env.XYDC_MCP_URL;
  try {
    const result = await syncXydcOrderFamilies({ families: [fixtureFamily()], token: "fixture-token", now: fixtureNow,
      dataRoot: fixture.root, ...{ env: fixture.env } });
    assert.equal(result[0]?.reasonCode, null);
    assert.equal(fixture.requests.filter(request => request.rpc === "initialize").length, 1);
    assert.ok(fixture.requests.slice(1).every((request, i) => request.at - fixture.requests[i]!.at >= 1995), JSON.stringify(fixture.requests));
    assert.equal(fixture.requests.filter(request => request.rpc === "tools/call").length, 2);
  } finally { if (old === undefined) delete process.env.XYDC_MCP_URL; else process.env.XYDC_MCP_URL = old; await fixture.close(); }
});

test("successful injected request keeps its signal live after completion", async () => {
  const fixture = await httpFixture();
  let signal: AbortSignal | undefined;
  try {
    await syncXydcOrderFamilies({ families: [fixtureFamily(["B0CHILD001"])], token: "fixture-token", now: fixtureNow, dataRoot: fixture.root,
      callTool: async input => { signal = input.signal; return fixtureOrders("B0CHILD001"); } });
    assert.equal(signal?.aborted, false);
  } finally { await fixture.close(); }
});

test("long Retry-After, date, missing hints and unrepresentable waits retain safe metadata", async () => {
  for (const [hint, expected] of [["120", 120_000], ["9".repeat(400), undefined]] as const) {
    await assert.rejects(callXydcTool("fixture-token", "get_asin_info", {}, {
      callTool: async () => { throw { code: 429, retryAfter: hint }; },
    }), error => error instanceof XydcProviderError && error.reasonCode === "RATE_LIMITED"
      && error.retryAfterMs === expected && (expected !== undefined || error.retryAfterUnbounded === true));
  }
  const future = new Date(Date.now() + 120_000).toUTCString();
  await assert.rejects(callXydcTool("fixture-token", "get_asin_info", {}, { callTool: async () => { throw { code: 429, retryAfter: future }; } }),
    error => error instanceof XydcProviderError && error.retryAfterMs! >= 119_000 && error.retryAfterMs! <= 120_000);
});

test("coordination honors durable cooldown, authority after waiting, fail closed corruption and credential isolation", async () => {
  const fixture = await httpFixture();
  let now = Date.now();
  let guard = 0;
  const waits: number[] = [];
  const options = { env: fixture.env, signal: new AbortController().signal, remaining: () => 300_000,
    wallNow: () => now, delay: async (ms: number) => { waits.push(ms); now += ms; }, beforeRequest: async () => { guard = now; } };
  try {
    const first = await acquireXydcCoordination(" fixture-token ", new URL(fixture.env.XYDC_MCP_URL), options);
    await first.rateLimited(new XydcProviderError("RATE_LIMITED", { retryAfterMs: 120_000 }));
    await first.release();
    const second = await acquireXydcCoordination("fixture-token", new URL(fixture.env.XYDC_MCP_URL), options);
    await second.dispatch(() => {}); await second.release();
    assert.deepEqual(waits, [120_000]); assert.equal(guard, now);
    const other = await acquireXydcCoordination("another-fixture-token", new URL(fixture.env.XYDC_MCP_URL), options);
    await other.dispatch(() => {}); await other.release(); assert.deepEqual(waits, [120_000]);
    const files = (await readdir(fixture.env.XYDC_COORDINATION_ROOT)).filter(file => file.endsWith(".json"));
    for (const file of files) {
      const serialized = await readFile(path.join(fixture.env.XYDC_COORDINATION_ROOT, file), "utf8");
      assert.equal(serialized.includes("fixture-token"), false); assert.equal(serialized.includes("fixture-session"), false);
      await writeFile(path.join(fixture.env.XYDC_COORDINATION_ROOT, file), "corrupt");
    }
    await assert.rejects(callXydcTool("fixture-token", "get_asin_info", {}, { env: fixture.env }), /RPC_ERROR/);
    assert.equal(fixture.requests.length, 0);
  } finally { await fixture.close(); }
});

test("cooldown fallback doubles and never sends ahead of a budget or an unrepresentable wait", async () => {
  const fixture = await httpFixture();
  const now = Date.now();
  try {
    const first = await acquireXydcCoordination("fixture-token", new URL(fixture.env.XYDC_MCP_URL), {
      env: fixture.env, signal: new AbortController().signal, remaining: () => 1_000, wallNow: () => now,
      delay: async () => { assert.fail("must not sleep beyond budget"); },
    });
    assert.equal(await first.rateLimited(new XydcProviderError("RATE_LIMITED")), now + 30_000);
    assert.equal(await first.rateLimited(new XydcProviderError("RATE_LIMITED")), now + 60_000);
    await assert.rejects(first.dispatch(() => {}), /BUDGET_EXHAUSTED/);
    await first.rateLimited(new XydcProviderError("RATE_LIMITED", { retryAfterUnbounded: true }));
    await first.release();
    await assert.rejects(callXydcTool("fixture-token", "get_asin_info", {}, { env: fixture.env }), /BUDGET_EXHAUSTED/);
    assert.equal(fixture.requests.length, 0);
  } finally { await fixture.close(); }
});

test("real initialize cancellation closes connection and a later scope can acquire the credential", async () => {
  let disconnected!: () => void;
  const disconnectedPromise = new Promise<void>(resolve => { disconnected = resolve; });
  const controller = new AbortController();
  const fixture = await httpFixture((body, req, res) => {
    if (body.method !== "initialize") return false;
    res.on("close", disconnected); controller.abort(); return true;
  });
  try {
    await assert.rejects(callXydcTool("fixture-token", "get_asin_info", {}, { env: fixture.env, signal: controller.signal }), /CANCELLED/);
    await disconnectedPromise;
    await withXydcSession("fixture-token", async () => {}, { env: fixture.env });
    assert.equal(fixture.requests.length, 1);
  } finally { await fixture.close(); }
});

test("cancel while waiting for a credential or pacing gate never emits HTTP", async () => {
  const fixture = await httpFixture();
  const holding = await acquireXydcCoordination("fixture-token", new URL(fixture.env.XYDC_MCP_URL), {
    env: fixture.env, signal: new AbortController().signal, remaining: () => 10_000,
  });
  const controller = new AbortController();
  try {
    const waiting = callXydcTool("fixture-token", "get_asin_info", {}, { env: fixture.env, signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(waiting, /CANCELLED/); await holding.release();
    const cooldown = await acquireXydcCoordination("fixture-token", new URL(fixture.env.XYDC_MCP_URL), {
      env: fixture.env, signal: new AbortController().signal, remaining: () => 10_000,
    });
    await cooldown.rateLimited(new XydcProviderError("RATE_LIMITED", { retryAfterMs: 2_000 })); await cooldown.release();
    const paced = new AbortController();
    const pending = callXydcTool("fixture-token", "get_asin_info", {}, { env: fixture.env, signal: paced.signal });
    setTimeout(() => paced.abort(), 50);
    await assert.rejects(pending, /CANCELLED/); assert.equal(fixture.requests.length, 0);
  } finally { await holding.release(); await fixture.close(); }
});

test("async authority rejected after real pacing prevents the next HTTP", async () => {
  const fixture = await httpFixture();
  let authorized = true;
  let guards = 0;
  try {
    await assert.rejects(withXydcSession("fixture-token", session => session.callTool("get_asin_info", {}), {
      env: fixture.env, beforeRequest: async () => {
        guards++; if (!authorized) throw new Error("fixture authority revoked");
        setTimeout(() => { authorized = false; }, 100);
      },
    }), /RPC_ERROR/);
    assert.equal(guards, 2); assert.equal(fixture.requests.length, 1);
  } finally { await fixture.close(); }
});

function childProcess(fixture: Awaited<ReturnType<typeof httpFixture>>, token: string, mode = "call") {
  const child = spawn(process.execPath, ["--import", "tsx", "--conditions=react-server", "tests/helpers/xydc-session-process.ts", mode], {
    cwd: process.cwd(), env: { ...process.env, ...fixture.env, XYDC_FIXTURE_TOKEN: token, XYDC_FIXTURE_DATA_ROOT: fixture.root }, stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    let output = ""; child.stdout.on("data", data => { output += data; }); child.stderr.on("data", data => { output += data; });
    child.on("error", reject); child.on("close", code => resolve({ code, output }));
  });
}

test("same credential batches in two processes do not overlap and cooldown survives process exit", async () => {
  const fixture = await httpFixture((body, _req, res) => {
    if (body.method === "tools/call") { res.writeHead(429, { "Retry-After": "120" }).end(); return true; }
    return false;
  });
  try {
    const results = await Promise.all([childProcess(fixture, "fixture-token"), childProcess(fixture, "fixture-token")]);
    assert.ok(results.every(result => result.code === 0), JSON.stringify(results));
    assert.equal(fixture.requests.filter(request => request.rpc === "initialize").length, 1);
    assert.equal(fixture.requests.filter(request => request.rpc === "tools/call").length, 1);
    assert.ok(results.some(result => result.output.includes("RATE_LIMITED")));
    assert.ok(results.some(result => result.output.includes("BUDGET_EXHAUSTED")));
    const third = await childProcess(fixture, "fixture-token");
    assert.equal(third.code, 0); assert.match(third.output, /BUDGET_EXHAUSTED/);
    assert.equal(fixture.requests.length, 4);
  } finally { await fixture.close(); }
});

test("slow reservation writes cannot bunch actual dispatch and concurrent cooldown cannot regress", async t => {
  const fixture = await httpFixture();
  let wall = Date.now();
  const original = fs.rename;
  let renames = 0;
  t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    renames++;
    if (renames === 1) { wall += 3_000; await new Promise(resolve => setTimeout(resolve, 30)); }
    return original(...args);
  });
  const coordination = await acquireXydcCoordination("fixture-token", new URL(fixture.env.XYDC_MCP_URL), {
    env: fixture.env, signal: new AbortController().signal, remaining: () => 300_000, wallNow: () => wall,
    delay: async ms => { wall += ms; },
  });
  try {
    const starts: number[] = [];
    const send = () => coordination.dispatch(() => { starts.push(wall); });
    await Promise.all([send(), send()]);
    assert.ok(starts[1]! - starts[0]! >= 2_000, JSON.stringify(starts));
    const cooldown = coordination.rateLimited(new XydcProviderError("RATE_LIMITED", { retryAfterMs: 120_000 }));
    await coordination.release();
    await cooldown;
    const files = (await readdir(fixture.env.XYDC_COORDINATION_ROOT)).filter(file => file.endsWith(".json"));
    const saved = JSON.parse(await readFile(path.join(fixture.env.XYDC_COORDINATION_ROOT, files[0]!), "utf8"));
    assert.ok(saved.cooldownUntil >= wall + 120_000);
  } finally { await coordination.release(); t.mock.restoreAll(); await fixture.close(); }
});

test("pending GET headers retain their fifteen second timeout after a tool succeeds", async () => {
  const fixture = await httpFixture((_body, req) => req.method === "GET");
  let wall = Date.now();
  let businessCompleted = false;
  let finish: ReturnType<typeof setTimeout> | undefined;
  try {
    await assert.rejects(withXydcSession("fixture-token", async session => {
      await session.callTool("get_asin_info", {}); businessCompleted = true;
      await new Promise<void>(resolve => { finish = setTimeout(resolve, 16_000); });
    }, { env: fixture.env, timeoutMs: 25_000, wallNow: () => wall, delay: async ms => { wall += ms; } }), /TIMEOUT/);
    assert.equal(businessCompleted, true);
    assert.equal(fixture.requests.filter(request => request.rpc === "tools/call").length, 1);
  } finally { if (finish) clearTimeout(finish); await fixture.close(); }
});

test("established GET stream survives fifteen seconds and successful tools send no late cancel", async () => {
  const fixture = await httpFixture((_body, req, res) => {
    if (req.method !== "GET") return false;
    res.writeHead(200, { "Content-Type": "text/event-stream" }); res.flushHeaders(); res.write(": fixture keepalive\n\n"); return true;
  });
  let wall = Date.now();
  try {
    await withXydcSession("fixture-token", async session => {
      await session.callTool("get_asin_info", {});
      await new Promise(resolve => setTimeout(resolve, 15_100));
      await session.callTool("get_asin_info", {});
    }, { env: fixture.env, timeoutMs: 25_000, wallNow: () => wall, delay: async ms => { wall += ms; } });
    assert.equal(fixture.requests.filter(request => request.rpc === "notifications/cancelled").length, 0);
    assert.equal(fixture.requests.filter(request => request.rpc === "tools/call").length, 2);
    assert.equal(fixture.requests.filter(request => request.method === "GET").length, 1);
  } finally { await fixture.close(); }
});

test("business cancellation and unknown HTTP results close actual sockets without replay", async () => {
  for (const mode of ["cancel", "disconnect", "initialize-failure"]) {
    const controller = new AbortController();
    let wall = Date.now();
    const fixture = await httpFixture((body, req, res) => {
      if (mode === "initialize-failure" && body.method === "initialize") { res.writeHead(500).end(); return true; }
      if (body.method !== "tools/call") return false;
      if (mode === "cancel") controller.abort(); else req.socket.destroy();
      return true;
    });
    try {
      await assert.rejects(withXydcSession("fixture-token", session => session.callTool("get_asin_info", {}), {
        env: fixture.env, signal: controller.signal, wallNow: () => wall, delay: async ms => { wall += ms; },
      }), mode === "cancel" ? /CANCELLED/ : /RPC_ERROR/);
      await withXydcSession("fixture-token", async () => {}, { env: fixture.env });
      assert.equal(fixture.requests.filter(request => request.rpc === "initialize").length, 1);
      assert.equal(fixture.requests.filter(request => request.rpc === "tools/call").length, mode === "initialize-failure" ? 0 : 1);
    } finally { await fixture.close(); }
  }
});

test("different credentials keep sessions and Authorization headers independent", async () => {
  const fixture = await httpFixture();
  let wall = Date.now();
  try {
    await Promise.all(["fixture-one", "fixture-two"].map(token => withXydcSession(token, session => session.callTool("get_asin_info", {}), {
      env: fixture.env, wallNow: () => wall, delay: async ms => { wall += ms; },
    })));
    for (const token of ["fixture-one", "fixture-two"]) {
      const requests = fixture.requests.filter(request => request.authorization === `Bearer ${token}`);
      assert.equal(requests.filter(request => request.rpc === "initialize").length, 1);
      assert.equal(requests.filter(request => request.rpc === "tools/call").length, 1);
    }
  } finally { await fixture.close(); }
});

test("queued collectors recheck under the credential lock and a complete cache needs zero HTTP or coordination config", async () => {
  const fixture = await httpFixture();
  try {
    const results = await Promise.all([childProcess(fixture, "fixture-token", "collect"), childProcess(fixture, "fixture-token", "collect")]);
    assert.ok(results.every(result => result.code === 0 && result.output.includes("completed")), JSON.stringify(results));
    assert.equal(fixture.requests.filter(request => request.rpc === "initialize").length, 1);
    assert.equal(fixture.requests.filter(request => request.rpc === "tools/call").length, 2);
    const count = fixture.requests.length;
    const result = await syncXydcOrderFamilies({ families: [fixtureFamily()], token: "", now: fixtureNow, dataRoot: fixture.root, env: { NODE_ENV: "test" } });
    assert.equal(result[0]?.reasonCode, null); assert.equal(fixture.requests.length, count);
  } finally { await fixture.close(); }
});

test("a process dying after its first successful child resumes only the unfinished child", async () => {
  const fixture = await httpFixture();
  try {
    const crashed = await childProcess(fixture, "fixture-token", "crash-after-child");
    assert.equal(crashed.code, 0, crashed.output);
    assert.equal(fixture.requests.filter(request => request.rpc === "tools/call").length, 1);
    const resumed = await childProcess(fixture, "fixture-token", "collect");
    assert.equal(resumed.code, 0, resumed.output);
    assert.equal(fixture.requests.filter(request => request.rpc === "tools/call").length, 2);
  } finally { await fixture.close(); }
});

test("a nonresponsive async authority callback cannot hold the scope beyond its budget", async () => {
  const fixture = await httpFixture();
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    // Warm the shared process identity lookup before measuring the short scope budget.
    await withXydcSession("fixture-token", async () => {}, { env: fixture.env });
    await assert.rejects(Promise.race([
      callXydcTool("fixture-token", "get_asin_info", {}, { env: fixture.env, timeoutMs: 100, beforeRequest: async () => new Promise<void>(() => {}) }),
      new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error("fixture scope hung")), 500); }),
    ]), /TIMEOUT/);
    assert.equal(fixture.requests.length, 0);
  } finally { if (watchdog) clearTimeout(watchdog); await fixture.close(); }
});

test("a hung business response has its own fifteen second deadline after another concurrent scope call succeeds", async () => {
  let calls = 0;
  let ended!: () => void;
  const disconnected = new Promise<void>(resolve => { ended = resolve; });
  const fixture = await httpFixture((body, _req, res) => {
    if (body.method !== "tools/call" || ++calls === 1) return false;
    res.on("close", ended);
    res.writeHead(200, { "Content-Type": "text/event-stream" }); res.flushHeaders(); return true;
  });
  let wall = Date.now();
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    await assert.rejects(withXydcSession("fixture-token", session => Promise.all([
      session.callTool("get_asin_info", {}), session.callTool("get_asin_info", {}),
    ]), { env: fixture.env, timeoutMs: 25_000, wallNow: () => wall, delay: async ms => { wall += ms; } }), /TIMEOUT/);
    await Promise.race([disconnected, new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error("fixture business socket did not close")), 1_000); })]);
    assert.equal(calls, 2);
    assert.equal(fixture.requests.filter(request => request.rpc === "notifications/cancelled").length, 0);
  } finally { if (watchdog) clearTimeout(watchdog); await fixture.close(); }
});

test("native fetch abort closes the fixture business SSE response", async () => {
  let ended!: () => void;
  const disconnected = new Promise<void>(resolve => { ended = resolve; });
  const fixture = await httpFixture((_body, _req, res) => {
    res.on("close", ended); res.writeHead(200, { "Content-Type": "text/event-stream" }); res.flushHeaders(); return true;
  });
  const controller = new AbortController();
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await fetch(fixture.env.XYDC_MCP_URL, { method: "POST", body: JSON.stringify({ method: "tools/call" }), signal: controller.signal });
    const reading = response.body!.pipeThrough(new TextDecoderStream()).getReader().read();
    controller.abort(new XydcProviderError("TIMEOUT"));
    await assert.rejects(reading);
    await Promise.race([disconnected, new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error("native socket did not close")), 1_000); })]);
  } finally { if (watchdog) clearTimeout(watchdog); await fixture.close(); }
});

test("a completed child is durable before the next business request finishes", async () => {
  const fixture = await httpFixture();
  let savedBeforeSecond = false;
  try {
    await syncXydcOrderFamilies({ families: [fixtureFamily()], token: "fixture-token", now: fixtureNow, dataRoot: fixture.root,
      callTool: async ({ args }) => {
        if (args.asin === "B0CHILD002") {
          const files = await readdir(fixture.root, { recursive: true });
          savedBeforeSecond = files.some(file => file.endsWith(".checkpoint.json"));
          throw new Error("interrupted fixture");
        }
        return fixtureOrders(args.asin as string);
      },
    }, { delay: async () => {}, timeout: async () => new Promise<never>(() => {}) });
    assert.equal(savedBeforeSecond, true);
    const calls: string[] = [];
    await syncXydcOrderFamilies({ families: [fixtureFamily()], token: "fixture-token", now: fixtureNow, dataRoot: fixture.root,
      callTool: async ({ args }) => { calls.push(args.asin as string); return fixtureOrders(args.asin as string); },
    });
    assert.deepEqual(calls, ["B0CHILD002"]);
  } finally { await fixture.close(); }
});

test("real requests fail closed without an absolute coordination root", async () => {
  const fixture = await httpFixture();
  try {
    await assert.rejects(callXydcTool("fixture-token", "get_asin_info", {}, { env: { NODE_ENV: "test", XYDC_MCP_URL: fixture.env.XYDC_MCP_URL } }), /NOT_CONFIGURED/);
    const file = path.join(fixture.root, "invalid-root-file");
    await writeFile(file, "fixture");
    for (const root of ["relative-path", file]) {
      await assert.rejects(callXydcTool("fixture-token", "get_asin_info", {}, { env: { ...fixture.env, XYDC_COORDINATION_ROOT: root } }), /NOT_CONFIGURED/);
    }
    assert.equal(fixture.requests.length, 0);
  } finally { await fixture.close(); }
});
