import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";

import {
  callSellerSpriteMcpTool,
  requestSellerSpriteMcp,
} from "../../scripts/lib/sellersprite-mcp-client.mjs";
import { ConnectorError } from "../../server/connectors/connector-contract";
import { createSellerSpriteConnector } from "../../server/connectors/mcp-connectors";
import { McpTransportError } from "../../server/connectors/mcp-transport.mjs";
import { createRemoteMcpConnector } from "../../server/connectors/remote-mcp-connector";
import { startFakeSellerSpriteMcpServer } from "./helpers/fake-sellersprite-mcp-server";

test("SellerSprite lists tools through an initialized MCP session", async (t) => {
  const fake = await startFakeSellerSpriteMcpServer();
  t.after(async () => fake.close());
  const requestBodies: string[] = [];

  const result = await requestSellerSpriteMcp("fake-secret", "tools/list", {}, {
    fetchImpl: async (input, init) => {
      requestBodies.push(typeof init?.body === "string" ? init.body : "");
      return await fetch(input, init);
    },
    env: {
      NODE_ENV: "test",
      SELLERSPRITE_MCP_ENDPOINT: fake.url,
    },
  });

  assert.equal(Array.isArray(result.tools), true);
  assert.deepEqual(fake.requests.map((request) => request.method), [
    "initialize",
    "notifications/initialized",
    "tools/list",
  ]);
  assert.equal(fake.requests.filter((request) => request.method === "tools/call").length, 0);
  assert.doesNotMatch(requestBodies.join("\n"), /\basin\b|B0[A-Z0-9]{8}/i);
  assert.equal(fake.requests[2]?.hasSession, true);
  assert.equal(fake.requests[2]?.hasProtocolVersion, true);
});

test("SellerSprite calls one tool through an initialized MCP session", async (t) => {
  const fake = await startFakeSellerSpriteMcpServer();
  t.after(async () => fake.close());

  const result = await callSellerSpriteMcpTool("fake-secret", "review", {
    asin: "B000000000",
  }, {
    env: {
      NODE_ENV: "test",
      SELLERSPRITE_MCP_ENDPOINT: fake.url,
    },
  });

  assert.deepEqual(result, { accepted: true });
  assert.deepEqual(fake.requests.map(request => request.method), [
    "initialize",
    "notifications/initialized",
    "tools/call",
  ]);
  assert.equal(fake.requests.filter(request => request.method === "tools/call").length, 1);
  assert.equal(fake.requests[2]?.hasSession, true);
  assert.equal(fake.requests[2]?.hasProtocolVersion, true);
});

test("SellerSprite initialize HTTP failure is safe and starts no operation", async (t) => {
  const fake = await startFakeSellerSpriteMcpServer({ mode: "initialize-http-error" });
  const closeCount = trackClientClose(t);
  t.after(async () => fake.close());

  const error = await captureTransportError(requestSellerSpriteMcp(
    "fake-secret",
    "tools/list",
    {},
    {
      env: {
        NODE_ENV: "test",
        SELLERSPRITE_MCP_ENDPOINT: fake.url,
      },
    },
  ));

  assert.equal(error.kind, "http");
  assert.equal(error.status, 400);
  assert.equal(closeCount(), 1);
  assert.deepEqual(fake.requests.map(request => request.method), ["initialize"]);
  assert.doesNotMatch(JSON.stringify(error), /fake-secret|raw-provider-body-sentinel|fake-session|127\.0\.0\.1/i);
});

test("SellerSprite total deadline aborts a hanging initialize safely", async (t) => {
  const fake = await startFakeSellerSpriteMcpServer({ mode: "initialize-hang" });
  const closeCount = trackClientClose(t);
  t.after(async () => fake.close());
  const startedAt = Date.now();

  const error = await captureTransportError(requestSellerSpriteMcp(
    "fake-secret",
    "tools/list",
    {},
    {
      timeoutMs: 40,
      env: {
        NODE_ENV: "test",
        SELLERSPRITE_MCP_ENDPOINT: fake.url,
      },
    },
  ));

  assert.equal(error.kind, "timeout");
  assert.equal(error.status, null);
  assert.equal(closeCount(), 1);
  assert.ok(Date.now() - startedAt < 500);
  assert.deepEqual(fake.requests.map(request => request.method), ["initialize"]);
});

