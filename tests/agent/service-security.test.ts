import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Writable } from "node:stream";
import test from "node:test";

import { proxyAgentRequest } from "../../app/api/agent/[...path]/route";
import { probeAgentReadiness } from "../../app/api/health/route";
import { createAgentServiceClient } from "../../app/lib/agent-service-client";
import { buildAgentApp } from "../../server/app";
import type { AuthenticationService } from "../../server/auth/authentication-service";
import {
  loadAgentAuthenticationConfig,
  type AgentAuthenticationConfig,
} from "../../server/config";

const proxyToken = "test-only-internal-proxy-token";
const trustedOrigin = "http://127.0.0.1:3001";
const privateLanOrigin = "http://192.168.1.109:31900";
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

test("Alexa normalization status surfaces pass the raw-data leakage allowlist", () => {
  const forbidden = /rawText|ciphertext|wrappedDek|modelResponse/i;
  const slice = (file: string, start: string, end: string) => {
    const source = readFileSync(file, "utf8").replaceAll("\r\n", "\n");
    const from = source.indexOf(start);
    const to = source.indexOf(end, from + start.length);
    assert.ok(from >= 0 && to > from, `${file} leakage gate markers must remain present`);
    return source.slice(from, to);
  };
  const guarded = [
    slice("shared/agent-contracts.ts", "export const AlexaVocNormalizationStatusSchema", "export const ManualAlexaVocWriteResponseSchema"),
    slice("server/services/manual-alexa-voc-service.ts", "async getNormalizationStatus", "async #authorizeImport"),
    slice("server/routes/manual-alexa-voc.ts", "app.get(\"/v1/manual-alexa-voc/normalization-status\"", "\n  });\n}"),
    slice("server/db/sqlite-repository.ts", "#listAlexaVocNormalizationStatuses", "#findCommittedAlexaVocNormalizationByFingerprint"),
    slice("server/db/postgres/manual-alexa-voc-store.ts", "listNormalizationStatuses", "findNormalizationInputByFingerprint"),
    readFileSync("app/api/alexa-voc/pending/route.ts", "utf8"),
    readFileSync("app/manual-alexa-voc-store.ts", "utf8"),
  ];
  for (const source of guarded) assert.doesNotMatch(source, forbidden);

  const skillSources = [
    "skills-src/alexa-for-shopping-voc/SKILL.md",
    "skills-src/amazon-voc-insight/SKILL.md",
  ].map((file) => readFileSync(file, "utf8")).join("\n");
  assert.doesNotMatch(skillSources, /voc-listing-optimizer/i);
});

class FakeAuthService {
  async authenticate(token: string | null) {
    if (token !== rawToken) return null;
    return {
      kind: "user" as const,
      userId: "10000000-0000-4000-8000-000000000001",
      organizationId: "10000000-0000-4000-8000-000000000002",
      role: "member" as const,
      sessionId: "10000000-0000-4000-8000-000000000003",
    };
  }
}

function asAuthService(service: FakeAuthService): AuthenticationService {
  return service as unknown as AuthenticationService;
}

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

function sessionHeaders(overrides: Record<string, string> = {}) {
  return proxyHeaders({
    cookie: `__Host-agent_session=${rawToken}`,
    ...overrides,
  });
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
    authConfig,
    authService: asAuthService(new FakeAuthService()),
  });
  t.after(() => app.close());
  app.get("/v1/test-deadline", async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { tooLate: true };
  });

  const response = await app.inject({
    method: "GET",
    url: "/v1/test-deadline",
    headers: sessionHeaders({ "x-request-id": "safe-50-request-id" }),
  });

  assert.equal(response.statusCode, 504);
  const { error } = response.json();
  assert.equal(error.code, "AGENT_SERVICE_TIMEOUT");
  assert.equal(error.message, "Agent Service request timed out");
  assert.equal(error.requestId, "safe-50-request-id");
  assert.doesNotMatch(`${error.code}\n${error.message}`, /test-deadline|50/);
});

test("Agent Service rejects untrusted and absent request origins", async (t) => {
  const app = buildAgentApp({
    env: securityEnv(),
    authConfig,
    authService: asAuthService(new FakeAuthService()),
  });
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
  const app = buildAgentApp({
    env: securityEnv(),
    authConfig,
    authService: asAuthService(new FakeAuthService()),
  });
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
    headers: sessionHeaders(),
  });
  assert.equal(proxiedResponse.statusCode, 200);
});

