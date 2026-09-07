import assert from "node:assert/strict";
import test from "node:test";

import { buildAgentApp } from "../../server/app";
import { loadAgentConfig } from "../../server/config";
import { HealthResponseSchema } from "../../shared/agent-contracts";

test("Agent health exposes only bounded startup source identity", async (t) => {
  const codeSource = { sourceCommit: "a".repeat(40), sourceHash: "b".repeat(64) };
  const app = buildAgentApp({ env: { AGENT_CODE_SOURCE_COMMIT: codeSource.sourceCommit, AGENT_CODE_SOURCE_HASH: codeSource.sourceHash } });
  t.after(() => app.close());
  const response = await app.inject({ method: "GET", url: "/health" });
  assert.deepEqual(response.json().codeSource, codeSource);
  assert.equal(HealthResponseSchema.safeParse(response.json()).success, true);
});

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

test("unexpected errors are structured and redact internal messages", async (t) => {
  const app = buildAgentApp();
  t.after(() => app.close());
  app.get("/test-error", async () => {
    throw new Error("database password leaked");
  });

  const response = await app.inject({
    method: "GET",
    url: "/test-error",
  });
  const requestId = response.headers["x-request-id"];

  assert.equal(response.statusCode, 500);
  assert.match(String(requestId), /^[0-9a-f-]{36}$/i);
  assert.doesNotMatch(response.payload, /database password leaked/i);
  assert.deepEqual(response.json(), {
    error: {
      code: "INTERNAL_SERVER_ERROR",
      message: "Internal server error",
      requestId,
    },
  });
});