test("SellerSprite parent abort during initialize closes exactly once", async (t) => {
  const fake = await startFakeSellerSpriteMcpServer({ mode: "initialize-hang" });
  const controller = new AbortController();
  const closeCount = trackClientClose(t);
  t.after(async () => fake.close());

  const pending = requestSellerSpriteMcp("fake-secret", "tools/list", {}, {
    signal: controller.signal,
    timeoutMs: 1_000,
    env: {
      NODE_ENV: "test",
      SELLERSPRITE_MCP_ENDPOINT: fake.url,
    },
  });
  await fake.waitForRequest("initialize");
  controller.abort();
  const error = await captureTransportError(pending);

  assert.equal(error.kind, "timeout");
  assert.equal(closeCount(), 1);
  assert.deepEqual(fake.requests.map(request => request.method), ["initialize"]);
});

test("SellerSprite parent abort stops a hanging operation safely", async (t) => {
  const fake = await startFakeSellerSpriteMcpServer({ mode: "operation-hang" });
  const controller = new AbortController();
  const closeCount = trackClientClose(t);
  t.after(async () => fake.close());

  const pending = requestSellerSpriteMcp("fake-secret", "tools/list", {}, {
    signal: controller.signal,
    timeoutMs: 1_000,
    env: {
      NODE_ENV: "test",
      SELLERSPRITE_MCP_ENDPOINT: fake.url,
    },
  });
  await fake.waitForRequest("tools/list");
  controller.abort();
  const error = await captureTransportError(pending);

  assert.equal(error.kind, "timeout");
  assert.equal(closeCount(), 1);
  assert.deepEqual(fake.requests.map(request => request.method), [
    "initialize",
    "notifications/initialized",
    "tools/list",
  ]);
});

test("SellerSprite malformed negotiation is projected safely", async (t) => {
  const fake = await startFakeSellerSpriteMcpServer({ mode: "initialize-malformed" });
  const closeCount = trackClientClose(t);
  t.after(async () => fake.close());

  const error = await captureTransportError(requestSellerSpriteMcp(
    "fake-secret",
    "tools/list",
    {},
    {
      env: {
        NODE_ENV: "test",
        SELLERSPRITE_MCP_ENDPOINT: fake.url,
      },
    },
  ));

  assert.equal(error.kind, "malformed");
  assert.equal(closeCount(), 1);
  assert.deepEqual(fake.requests.map(request => request.method), ["initialize"]);
});

test("SellerSprite initialized notification failure closes exactly once", async (t) => {
  const fake = await startFakeSellerSpriteMcpServer({ mode: "initialized-http-error" });
  const closeCount = trackClientClose(t);
  t.after(async () => fake.close());

  const error = await captureTransportError(requestSellerSpriteMcp(
    "fake-secret",
    "tools/list",
    {},
    {
      env: {
        NODE_ENV: "test",
        SELLERSPRITE_MCP_ENDPOINT: fake.url,
      },
    },
  ));

  assert.equal(error.kind, "http");
  assert.equal(error.status, 400);
  assert.equal(closeCount(), 1);
  assert.deepEqual(fake.requests.map(request => request.method), [
    "initialize",
    "notifications/initialized",
  ]);
});

test("SellerSprite malformed operation result is projected safely", async (t) => {
  const fake = await startFakeSellerSpriteMcpServer({ mode: "operation-malformed" });
  const closeCount = trackClientClose(t);
  t.after(async () => fake.close());

  const error = await captureTransportError(requestSellerSpriteMcp(
    "fake-secret",
    "tools/list",
    {},
    {
      env: {
        NODE_ENV: "test",
        SELLERSPRITE_MCP_ENDPOINT: fake.url,
      },
    },
  ));

  assert.equal(error.kind, "malformed");
  assert.equal(closeCount(), 1);
  assert.deepEqual(fake.requests.map(request => request.method), [
    "initialize",
    "notifications/initialized",
    "tools/list",
  ]);
  assert.equal(fake.requests.filter(request => request.method === "tools/list").length, 1);
});

