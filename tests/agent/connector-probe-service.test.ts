import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createAgentService } from "../../server/agent-service";
import { createRemoteMcpConnectors } from "../../server/connectors/mcp-connectors";
import { openSqliteAgentRepository } from "../../server/db/sqlite-repository";
import { ConnectorProbeService } from "../../server/services/connector-probe-service";
import { ConnectorHealthSchema } from "../../shared/agent-contracts";

const origin = "http://127.0.0.1:31900";
const proxyToken = "connector-probe-proxy-token";
const proxyHeaders = {
  origin,
  "x-agent-proxy-token": proxyToken,
};
const checkedAt = "2026-08-17T01:02:03.000Z";

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

  await service.start({ host: "127.0.0.1", port: 0 });
  assert.equal(transportCalls, 0);
  const healthBefore = await service.app.inject({ method: "GET", url: "/health" });
  assert.equal(healthBefore.statusCode, 200);

  const before = await service.app.inject({
    method: "GET",
    url: "/v1/capabilities",
    headers: proxyHeaders,
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
    headers: proxyHeaders,
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
    env,
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
    headers: proxyHeaders,
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
    headers: proxyHeaders,
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
