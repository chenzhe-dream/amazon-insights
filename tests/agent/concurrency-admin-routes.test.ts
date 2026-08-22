import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { buildAgentApp } from "../../server/app";
import type { AuthenticationService } from "../../server/auth/authentication-service";
import type { AgentAuthenticationConfig } from "../../server/config";
import {
  PostgresResourceGovernor,
  UnavailableConcurrencyControlRepository,
} from "../../server/db/concurrency-control-repository";
import { PostgresAgentRepository } from "../../server/db/postgres-repository";
import { runPostgresMigrations } from "../../server/db/postgres/migrations";
import {
  SellerSpriteQuotaService,
  type ConcurrencyAdminService,
} from "../../server/services/seller-sprite-quota-service";
import {
  ConcurrencyAdminResponseSchema,
  type User,
} from "../../shared/agent-contracts";
import {
  startPostgresTestContainer,
} from "./helpers/postgres-test-container";

const origin = "http://127.0.0.1:31900";
const proxyToken = "concurrency-admin-proxy-token";
const rawToken = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const checkedAt = "2026-08-22T08:00:00.000Z";
const organizationId = "20000000-0000-4000-8000-000000000001";
const primaryUser = user("10000000-0000-4000-8000-000000000001", organizationId, "admin@example.com", "admin");
const ordinaryAdmin = user("10000000-0000-4000-8000-000000000002", organizationId, "ops@example.com", "admin");
const memberUser = user("10000000-0000-4000-8000-000000000003", organizationId, "member@example.com", "member");

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

function securityEnv() {
  return {
    AGENT_SERVICE_PROXY_TOKEN: proxyToken,
    AGENT_SERVICE_TRUSTED_ORIGINS: origin,
  };
}

function sessionHeaders() {
  return {
    origin,
    "x-agent-proxy-token": proxyToken,
    cookie: `__Host-agent_session=${rawToken}`,
  };
}

function user(
  id: string,
  organizationId: string,
  email: string,
  role: User["role"],
): User {
  return {
    id,
    organizationId,
    email,
    displayName: email,
    role,
    status: "active",
    createdAt: checkedAt,
    updatedAt: checkedAt,
  };
}

class FakeAuthService {
  constructor(
    readonly principalUser: User | null,
    readonly loadedUser: User | null = principalUser,
  ) {}

  async authenticate(token: string | null) {
    if (token !== rawToken || !this.principalUser) return null;
    return {
      kind: "user" as const,
      userId: this.principalUser.id,
      organizationId: this.principalUser.organizationId,
      role: this.principalUser.role,
      sessionId: "10000000-0000-4000-8000-000000000099",
    };
  }

  async findPublicUser(userId: string) {
    return this.loadedUser?.id === userId ? this.loadedUser : null;
  }
}

function asAuthService(service: FakeAuthService): AuthenticationService {
  return service as unknown as AuthenticationService;
}

function adminSnapshot(organizationId = "20000000-0000-4000-8000-000000000001") {
  return {
    schemaVersion: "1.0.0" as const,
    organizationId,
    queue: {
      queued: 2,
      running: 1,
      paused: 0,
      terminal: 3,
    },
    policy: {
      version: "standard-v1",
      profile: "standard" as const,
      limits: {
        wholeJob: 4,
        sellerSprite: 2,
        sif: 1,
        sorftime: 1,
        model: 2,
        image: 2,
      },
      sellerSpriteRolling: {
        maxAttempts: 30,
        windowMs: 60_000,
      },
    },
    connectors: {
      sellerSprite: {
        configured: true,
        available: true,
        reason: null,
        checkedAt,
        circuit: {
          paused: false,
          manualHold: false,
          reason: null,
          updatedAt: null,
        },
      },
      sif: {
        configured: false,
        available: false,
        reason: "SIF credential is not configured",
        checkedAt: null,
        circuit: {
          paused: false,
          manualHold: false,
          reason: null,
          updatedAt: null,
        },
      },
      sorftime: {
        configured: false,
        available: false,
        reason: "Sorftime credential is not configured",
        checkedAt: null,
        circuit: {
          paused: false,
          manualHold: false,
          reason: null,
          updatedAt: null,
        },
      },
    },
    sellerSpriteQuota: {
      total: null,
      totalLabel: "总额度未知",
      remaining: 300,
      used: null,
      localObservedAttempts: 7,
      source: "provider" as const,
      status: "ok" as const,
      checkedAt,
      ageSeconds: 60,
      warning: null,
    },
  };
}

