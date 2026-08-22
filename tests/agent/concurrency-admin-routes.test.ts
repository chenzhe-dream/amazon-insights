import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { buildAgentApp } from "../../server/app";
import type { AuthenticationService } from "../../server/auth/authentication-service";
import type { AgentAuthenticationConfig } from "../../server/config";
import { PostgresResourceGovernor } from "../../server/db/concurrency-control-repository";
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
    fetchVisits: async (url) => {
      transportCalls += 1;
      assert.equal(url, "https://seller.example.test/v1/visits");
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

  const serializedRows = JSON.stringify(
    (await postgres.pool.query("SELECT * FROM seller_sprite_quota_snapshots")).rows,
  );
  assert.doesNotMatch(serializedRows, /https?:|authorization|cookie/i);
});