test("SellerSprite closes exactly once within the bound and sends nothing after close", async (t) => {
  const fake = await startFakeSellerSpriteMcpServer();
  const originalClose = Client.prototype.close;
  let closeCalls = 0;
  let closeStarted = false;
  let postCloseFetches = 0;
  const fetchMethods: string[] = [];
  const redirects: Array<RequestRedirect | undefined> = [];
  Client.prototype.close = async function () {
    closeCalls += 1;
    closeStarted = true;
    await originalClose.call(this);
    await new Promise(() => undefined);
  };
  t.after(async () => {
    Client.prototype.close = originalClose;
    await fake.close();
  });

  const startedAt = Date.now();
  const result = await requestSellerSpriteMcp("fake-secret", "tools/list", {}, {
    fetchImpl: async (input, init) => {
      if (closeStarted) postCloseFetches += 1;
      fetchMethods.push(init?.method ?? "GET");
      redirects.push(init?.redirect);
      return await fetch(input, init);
    },
    env: {
      NODE_ENV: "test",
      SELLERSPRITE_MCP_ENDPOINT: fake.url,
    },
  });
  const elapsedMs = Date.now() - startedAt;
  const requestCountAtReturn = fake.requests.length;
  await new Promise(resolve => setTimeout(resolve, 50));

  assert.equal(Array.isArray(result.tools), true);
  assert.equal(closeCalls, 1);
  assert.ok(elapsedMs >= 200 && elapsedMs < 750);
  assert.equal(postCloseFetches, 0);
  assert.equal(fake.requests.length, requestCountAtReturn);
  assert.deepEqual(fetchMethods, ["POST", "POST", "GET", "POST"]);
  assert.deepEqual(fake.dispatchMethods, ["POST", "POST", "GET", "POST"]);
  assert.equal(fetchMethods.includes("DELETE"), false);
  assert.equal(redirects.every(redirect => redirect === "error"), true);
});

test("SellerSprite client close aborts the optional SSE GET", async (t) => {
  const fake = await startFakeSellerSpriteMcpServer({ mode: "get-hang" });
  t.after(async () => fake.close());

  const result = await requestSellerSpriteMcp("fake-secret", "tools/list", {}, {
    env: {
      NODE_ENV: "test",
      SELLERSPRITE_MCP_ENDPOINT: fake.url,
    },
  });
  await fake.waitForGetClose();

  assert.equal(Array.isArray(result.tools), true);
  assert.deepEqual(fake.requests.map(request => request.method), [
    "initialize",
    "notifications/initialized",
    "tools/list",
  ]);
  assert.deepEqual(fake.dispatchMethods, ["POST", "POST", "GET", "POST"]);
});

test("SellerSprite structural timeout maps to the fixed connector timeout", async () => {
  const connector = createRemoteMcpConnector({
    id: "sellerSprite",
    resolveCredential: async () => "fake-secret",
    transport: async () => {
      throw new McpTransportError("timeout");
    },
    probeTransport: async () => ({ tools: [] }),
    clock: () => new Date("2026-08-24T00:00:00.000Z"),
    sleep: async () => undefined,
    policy: {
      timeoutMs: 1_000,
      maxAttempts: 1,
      retryDelayMs: 0,
      maxConcurrent: 1,
      maxQueue: 0,
    },
  });

  await assert.rejects(
    connector.execute({ operation: "review", input: {} }),
    (error: unknown) => {
      assert.ok(error instanceof ConnectorError);
      assert.equal(error.code, "timeout");
      assert.equal(error.retryable, true);
      return true;
    },
  );
});

