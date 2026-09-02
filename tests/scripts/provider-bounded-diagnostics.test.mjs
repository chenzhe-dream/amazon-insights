import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { callSellerSpriteMcpTool, requestSellerSpriteMcp } from "../../scripts/lib/sellersprite-mcp-client.mjs";
import { callSorftimeTool } from "../../scripts/lib/sorftime-mcp-client.mjs";
import { classifyProviderFailure } from "../../scripts/lib/provider-diagnostics.mjs";
import { McpTransportError } from "../../server/connectors/mcp-transport.mjs";

const ASIN = "B0TEST0001";
const SECRET_SENTINEL = "bounded-diagnostic-secret-sentinel";
const BODY_SENTINEL = "bounded-diagnostic-body-sentinel";

test("Sorftime schema diagnostics distinguish allowlisted review operations without values or open keys", async (t) => {
  const provider = await invalidSorftimeProvider();
  t.after(provider.close);

  for (const operation of ["product_customers_say", "product_reviews"]) {
    const error = await captureDiagnostic(callSorftimeTool(
      SECRET_SENTINEL,
      operation,
      { asin: ASIN },
      { env: syncEnvironment("sorftime", provider.endpoint) },
    ));

    assert.deepEqual(error.diagnostic, {
      connector: "sorftime",
      stage: "reviews",
      asin: ASIN,
      failureKind: "schema",
      causeCode: "MCP_SCHEMA",
      operation,
      boundary: "tool-content",
      shape: {
        topLevelType: "unknown",
        data: { presence: "unknown", type: "unknown" },
        details: { presence: "unknown", type: "unknown" },
        items: { presence: "unknown", type: "unknown" },
      },
    });
    assertClosed(error.diagnostic);
  }
});

test("Sorftime diagnostics distinguish an invalid response body without retaining it", async (t) => {
  const provider = await rawInvalidProvider();
  t.after(provider.close);
  const error = await captureDiagnostic(callSorftimeTool(
    SECRET_SENTINEL,
    "product_reviews",
    { asin: ASIN },
    { env: syncEnvironment("sorftime", provider.endpoint) },
  ));

  assert.equal(error.diagnostic.operation, "product_reviews");
  assert.equal(error.diagnostic.boundary, "response-body");
  assertClosed(error.diagnostic);
});

test("SellerSprite diagnostics distinguish an invalid capability handshake from an invalid tool result", async (t) => {
  const capability = await invalidSellerSpriteProvider("capability");
  t.after(capability.close);
  const capabilityError = await captureDiagnostic(requestSellerSpriteMcp(
    SECRET_SENTINEL,
    "tools/list",
    {},
    { env: syncEnvironment("sellerSprite", capability.endpoint) },
  ));

  assert.equal(capabilityError.diagnostic.operation, "tools/list");
  assert.equal(capabilityError.diagnostic.boundary, "rpc-envelope");
  assertClosed(capabilityError.diagnostic);

  const tool = await invalidSellerSpriteProvider("tool");
  t.after(tool.close);
  const toolError = await captureDiagnostic(callSellerSpriteMcpTool(
    SECRET_SENTINEL,
    "review",
    { asin: ASIN },
    { env: syncEnvironment("sellerSprite", tool.endpoint) },
  ));

  assert.equal(toolError.diagnostic.operation, "review");
  assert.equal(toolError.diagnostic.boundary, "rpc-envelope");
  assertClosed(toolError.diagnostic);
});

test("unknown diagnostic operation and attacker-controlled shape keys are omitted", async (t) => {
  const provider = await invalidSorftimeProvider();
  t.after(provider.close);
  const error = await captureDiagnostic(callSorftimeTool(
    SECRET_SENTINEL,
    "unknown-operation-sentinel",
    { asin: ASIN },
    { env: syncEnvironment("sorftime", provider.endpoint) },
  ));

  assert.equal(Object.hasOwn(error.diagnostic, "operation"), false);
  assertClosed(error.diagnostic);
});

test("consumer shape diagnostics report only fixed field presence and JSON types", () => {
  const error = new McpTransportError("schema", null, {
    boundary: "consumer-shape",
    candidate: {
      data: { details: BODY_SENTINEL, unknownKeySentinel: SECRET_SENTINEL },
      unknownRootSentinel: BODY_SENTINEL,
    },
  });
  const diagnostic = classifyProviderFailure(error, {
    connector: "sorftime",
    stage: "reviews",
    asin: ASIN,
    operation: "product_customers_say",
  });

  assert.deepEqual(diagnostic, {
    connector: "sorftime",
    stage: "reviews",
    asin: ASIN,
    failureKind: "schema",
    causeCode: "MCP_SCHEMA",
    operation: "product_customers_say",
    boundary: "consumer-shape",
    shape: {
      topLevelType: "object",
      data: { presence: "present", type: "object" },
      details: { presence: "present", type: "string" },
      items: { presence: "missing", type: "unknown" },
    },
  });
  assertClosed(diagnostic);
});

