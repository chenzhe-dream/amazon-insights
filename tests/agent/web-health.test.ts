import assert from "node:assert/strict";
import test from "node:test";

import { probeAgentReadiness } from "../../app/api/health/route";

function readyCapabilities() {
  return {
    schemaVersion: "1.0.0",
    capabilities: {
      storage: { configured: true, available: true, reason: null },
      openai: { configured: true, available: true, reason: null },
      sif: {
        configured: false,
        available: false,
        reason: "SIF credential is not configured",
        checkedAt: null,
      },
      sorftime: {
        configured: false,
        available: false,
        reason: "Sorftime credential is not configured",
        checkedAt: null,
      },
      sellerSprite: {
        configured: false,
        available: false,
        reason: "SellerSprite credential is not configured",
        checkedAt: null,
      },
      manualVoc: { configured: true, available: true, reason: null },
    },
  };
}

function healthEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    AGENT_SERVICE_INTERNAL_URL: "http://10.0.0.8:3100",
    AGENT_SERVICE_PROXY_TOKEN: "test-only-proxy-token",
    ...overrides,
  };
}

async function responseText(response: Response) {
  return await response.clone().text();
}

test("Web health returns ok when the Agent Service readiness probe succeeds", async () => {
  const response = await probeAgentReadiness({
    env: healthEnv(),
    requestUrl: "https://web.example/api/health",
    fetchImplementation: async (input, init) => {
      const headers = new Headers(init?.headers);
      assert.equal(String(input), "http://10.0.0.8:3100/v1/capabilities");
      assert.equal(headers.get("origin"), "https://web.example");
      assert.equal(
        headers.get("x-agent-proxy-token"),
        "test-only-proxy-token",
      );
      return Response.json(readyCapabilities());
    },
    timeoutMs: 2_000,
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: "ok",
    service: "web",
    agent: "ok",
  });
});

test("Web health returns generic degraded when the internal token is rejected", async () => {
  const response = await probeAgentReadiness({
    env: healthEnv(),
    requestUrl: "https://web.example/api/health",
    fetchImplementation: async () =>
      Response.json(
        {
          error: {
            code: "AUTHENTICATION_REQUIRED",
            message: "bad token test-only-proxy-token for http://10.0.0.8:3100",
          },
        },
        { status: 401 },
      ),
    timeoutMs: 2_000,
  });
  const body = await responseText(response);

  assert.equal(response.status, 503);
  assert.match(body, /degraded/);
  assert.doesNotMatch(body, /10\.0\.0\.8|3100|test-only-proxy-token|bad token/i);
});

test("Web health returns generic degraded when the trusted origin is rejected", async () => {
  const response = await probeAgentReadiness({
    env: healthEnv(),
    requestUrl: "https://web.example/api/health",
    fetchImplementation: async () =>
      Response.json(
        {
          error: {
            code: "FORBIDDEN",
            message: "origin https://web.example is not trusted",
          },
        },
        { status: 403 },
      ),
    timeoutMs: 2_000,
  });
  const body = await responseText(response);

  assert.equal(response.status, 503);
  assert.match(body, /degraded/);
  assert.doesNotMatch(body, /web\.example|FORBIDDEN|origin/i);
});

test("Web health returns generic degraded when required runtime capabilities are unavailable", async () => {
  const degradedCapabilities = readyCapabilities();
  degradedCapabilities.capabilities.openai = {
    configured: true,
    available: false,
    reason: "OpenAI runtime is not active",
  };

  const response = await probeAgentReadiness({
    env: healthEnv(),
    requestUrl: "https://web.example/api/health",
    fetchImplementation: async () => Response.json(degradedCapabilities),
    timeoutMs: 2_000,
  });
  const body = await responseText(response);

  assert.equal(response.status, 503);
  assert.match(body, /degraded/);
  assert.doesNotMatch(body, /OpenAI runtime|10\.0\.0\.8|test-only-proxy-token/i);
});

test("Web health returns a generic degraded response without leaking the Agent URL", async () => {
  const response = await probeAgentReadiness({
    env: healthEnv(),
    requestUrl: "https://web.example/api/health",
    fetchImplementation: async () => {
      throw new Error("connect ECONNREFUSED http://10.0.0.8:3100");
    },
    timeoutMs: 2_000,
  });
  const body = await response.text();

  assert.equal(response.status, 503);
  assert.match(body, /degraded/);
  assert.doesNotMatch(body, /10\.0\.0\.8|3100|ECONNREFUSED/i);
});
