import assert from "node:assert/strict";
import test from "node:test";

import { buildAgentApp } from "../../server/app";
import { getAgentCapabilities } from "../../server/routes/capabilities";
import { ApiErrorResponseSchema } from "../../shared/agent-contracts";

test("capabilities explicitly report configured and available state", () => {
  const capabilities = getAgentCapabilities({
    AGENT_DATABASE_URL: "postgres://internal-db/secret",
    OPENAI_API_KEY: "openai-secret",
    SIF_MCP_SECRET: "sif-secret",
    SORFTIME_MCP_KEY: "sorftime-secret",
    SELLERSPRITE_SECRET_KEY: "sellersprite-secret",
  });

  assert.deepEqual(capabilities, {
    schemaVersion: "1.0.0",
    capabilities: {
      storage: {
        configured: true,
        available: false,
        reason: "Storage runtime is not available in this build",
      },
      openai: {
        configured: true,
        available: false,
        reason: "OpenAI runtime is not available in this build",
      },
      sif: {
        configured: true,
        available: false,
        reason: "SIF connector is not available in this build",
      },
      sorftime: {
        configured: true,
        available: false,
        reason: "Sorftime connector is not available in this build",
      },
      sellerSprite: {
        configured: true,
        available: false,
        reason: "SellerSprite connector is not available in this build",
      },
      manualVoc: {
        configured: true,
        available: false,
        reason: "Manual VOC import is not available in this build",
      },
    },
  });
});

test("capabilities explain missing configuration without exposing values", () => {
  const env = {
    AGENT_DATABASE_URL: "postgres://internal-db/db-secret",
    OPENAI_API_KEY: "openai-secret",
    SIF_MCP_SECRET: "",
    SORFTIME_MCP_KEY: undefined,
    SELLERSPRITE_SECRET_KEY: undefined,
    AGENT_SERVICE_INTERNAL_URL: "http://10.0.0.9:3100",
    AGENT_SERVICE_PROXY_TOKEN: "proxy-secret",
  };
  const payload = JSON.stringify(getAgentCapabilities(env));

  assert.doesNotMatch(
    payload,
    /db-secret|openai-secret|proxy-secret|10\.0\.0\.9/i,
  );
  assert.match(payload, /SIF credential is not configured/i);
  assert.match(payload, /Sorftime credential is not configured/i);
  assert.match(payload, /SellerSprite credential is not configured/i);
});

test("GET /v1/capabilities returns only the public capability contract", async (t) => {
  const app = buildAgentApp({
    env: {
      OPENAI_API_KEY: "never-return-this-key",
    },
  });
  t.after(() => app.close());

  const response = await app.inject({ method: "GET", url: "/v1/capabilities" });

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["content-type"], "application/json; charset=utf-8");
  assert.doesNotMatch(response.payload, /never-return-this-key/);
  assert.deepEqual(Object.keys(response.json().capabilities), [
    "storage",
    "openai",
    "sif",
    "sorftime",
    "sellerSprite",
    "manualVoc",
  ]);
});

test("Agent Service routes preserve a proxy-provided request ID", async (t) => {
  const app = buildAgentApp();
  t.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/v1/capabilities",
    headers: { "x-request-id": "proxy-request-456" },
  });

  assert.equal(response.headers["x-request-id"], "proxy-request-456");
});

test("Agent Service replaces unsafe request IDs before assigning request.id", async (t) => {
  const app = buildAgentApp();
  t.after(() => app.close());

  for (const unsafeRequestId of ["café", "a".repeat(129), "   "]) {
    const response = await app.inject({
      method: "GET",
      url: "/v1/capabilities",
      headers: { "x-request-id": unsafeRequestId },
    });
    const responseRequestId = response.headers["x-request-id"];

    assert.match(
      String(responseRequestId),
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    assert.notEqual(responseRequestId, unsafeRequestId);
  }
});

test("Fastify application errors conform to the closed standard error contract", async (t) => {
  const app = buildAgentApp();
  t.after(() => app.close());
  app.get("/test-validation-error", async () => {
    throw Object.assign(new Error("invalid request"), {
      statusCode: 400,
      code: "FST_ERR_VALIDATION",
    });
  });

  const response = await app.inject({
    method: "GET",
    url: "/test-validation-error",
    headers: { "x-request-id": "validation-request" },
  });

  assert.equal(response.statusCode, 400);
  assert.equal(ApiErrorResponseSchema.safeParse(response.json()).success, true);
  assert.equal(response.json().error.code, "VALIDATION_ERROR");
});
