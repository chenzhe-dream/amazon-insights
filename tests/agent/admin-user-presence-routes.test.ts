import assert from "node:assert/strict";
import test from "node:test";

import { buildAgentApp } from "../../server/app";
import type { AuthenticationService } from "../../server/auth/authentication-service";
import type {
  AdminUserPresenceHeartbeatInput,
  AdminUserPresenceHeartbeatResult,
  AdminUserPresenceReadInput,
  AdminUserPresenceReadResult,
  AdminUserPresenceRepository,
  AdminUserPresenceUserFact,
} from "../../server/db/admin-user-presence-repository";
import type { AgentAuthenticationConfig } from "../../server/config";
import { AdminUserPresenceResponseSchema } from "../../shared/agent-contracts";

const ORIGIN = "http://127.0.0.1:31900";
const PROXY_TOKEN = "presence-route-proxy-sentinel";
const RAW_TOKEN = "C".repeat(43);
const INTERNAL_ORGANIZATION = "internal-org-sentinel";
const INTERNAL_ADMIN = "internal-admin-sentinel";
const INTERNAL_MEMBER = "internal-member-sentinel";
const INTERNAL_SESSION = "internal-session-sentinel";

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

type Principal = NonNullable<
  Awaited<ReturnType<AuthenticationService["authenticate"]>>
>;

function principal(role: "admin" | "member"): Principal {
  return {
    kind: "user",
    userId: role === "admin" ? INTERNAL_ADMIN : INTERNAL_MEMBER,
    organizationId: INTERNAL_ORGANIZATION,
    email: `${role}@example.com`,
    role,
    sessionId: INTERNAL_SESSION,
  };
}

class FakeAuthService {
  constructor(readonly currentPrincipal: Principal | null) {}

  async authenticate(rawToken: string | null) {
    return rawToken === RAW_TOKEN ? this.currentPrincipal : null;
  }
}

function asAuthService(service: FakeAuthService): AuthenticationService {
  return service as unknown as AuthenticationService;
}

class FakePresenceRepository implements AdminUserPresenceRepository {
  listCalls: AdminUserPresenceReadInput[] = [];
  heartbeatCalls: AdminUserPresenceHeartbeatInput[] = [];
  listResult: AdminUserPresenceReadResult = { users: [presenceFact()] };
  heartbeatResult: AdminUserPresenceHeartbeatResult = "recorded";
  listFailure: Error | null = null;

  async listOrganizationUsers(input: AdminUserPresenceReadInput) {
    this.listCalls.push(input);
    if (this.listFailure) throw this.listFailure;
    return this.listResult;
  }

  async recordHeartbeat(input: AdminUserPresenceHeartbeatInput) {
    this.heartbeatCalls.push(input);
    return this.heartbeatResult;
  }
}

function presenceFact(
  overrides: Partial<AdminUserPresenceUserFact> = {},
): AdminUserPresenceUserFact {
  return {
    account: "visible-admin@example.com",
    displayName: "Visible Admin",
    role: "admin",
    accountStatus: "active",
    loginCount: 1,
    lastLoginAt: "2026-08-31T00:00:00.000Z",
    lastActivityAt: "2026-08-31T00:04:00.000Z",
    validSessionExpiresAt: "2026-08-31T08:00:00.000Z",
    hasValidSession: true,
    hasRecentlyActiveValidSession: true,
    recentLogins: [
      {
        loggedInAt: "2026-08-31T00:00:00.000Z",
        lastActivityAt: "2026-08-31T00:04:00.000Z",
        expiresAt: "2026-08-31T08:00:00.000Z",
        revokedAt: null,
      },
    ],
    ...overrides,
  };
}

function securityEnv() {
  return {
    AGENT_SERVICE_PROXY_TOKEN: PROXY_TOKEN,
    AGENT_SERVICE_TRUSTED_ORIGINS: ORIGIN,
  };
}

