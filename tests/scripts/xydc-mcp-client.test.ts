import assert from "node:assert/strict";
import test from "node:test";

import {
  callXydcTool,
  unwrapXydcToolResult,
  XydcProviderError,
  xydcRequestHeaders,
} from "../../scripts/lib/xydc-mcp-client";

const token = "fixture-xydc-token";
const providerBody = "fixture-provider-body-must-not-escape";

test("creates the required immutable Bearer header", () => {
  const headers = xydcRequestHeaders(`  ${token}  `);
  assert.deepEqual(headers, { Authorization: `Bearer ${token}` });
  assert.equal(Object.isFrozen(headers), true);
});

test("rejects a missing token without creating a transport", async () => {
  let calls = 0;
  await assert.rejects(
    callXydcTool("", "get_asin_variations", {}, { callTool: async () => { calls += 1; return {}; } }),
    error => error instanceof XydcProviderError && error.reasonCode === "NOT_CONFIGURED",
  );
  assert.equal(calls, 0);
});

test("maps injected timeout, RPC, and invalid schema failures to stable redacted codes", async () => {
  for (const [error, expected] of [
    [Object.assign(new Error(providerBody), { name: "TimeoutError" }), "TIMEOUT"],
    [Object.assign(new Error(providerBody), { code: "RPC_ERROR" }), "RPC_ERROR"],
    [Object.assign(new Error(providerBody), { code: "SCHEMA_INVALID" }), "SCHEMA_INVALID"],
  ] as const) {
    await assert.rejects(
      callXydcTool(token, "get_asin_info", {}, { callTool: async () => { throw error; } }),
      candidate => {
        assert.ok(candidate instanceof XydcProviderError);
        assert.equal(candidate.reasonCode, expected);
        const encoded = JSON.stringify(candidate);
        assert.equal(encoded.includes(token), false);
        assert.equal(encoded.includes(providerBody), false);
        return true;
      },
    );
  }
});

test("rejects tools outside the allow-list before an injected network call", async () => {
  let calls = 0;
  await assert.rejects(
    callXydcTool(token, "delete_everything" as never, {}, { callTool: async () => { calls += 1; return {}; } }),
    error => error instanceof XydcProviderError && error.reasonCode === "RPC_ERROR",
  );
  assert.equal(calls, 0);
});

test("unwraps only a structured result or one JSON text result without returning an MCP envelope", async () => {
  assert.deepEqual(unwrapXydcToolResult({
    structuredContent: { parentAsin: "B0PARENT01" },
    content: [{ type: "text", text: JSON.stringify({ providerBody }) }],
  }), { parentAsin: "B0PARENT01" });
  assert.deepEqual(await callXydcTool(token, "get_asin_info", {}, {
    callTool: async () => ({ content: [{ type: "text", text: JSON.stringify([{ asin: "B0CHILD001" }]) }] }),
  }), [{ asin: "B0CHILD001" }]);
});

test("rejects malformed or ambiguous MCP result envelopes as redacted schema failures", async () => {
  for (const response of [
    { content: [{ type: "text", text: "not JSON" }] },
    { content: [{ type: "text", text: "{}" }, { type: "text", text: "{}" }] },
    { content: [{ type: "image", data: providerBody }] },
  ]) {
    await assert.rejects(
      callXydcTool(token, "get_asin_info", {}, { callTool: async () => response }),
      error => {
        assert.ok(error instanceof XydcProviderError);
        assert.equal(error.reasonCode, "SCHEMA_INVALID");
        assert.equal(JSON.stringify(error).includes(providerBody), false);
        return true;
      },
    );
  }
});

test("treats MCP error envelopes as redacted RPC failures before structured or text payload parsing", async () => {
  for (const response of [
    { isError: true, structuredContent: { providerBody }, content: [] },
    { isError: true, content: [{ type: "text", text: JSON.stringify({ providerBody }) }] },
  ]) {
    await assert.rejects(
      callXydcTool(token, "get_asin_info", {}, { callTool: async () => response }),
      error => {
        assert.ok(error instanceof XydcProviderError);
        assert.equal(error.reasonCode, "RPC_ERROR");
        assert.equal(JSON.stringify(error).includes(providerBody), false);
        return true;
      },
    );
  }
});

test("allows monthly order trends and preserves only bounded structured rate metadata", async () => {
  const response = { structuredContent: { status: 200, data: { asin: "B07R56PTMS", country: "US", trends: [] } } };
  assert.deepEqual(await callXydcTool(token, "get_asin_order_trends", {
    asin: "B07R56PTMS", country: "US", start_month: "2025-09", end_month: "2026-08",
  }, { callTool: async input => {
    assert.equal(input.toolName, "get_asin_order_trends");
    return response;
  } }), response.structuredContent);

  await assert.rejects(
    callXydcTool(token, "get_asin_order_trends", {}, {
      callTool: async () => { throw Object.assign(new Error(providerBody), { code: 429, reason: "RateLimitExceeded", retryAfter: "2" }); },
    }),
    error => {
      assert.ok(error instanceof XydcProviderError);
      assert.equal(error.reasonCode, "RATE_LIMITED");
      assert.equal(error.statusCode, 429);
      assert.equal(error.retryAfterMs, 2_000);
      assert.equal(error.providerReason, "RateLimitExceeded");
      assert.equal(JSON.stringify(error).includes(providerBody), false);
      return true;
    },
  );
});

test("maps documented structured order auth/quota reasons without guessing from message prose", async () => {
  for (const [payload, expected] of [
    [{ code: 401, reason: "APICredentialUnavailable", message: providerBody, metadata: { secret: providerBody } }, "AUTH_FAILED"],
    [{ code: 403, reason: "CreditBalanceInsufficient", message: providerBody, metadata: { secret: providerBody } }, "QUOTA_EXCEEDED"],
    [{ code: 404, reason: "APICredentialNotFound", message: providerBody, metadata: {} }, "AUTH_FAILED"],
    [{ code: 404, reason: "UnknownProduct", message: "quota credit auth " + providerBody }, "NOT_FOUND"],
    [{ code: 500, reason: "Unknown", message: "quota credit auth " + providerBody }, "RPC_ERROR"],
  ] as const) {
    await assert.rejects(
      callXydcTool(token, "get_asin_order_trends", {}, {
        callTool: async () => ({ isError: true, structuredContent: payload }),
      }),
      error => {
        assert.ok(error instanceof XydcProviderError);
        assert.equal(error.reasonCode, expected);
        assert.equal(JSON.stringify(error).includes(providerBody), false);
        assert.equal("message" in JSON.parse(JSON.stringify(error)), false);
        return true;
      },
    );
  }
});

test("drops Retry-After metadata outside the single-retry bound", async () => {
  await assert.rejects(
    callXydcTool(token, "get_asin_order_trends", {}, {
      callTool: async () => { throw Object.assign(new Error(providerBody), { code: 429, retryAfter: "31" }); },
    }),
    error => error instanceof XydcProviderError
      && error.reasonCode === "RATE_LIMITED"
      && error.retryAfterMs === undefined,
  );
});