class FakeConcurrencyAdminService implements ConcurrencyAdminService {
  calls: Array<{ method: string; organizationId: string; actorUserId?: string; body?: unknown }> = [];

  async read(input: { organizationId: string }) {
    this.calls.push({ method: "read", organizationId: input.organizationId });
    return adminSnapshot(input.organizationId);
  }

  async setPolicy(input: { organizationId: string; actorUserId: string; profile: "conservative" | "standard" | "fast" }) {
    this.calls.push({ method: "setPolicy", organizationId: input.organizationId, actorUserId: input.actorUserId, body: input });
    return adminSnapshot(input.organizationId);
  }

  async setManualTotal(input: { organizationId: string; actorUserId: string; total: number | null }) {
    this.calls.push({ method: "setManualTotal", organizationId: input.organizationId, actorUserId: input.actorUserId, body: input });
    return adminSnapshot(input.organizationId);
  }

  async refreshQuota(input: { organizationId: string; actorUserId: string }) {
    this.calls.push({ method: "refreshQuota", organizationId: input.organizationId, actorUserId: input.actorUserId });
    return adminSnapshot(input.organizationId);
  }

  async setPause(input: { organizationId: string; actorUserId: string; resource: "sellerSprite"; paused: boolean }) {
    this.calls.push({ method: "setPause", organizationId: input.organizationId, actorUserId: input.actorUserId, body: input });
    return adminSnapshot(input.organizationId);
  }

  async resetCircuit(input: { organizationId: string; actorUserId: string; connectorId: "sellerSprite" | "sif" | "sorftime" }) {
    this.calls.push({ method: "resetCircuit", organizationId: input.organizationId, actorUserId: input.actorUserId, body: input });
    return adminSnapshot(input.organizationId);
  }
}

test("concurrency admin routes enforce role and repository-loaded primary administrator", async (t) => {
  const service = new FakeConcurrencyAdminService();
  const member = buildAgentApp({
    env: securityEnv(),
    authConfig,
    authService: asAuthService(new FakeAuthService(memberUser)),
    concurrencyAdminService: service,
  });
  const ordinary = buildAgentApp({
    env: securityEnv(),
    authConfig,
    authService: asAuthService(new FakeAuthService(ordinaryAdmin)),
    concurrencyAdminService: service,
  });
  const spoofed = buildAgentApp({
    env: securityEnv(),
    authConfig,
    authService: asAuthService(new FakeAuthService(ordinaryAdmin, ordinaryAdmin)),
    concurrencyAdminService: service,
  });
  const primary = buildAgentApp({
    env: securityEnv(),
    authConfig,
    authService: asAuthService(new FakeAuthService(primaryUser)),
    concurrencyAdminService: service,
  });
  t.after(async () => {
    await member.close();
    await ordinary.close();
    await spoofed.close();
    await primary.close();
  });

  const memberRead = await member.inject({
    method: "GET",
    url: "/v1/admin/concurrency",
    headers: sessionHeaders(),
  });
  assert.equal(memberRead.statusCode, 403);

  const ordinaryRead = await ordinary.inject({
    method: "GET",
    url: "/v1/admin/concurrency",
    headers: sessionHeaders(),
  });
  assert.equal(ordinaryRead.statusCode, 200);
  assert.equal(ConcurrencyAdminResponseSchema.safeParse(ordinaryRead.json()).success, true);

  const ordinaryMutation = await ordinary.inject({
    method: "PUT",
    url: "/v1/admin/concurrency/policy",
    headers: sessionHeaders(),
    payload: { profile: "conservative" },
  });
  assert.equal(ordinaryMutation.statusCode, 403);

  const spoofedMutation = await spoofed.inject({
    method: "PUT",
    url: "/v1/admin/concurrency/policy?email=admin@example.com",
    headers: sessionHeaders(),
    payload: {
      email: "admin@example.com",
      role: "admin",
      organizationId: "org-b",
      profile: "conservative",
    },
  });
  assert.equal(spoofedMutation.statusCode, 403);

  const primaryMutation = await primary.inject({
    method: "PUT",
    url: "/v1/admin/concurrency/policy",
    headers: sessionHeaders(),
    payload: {
      organizationId: "org-b",
      profile: "conservative",
    },
  });
  assert.equal(primaryMutation.statusCode, 200);
  assert.equal(service.calls.at(-1)?.method, "setPolicy");
  assert.equal(service.calls.at(-1)?.organizationId, primaryUser.organizationId);
  assert.equal(service.calls.at(-1)?.actorUserId, primaryUser.id);
});