function proxyHeaders(withSession = true) {
  return {
    origin: ORIGIN,
    "x-agent-proxy-token": PROXY_TOKEN,
    ...(withSession
      ? { cookie: `__Host-agent_session=${RAW_TOKEN}` }
      : {}),
  };
}

function buildPresenceApp(
  role: "admin" | "member" | null,
  repository: AdminUserPresenceRepository | null,
) {
  return buildAgentApp({
    env: securityEnv(),
    authConfig,
    authService: asAuthService(
      new FakeAuthService(role === null ? null : principal(role)),
    ),
    adminUserPresenceRepository: repository,
  });
}

function assertPublicPayload(payload: unknown) {
  const serialized = JSON.stringify(payload);
  assert.doesNotMatch(
    serialized,
    /cookie|token|hash|password|session[_ -]?id|credential|\bip(?: address)?\b|\bsql\b|\bquery\b|\btable\b|internal-(?:org|admin|member|session)-sentinel/i,
  );
}

test("admin presence GET is centrally authenticated and admin-only", async (t) => {
  const repository = new FakePresenceRepository();
  const unauthenticated = buildPresenceApp(null, repository);
  const member = buildPresenceApp("member", repository);
  t.after(async () => {
    await unauthenticated.close();
    await member.close();
  });

  const missing = await unauthenticated.inject({
    method: "GET",
    url: "/v1/admin/users",
    headers: proxyHeaders(false),
  });
  assert.equal(missing.statusCode, 401);
  assertPublicPayload(missing.json());

  const forbidden = await member.inject({
    method: "GET",
    url: "/v1/admin/users",
    headers: proxyHeaders(),
  });
  assert.equal(forbidden.statusCode, 403);
  assertPublicPayload(forbidden.json());
  assert.equal(repository.listCalls.length, 0);
});

test("admin presence GET scopes the repository and shares one server asOf with the strict response", async (t) => {
  const repository = new FakePresenceRepository();
  const app = buildPresenceApp("admin", repository);
  t.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: "/v1/admin/users?organizationId=attacker-org",
    headers: proxyHeaders(),
  });

  assert.equal(response.statusCode, 200);
  assert.equal(repository.listCalls.length, 1);
  const read = repository.listCalls[0];
  assert.ok(read);
  assert.deepEqual(Object.keys(read).sort(), ["asOf", "organizationId"]);
  assert.equal(read.organizationId, INTERNAL_ORGANIZATION);
  assert.equal(Number.isNaN(new Date(read.asOf).getTime()), false);

  const payload = response.json();
  assert.equal(AdminUserPresenceResponseSchema.safeParse(payload).success, true);
  assert.deepEqual(payload, {
    asOf: read.asOf,
    recentActivityWindowSeconds: 300,
    users: [
      {
        account: "visible-admin@example.com",
        displayName: "Visible Admin",
        role: "admin",
        accountStatus: "active",
        presenceStatus: "recently-online",
        loginCount: 1,
        lastLoginAt: "2026-08-31T00:00:00.000Z",
        lastActivityAt: "2026-08-31T00:04:00.000Z",
        validSessionExpiresAt: "2026-08-31T08:00:00.000Z",
        recentLogins: [
          {
            loggedInAt: "2026-08-31T00:00:00.000Z",
            lastActivityAt: "2026-08-31T00:04:00.000Z",
            expiresAt: "2026-08-31T08:00:00.000Z",
            invalidationReason: null,
          },
        ],
      },
    ],
  });
  assertPublicPayload(payload);
});

