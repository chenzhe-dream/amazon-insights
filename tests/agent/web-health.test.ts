import assert from "node:assert/strict";
import test from "node:test";

import { probeAgentHealth } from "../../app/api/health/route";

test("Web health returns ok when the Agent Service health probe succeeds", async () => {
  const response = await probeAgentHealth({
    env: { AGENT_SERVICE_INTERNAL_URL: "http://10.0.0.8:3100" },
    fetchImplementation: async (input) => {
      assert.equal(String(input), "http://10.0.0.8:3100/health");
      return Response.json({ status: "ok", service: "agent-service" });
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

test("Web health returns a generic degraded response without leaking the Agent URL", async () => {
  const response = await probeAgentHealth({
    env: { AGENT_SERVICE_INTERNAL_URL: "http://10.0.0.8:3100" },
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

