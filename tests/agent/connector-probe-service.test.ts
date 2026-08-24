import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildAgentApp } from "../../server/app";
import type { AuthenticationService } from "../../server/auth/authentication-service";
import { digestSessionToken } from "../../server/auth/session";
import type { AgentAuthenticationConfig } from "../../server/config";
import { createAgentService } from "../../server/agent-service";
import type { ConnectorMap } from "../../server/connectors/connector-contract";
import { createRemoteMcpConnectors } from "../../server/connectors/mcp-connectors";
import { UnavailableConcurrencyControlRepository } from "../../server/db/concurrency-control-repository";
import { PostgresAgentRepository } from "../../server/db/postgres-repository";
import { runPostgresMigrations } from "../../server/db/postgres/migrations";
import {
  openSqliteAgentRepository,
  type SqliteAgentRepository,
} from "../../server/db/sqlite-repository";
import { ConnectorProbeService } from "../../server/services/connector-probe-service";
import { ConnectorCredentialService } from "../../server/services/connector-credential-service";
import { ConnectorHealthSchema } from "../../shared/agent-contracts";
import {
  startPostgresTestContainer,
} from "./helpers/postgres-test-container";
import { startFakeSellerSpriteMcpServer } from "./helpers/fake-sellersprite-mcp-server";

const origin = "http://127.0.0.1:31900";
const proxyToken = "connector-probe-proxy-token";
const proxyHeaders = {
  origin,
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
const checkedAt = "2026-08-17T01:02:03.000Z";

class FakeAuthService {
  constructor(
    readonly role: "admin" | "member",
    readonly organizationId = "10000000-0000-4000-8000-000000000002",
  ) {}

  async authenticate(token: string | null) {
    if (token !== rawToken) return null;
    return {
      kind: "user" as const,
      userId: "10000000-0000-4000-8000-000000000001",
      organizationId: this.organizationId,
      role: this.role,
      sessionId: "10000000-0000-4000-8000-000000000003",
    };
  }
}

function asAuthService(service: FakeAuthService): AuthenticationService {
  return service as unknown as AuthenticationService;
}

function sessionHeaders() {
  return {
    ...proxyHeaders,
    cookie: `__Host-agent_session=${rawToken}`,
  };
}

function testEnv(path: string) {
  return {
    AGENT_SQLITE_PATH: path,
    AGENT_SQLITE_BUSY_TIMEOUT_MS: "5000",
    AGENT_EXECUTION_ACTOR_ID: randomUUID(),
    AGENT_EXECUTION_ORGANIZATION_ID: randomUUID(),
    AGENT_SERVICE_PROXY_TOKEN: proxyToken,
    AGENT_SERVICE_TRUSTED_ORIGINS: origin,
    SIF_MCP_SECRET: "sif-probe-secret-sentinel",
    SORFTIME_MCP_KEY: "sorftime-probe-secret-sentinel",
    SELLERSPRITE_SECRET_KEY: "seller-probe-secret-sentinel",
  };
}

function toolsListResponse() {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }),
    { status: 200 },
  );
}

async function seedAdminSession(
  repository: SqliteAgentRepository,
  organizationId: string,
) {
  await repository.createUser({
    id: "10000000-0000-4000-8000-000000000001",
    organizationId,
    email: "connector-admin@example.com",
    displayName: "Connector Admin",
    role: "admin",
    status: "active",
    createdAt: checkedAt,
    updatedAt: checkedAt,
  });
  await repository.createSession({
    id: "10000000-0000-4000-8000-000000000003",
    userId: "10000000-0000-4000-8000-000000000001",
    tokenHash: digestSessionToken(rawToken),
    expiresAt: "2099-08-18T01:02:03.000Z",
    revokedAt: null,
    createdAt: checkedAt,
    lastSeenAt: null,
  });
}