test("PostgreSQL quota controls persist safe state, audit mutations, and never store raw provider material", async (t) => {
  const postgres = await startPostgresTestContainer();
  await runPostgresMigrations(postgres.pool);
  const repository = new PostgresAgentRepository(postgres.pool);
  const now = new Date(checkedAt);
  let transportCalls = 0;
  const service = new SellerSpriteQuotaService({
    store: repository.concurrencyControl,
    governor: new PostgresResourceGovernor(repository.concurrencyControl, "quota-test-owner"),
    visitsUrl: "https://seller.example.test/v1/visits",
    secretKey: "seller-quota-secret-sentinel",
    fetchVisits: async (url, init) => {
      transportCalls += 1;
      assert.equal(url, "https://seller.example.test/v1/visits");
      assert.equal((init.headers as Record<string, string>)["secret-key"], "seller-quota-secret-sentinel");
      assert.ok(init.signal instanceof AbortSignal);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          remaining: 8,
          used: 92,
        }),
      } as Response;
    },
    clock: () => now,
    createId: () => randomUUID(),
  });
  t.after(async () => {
    await repository.close();
    await postgres.close();
  });

  await repository.createUser({
    id: primaryUser.id,
    organizationId: primaryUser.organizationId,
    email: primaryUser.email,
    displayName: primaryUser.displayName,
    role: "admin",
    status: "active",
    createdAt: checkedAt,
    updatedAt: checkedAt,
  });

  await service.setManualTotal({
    organizationId: primaryUser.organizationId,
    actorUserId: primaryUser.id,
    total: 100,
  });
  const refreshed = await service.refreshQuota({
    organizationId: primaryUser.organizationId,
    actorUserId: primaryUser.id,
  });

  assert.equal(transportCalls, 1);
  assert.equal(refreshed.sellerSpriteQuota.status, "conservative");
  assert.equal(refreshed.policy.profile, "conservative");
  assert.equal(refreshed.sellerSpriteQuota.total, 100);
  assert.equal(refreshed.sellerSpriteQuota.remaining, 8);
  assert.equal(refreshed.sellerSpriteQuota.used, 92);

  const persisted = await postgres.pool.query<{
    action: string;
    metadata_json: unknown;
  }>(
    `SELECT action, metadata_json
       FROM audit_events
      WHERE organization_id = $1
      ORDER BY created_at, action`,
    [primaryUser.organizationId],
  );
  assert.deepEqual(
    persisted.rows.map((row) => row.action),
    [
      "concurrency.policy-changed",
      "seller-sprite.quota-refreshed",
      "seller-sprite.quota-total-updated",
    ].sort(),
  );
  const serialized = JSON.stringify(persisted.rows);
  assert.doesNotMatch(serialized, /raw-provider-secret-sentinel|seller\.example|authorization|cookie/i);

  const attempts = await postgres.pool.query<{ count: number }>(
    `SELECT count(*)::integer AS count
       FROM concurrency_physical_attempts
      WHERE organization_id = $1
        AND resource = 'sellerSprite'
        AND attempt_kind = 'quota-refresh'`,
    [primaryUser.organizationId],
  );
  assert.equal(attempts.rows[0]?.count, 1);
});

