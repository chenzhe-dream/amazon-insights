import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Writable } from "node:stream";
import test from "node:test";
import { tmpdir } from "node:os";

import { buildAgentApp } from "../../server/app";
import type { AuthenticationService } from "../../server/auth/authentication-service";
import {
  loadAgentAuthenticationConfig,
  type AgentAuthenticationConfig,
} from "../../server/config";
import { createAgentService } from "../../server/agent-service";
import type { SqliteAgentRepository } from "../../server/db/sqlite-repository";
import {
  ApiErrorCodeSchema,
  DingTalkOAuthCallbackRequestSchema,
  DingTalkOAuthCallbackResponseSchema,
  DingTalkOAuthStartRequestSchema,
  DingTalkOAuthStartResponseSchema,
  DingTalkPublicConfigResponseSchema,
  DingTalkWorkbenchLoginRequestSchema,
  DingTalkWorkbenchLoginResponseSchema,
  findHttpContract,
  SessionResponseSchema,
  type AgentServiceV1Path,
  type User,
} from "../../shared/agent-contracts";

const NOW = "2026-08-18T00:00:00.000Z";
const USER: User = {
  id: "10000000-0000-4000-8000-000000000001",
  organizationId: "20000000-0000-4000-8000-000000000001",
  email: "member@example.com",
  displayName: "Member User",
  role: "member",
  status: "active",
  createdAt: NOW,
  updatedAt: NOW,
};
const RAW_TOKEN = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const TOKEN_HASH =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SECRET_PASSWORD = "route-test-password-sentinel";
const PROXY_TOKEN = "route-test-proxy-token-sentinel";
const TRUSTED_ORIGIN = "http://127.0.0.1:31900";
const PRIVATE_LAN_ORIGIN = "http://192.168.1.109:31900";
const SESSION_IDENTITY = "A".repeat(43);

const privateLanAuthConfig = loadAgentAuthenticationConfig(
  {
    NODE_ENV: "development",
    WEB_HOST: "0.0.0.0",
    WEB_PORT: "31900",
    AGENT_SERVICE_HOST: "127.0.0.1",
    AGENT_SERVICE_PORT: "31901",
    AGENT_SERVICE_INTERNAL_URL: "http://127.0.0.1:31901",
    AGENT_SERVICE_PROXY_TOKEN: PROXY_TOKEN,
    AGENT_SERVICE_TRUSTED_ORIGINS: PRIVATE_LAN_ORIGIN,
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

const secureConfig: AgentAuthenticationConfig = {
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

const insecureLoopbackConfig: AgentAuthenticationConfig = {
  ...secureConfig,
  cookie: {
    name: "agent_session",
    secure: false,
    maxAgeSeconds: 28_800,
  },
};

function securityEnv() {
  return {
    AGENT_SERVICE_PROXY_TOKEN: PROXY_TOKEN,
    AGENT_SERVICE_TRUSTED_ORIGINS: TRUSTED_ORIGIN,
  };
}

function proxyHeaders(overrides: Record<string, string> = {}) {
  return {
    origin: TRUSTED_ORIGIN,
    "x-agent-proxy-token": PROXY_TOKEN,
    "x-agent-client-ip": "203.0.113.7",
    ...overrides,
  };
}

class FakeAuthService {
  loginCalls: Array<{ email: string; password: string; source: string }> = [];
  logoutCalls: Array<string | null> = [];
  authenticateCalls: Array<string | null> = [];
  publicUserCalls: string[] = [];
  result:
    | Awaited<ReturnType<AuthenticationService["login"]>>
    | null = null;
  principal: Awaited<ReturnType<AuthenticationService["authenticate"]>> = null;
  publicUser: User | null = USER;

  async login(input: { email: string; password: string; source: string }) {
    this.loginCalls.push(input);
    return (
      this.result ?? {
        status: "authenticated" as const,
        user: USER,
        principal: {
          kind: "user" as const,
          userId: USER.id,
          organizationId: USER.organizationId,
          role: USER.role,
          sessionId: "30000000-0000-4000-8000-000000000001",
        },
        rawSessionToken: RAW_TOKEN,
        expiresAt: "2026-08-18T08:00:00.000Z",
      }
    );
  }

  async authenticate(rawToken: string | null) {
    this.authenticateCalls.push(rawToken);
    return this.principal;
  }

  async logout(rawToken: string | null) {
    this.logoutCalls.push(rawToken);
  }

  async findPublicUser(userId: string) {
    this.publicUserCalls.push(userId);
    return this.publicUser;
  }
}

function asAuthService(service: FakeAuthService): AuthenticationService {
  return service as unknown as AuthenticationService;
}

function invalidAuthConfigEnv(sqlitePath: string) {
  return {
    AGENT_SQLITE_PATH: sqlitePath,
    AGENT_AUTH_ALLOW_INSECURE_LOOPBACK_COOKIE: "1",
    AGENT_SERVICE_HOST: "0.0.0.0",
    AGENT_SERVICE_TRUSTED_ORIGINS: TRUSTED_ORIGIN,
  };
}

test("createAgentService closes an owned repository when auth config validation fails", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "agent-auth-config-failure-"));
  const sqlitePath = join(tempDir, "agent.sqlite");

  await assert.rejects(
    createAgentService({ env: invalidAuthConfigEnv(sqlitePath) }),
    /Agent authentication configuration is invalid/,
  );

  await rm(tempDir, { recursive: true });
});

