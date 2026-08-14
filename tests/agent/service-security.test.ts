import assert from "node:assert/strict";
import { Writable } from "node:stream";
import test from "node:test";

import { proxyAgentRequest } from "../../app/api/agent/[...path]/route";
import { createAgentServiceClient } from "../../app/lib/agent-service-client";
import { buildAgentApp } from "../../server/app";

const proxyToken = "test-only-internal-proxy-token";
const trustedOrigin = "http://127.0.0.1:3001";

function securityEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    AGENT_SERVICE_PROXY_TOKEN: proxyToken,
    AGENT_SERVICE_TRUSTED_ORIGINS: trustedOrigin,
    ...overrides,
  };
}

function proxyHeaders(overrides: Record<string, string> = {}) {
  return {
    origin: trustedOrigin,
    "x-agent-proxy-token": proxyToken,
    ...overrides,
  };
}

test("Agent Service rejects request bodies over the configured byte limit", async (t) => {
  const app = buildAgentApp({
    env: securityEnv({ AGENT_SERVICE_BODY_LIMIT_BYTES: "64" }),
  });
  t.after(() => app.close());
  app.post("/v1/test-body-limit", async (request) => ({ body: request.body }));

  const response = await app.inject({
    method: "POST",
    url: "/v1/test-body-limit",
    headers: {
      ...proxyHeaders(),
      "content-type": "application/json",
    },
    payload: { value: "x".repeat(128) },
  });

  assert.equal(response.statusCode, 413);
  assert.equal(response.json().error.code, "VALIDATION_ERROR");
});

test("Agent Service terminates handlers that exceed the request deadline", async (t) => {
  const app = buildAgentApp({
    env: securityEnv({ AGENT_SERVICE_REQUEST_DEADLINE_MS: "5" }),
  });
  t.after(() => app.close());
  app.get("/v1/test-deadline", async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { tooLate: true };
  });

  const response = await app.inject({
    method: "GET",
    url: "/v1/test-deadline",
    headers: proxyHeaders({ "x-request-id": "safe-50-request-id" }),
  });

  assert.equal(response.statusCode, 504);
  const { error } = response.json();
  assert.equal(error.code, "AGENT_SERVICE_TIMEOUT");
  assert.equal(error.message, "Agent Service request timed out");
  assert.equal(error.requestId, "safe-50-request-id");
  assert.doesNotMatch(`${error.code}\n${error.message}`, /test-deadline|50/);
});

test("Agent Service rejects untrusted and absent request origins", async (t) => {
  const app = buildAgentApp({ env: securityEnv() });
  t.after(() => app.close());

  for (const origin of [undefined, "https://evil.example"]) {
    const response = await app.inject({
      method: "GET",
      url: "/v1/capabilities",
      headers: {
        "x-agent-proxy-token": proxyToken,
        ...(origin ? { origin } : {}),
      },
    });

    assert.equal(response.statusCode, 403);
    assert.equal(response.json().error.code, "FORBIDDEN");
  }
});

test("Agent Service rejects direct requests without the internal proxy token", async (t) => {
  const app = buildAgentApp({ env: securityEnv() });
  t.after(() => app.close());

  for (const suppliedToken of [undefined, "incorrect-token"]) {
    const response = await app.inject({
      method: "GET",
      url: "/v1/capabilities",
      headers: {
        origin: trustedOrigin,
        ...(suppliedToken
          ? { "x-agent-proxy-token": suppliedToken }
          : {}),
      },
    });

    assert.equal(response.statusCode, 401);
    assert.equal(response.json().error.code, "AUTHENTICATION_REQUIRED");
  }

  const proxiedResponse = await app.inject({
    method: "GET",
    url: "/v1/capabilities",
    headers: proxyHeaders(),
  });
  assert.equal(proxiedResponse.statusCode, 200);
});

test("the vinext proxy can call the protected Agent Service", async (t) => {
  const app = buildAgentApp({ env: securityEnv() });
  t.after(() => app.close());
  const client = createAgentServiceClient({
    env: {
      AGENT_SERVICE_INTERNAL_URL: "http://127.0.0.1:3100",
      AGENT_SERVICE_PROXY_TOKEN: proxyToken,
    },
    fetchImplementation: async (input, init) => {
      const headers = Object.fromEntries(new Headers(init?.headers));
      const method = init?.method === "POST" ? "POST" : "GET";
      const upstream = await app.inject({
        method,
        url: new URL(String(input)).pathname,
        headers,
        payload: typeof init?.body === "string" ? init.body : undefined,
      });
      return new Response(upstream.payload, {
        status: upstream.statusCode,
        headers: {
          "content-type": String(upstream.headers["content-type"]),
          "x-request-id": String(upstream.headers["x-request-id"]),
        },
      });
    },
  });

  const response = await proxyAgentRequest(
    new Request(`${trustedOrigin}/api/agent/v1/capabilities`),
    { params: Promise.resolve({ path: ["v1", "capabilities"] }) },
    client,
  );

  assert.equal(response.status, 200);
  assert.equal((await response.json()).schemaVersion, "1.0.0");
});

test("health stays public while missing service security is reported distinctly", async (t) => {
  const app = buildAgentApp({ env: {} });
  t.after(() => app.close());

  const health = await app.inject({ method: "GET", url: "/health" });
  const capabilities = await app.inject({
    method: "GET",
    url: "/v1/capabilities",
  });

  assert.equal(health.statusCode, 200);
  assert.equal(capabilities.statusCode, 503);
  assert.equal(capabilities.json().error.code, "CONFIGURATION_ERROR");
});

test("Agent Service logs redact authentication headers and cookies", async (t) => {
  let output = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  });
  const app = buildAgentApp({
    env: securityEnv(),
    logger: { level: "info", stream },
  });
  t.after(() => app.close());
  app.get("/v1/test-log-redaction", async (request) => {
    request.log.info({ headers: request.headers }, "received secure request");
    return { ok: true };
  });

  const response = await app.inject({
    method: "GET",
    url: "/v1/test-log-redaction",
    headers: {
      ...proxyHeaders(),
      authorization: "Bearer must-never-appear",
      cookie: "session=must-never-appear",
    },
  });

  assert.equal(response.statusCode, 200);
  assert.doesNotMatch(
    output,
    /test-only-internal-proxy-token|Bearer must-never-appear|session=must-never-appear/,
  );
  assert.match(output, /\[Redacted\]/);
});