test("activity POST requires a valid session and accepts admin or member principals", async (t) => {
  const repository = new FakePresenceRepository();
  const unauthenticated = buildPresenceApp(null, repository);
  const admin = buildPresenceApp("admin", repository);
  const member = buildPresenceApp("member", repository);
  t.after(async () => {
    await unauthenticated.close();
    await admin.close();
    await member.close();
  });

  for (const headers of [proxyHeaders(false), proxyHeaders()]) {
    const response = await unauthenticated.inject({
      method: "POST",
      url: "/v1/auth/activity",
      headers,
      payload: {},
    });
    assert.equal(response.statusCode, 401);
    assertPublicPayload(response.json());
  }

  for (const app of [admin, member]) {
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/activity",
      headers: proxyHeaders(),
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { ok: true });
    assertPublicPayload(response.json());
  }

  assert.equal(repository.heartbeatCalls.length, 2);
  for (const call of repository.heartbeatCalls) {
    assert.deepEqual(Object.keys(call).sort(), [
      "asOf",
      "organizationId",
      "sessionId",
      "userId",
    ]);
    assert.equal(call.organizationId, INTERNAL_ORGANIZATION);
    assert.equal(call.sessionId, INTERNAL_SESSION);
    assert.equal(Number.isNaN(new Date(call.asOf).getTime()), false);
  }
  assert.equal(repository.heartbeatCalls[0]?.userId, INTERNAL_ADMIN);
  assert.equal(repository.heartbeatCalls[1]?.userId, INTERNAL_MEMBER);
});

test("recorded and throttled activity are indistinguishable while inactive fails closed", async (t) => {
  const repository = new FakePresenceRepository();
  const app = buildPresenceApp("member", repository);
  t.after(() => app.close());

  for (const result of ["recorded", "throttled"] as const) {
    repository.heartbeatResult = result;
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/activity",
      headers: proxyHeaders(),
      payload: {},
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { ok: true });
  }

  repository.heartbeatResult = "inactive";
  const inactive = await app.inject({
    method: "POST",
    url: "/v1/auth/activity",
    headers: proxyHeaders(),
    payload: {},
  });
  assert.equal(inactive.statusCode, 401);
  assert.equal(inactive.json().error.code, "AUTHENTICATION_REQUIRED");
  assert.doesNotMatch(inactive.payload, /inactive/i);
  assertPublicPayload(inactive.json());
});

test("activity POST rejects every client identity or time field without echoing it", async (t) => {
  const repository = new FakePresenceRepository();
  const app = buildPresenceApp("member", repository);
  t.after(() => app.close());

  for (const payload of [
    { organizationId: "attacker-org" },
    { userId: "attacker-user" },
    { sessionId: "attacker-session" },
    { asOf: "2099-01-01T00:00:00.000Z" },
    { clientTime: "2099-01-01T00:00:00.000Z" },
  ]) {
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/activity",
      headers: proxyHeaders(),
      payload,
    });
    assert.equal(response.statusCode, 400, JSON.stringify(payload));
    assert.equal(response.json().error.code, "VALIDATION_ERROR");
    assertPublicPayload(response.json());
  }
  assert.equal(repository.heartbeatCalls.length, 0);
});

test("missing repository, repository failures, and contract failures return safe non-partial errors", async (t) => {
  const missing = buildPresenceApp("admin", null);
  const failedRepository = new FakePresenceRepository();
  failedRepository.listFailure = new Error(
    "SQL SELECT token_hash FROM sessions WHERE organization_id=internal-org-sentinel",
  );
  const failed = buildPresenceApp("admin", failedRepository);
  const invalidRepository = new FakePresenceRepository();
  invalidRepository.listResult = {
    users: [presenceFact({ account: "not-an-email" })],
  };
  const invalid = buildPresenceApp("admin", invalidRepository);
  t.after(async () => {
    await missing.close();
    await failed.close();
    await invalid.close();
  });

  for (const [app, expectedStatus] of [
    [missing, 503],
    [failed, 500],
    [invalid, 500],
  ] as const) {
    const response = await app.inject({
      method: "GET",
      url: "/v1/admin/users",
      headers: proxyHeaders(),
    });
    assert.equal(response.statusCode, expectedStatus);
    const payload = response.json();
    assert.equal(Array.isArray(payload.users), false);
    assertPublicPayload(payload);
  }
});
