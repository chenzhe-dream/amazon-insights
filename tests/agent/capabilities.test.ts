import assert from "node:assert/strict";
import test from "node:test";

import { buildAgentApp } from "../../server/app";
import type { AuthenticationService } from "../../server/auth/authentication-service";
import type { AgentAuthenticationConfig } from "../../server/config";
import { getAgentCapabilities } from "../../server/routes/capabilities";
import { ApiErrorResponseSchema } from "../../shared/agent-contracts";

const proxyToken = "capabilities-test-proxy-token";
const trustedOrigin = "http://127.0.0.1:3001";
const securityEnv = {
  AGENT_SERVICE_PROXY_TOKEN: proxyToken,
  AGENT_SERVICE_TRUSTED_ORIGINS: trustedOrigin,
};
const proxyHeaders = {
  origin: trustedOrigin,
  "x-agent-proxy-token": proxyToken,
};
const rawToken = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const authConfig: AgentAuthenticationConfig = {
  mode: "authenticated",
  cookie: {
    name: "__Host-agent_session",
    secure: true,
    maxAgeSeconds: 28_800,
  },
  sessionTtlMs: 28_800_000,
  loginLimiter: {
    windowMs: 900_000,
    maxFailures: 5,
    maxEntries: 10_000,
  },
};

class FakeAuthService {
  constructor(readonly role: "admin" | "member") {}

  async authenticate(token: string | null) {
    if (token !== rawToken) return null;
    return {
      kind: "user" as const,
      userId: "10000000-0000-4000-8000-000000000001",
      organizationId: "10000000-0000-4000-8000-000000000002",
      role: this.role,
      sessionId: "10000000-0000-4000-8000-000000000003",
    };
  }
}

function asAuthService(service: FakeAuthService): AuthenticationService {
  return service as unknown as AuthenticationService;
}

function cookieHeaders(role: "admin" | "member") {
  return {
    ...proxyHeaders,
    cookie: `${role === "admin" ? "__Host-agent_session" : "__Host-agent_session"}=${rawToken}`,
  };
}

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
        reason: "OpenAI runtime is not active",
      },
      sif: {
        configured: true,
        available: false,
        reason: "Connector health has not been checked",
        checkedAt: null,
      },
      sorftime: {
        configured: true,
        available: false,
        reason: "Connector health has not been checked",
        checkedAt: null,
      },
      sellerSprite: {
        configured: true,
        available: false,
        reason: "Connector health has not been checked",
        checkedAt: null,
      },
      manualVoc: {
        configured: true,
        available: false,
        reason: "Manual VOC import is not available in this build",
      },
    },
  });
});

test("OpenAI is available only when the composed provider runtime is active", () => {
  const capabilities = getAgentCapabilities(
    { OPENAI_API_KEY: "configured-secret" },
    { storageAvailable: false, openaiAvailable: true },
  );
  assert.deepEqual(capabilities.capabilities.openai, {
    configured: true,
    available: true,
    reason: null,
  });
});

test("storage is available only when the Agent Service opened its repository", () => {
  const capabilities = getAgentCapabilities(
    { AGENT_SQLITE_PATH: "C:\\runtime\\agent.sqlite" },
    { storageAvailable: true },
  );

  assert.deepEqual(capabilities.capabilities.storage, {
    configured: true,
    available: true,
    reason: null,
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
      ...securityEnv,
      OPENAI_API_KEY: "never-return-this-key",
    },
    authService: asAuthService(new FakeAuthService("member")),
    authConfig,
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/v1/capabilities",
    headers: cookieHeaders("member"),
  });

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

test("capabilities uses the proxy trust boundary without requiring a business session", async (t) => {
  const authenticated = buildAgentApp({
    env: securityEnv,
    authService: asAuthService(new FakeAuthService("admin")),
    authConfig,
  });
  const anonymous = buildAgentApp({
    env: {
      ...securityEnv,
      AGENT_SERVICE_HOST: "127.0.0.1",
      AGENT_AUTH_ALLOW_ANONYMOUS_LOOPBACK: "1",
    },
  });
  t.after(async () => {
    await authenticated.close();
    await anonymous.close();
  });

  const missingProxy = await authenticated.inject({
    method: "GET",
    url: "/v1/capabilities",
  });
  assert.equal(missingProxy.statusCode, 401);

  const trustedReadiness = await authenticated.inject({
    method: "GET",
    url: "/v1/capabilities",
    headers: proxyHeaders,
  });
  assert.equal(trustedReadiness.statusCode, 200);

  const admin = await authenticated.inject({
    method: "GET",
    url: "/v1/capabilities",
    headers: cookieHeaders("admin"),
  });
  assert.equal(admin.statusCode, 200);

  const member = await authenticated.inject({
    method: "GET",
    url: "/v1/capabilities",
    headers: cookieHeaders("member"),
  });
  assert.equal(member.statusCode, 200);

  const loopback = await anonymous.inject({
    method: "GET",
    url: "/v1/capabilities",
    headers: proxyHeaders,
  });
  assert.equal(loopback.statusCode, 200);
  assert.deepEqual(trustedReadiness.json(), admin.json());
  assert.deepEqual(admin.json(), member.json());
  assert.deepEqual(admin.json(), loopback.json());
});

test("Agent Service routes preserve a proxy-provided request ID", async (t) => {
  const app = buildAgentApp({ env: securityEnv });
  t.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/v1/capabilities",
    headers: { ...proxyHeaders, "x-request-id": "proxy-request-456" },
  });

  assert.equal(response.headers["x-request-id"], "proxy-request-456");
});

test("Agent Service replaces unsafe request IDs before assigning request.id", async (t) => {
  const app = buildAgentApp({ env: securityEnv });
  t.after(() => app.close());

  for (const unsafeRequestId of ["café", "a".repeat(129), "   "]) {
    const response = await app.inject({
      method: "GET",
      url: "/v1/capabilities",
      headers: { ...proxyHeaders, "x-request-id": unsafeRequestId },
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