test("private-LAN service trust requires the exact origin, proxy token, and session", async (t) => {
  const privateLanAuthConfig = loadAgentAuthenticationConfig(
    {
      NODE_ENV: "development",
      WEB_HOST: "0.0.0.0",
      WEB_PORT: "31900",
      AGENT_SERVICE_HOST: "127.0.0.1",
      AGENT_SERVICE_PORT: "31901",
      AGENT_SERVICE_INTERNAL_URL: "http://127.0.0.1:31901",
      AGENT_SERVICE_PROXY_TOKEN: proxyToken,
      AGENT_SERVICE_TRUSTED_ORIGINS: privateLanOrigin,
      AGENT_AUTH_ALLOW_ANONYMOUS_LOOPBACK: "0",
      AGENT_AUTH_ALLOW_INSECURE_LOOPBACK_COOKIE: "0",
      AGENT_AUTH_ALLOW_INSECURE_PRIVATE_NETWORK_COOKIE: "1",
    },
    () => ({
      Ethernet: [{
        address: "192.168.1.109",
        netmask: "255.255.255.0",
        family: "IPv4" as const,
        mac: "00:00:00:00:00:01",
        internal: false,
        cidr: "192.168.1.109/24",
      }],
    }),
  );
  const app = buildAgentApp({
    env: securityEnv({ AGENT_SERVICE_TRUSTED_ORIGINS: privateLanOrigin }),
    authConfig: privateLanAuthConfig,
    authService: asAuthService(new FakeAuthService()),
  });
  t.after(() => app.close());

  for (const origin of [
    "http://192.168.1.109:31901",
    "http://192.168.1.110:31900",
    "https://192.168.1.109:31900",
  ]) {
    const response = await app.inject({
      method: "GET",
      url: "/v1/capabilities",
      headers: {
        origin,
        "x-agent-proxy-token": proxyToken,
      },
    });
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().error.code, "FORBIDDEN");
  }

  const cookieWithoutProxy = await app.inject({
    method: "GET",
    url: "/v1/capabilities",
    headers: {
      origin: privateLanOrigin,
      cookie: `agent_session=${rawToken}`,
    },
  });
  assert.equal(cookieWithoutProxy.statusCode, 401);
  assert.equal(
    cookieWithoutProxy.json().error.code,
    "AUTHENTICATION_REQUIRED",
  );

  const proxyWithoutSession = await app.inject({
    method: "GET",
    url: "/v1/projects/10000000-0000-4000-8000-000000000001",
    headers: {
      origin: privateLanOrigin,
      "x-agent-proxy-token": proxyToken,
    },
  });
  assert.equal(proxyWithoutSession.statusCode, 401);
  assert.equal(
    proxyWithoutSession.json().error.code,
    "AUTHENTICATION_REQUIRED",
  );
});