test("connector probe is admin-only after proxy trust", async (t) => {
  let probeCalls = 0;
  const connectorProbeService = {
    async probe(connectorId: string) {
      probeCalls += 1;
      return {
        connectorId,
        configured: true,
        available: true,
        reason: null,
        checkedAt,
      };
    },
  } as unknown as ConnectorProbeService;
  const member = buildAgentApp({
    env: testEnv("unused-member.sqlite"),
    authConfig,
    authService: asAuthService(new FakeAuthService("member")),
    connectorProbeService,
  });
  const admin = buildAgentApp({
    env: testEnv("unused-admin.sqlite"),
    authConfig,
    authService: asAuthService(new FakeAuthService("admin")),
    connectorProbeService,
  });
  const anonymous = buildAgentApp({
    env: {
      ...testEnv("unused-anonymous.sqlite"),
      AGENT_SERVICE_HOST: "127.0.0.1",
      AGENT_AUTH_ALLOW_ANONYMOUS_LOOPBACK: "1",
    },
    connectorProbeService,
  });
  t.after(async () => {
    await member.close();
    await admin.close();
    await anonymous.close();
  });

  const memberResponse = await member.inject({
    method: "POST",
    url: "/v1/connectors/sif/probe",
    headers: sessionHeaders(),
  });
  assert.equal(memberResponse.statusCode, 403);
  assert.equal(memberResponse.json().error.code, "FORBIDDEN");

  const anonymousResponse = await anonymous.inject({
    method: "POST",
    url: "/v1/connectors/sif/probe",
    headers: proxyHeaders,
  });
  assert.equal(anonymousResponse.statusCode, 403);
  assert.equal(anonymousResponse.json().error.code, "FORBIDDEN");

  const adminResponse = await admin.inject({
    method: "POST",
    url: "/v1/connectors/sif/probe",
    headers: sessionHeaders(),
  });
  assert.equal(adminResponse.statusCode, 200);
  assert.equal(adminResponse.json().available, true);
  assert.equal(probeCalls, 1);
});

test("connector probe uses authenticated principal organization for scope and persisted status", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "connector-principal-org-"));
  const path = join(directory, "agent.sqlite");
  const env = testEnv(path);
  const fixedServiceOrg = "20000000-0000-4000-8000-0000000000aa";
  const principalOrg = "20000000-0000-4000-8000-0000000000bb";
  const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  const capturedScopes: unknown[] = [];
  const connectors = {
    sif: {
      id: "sif",
      execute: async () => {
        throw new Error("unexpected execute");
      },
      probe: async (scope: unknown) => {
        capturedScopes.push(scope);
        return {
          connectorId: "sif",
          configured: true,
          available: true,
          reason: null,
          checkedAt,
        };
      },
    },
    sorftime: {
      id: "sorftime",
      execute: async () => {
        throw new Error("unexpected execute");
      },
      probe: async () => {
        throw new Error("unexpected probe");
      },
    },
    sellerSprite: {
      id: "sellerSprite",
      execute: async () => {
        throw new Error("unexpected execute");
      },
      probe: async () => {
        throw new Error("unexpected probe");
      },
    },
  } as unknown as ConnectorMap;
  const connectorProbeService = new ConnectorProbeService({
    repository,
    organizationId: fixedServiceOrg,
    credentialService: new ConnectorCredentialService({
      repository,
      organizationId: fixedServiceOrg,
      env,
    }),
    connectors,
    clock: () => new Date(checkedAt),
  });
  const app = buildAgentApp({
    env,
    authConfig,
    authService: asAuthService(new FakeAuthService("admin", principalOrg)),
    connectorProbeService,
  });
  t.after(async () => {
    await app.close();
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const response = await app.inject({
    method: "POST",
    url: "/v1/connectors/sif/probe",
    headers: sessionHeaders(),
    payload: { organizationId: fixedServiceOrg },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(capturedScopes, [
    { organizationId: principalOrg, jobId: "connector-probe:sif" },
  ]);
  assert.equal(await repository.findConnectorStatus(fixedServiceOrg, "sif"), null);
  assert.equal(
    (await repository.findConnectorStatus(principalOrg, "sif"))?.health,
    "available",
  );
  const principalProbeService = new ConnectorProbeService({
    repository,
    organizationId: principalOrg,
    credentialService: new ConnectorCredentialService({
      repository,
      organizationId: principalOrg,
      env,
    }),
    connectors,
    clock: () => new Date(checkedAt),
  });
  assert.equal((await principalProbeService.getCapabilities()).sif.available, true);
  assert.equal((await connectorProbeService.getCapabilities()).sif.available, false);
});

test("Agent Service startup is passive and explicit probe persists last-known capability across reopen", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "connector-probe-"));
  const path = join(directory, "agent.sqlite");
  const env = testEnv(path);
  let transportCalls = 0;
  let repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  const connectors = createRemoteMcpConnectors({
    env,
    fetchImpl: async () => {
      transportCalls += 1;
      return toolsListResponse();
    },
    clock: () => new Date(checkedAt),
    sleep: async () => undefined,
    policy: {
      timeoutMs: 100,
      maxAttempts: 2,
      retryDelayMs: 0,
      maxConcurrent: 1,
      maxQueue: 1,
    },
  });
  const service = await createAgentService({ env, repository, connectors });
  await seedAdminSession(repository, env.AGENT_EXECUTION_ORGANIZATION_ID);

  await service.start({ host: "127.0.0.1", port: 0 });
  assert.equal(transportCalls, 0);
  const healthBefore = await service.app.inject({ method: "GET", url: "/health" });
  assert.equal(healthBefore.statusCode, 200);

  const before = await service.app.inject({
    method: "GET",
    url: "/v1/capabilities",
    headers: sessionHeaders(),
  });
  assert.equal(before.statusCode, 200);
  assert.deepEqual(before.json().capabilities.sif, {
    configured: true,
    available: false,
    reason: "Connector health has not been checked",
    checkedAt: null,
  });
  assert.equal(transportCalls, 0);

  const probe = await service.app.inject({
    method: "POST",
    url: "/v1/connectors/sif/probe",
    headers: sessionHeaders(),
  });
  assert.equal(probe.statusCode, 200);
  assert.equal(ConnectorHealthSchema.safeParse(probe.json()).success, true);
  assert.deepEqual(probe.json(), {
    connectorId: "sif",
    configured: true,
    available: true,
    reason: null,
    checkedAt,
  });
  assert.equal(transportCalls, 1);

  const persisted = await repository.findConnectorStatus(
    env.AGENT_EXECUTION_ORGANIZATION_ID,
    "sif",
  );
  assert.equal(persisted?.health, "available");
  assert.equal(persisted?.lastCheckedAt, checkedAt);
  assert.equal(persisted?.lastError, null);

  await service.stop();
  repository.close();
  repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  const reopenedProbeService = new ConnectorProbeService({
    repository,
    organizationId: env.AGENT_EXECUTION_ORGANIZATION_ID,
    credentialService: new ConnectorCredentialService({
      repository,
      organizationId: env.AGENT_EXECUTION_ORGANIZATION_ID,
      env,
    }),
    connectors,
    clock: () => new Date(checkedAt),
  });
  const reopenedCapabilities = await reopenedProbeService.getCapabilities();
  assert.deepEqual(reopenedCapabilities.sif, {
    configured: true,
    available: true,
    reason: null,
    checkedAt,
  });
  assert.equal(transportCalls, 1);

  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
});