test("manual quota refresh requires explicit config, times out safely, and audits every safe result", async (t) => {
  const postgres = await startPostgresTestContainer();
  await runPostgresMigrations(postgres.pool);
  const repository = new PostgresAgentRepository(postgres.pool);
  t.after(async () => {
    await repository.close();
    await postgres.close();
  });
  await repository.createUser({
    id: primaryUser.id,
    organizationId: primaryUser.organizationId,
    email: primaryUser.email,
    displayName: primaryUser.displayName,
    role: "admin",
    status: "active",
    createdAt: checkedAt,
    updatedAt: checkedAt,
  });

  let missingConfigCalls = 0;
  const missingConfig = new SellerSpriteQuotaService({
    store: repository.concurrencyControl,
    governor: new PostgresResourceGovernor(repository.concurrencyControl, "quota-missing-config"),
    visitsUrl: null,
    secretKey: null,
    fetchVisits: async () => {
      missingConfigCalls += 1;
      throw new Error("must not call transport");
    },
    clock: () => new Date(checkedAt),
    createId: () => randomUUID(),
  });
  await assert.rejects(
    missingConfig.refreshQuota({
      organizationId: primaryUser.organizationId,
      actorUserId: primaryUser.id,
    }),
    /not configured/i,
  );
  assert.equal(missingConfigCalls, 0);

  const responses = [
    { kind: "malformed" as const, response: { ok: true, status: 200, body: { remaining: 1, raw: "extra" } } },
    { kind: "upstream" as const, response: { ok: false, status: 503, body: {} } },
    { kind: "visit-max" as const, response: { ok: true, status: 200, body: { code: "ERROR_VISIT_MAX" } } },
  ];
  let quotaClockTicks = 0;
  const quotaClock = () => new Date(new Date(checkedAt).getTime() + quotaClockTicks++ * 1000);
  const service = new SellerSpriteQuotaService({
    store: repository.concurrencyControl,
    governor: new PostgresResourceGovernor(repository.concurrencyControl, "quota-audit-owner"),
    visitsUrl: "https://seller.example.test/v1/visits",
    secretKey: "seller-quota-secret-sentinel",
    fetchVisits: async (_url, init) => {
      assert.equal((init.headers as Record<string, string>)["secret-key"], "seller-quota-secret-sentinel");
      const next = responses.shift();
      assert.ok(next);
      return {
        ok: next.response.ok,
        status: next.response.status,
        json: async () => next.response.body,
      } as Response;
    },
    clock: quotaClock,
    createId: () => randomUUID(),
  });
  await service.refreshQuota({ organizationId: primaryUser.organizationId, actorUserId: primaryUser.id });
  await service.refreshQuota({ organizationId: primaryUser.organizationId, actorUserId: primaryUser.id });
  await service.refreshQuota({ organizationId: primaryUser.organizationId, actorUserId: primaryUser.id });
  await service.resetCircuit({
    organizationId: primaryUser.organizationId,
    actorUserId: primaryUser.id,
    connectorId: "sellerSprite",
  });

  let abortSeen = false;
  const timeoutService = new SellerSpriteQuotaService({
    store: repository.concurrencyControl,
    governor: new PostgresResourceGovernor(repository.concurrencyControl, "quota-timeout-owner"),
    visitsUrl: "https://seller.example.test/v1/visits",
    secretKey: "seller-quota-secret-sentinel",
    timeoutMs: 1,
    fetchVisits: async (_url, init) => new Promise<Response>((_resolve, reject) => {
      const signal = init.signal;
      assert.ok(signal);
      signal.addEventListener("abort", () => {
        abortSeen = true;
        reject(new DOMException("aborted", "AbortError"));
      });
    }),
    clock: quotaClock,
    createId: () => randomUUID(),
  });
  const timeoutSnapshot = await timeoutService.refreshQuota({
    organizationId: primaryUser.organizationId,
    actorUserId: primaryUser.id,
  });
  assert.equal(abortSeen, true);
  assert.equal(timeoutSnapshot.sellerSpriteQuota.status, "error");

  const audit = await postgres.pool.query<{ action: string; metadata_json: { status?: string; errorCode?: string } }>(
    `SELECT action, metadata_json
       FROM audit_events
      WHERE organization_id = $1
        AND action = 'seller-sprite.quota-refreshed'
      ORDER BY created_at, id`,
    [primaryUser.organizationId],
  );
  assert.deepEqual(
    audit.rows.map((row) => row.metadata_json),
    [
      { status: "error", errorCode: "MALFORMED_RESPONSE" },
      { status: "error", errorCode: "UPSTREAM_UNAVAILABLE" },
      { status: "paused", errorCode: "ERROR_VISIT_MAX" },
      { status: "error", errorCode: "REQUEST_TIMEOUT" },
    ],
  );
  assert.doesNotMatch(JSON.stringify(audit.rows), /seller-quota-secret|seller\.example|authorization|cookie|raw/i);
});