test("dedicated readiness is proxy-only while user routes remain session-protected", async (t) => {
  const env = securityEnv({
    AGENT_SQLITE_PATH: ":memory:",
    OPENAI_API_KEY: "test-only-openai-key",
    SIF_MCP_SECRET: "must-not-leak-sif-secret",
    SORFTIME_MCP_KEY: "must-not-leak-sorftime-secret",
    SELLERSPRITE_SECRET_KEY: "must-not-leak-seller-sprite-secret",
  });
  const app = buildAgentApp({
    env,
    authConfig,
    authService: asAuthService(new FakeAuthService()),
    storageAvailable: true,
    openaiAvailable: true,
  });
  t.after(() => app.close());

  const exactHeaders = proxyHeaders();
  assert.equal(Object.hasOwn(exactHeaders, "cookie"), false);
  const readiness = await app.inject({
    method: "GET",
    url: "/v1/readiness",
    headers: exactHeaders,
  });
  assert.equal(readiness.statusCode, 200);
  assert.deepEqual(readiness.json(), {
    schemaVersion: "1.0.0",
    readiness: { storage: true, openai: true },
  });
  assert.doesNotMatch(
    readiness.payload,
    /sif|sorftime|seller.?sprite|secret|organization|configured|reason/i,
  );

  const webHealth = await probeAgentReadiness({
    env: {
      AGENT_SERVICE_INTERNAL_URL: "http://127.0.0.1:3100",
      AGENT_SERVICE_PROXY_TOKEN: proxyToken,
    },
    requestUrl: `${trustedOrigin}/api/health`,
    fetchImplementation: async (input, init) => {
      assert.equal(String(input), "http://127.0.0.1:3100/v1/readiness");
      const headers = Object.fromEntries(new Headers(init?.headers));
      assert.equal(Object.hasOwn(headers, "cookie"), false);
      const upstream = await app.inject({
        method: init?.method === "GET" ? "GET" : "POST",
        url: new URL(String(input)).pathname,
        headers,
      });
      return new Response(upstream.payload, {
        status: upstream.statusCode,
        headers: { "content-type": String(upstream.headers["content-type"]) },
      });
    },
  });
  assert.equal(webHealth.status, 200);

  for (const headers of [
    { origin: trustedOrigin },
    { origin: trustedOrigin, "x-agent-proxy-token": "wrong-token" },
  ]) {
    const response = await app.inject({
      method: "GET",
      url: "/v1/readiness",
      headers,
    });
    assert.equal(response.statusCode, 401);
  }

  const wrongOrigin = await app.inject({
    method: "GET",
    url: "/v1/readiness",
    headers: proxyHeaders({ origin: "https://evil.example" }),
  });
  assert.equal(wrongOrigin.statusCode, 403);

  for (const [method, url] of [
    ["POST", "/v1/readiness"],
    ["GET", "/v1/readiness/extra"],
    ["GET", "/v1/readiness-status"],
    ["GET", "/v1/capabilities"],
    ["POST", "/v1/capabilities"],
    ["GET", "/v1/capabilities/extra"],
    ["GET", "/v1/projects/10000000-0000-4000-8000-000000000001"],
    ["POST", "/v1/feedback"],
    ["GET", "/v1/feedback/mine"],
    ["GET", "/v1/feedback/mine/40000000-0000-4000-8000-000000000001"],
    [
      "GET",
      "/v1/feedback/mine/40000000-0000-4000-8000-000000000001/attachments/50000000-0000-4000-8000-000000000001",
    ],
    ["GET", "/v1/feedback/admin"],
    ["GET", "/v1/feedback/admin/unread-count"],
    ["GET", "/v1/feedback/admin/40000000-0000-4000-8000-000000000001"],
    [
      "GET",
      "/v1/feedback/admin/40000000-0000-4000-8000-000000000001/attachments/50000000-0000-4000-8000-000000000001",
    ],
    ["POST", "/v1/feedback/admin/40000000-0000-4000-8000-000000000001/mark-seen"],
    ["POST", "/v1/feedback/admin/40000000-0000-4000-8000-000000000001/status"],
  ] as const) {
    const response = await app.inject({ method, url, headers: exactHeaders });
    assert.equal(response.statusCode, 401, `${method} ${url}`);
  }
});

test("Web preflight readiness uses the launcher-configured formal Web origin", async (t) => {
  const formalOrigin = "http://127.0.0.1:31900";
  const preflightOrigin = "http://127.0.0.1:61347";
  const env = securityEnv({
    AGENT_SERVICE_TRUSTED_ORIGINS: formalOrigin,
    AGENT_SQLITE_PATH: ":memory:",
    OPENAI_API_KEY: "test-only-openai-key",
  });
  const app = buildAgentApp({
    env,
    authConfig,
    authService: asAuthService(new FakeAuthService()),
    storageAvailable: true,
    openaiAvailable: true,
  });
  t.after(() => app.close());

  const response = await probeAgentReadiness({
    env: {
      AGENT_SERVICE_INTERNAL_URL: "http://127.0.0.1:31901",
      AGENT_SERVICE_PROXY_TOKEN: proxyToken,
      AGENT_SERVICE_READINESS_ORIGIN: formalOrigin,
    },
    requestUrl: `${preflightOrigin}/api/health`,
    fetchImplementation: async (input, init) => {
      const upstream = await app.inject({
        method: init?.method === "GET" ? "GET" : "POST",
        url: new URL(String(input)).pathname,
        headers: Object.fromEntries(new Headers(init?.headers)),
      });
      return new Response(upstream.payload, {
        status: upstream.statusCode,
        headers: { "content-type": String(upstream.headers["content-type"]) },
      });
    },
  });

  assert.equal(response.status, 200);
});