test("SellerSprite probe uses only capability negotiation and persists available safely", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "sellersprite-capability-probe-"));
  const path = join(directory, "agent.sqlite");
  const fake = await startFakeSellerSpriteMcpServer();
  const env = {
    ...testEnv(path),
    NODE_ENV: "test",
    SELLERSPRITE_MCP_ENDPOINT: fake.url,
  };
  const requestBodies: string[] = [];
  const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  const service = new ConnectorProbeService({
    repository,
    organizationId: env.AGENT_EXECUTION_ORGANIZATION_ID,
    credentialService: new ConnectorCredentialService({
      repository,
      organizationId: env.AGENT_EXECUTION_ORGANIZATION_ID,
      env,
    }),
    connectors: createRemoteMcpConnectors({
      env,
      fetchImpl: async (input, init) => {
        requestBodies.push(typeof init?.body === "string" ? init.body : "");
        return await fetch(input, init);
      },
      clock: () => new Date(checkedAt),
      sleep: async () => undefined,
      policy: {
        timeoutMs: 100,
        maxAttempts: 1,
        retryDelayMs: 0,
        maxConcurrent: 1,
        maxQueue: 1,
      },
    }),
    clock: () => new Date(checkedAt),
  });
  t.after(async () => {
    repository.close();
    await fake.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const health = await service.probe("sellerSprite");

  assert.deepEqual(health, {
    connectorId: "sellerSprite",
    configured: true,
    available: true,
    reason: null,
    checkedAt,
  });
  assert.deepEqual(fake.requests.map((request) => request.method), [
    "initialize",
    "notifications/initialized",
    "tools/list",
  ]);
  assert.equal(fake.requests.filter((request) => request.method === "tools/call").length, 0);
  assert.doesNotMatch(requestBodies.join("\n"), /\basin\b|B0[A-Z0-9]{8}/i);
  const persisted = await repository.findConnectorStatus(
    env.AGENT_EXECUTION_ORGANIZATION_ID,
    "sellerSprite",
  );
  assert.deepEqual(
    persisted,
    {
      id: persisted?.id,
      organizationId: env.AGENT_EXECUTION_ORGANIZATION_ID,
      connector: "sellerSprite",
      configured: true,
      health: "available",
      lastCheckedAt: checkedAt,
      lastError: null,
      updatedAt: checkedAt,
    },
  );
});

