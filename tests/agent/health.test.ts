import assert from "node:assert/strict";
import test from "node:test";

import { buildAgentApp } from "../../server/app";
import { loadAgentConfig } from "../../server/config";

test("GET /health reports the Agent Service status", async (t) => {
  const app = buildAgentApp();
  t.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/health",
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    status: "ok",
    service: "agent-service",
  });
});

test("Agent Service configuration defaults to loopback port 3100", () => {
  assert.deepEqual(loadAgentConfig({}), {
    host: "127.0.0.1",
    port: 3100,
  });
});

test("Agent Service configuration rejects invalid ports", () => {
  assert.throws(
    () => loadAgentConfig({ AGENT_SERVICE_PORT: "70000" }),
    /Too big|less than or equal to 65535/i,
  );
});

test("responses include request IDs and structured not-found errors", async (t) => {
  const app = buildAgentApp();
  t.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/missing",
  });
  const requestId = response.headers["x-request-id"];

  assert.equal(response.statusCode, 404);
  assert.match(String(requestId), /^[0-9a-f-]{36}$/i);
  assert.deepEqual(response.json(), {
    error: {
      code: "NOT_FOUND",
      message: "Route not found",
      requestId,
    },
  });
});