test("createAgentService does not close an injected repository on auth config failure", async () => {
  let closeCalls = 0;
  const repository = {
    close() {
      closeCalls += 1;
    },
  } as unknown as SqliteAgentRepository;

  await assert.rejects(
    createAgentService({
      env: invalidAuthConfigEnv(join(tmpdir(), "unused-agent-auth.sqlite")),
      repository,
    }),
    /Agent authentication configuration is invalid/,
  );

  assert.equal(closeCalls, 0);
});

test("auth contracts register closed login errors and current-session response", () => {
  assert.equal(ApiErrorCodeSchema.safeParse("INVALID_CREDENTIALS").success, true);
  assert.equal(ApiErrorCodeSchema.safeParse("LOGIN_RATE_LIMITED").success, true);

  assert.equal(
    SessionResponseSchema.safeParse({
      authenticated: false,
      user: null,
      extra: "must be rejected",
    }).success,
    false,
  );
  assert.equal(
    SessionResponseSchema.safeParse({ authenticated: false, user: null, sessionIdentity: null }).success,
    true,
  );
  assert.equal(
    SessionResponseSchema.safeParse({ authenticated: false, user: null, sessionIdentity: SESSION_IDENTITY }).success,
    false,
  );
  const defaultedSession = SessionResponseSchema.parse({
    authenticated: true,
    user: USER,
    sessionIdentity: SESSION_IDENTITY,
  });
  assert.equal(defaultedSession.authenticated, true);
  if (!defaultedSession.authenticated) assert.fail("authenticated session expected");
  assert.equal(defaultedSession.canViewUserPresence, false);
  assert.equal(
    SessionResponseSchema.safeParse({
      authenticated: true,
      user: USER,
      sessionIdentity: SESSION_IDENTITY,
      canViewUserPresence: true,
    }).success,
    true,
  );

  assert.equal(
    findHttpContract("GET", "/v1/auth/session")?.path,
    "/v1/auth/session",
  );
  const path: AgentServiceV1Path = "/v1/auth/session";
  assert.equal(path, "/v1/auth/session");

  assert.equal(
    DingTalkPublicConfigResponseSchema.safeParse({ enabled: false }).success,
    true,
  );
  assert.equal(
    DingTalkPublicConfigResponseSchema.safeParse({
      enabled: true,
      clientId: "ding-client-id",
      corpId: "ding-corp-id",
      agentId: "ding-agent-id",
      clientSecret: "must-not-be-public",
    }).success,
    false,
  );
  assert.equal(
    DingTalkWorkbenchLoginRequestSchema.safeParse({ code: "workbench-code" }).success,
    true,
  );
  assert.equal(DingTalkWorkbenchLoginResponseSchema.safeParse({ user: USER }).success, true);
  assert.equal(DingTalkOAuthStartRequestSchema.safeParse({ returnPath: "/" }).success, true);
  assert.equal(
    DingTalkOAuthStartResponseSchema.safeParse({
      authorizationUrl: "https://login.dingtalk.com/oauth2/auth?client_id=client",
      expiresAt: "2026-08-18T00:05:00.000Z",
    }).success,
    true,
  );
  assert.equal(
    DingTalkOAuthCallbackRequestSchema.safeParse({
      code: "oauth-code",
      state: "A".repeat(43),
    }).success,
    true,
  );
  assert.equal(
    DingTalkOAuthCallbackResponseSchema.safeParse({ user: USER, returnPath: "/" }).success,
    true,
  );

  for (const [method, route] of [
    ["GET", "/v1/auth/dingtalk/config"],
    ["POST", "/v1/auth/dingtalk/workbench"],
    ["POST", "/v1/auth/dingtalk/oauth/start"],
    ["POST", "/v1/auth/dingtalk/oauth/callback"],
  ] as const) {
    assert.equal(findHttpContract(method, route)?.path, route);
    const dingTalkPath: AgentServiceV1Path = route;
    assert.equal(dingTalkPath, route);
  }
});