test("SellerSprite initialize failures persist only unavailable safe capability state", async (t) => {
  const cases = [
    { mode: "initialize-http-error" as const, reason: "Connector upstream request failed" },
    { mode: "initialize-hang" as const, reason: "Connector request timed out" },
  ];

  for (const item of cases) {
    const directory = mkdtempSync(join(tmpdir(), `sellersprite-${item.mode}-`));
    const path = join(directory, "agent.sqlite");
    const fake = await startFakeSellerSpriteMcpServer({ mode: item.mode });
    const env = {
      ...testEnv(path),
      NODE_ENV: "test",
      SELLERSPRITE_MCP_ENDPOINT: fake.url,
    };
    const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
    const service = new ConnectorProbeService({
      repository,
      organizationId: env.AGENT_EXECUTION_ORGANIZATION_ID,
      credentialService: new ConnectorCredentialService({
        repository,
        organizationId: env.AGENT_EXECUTION_ORGANIZATION_ID,
        env,
      }),
      connectors: createRemoteMcpConnectors({
        env,
        clock: () => new Date(checkedAt),
        sleep: async () => undefined,
        policy: {
          timeoutMs: 40,
          maxAttempts: 1,
          retryDelayMs: 0,
          maxConcurrent: 1,
          maxQueue: 1,
        },
      }),
      clock: () => new Date(checkedAt),
    });
    t.after(async () => {
      repository.close();
      await fake.close();
      rmSync(directory, { recursive: true, force: true });
    });

    const health = await service.probe("sellerSprite");
    const persisted = await repository.findConnectorStatus(
      env.AGENT_EXECUTION_ORGANIZATION_ID,
      "sellerSprite",
    );

    assert.deepEqual(health, {
      connectorId: "sellerSprite",
      configured: true,
      available: false,
      reason: item.reason,
      checkedAt,
    });
    assert.deepEqual(fake.requests.map((request) => request.method), ["initialize"]);
    assert.equal(fake.requests.filter((request) => request.method === "tools/list").length, 0);
    assert.equal(fake.requests.filter((request) => request.method === "tools/call").length, 0);
    assert.equal(persisted?.health, "unavailable");
    assert.equal(persisted?.lastError?.message, item.reason);
    assert.doesNotMatch(
      JSON.stringify({ health, persisted }),
      /seller-probe-secret-sentinel|fake-session|raw-provider-body-sentinel/i,
    );
  }
});

test("production Agent Service connector probes use the PostgreSQL resource governor", async (t) => {
  const postgres = await startPostgresTestContainer();
  await runPostgresMigrations(postgres.pool);
  const repository = new PostgresAgentRepository(postgres.pool);
  const env = {
    AGENT_EXECUTION_ACTOR_ID: "10000000-0000-4000-8000-000000000001",
    AGENT_EXECUTION_ORGANIZATION_ID: "10000000-0000-4000-8000-000000000002",
    AGENT_SERVICE_PROXY_TOKEN: proxyToken,
    AGENT_SERVICE_TRUSTED_ORIGINS: origin,
    SIF_MCP_SECRET: "sif-probe-secret-sentinel",
  };
  await repository.createUser({
    id: "10000000-0000-4000-8000-000000000001",
    organizationId: env.AGENT_EXECUTION_ORGANIZATION_ID,
    email: "pg-connector-admin@example.com",
    displayName: "PG Connector Admin",
    role: "admin",
    status: "active",
    createdAt: checkedAt,
    updatedAt: checkedAt,
  });
  await repository.createSession({
    id: "10000000-0000-4000-8000-000000000003",
    userId: "10000000-0000-4000-8000-000000000001",
    tokenHash: digestSessionToken(rawToken),
    expiresAt: "2099-08-18T01:02:03.000Z",
    revokedAt: null,
    createdAt: checkedAt,
    lastSeenAt: null,
  });
  let transportCalls = 0;
  const service = await createAgentService({
    env,
    repository,
    connectorFetchImpl: async () => {
      transportCalls += 1;
      return toolsListResponse();
    },
  });
  t.after(async () => {
    await service.stop();
    await repository.close();
    await postgres.close();
  });

  const probe = await service.app.inject({
    method: "POST",
    url: "/v1/connectors/sif/probe",
    headers: sessionHeaders(),
  });

  assert.equal(probe.statusCode, 200);
  assert.equal(probe.json().available, true);
  assert.equal(transportCalls, 1);
  const attempts = await postgres.pool.query<{ count: number }>(
    `SELECT count(*)::integer AS count
     FROM concurrency_physical_attempts
     WHERE organization_id = $1 AND resource = 'sif' AND attempt_kind = 'probe'`,
    [env.AGENT_EXECUTION_ORGANIZATION_ID],
  );
  assert.equal(attempts.rows[0]?.count, 1);
});

