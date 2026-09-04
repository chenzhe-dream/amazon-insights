import assert from "node:assert/strict";
import test from "node:test";

import {
  callXydcTool,
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