test("login requires proxy trust but no existing session and stores the raw token only in Set-Cookie", async (t) => {
  const service = new FakeAuthService();
  const app = buildAgentApp({
    env: securityEnv(),
    authService: asAuthService(service),
    authConfig: secureConfig,
  });
  t.after(() => app.close());

  const direct = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: { email: USER.email, password: SECRET_PASSWORD },
  });
  assert.equal(direct.statusCode, 401);

  const response = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    headers: proxyHeaders(),
    payload: { email: USER.email, password: SECRET_PASSWORD },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { user: USER });
  assert.equal(JSON.stringify(response.json()).includes(RAW_TOKEN), false);
  assert.equal(JSON.stringify(response.json()).includes(SECRET_PASSWORD), false);
  const cookie = String(response.headers["set-cookie"]);
  assert.match(cookie, /__Host-agent_session=/);
  assert.match(cookie, new RegExp(RAW_TOKEN));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Path=\//);
  assert.doesNotMatch(cookie, /Domain=/i);
  assert.deepEqual(service.loginCalls, [
    { email: USER.email, password: SECRET_PASSWORD, source: "203.0.113.7" },
  ]);
});

test("invalid credential responses are generic and rate limits include Retry-After", async (t) => {
  const service = new FakeAuthService();
  service.result = { status: "invalid-credentials" };
  const app = buildAgentApp({
    env: securityEnv(),
    authService: asAuthService(service),
    authConfig: secureConfig,
  });
  t.after(() => app.close());

  const invalid = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    headers: proxyHeaders(),
    payload: { email: USER.email, password: "wrong-password" },
  });
  assert.equal(invalid.statusCode, 401);
  assert.deepEqual(invalid.json().error, {
    code: "INVALID_CREDENTIALS",
    message: "Email or password is incorrect",
    requestId: invalid.headers["x-request-id"],
  });

  service.result = { status: "rate-limited", retryAfterSeconds: 42 };
  const limited = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    headers: proxyHeaders(),
    payload: { email: USER.email, password: "wrong-password" },
  });
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.headers["retry-after"], "42");
  assert.equal(limited.json().error.code, "LOGIN_RATE_LIMITED");
  assert.equal(limited.json().error.message, "Too many login attempts; try again later");
});

test("logout is idempotent and clears the exact active cookie profile", async (t) => {
  const service = new FakeAuthService();
  const app = buildAgentApp({
    env: securityEnv(),
    authService: asAuthService(service),
    authConfig: insecureLoopbackConfig,
  });
  t.after(() => app.close());

  const absent = await app.inject({
    method: "POST",
    url: "/v1/auth/logout",
    headers: proxyHeaders(),
    payload: {},
  });
  assert.equal(absent.statusCode, 200);
  assert.deepEqual(absent.json(), { ok: true });

  const revoked = await app.inject({
    method: "POST",
    url: "/v1/auth/logout",
    headers: {
      ...proxyHeaders(),
      cookie: `agent_session=${RAW_TOKEN}`,
    },
    payload: {},
  });
  assert.equal(revoked.statusCode, 200);
  assert.deepEqual(revoked.json(), { ok: true });
  assert.deepEqual(service.logoutCalls, [null, RAW_TOKEN]);
  const cookie = String(revoked.headers["set-cookie"]);
  assert.match(cookie, /^agent_session=; Max-Age=0; Path=\/; HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.doesNotMatch(cookie, /Secure/);
  assert.doesNotMatch(cookie, /Domain=/i);
});

test("private-LAN login and logout use the complete insecure cookie attribute boundary", async (t) => {
  const service = new FakeAuthService();
  const env = {
    AGENT_SERVICE_PROXY_TOKEN: PROXY_TOKEN,
    AGENT_SERVICE_TRUSTED_ORIGINS: PRIVATE_LAN_ORIGIN,
  };
  const headers = {
    origin: PRIVATE_LAN_ORIGIN,
    "x-agent-proxy-token": PROXY_TOKEN,
    "x-agent-client-ip": "192.168.1.20",
  };
  const app = buildAgentApp({
    env,
    authService: asAuthService(service),
    authConfig: privateLanAuthConfig,
  });
  t.after(() => app.close());

  const login = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    headers,
    payload: { email: USER.email, password: SECRET_PASSWORD },
  });
  assert.equal(login.statusCode, 200);
  const cookie = String(login.headers["set-cookie"]);
  assert.match(cookie, /^agent_session=/);
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.doesNotMatch(cookie, /Secure|Domain=/i);

  const logout = await app.inject({
    method: "POST",
    url: "/v1/auth/logout",
    headers: {
      ...headers,
      cookie: `agent_session=${RAW_TOKEN}`,
    },
    payload: {},
  });
  assert.equal(logout.statusCode, 200);
  assert.match(String(logout.headers["set-cookie"]), /^agent_session=/);
  assert.doesNotMatch(String(logout.headers["set-cookie"]), /Secure|Domain=/i);
});