test("Sorftime diagnostic suppression is opt-in and leaves default reporting unchanged", async () => {
  const silent = await diagnosticSideEffects(false, "bounded-silent-job");
  assert.equal(silent.error.diagnostic.causeCode, "MCP_SCHEMA");
  assert.deepEqual(silent.stderr, []);
  assert.equal(silent.exitCode, undefined);

  const reported = await diagnosticSideEffects(undefined, "bounded-reported-job");
  assert.equal(reported.error.diagnostic.causeCode, "MCP_SCHEMA");
  assert.equal(reported.stderr.length, 1);
  assert.match(reported.stderr[0], /^@@provider-diagnostic@@/);
  assert.equal(reported.exitCode, 1);
});

function syncEnvironment(connector, endpoint) {
  return {
    NODE_ENV: "test",
    AGENT_SYNC_JOB_ID: `bounded-${connector}-job`,
    AGENT_SYNC_STAGE_ID: connector === "sorftime" ? "reviews" : "catalog",
    ...(connector === "sorftime"
      ? { SORFTIME_MCP_ENDPOINT: endpoint }
      : { SELLERSPRITE_MCP_ENDPOINT: endpoint }),
  };
}

function assertClosed(diagnostic) {
  const serialized = JSON.stringify(diagnostic);
  assert.doesNotMatch(serialized, new RegExp(`${SECRET_SENTINEL}|${BODY_SENTINEL}|unknown-operation-sentinel`, "i"));
  assert.ok(serialized.length < 1_024);
  assert.deepEqual(Object.keys(diagnostic).sort(), [
    "asin", "boundary", "causeCode", "connector", "failureKind", "operation", "shape", "stage",
  ].filter((key) => Object.hasOwn(diagnostic, key)).sort());
  if (diagnostic.shape) {
    assert.deepEqual(Object.keys(diagnostic.shape).sort(), ["data", "details", "items", "topLevelType"]);
  }
}

async function captureDiagnostic(promise) {
  try {
    await promise;
  } catch (error) {
    process.exitCode = undefined;
    assert.ok(error && typeof error === "object" && error.diagnostic);
    return error;
  }
  assert.fail("expected provider diagnostic failure");
}

async function diagnosticSideEffects(emitDiagnostics, jobId) {
  const stderr = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = (chunk) => {
    stderr.push(String(chunk));
    return true;
  };
  process.exitCode = undefined;
  let error;
  try {
    await callSorftimeTool(SECRET_SENTINEL, "product_detail", { asin: ASIN }, {
      env: {
        NODE_ENV: "test",
        AGENT_SYNC_JOB_ID: jobId,
        AGENT_SYNC_STAGE_ID: "category",
        SORFTIME_MCP_ENDPOINT: "http://127.0.0.1:1/mcp",
      },
      emitDiagnostics,
      fetchImpl: async () => new Response(BODY_SENTINEL),
    });
    assert.fail("expected provider diagnostic failure");
  } catch (caught) {
    error = caught;
  } finally {
    process.stderr.write = originalWrite;
  }
  const exitCode = process.exitCode;
  process.exitCode = undefined;
  return { error, stderr, exitCode };
}

async function invalidSorftimeProvider() {
  return await startJsonServer(() => ({
    jsonrpc: "2.0",
    id: 1,
    result: { content: [{ type: "text", text: BODY_SENTINEL }] },
  }));
}

async function rawInvalidProvider() {
  const server = createServer(async (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(BODY_SENTINEL);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    endpoint: `http://127.0.0.1:${address.port}/mcp`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}

async function invalidSellerSpriteProvider(mode) {
  let initialized = false;
  return await startJsonServer((payload, request) => {
    if (payload.method === "initialize") {
      if (mode === "capability") return { jsonrpc: "2.0", id: payload.id, result: { invalid: true } };
      initialized = true;
      return {
        jsonrpc: "2.0",
        id: payload.id,
        result: {
          protocolVersion: payload.params?.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "bounded-fixture", version: "1.0.0" },
        },
        headers: { "Mcp-Session-Id": "bounded-session" },
      };
    }
    if (payload.method === "notifications/initialized" && initialized) return { status: 202 };
    if (payload.method === "tools/call" && request.headers["mcp-session-id"] === "bounded-session") {
      return { jsonrpc: "2.0", id: payload.id, result: { content: "invalid" } };
    }
    return { status: 400 };
  });
}

async function startJsonServer(handler) {
  const server = createServer(async (request, response) => {
    if (request.method === "GET") return response.writeHead(405).end();
    let body = "";
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body || "{}");
    const result = handler(payload, request);
    if (result.status) return response.writeHead(result.status).end();
    const { headers = {}, ...json } = result;
    response.writeHead(200, { "content-type": "application/json", ...headers });
    response.end(JSON.stringify(json));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    endpoint: `http://127.0.0.1:${address.port}/mcp`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}