test("Web preflight readiness stays degraded without an exact trusted formal origin", async (t) => {
  const formalOrigin = "http://127.0.0.1:31900";
  const preflightOrigin = "http://127.0.0.1:61347";
  const env = securityEnv({
    AGENT_SERVICE_TRUSTED_ORIGINS: formalOrigin,
    AGENT_SQLITE_PATH: ":memory:",
    OPENAI_API_KEY: "test-only-openai-key",
  });
  const app = buildAgentApp({
    env,
    authConfig,
    authService: asAuthService(new FakeAuthService()),
    storageAvailable: true,
    openaiAvailable: true,
  });
  t.after(() => app.close());
  const fetchImplementation: typeof fetch = async (input, init) => {
    const upstream = await app.inject({
      method: init?.method === "GET" ? "GET" : "POST",
      url: new URL(String(input)).pathname,
      headers: Object.fromEntries(new Headers(init?.headers)),
    });
    return new Response(upstream.payload, {
      status: upstream.statusCode,
      headers: { "content-type": String(upstream.headers["content-type"]) },
    });
  };
  const baseEnv = {
    AGENT_SERVICE_INTERNAL_URL: "http://127.0.0.1:31901",
    AGENT_SERVICE_PROXY_TOKEN: proxyToken,
  };

  const missing = await probeAgentReadiness({
    env: baseEnv,
    requestUrl: `${preflightOrigin}/api/health`,
    fetchImplementation,
  });
  const wrong = await probeAgentReadiness({
    env: {
      ...baseEnv,
      AGENT_SERVICE_READINESS_ORIGIN: "http://127.0.0.1:31902",
    },
    requestUrl: `${preflightOrigin}/api/health`,
    fetchImplementation,
  });
  let malformedFetches = 0;
  const malformed = await probeAgentReadiness({
    env: {
      ...baseEnv,
      AGENT_SERVICE_READINESS_ORIGIN: `${formalOrigin}/user-controlled-path`,
    },
    requestUrl: `${preflightOrigin}/api/health`,
    fetchImplementation: async () => {
      malformedFetches += 1;
      return Response.json(readyReadiness());
    },
  });

  assert.deepEqual([missing.status, wrong.status, malformed.status], [503, 503, 503]);
  assert.equal(malformedFetches, 0);
});

test("the vinext proxy can call the protected Agent Service", async (t) => {
  const app = buildAgentApp({
    env: securityEnv(),
    authConfig,
    authService: asAuthService(new FakeAuthService()),
  });
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
    new Request(`${trustedOrigin}/api/agent/v1/capabilities`, {
      headers: { cookie: `__Host-agent_session=${rawToken}` },
    }),
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

test("Agent Service logs redact authentication headers, cookies, and Alexa raw text fields", async (t) => {
  let output = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  });
  const app = buildAgentApp({
    env: securityEnv(),
    authConfig,
    authService: asAuthService(new FakeAuthService()),
    logger: { level: "info", stream },
  });
  t.after(() => app.close());
  app.get("/v1/test-log-redaction", async (request) => {
    request.log.info({ headers: request.headers }, "received secure request");
    return { ok: true };
  });
  app.post("/v1/test-body-log-redaction", async (request) => {
    request.log.info({ body: request.body, req: { body: request.body } }, "received Alexa input");
    return { ok: true };
  });

  const response = await app.inject({
    method: "GET",
    url: "/v1/test-log-redaction",
    headers: {
      ...sessionHeaders(),
      authorization: "Bearer must-never-appear",
      cookie: `__Host-agent_session=${rawToken}; session=must-never-appear`,
    },
  });
  const bodyResponse = await app.inject({
    method: "POST",
    url: "/v1/test-body-log-redaction",
    headers: sessionHeaders(),
    payload: {
      rawText: "must-never-log-rawText",
      text: "must-never-log-text",
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(bodyResponse.statusCode, 200);
  assert.doesNotMatch(
    output,
    /test-only-internal-proxy-token|Bearer must-never-appear|session=must-never-appear|must-never-log-rawText|must-never-log-text/,
  );
  assert.match(output, /\[Redacted\]/);
});