test("current session returns either the authenticated public user or a strict unauthenticated body", async (t) => {
  const service = new FakeAuthService();
  service.principal = {
    kind: "user",
    userId: USER.id,
    organizationId: USER.organizationId,
    email: USER.email,
    role: USER.role,
    sessionId: "30000000-0000-4000-8000-000000000001",
  };
  const app = buildAgentApp({
    env: securityEnv(),
    authService: asAuthService(service),
    authConfig: secureConfig,
  });
  t.after(() => app.close());

  const authenticated = await app.inject({
    method: "GET",
    url: "/v1/auth/session",
    headers: {
      ...proxyHeaders(),
      cookie: `__Host-agent_session=${RAW_TOKEN}`,
    },
  });
  assert.equal(authenticated.statusCode, 200);
  assert.deepEqual(authenticated.json(), {
    authenticated: true,
    user: USER,
    sessionIdentity: createHash("sha256").update("30000000-0000-4000-8000-000000000001", "utf8").digest("base64url"),
    canViewUserPresence: false,
  });
  assert.deepEqual(service.authenticateCalls, [RAW_TOKEN]);
  assert.deepEqual(service.publicUserCalls, [USER.id]);

  service.principal = null;
  const anonymous = await app.inject({
    method: "GET",
    url: "/v1/auth/session",
    headers: proxyHeaders(),
  });
  assert.equal(anonymous.statusCode, 200);
  assert.deepEqual(anonymous.json(), { authenticated: false, user: null, sessionIdentity: null });
  assert.equal(SessionResponseSchema.safeParse(anonymous.json()).success, true);
});

test("current session projects only the dedicated user-presence capability", async (t) => {
  const service = new FakeAuthService();
  service.principal = {
    kind: "user",
    userId: USER.id,
    organizationId: USER.organizationId,
    email: USER.email,
    role: USER.role,
    sessionId: "30000000-0000-4000-8000-000000000001",
  };
  const checked: unknown[] = [];
  const app = buildAgentApp({
    env: securityEnv(),
    authService: asAuthService(service),
    authConfig: secureConfig,
    userPresenceAccess: {
      async canView(principal) {
        checked.push(principal);
        return true;
      },
    },
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/v1/auth/session",
    headers: {
      ...proxyHeaders(),
      cookie: `__Host-agent_session=${RAW_TOKEN}`,
    },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().canViewUserPresence, true);
  assert.deepEqual(checked, [service.principal]);
});

test("auth responses and logs do not contain secret sentinels", async (t) => {
  let output = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  });
  const service = new FakeAuthService();
  const app = buildAgentApp({
    env: securityEnv(),
    authService: asAuthService(service),
    authConfig: secureConfig,
    logger: { level: "info", stream },
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    headers: proxyHeaders(),
    payload: { email: USER.email, password: SECRET_PASSWORD },
  });

  assert.equal(response.statusCode, 200);
  const responseWithoutCookie = JSON.stringify({
    payload: response.payload,
    headers: {
      ...response.headers,
      "set-cookie": "[cookie omitted]",
    },
  });
  assert.doesNotMatch(
    `${responseWithoutCookie}\n${output}`,
    new RegExp(`${SECRET_PASSWORD}|${PROXY_TOKEN}|${TOKEN_HASH}`),
  );
});