test("production Agent Service connector probes fail closed when the injected governor is unavailable", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "connector-governor-unavailable-"));
  const path = join(directory, "agent.sqlite");
  const env = testEnv(path);
  const sqliteRepository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  const repository = Object.assign(sqliteRepository, {
    concurrencyControl: new UnavailableConcurrencyControlRepository(),
  });
  await seedAdminSession(sqliteRepository, env.AGENT_EXECUTION_ORGANIZATION_ID);
  let transportCalls = 0;
  const service = await createAgentService({
    env,
    repository,
    connectorFetchImpl: async () => {
      transportCalls += 1;
      return toolsListResponse();
    },
  });
  t.after(async () => {
    await service.stop();
    sqliteRepository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const probe = await service.app.inject({
    method: "POST",
    url: "/v1/connectors/sif/probe",
    headers: sessionHeaders(),
  });

  assert.equal(probe.statusCode, 200);
  assert.equal(probe.json().available, false);
  assert.equal(transportCalls, 0);
});

test("unconfigured probes fail closed without transport and persist no secret", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "connector-missing-"));
  const path = join(directory, "agent.sqlite");
  const configuredEnv = testEnv(path);
  const env = {
    ...configuredEnv,
    SIF_MCP_SECRET: "",
    SORFTIME_MCP_KEY: undefined,
    SELLERSPRITE_SECRET_KEY: undefined,
  };
  let transportCalls = 0;
  const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  await seedAdminSession(repository, env.AGENT_EXECUTION_ORGANIZATION_ID);
  const service = await createAgentService({
    env,
    repository,
    connectors: createRemoteMcpConnectors({
      env,
      fetchImpl: async () => {
        transportCalls += 1;
        return toolsListResponse();
      },
      clock: () => new Date(checkedAt),
    }),
  });
  t.after(async () => {
    await service.stop();
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const probe = await service.app.inject({
    method: "POST",
    url: "/v1/connectors/sorftime/probe",
    headers: sessionHeaders(),
  });
  assert.equal(probe.statusCode, 200);
  assert.deepEqual(probe.json(), {
    connectorId: "sorftime",
    configured: false,
    available: false,
    reason: "Sorftime connector credential is not configured",
    checkedAt,
  });
  assert.equal(transportCalls, 0);
  assert.doesNotMatch(JSON.stringify(await repository.listConnectorStatuses(
    configuredEnv.AGENT_EXECUTION_ORGANIZATION_ID,
  )), /secret-sentinel|https?:|authorization|header/i);
});

test("failed on-demand probe is sanitized and never affects Agent Service health", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "connector-failure-"));
  const path = join(directory, "agent.sqlite");
  const env = testEnv(path);
  const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  await seedAdminSession(repository, env.AGENT_EXECUTION_ORGANIZATION_ID);
  const service = await createAgentService({
    env,
    repository,
    connectors: createRemoteMcpConnectors({
      env,
      fetchImpl: async () =>
        new Response("raw-url-header-secret-sentinel", { status: 503 }),
      clock: () => new Date(checkedAt),
      sleep: async () => undefined,
      policy: {
        timeoutMs: 100,
        maxAttempts: 2,
        retryDelayMs: 0,
        maxConcurrent: 1,
        maxQueue: 1,
      },
    }),
  });
  t.after(async () => {
    await service.stop();
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const probe = await service.app.inject({
    method: "POST",
    url: "/v1/connectors/sellerSprite/probe",
    headers: sessionHeaders(),
  });
  assert.equal(probe.statusCode, 200);
  assert.equal(probe.json().available, false);
  assert.equal(probe.json().reason, "Connector upstream is temporarily unavailable");
  const serialized = JSON.stringify({
    response: probe.json(),
    rows: await repository.listConnectorStatuses(
      env.AGENT_EXECUTION_ORGANIZATION_ID,
    ),
  });
  assert.doesNotMatch(serialized, /raw-url|secret-sentinel|https?:|authorization|header/i);

  const health = await service.app.inject({ method: "GET", url: "/health" });
  assert.equal(health.statusCode, 200);
});