test("scheduled quota refresh uses a system-safe audit event and opens the SellerSprite circuit without a fake actor", async (t) => {
  const postgres = await startPostgresTestContainer();
  await runPostgresMigrations(postgres.pool);
  const repository = new PostgresAgentRepository(postgres.pool);
  t.after(async () => {
    await repository.close();
    await postgres.close();
  });

  const service = new SellerSpriteQuotaService({
    store: repository.concurrencyControl,
    governor: new PostgresResourceGovernor(repository.concurrencyControl, "quota-scheduled-owner"),
    visitsUrl: "https://seller.example.test/v1/visits",
    secretKey: "seller-quota-secret-sentinel",
    fetchVisits: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ code: "ERROR_VISIT_MAX" }),
    }) as Response,
    clock: () => new Date(checkedAt),
    createId: () => randomUUID(),
  });

  const refreshed = await service.refreshQuota({
    organizationId: primaryUser.organizationId,
    actorUserId: null,
  });
  assert.equal(refreshed.connectors.sellerSprite.circuit.paused, true);
  assert.equal(refreshed.connectors.sellerSprite.circuit.manualHold, false);

  await assert.rejects(
    repository.concurrencyControl.acquirePermit({
      organizationId: primaryUser.organizationId,
      resource: "sellerSprite",
      jobId: "scheduled-visit-max",
      attemptKind: "initial",
      ownerId: "scheduled-owner",
      leaseMs: 30_000,
      maxWaitMs: 0,
    }),
    /capacity|unavailable/i,
  );

  const audit = await postgres.pool.query<{ actor_user_id: string | null; action: string; metadata_json: unknown }>(
    `SELECT actor_user_id, action, metadata_json
       FROM audit_events
      WHERE organization_id = $1
        AND action = 'seller-sprite.quota-refreshed-scheduled'`,
    [primaryUser.organizationId],
  );
  assert.deepEqual(audit.rows, [{
    actor_user_id: null,
    action: "seller-sprite.quota-refreshed-scheduled",
    metadata_json: { status: "paused", errorCode: "ERROR_VISIT_MAX" },
  }]);
});