test("SellerSprite execution boundaries map safe HTTP errors and retry from a fresh session", async (t) => {
  const expected = [
    [400, "upstream-permanent", false], [401, "authentication", false],
    [403, "authentication", false], [429, "rate-limit", true],
    [503, "upstream-temporary", true],
  ] as const;

  for (const [status, code, retryable] of expected) {
    const fake = await startFakeSellerSpriteMcpServer();
    const methods: string[] = [];
    const redirects: Array<RequestRedirect | undefined> = [];
    const connector = createSellerSpriteConnector({
      env: {
        NODE_ENV: "test",
        SELLERSPRITE_MCP_ENDPOINT: fake.url,
        SELLERSPRITE_SECRET_KEY: "fake-secret",
      },
      fetchImpl: async (_input, init) => {
        methods.push(JSON.parse(String(init?.body ?? "{}")).method);
        redirects.push(init?.redirect);
        return new Response("raw-provider-body-sentinel", { status });
      },
      clock: () => new Date("2026-08-24T00:00:00.000Z"),
      sleep: async () => undefined,
      policy: {
        timeoutMs: 1_000,
        maxAttempts: 1,
        retryDelayMs: 0,
        maxConcurrent: 1,
        maxQueue: 0,
      },
    });
    t.after(async () => fake.close());

    await assert.rejects(
      connector.execute({ operation: "review", input: { asin: "B000000000" } }),
      (error: unknown) => {
        assert.ok(error instanceof ConnectorError);
        assert.equal(error.code, code);
        assert.equal(error.retryable, retryable);
        assert.doesNotMatch(
          JSON.stringify(error),
          /fake-secret|raw-provider-body-sentinel|fake-session/i,
        );
        return true;
      },
    );
    assert.deepEqual(methods, ["initialize"]);
    assert.deepEqual(fake.requests, []);
    assert.equal(redirects.every((redirect) => redirect === "error"), true);
  }

  const fake = await startFakeSellerSpriteMcpServer();
  const methods: string[] = [];
  const sessionHeaders: Array<string | null> = [];
  const dispatchMethods: string[] = [];
  const redirects: Array<RequestRedirect | undefined> = [];
  let initializeAttempts = 0;
  t.after(async () => fake.close());
  const connector = createSellerSpriteConnector({
    env: {
      NODE_ENV: "test",
      SELLERSPRITE_MCP_ENDPOINT: fake.url,
      SELLERSPRITE_SECRET_KEY: "fake-secret",
    },
    fetchImpl: async (input, init) => {
      dispatchMethods.push(init?.method ?? "GET");
      redirects.push(init?.redirect);
      if (init?.body) {
        const request = JSON.parse(String(init.body)) as { method: string };
        methods.push(request.method);
        sessionHeaders.push(new Headers(init.headers).get("mcp-session-id"));
        if (request.method === "initialize" && initializeAttempts++ === 0) {
          return new Response("retry-body-sentinel", { status: 503 });
        }
      }
      return await fetch(input, init);
    },
    clock: () => new Date("2026-08-24T00:00:00.000Z"),
    sleep: async () => undefined,
    policy: {
      timeoutMs: 1_000,
      maxAttempts: 2,
      retryDelayMs: 0,
      maxConcurrent: 1,
      maxQueue: 0,
    },
  });

  const result = await connector.execute({
    operation: "review",
    input: { asin: "B000000000" },
  });

  assert.deepEqual(result.data, { accepted: true });
  assert.equal(result.source.attemptCount, 2);
  assert.deepEqual(methods, [
    "initialize",
    "initialize",
    "notifications/initialized",
    "tools/call",
  ]);
  assert.deepEqual(sessionHeaders, [null, null, "fake-session-1", "fake-session-1"]);
  assert.deepEqual(dispatchMethods, ["POST", "POST", "POST", "GET", "POST"]);
  assert.equal(redirects.every((redirect) => redirect === "error"), true);
  assert.deepEqual(fake.requests.map((request) => request.method), [
    "initialize",
    "notifications/initialized",
    "tools/call",
  ]);
});

async function captureTransportError(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof McpTransportError);
    return error;
  }
  assert.fail("Expected SellerSprite transport to fail");
}

function trackClientClose(t: TestContext) {
  const originalClose = Client.prototype.close;
  let closeCalls = 0;
  Client.prototype.close = async function () {
    closeCalls += 1;
    await originalClose.call(this);
  };
  t.after(() => {
    Client.prototype.close = originalClose;
  });
  return () => closeCalls;
}
