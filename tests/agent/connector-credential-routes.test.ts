import assert from "node:assert/strict";
import test from "node:test";

import { buildAgentApp } from "../../server/app";
import type { AuthenticationService } from "../../server/auth/authentication-service";
import type { AgentAuthenticationConfig } from "../../server/config";
import type { ConnectorCredentialService } from "../../server/services/connector-credential-service";

const origin = "http://127.0.0.1:31900";
const proxyToken = "connector-credential-proxy-token";
const rawToken = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
const headers = {
  origin,
  "x-agent-proxy-token": proxyToken,
  cookie: `__Host-agent_session=${rawToken}`,
};
const env = {
  AGENT_SERVICE_PROXY_TOKEN: proxyToken,
  AGENT_SERVICE_TRUSTED_ORIGINS: origin,
};
const authConfig: AgentAuthenticationConfig = {
  mode: "authenticated",
  cookie: { name: "__Host-agent_session", secure: true, maxAgeSeconds: 28_800 },
  sessionTtlMs: 28_800_000,
  loginLimiter: { windowMs: 900_000, maxFailures: 5, maxEntries: 10_000 },
};

class FakeAuthService {
  constructor(readonly role: "admin" | "member") {}
  async authenticate(token: string | null) {
    if (token !== rawToken) return null;
    return {
      kind: "user" as const,
      userId: "10000000-0000-4000-8000-000000000001",
      organizationId: "20000000-0000-4000-8000-000000000001",
      role: this.role,
      sessionId: "30000000-0000-4000-8000-000000000001",
    };
  }
}

function authService(role: "admin" | "member") {
  return new FakeAuthService(role) as unknown as AuthenticationService;
}

test("credential management routes are admin-only, strict, and return safe state", async (t) => {
  const calls: Array<Record<string, unknown>> = [];
  const safeStates = [
    {
      connectorId: "sif",
      configured: false,
      managed: true,
      version: 2,
      updatedAt: "2026-08-19T08:00:00.000Z",
    },
    {
      connectorId: "sorftime",
      configured: false,
      managed: false,
      version: null,
      updatedAt: null,
    },
    {
      connectorId: "sellerSprite",
      configured: false,
      managed: false,
      version: null,
      updatedAt: null,
    },
  ] as const;
  const service = {
    async listSafeStates() {
      calls.push({ operation: "list" });
      return safeStates;
    },
    async rotate(input: Record<string, unknown>) {
      calls.push({ operation: "rotate", ...input });
      return {
        connectorId: "sif",
        configured: true,
        managed: true,
        version: 3,
        updatedAt: "2026-08-19T08:00:00.000Z",
      };
    },
    async revoke(input: Record<string, unknown>) {
      calls.push({ operation: "revoke", ...input });
      return {
        connectorId: "sif",
        configured: false,
        managed: true,
        version: 3,
        updatedAt: "2026-08-19T08:00:00.000Z",
      };
    },
  } as unknown as ConnectorCredentialService;
  const resolver = (organizationId: string) => {
    assert.equal(organizationId, "20000000-0000-4000-8000-000000000001");
    return service;
  };
  const admin = buildAgentApp({
    env,
    authConfig,
    authService: authService("admin"),
    connectorCredentialServiceResolver: resolver,
  });
  const member = buildAgentApp({
    env,
    authConfig,
    authService: authService("member"),
    connectorCredentialServiceResolver: resolver,
  });
  const anonymous = buildAgentApp({
    env: {
      ...env,
      AGENT_SERVICE_HOST: "127.0.0.1",
      AGENT_AUTH_ALLOW_ANONYMOUS_LOOPBACK: "1",
    },
    connectorCredentialServiceResolver: resolver,
  });
  t.after(async () => Promise.all([admin.close(), member.close(), anonymous.close()]));

  for (const app of [member, anonymous]) {
    for (const request of [
      { method: "GET" as const, url: "/v1/connectors" },
      {
        method: "PUT" as const,
        url: "/v1/connectors/sif/credential",
        payload: { secret: "must-never-reach-service" },
      },
      { method: "DELETE" as const, url: "/v1/connectors/sif/credential" },
    ]) {
      const response = await app.inject({ ...request, headers });
      assert.equal(response.statusCode, 403);
      assert.equal(response.json().error.code, "FORBIDDEN");
    }
  }
  assert.equal(calls.length, 0);

  const invalidBodies = [
    {},
    { secret: "" },
    { secret: "x", extra: true },
    { secret: "x".repeat(8_193) },
  ];
  for (const payload of invalidBodies) {
    const response = await admin.inject({
      method: "PUT",
      url: "/v1/connectors/sif/credential",
      headers,
      payload,
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, "VALIDATION_ERROR");
  }
  assert.equal(calls.length, 0);

  const listed = await admin.inject({ method: "GET", url: "/v1/connectors", headers });
  assert.equal(listed.statusCode, 200);
  assert.deepEqual(listed.json(), { connectors: safeStates });
  calls.length = 0;

  const rotated = await admin.inject({
    method: "PUT",
    url: "/v1/connectors/sif/credential",
    headers,
    payload: { secret: "sentinel-secret-A" },
  });
  assert.equal(rotated.statusCode, 200);
  assert.doesNotMatch(rotated.body, /sentinel-secret-A/);
  assert.deepEqual(calls, [{
    operation: "rotate",
    connector: "sif",
    secret: "sentinel-secret-A",
    actorUserId: "10000000-0000-4000-8000-000000000001",
  }]);

  calls.length = 0;
  const revoked = await admin.inject({
    method: "DELETE",
    url: "/v1/connectors/sif/credential",
    headers,
  });
  assert.equal(revoked.statusCode, 200);
  assert.deepEqual(calls, [{
    operation: "revoke",
    connector: "sif",
    actorUserId: "10000000-0000-4000-8000-000000000001",
  }]);
});