test("scheduled quota refresh bypasses only the SellerSprite business circuit while preserving governor admission", async (t) => {
  const postgres = await startPostgresTestContainer();
  await runPostgresMigrations(postgres.pool);
  const repository = new PostgresAgentRepository(postgres.pool);
  t.after(async () => {
    await repository.close();
    await postgres.close();
  });
  await repository.createUser({
    id: primaryUser.id,
    organizationId: primaryUser.organizationId,
    email: primaryUser.email,
    displayName: primaryUser.displayName,
    role: "admin",
    status: "active",
    createdAt: checkedAt,
    updatedAt: checkedAt,
  });
  await repository.concurrencyControl.setSellerSpriteManualPause({
    organizationId: primaryUser.organizationId,
    actorUserId: primaryUser.id,
    paused: true,
    updatedAt: "2026-08-22T08:10:00.000Z",
    auditEventId: "10000000-0000-4000-8000-0000000000b1",
  });

  const responses = [
    { remaining: 8, used: 92, total: 100 },
    { remaining: 90, used: 10, total: 100 },
  ];
  let fetchCalls = 0;
  let quotaClockTicks = 0;
  const quotaClock = () => new Date(new Date(checkedAt).getTime() + quotaClockTicks++ * 1000);
  const service = new SellerSpriteQuotaService({
    store: repository.concurrencyControl,
    governor: new PostgresResourceGovernor(repository.concurrencyControl, "quota-manual-hold-owner"),
    visitsUrl: "https://seller.example.test/v1/visits",
    secretKey: "seller-quota-secret-sentinel",
    fetchVisits: async () => {
      fetchCalls += 1;
      const body = responses.shift();
      assert.ok(body);
      return {
        ok: true,
        status: 200,
        json: async () => body,
      } as Response;
    },
    clock: quotaClock,
    createId: () => randomUUID(),
  });

  const lowQuota = await service.refreshQuota({
    organizationId: primaryUser.organizationId,
    actorUserId: null,
  });
  assert.equal(fetchCalls, 1);
  assert.equal(lowQuota.sellerSpriteQuota.status, "conservative");
  assert.equal(lowQuota.policy.profile, "conservative");
  assert.equal(lowQuota.connectors.sellerSprite.circuit.paused, true);
  assert.equal(lowQuota.connectors.sellerSprite.circuit.manualHold, true);

  const healthyQuota = await service.refreshQuota({
    organizationId: primaryUser.organizationId,
    actorUserId: null,
  });
  assert.equal(fetchCalls, 2);
  assert.equal(healthyQuota.sellerSpriteQuota.status, "ok");
  assert.equal(healthyQuota.policy.profile, "conservative");
  assert.equal(healthyQuota.connectors.sellerSprite.circuit.paused, true);
  assert.equal(healthyQuota.connectors.sellerSprite.circuit.manualHold, true);

  await assert.rejects(
    repository.concurrencyControl.acquirePermit({
      organizationId: primaryUser.organizationId,
      resource: "sellerSprite",
      jobId: "ordinary-business-attempt",
      attemptKind: "initial",
      ownerId: "ordinary-owner",
      leaseMs: 30_000,
      maxWaitMs: 0,
    }),
    /capacity|unavailable/i,
  );
  const attempts = await postgres.pool.query<{ count: number }>(
    `SELECT count(*)::integer AS count
       FROM concurrency_physical_attempts
      WHERE organization_id = $1
        AND resource = 'sellerSprite'
        AND attempt_kind = 'quota-refresh'`,
    [primaryUser.organizationId],
  );
  assert.equal(attempts.rows[0]?.count, 2);

  let unavailableFetchCalls = 0;
  const unavailableGovernorService = new SellerSpriteQuotaService({
    store: repository.concurrencyControl,
    governor: new PostgresResourceGovernor(
      new UnavailableConcurrencyControlRepository(),
      "quota-unavailable-owner",
    ),
    visitsUrl: "https://seller.example.test/v1/visits",
    secretKey: "seller-quota-secret-sentinel",
    fetchVisits: async () => {
      unavailableFetchCalls += 1;
      throw new Error("must not fetch without PG governor");
    },
    clock: () => new Date(checkedAt),
    createId: () => randomUUID(),
  });
  await assert.rejects(
    unavailableGovernorService.refreshQuota({
      organizationId: primaryUser.organizationId,
      actorUserId: null,
    }),
    /capacity|unavailable/i,
  );
  assert.equal(unavailableFetchCalls, 0);
});

test("quota reducer handles unknown total, visit-max pause, sticky manual hold, and no automatic upgrade", async (t) => {
  const postgres = await startPostgresTestContainer();
  await runPostgresMigrations(postgres.pool);
  const repository = new PostgresAgentRepository(postgres.pool);
  const responses = [
    { ok: true, status: 200, body: { remaining: 30 } },
    { ok: true, status: 200, body: { code: "ERROR_VISIT_MAX" } },
    { ok: true, status: 200, body: { remaining: 90, used: 10, total: 100 } },
  ];
  const service = new SellerSpriteQuotaService({
    store: repository.concurrencyControl,
    governor: new PostgresResourceGovernor(repository.concurrencyControl, "quota-reducer-owner"),
    visitsUrl: "https://seller.example.test/v1/visits",
    secretKey: "seller-quota-secret-sentinel",
    fetchVisits: async () => {
      const next = responses.shift();
      assert.ok(next);
      return {
        ok: next.ok,
        status: next.status,
        json: async () => next.body,
      } as Response;
    },
    clock: () => new Date(checkedAt),
    createId: () => randomUUID(),
  });
  t.after(async () => {
    await repository.close();
    await postgres.close();
  });

  await repository.createUser({
    id: primaryUser.id,
    organizationId: primaryUser.organizationId,
    email: primaryUser.email,
    displayName: primaryUser.displayName,
    role: "admin",
    status: "active",
    createdAt: checkedAt,
    updatedAt: checkedAt,
  });

  const unknownTotal = await service.refreshQuota({
    organizationId: primaryUser.organizationId,
    actorUserId: primaryUser.id,
  });
  assert.equal(unknownTotal.sellerSpriteQuota.total, null);
  assert.equal(unknownTotal.sellerSpriteQuota.totalLabel, "总额度未知");
  assert.equal(unknownTotal.sellerSpriteQuota.status, "ok");

  const visitMax = await service.refreshQuota({
    organizationId: primaryUser.organizationId,
    actorUserId: primaryUser.id,
  });
  assert.equal(visitMax.connectors.sellerSprite.circuit.paused, true);
  assert.equal(visitMax.connectors.sellerSprite.circuit.reason, "quota-exhausted");
  assert.equal(visitMax.connectors.sellerSprite.circuit.manualHold, false);

  await service.setPause({
    organizationId: primaryUser.organizationId,
    actorUserId: primaryUser.id,
    resource: "sellerSprite",
    paused: true,
  });
  await service.resetCircuit({
    organizationId: primaryUser.organizationId,
    actorUserId: primaryUser.id,
    connectorId: "sellerSprite",
  });
  const recoveredProvider = await service.refreshQuota({
    organizationId: primaryUser.organizationId,
    actorUserId: primaryUser.id,
  });

  assert.equal(recoveredProvider.policy.profile, "standard");
  assert.equal(recoveredProvider.connectors.sellerSprite.circuit.paused, true);
  assert.equal(recoveredProvider.connectors.sellerSprite.circuit.manualHold, true);
  assert.equal(recoveredProvider.sellerSpriteQuota.status, "ok");
  await assert.rejects(
    repository.concurrencyControl.acquirePermit({
      organizationId: primaryUser.organizationId,
      resource: "sellerSprite",
      jobId: "manual-hold-after-reset",
      attemptKind: "initial",
      ownerId: "manual-hold-owner",
      leaseMs: 30_000,
      maxWaitMs: 0,
    }),
    /capacity|unavailable/i,
  );

  const serializedRows = JSON.stringify(
    (await postgres.pool.query("SELECT * FROM seller_sprite_quota_snapshots")).rows,
  );
  assert.doesNotMatch(serializedRows, /https?:|authorization|cookie/i);
});
