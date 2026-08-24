import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ConnectorStatusRecord } from "../../server/db/repository";
import { openSqliteAgentRepository } from "../../server/db/sqlite-repository";
import type { SyncJobLease, SyncJobRecord, SyncJobRepository } from "../../server/db/sync-job-repository";
import { SyncJobWorkerHandler } from "../../server/services/sync-job-worker-handler";

const providerWide = [
  ["dns", "DNS_NOT_FOUND"],
  ["tls", "TLS_CERTIFICATE"],
  ["proxy", "PROXY_CONNECT"],
  ["connection", "CONNECTION_REFUSED"],
  ["timeout", "REQUEST_TIMEOUT"],
  ["http", "HTTP_5XX"],
  ["rpc", "MCP_RPC"],
  ["governor", "RESOURCE_GOVERNOR"],
] as const;

for (const [failureKind, causeCode] of providerWide) {
  test(`worker keeps ${failureKind} (${causeCode}) provider degradation out of global connector health`, async (t) => {
    const fixture = await createFixture(t);
    const existingStatus = trustedAvailableStatus(fixture.lease);
    await fixture.connectorStatuses.upsertConnectorStatus(existingStatus);
    const handler = createHandler(fixture, [{
      connector: "sif",
      failureKind,
      causeCode,
    }]);

    await handler.handle(fixture.lease);

    const persisted = await fixture.connectorStatuses.findConnectorStatus(
      fixture.lease.job.organizationId,
      "sif",
    );
    assert.deepEqual(persisted, existingStatus);
  });
}

test("worker keeps legacy schema provider degradations local to the mirror", async (t) => {
  const fixture = await createFixture(t);
  const handler = createHandler(fixture, [
    { connector: "sif", failureKind: "schema", causeCode: "MCP_SCHEMA" },
    { connector: "sif", failureKind: "schema", causeCode: "DNS_NOT_FOUND" },
    { connector: "sif", failureKind: "dns", causeCode: "MCP_SCHEMA" },
    { connector: "unknown", failureKind: "schema", causeCode: "MCP_SCHEMA" },
    { connector: "sif", failureKind: "provider-degraded", causeCode: "MCP_SCHEMA" },
    null,
  ]);

  await handler.handle(fixture.lease);

  assert.equal(
    await fixture.connectorStatuses.findConnectorStatus(fixture.lease.job.organizationId, "sif"),
    null,
  );
});

async function createFixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "sync-degraded-admin-"));
  const connectorStatuses = openSqliteAgentRepository({
    path: join(directory, "agent.sqlite"),
    busyTimeoutMs: 5_000,
  });
  const lease = fakeLease();
  await connectorStatuses.createUser({
    id: "dd400000-0000-4000-8000-000000000002",
    organizationId: lease.job.organizationId,
    email: "degraded-admin@example.com",
    displayName: "Degraded admin test",
    role: "admin",
    status: "active",
    createdAt: "2026-08-23T00:01:00.000Z",
    updatedAt: "2026-08-23T00:01:00.000Z",
  });
  t.after(async () => {
    connectorStatuses.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, connectorStatuses, lease };
}

function createHandler(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  providerDegraded: unknown[],
) {
  return new SyncJobWorkerHandler({
    syncJobs: new MemorySyncJobs(),
    now: () => "2026-08-23T00:01:00.000Z",
    mirrorDirectory: fixture.directory,
    progressPollMs: 60_000,
    heartbeatIntervalMs: 60_000,
    runner: async (_lease, context) => {
      await context.writeMirror({
        status: "completed-with-gaps",
        message: "部分 provider 已降级",
        diagnostics: [{
          connector: "sif",
          stage: "keywords",
          asin: "B0TEST0001",
          failureKind: "dns",
          causeCode: "DNS_NOT_FOUND",
        }],
        providerDegraded,
      });
      return { status: "completed-with-gaps", message: "部分 provider 已降级" };
    },
  });
}

function trustedAvailableStatus(lease: SyncJobLease): ConnectorStatusRecord {
  return {
    id: "dd400000-0000-4000-8000-000000000003",
    organizationId: lease.job.organizationId,
    connector: "sif",
    configured: true,
    health: "available",
    lastCheckedAt: "2026-08-22T00:01:00.000Z",
    lastError: null,
    updatedAt: "2026-08-22T00:01:00.000Z",
  };
}

class MemorySyncJobs implements SyncJobRepository {
  admit(): Promise<never> { throw new Error("not used"); }
  findById(): Promise<null> { return Promise.resolve(null); }
  resume(): Promise<null> { return Promise.resolve(null); }
  claimNext(): Promise<null> { return Promise.resolve(null); }
  heartbeat(): Promise<SyncJobRecord> { return Promise.resolve(fakeLease().job); }
  recordProgress(): Promise<SyncJobRecord> { return Promise.resolve(fakeLease().job); }
  complete(): Promise<SyncJobRecord> { return Promise.resolve(fakeLease().job); }
  fail(): Promise<SyncJobRecord> { return Promise.resolve(fakeLease().job); }
}

function fakeLease(): SyncJobLease {
  const now = "2026-08-23T00:01:00.000Z";
  return {
    leaseGeneration: 1,
    job: {
      jobId: "degraded-admin-job",
      organizationId: "dd400000-0000-4000-8000-000000000001",
      projectId: null,
      runId: null,
      actorId: null,
      fingerprint: "degraded-admin-fingerprint",
      asins: ["B0TEST0001"],
      marketplace: "US",
      status: "running",
      message: "running",
      currentStageId: "keywords",
      stages: [],
      asinProgress: {},
      leasedBy: "degraded-admin-worker",
      leaseGeneration: 1,
      leaseExpiresAt: "2026-08-23T00:02:00.000Z",
      error: null,
      createdAt: now,
      updatedAt: now,
      scope: {
        organizationId: "dd400000-0000-4000-8000-000000000001",
        projectId: null,
        runId: null,
        marketplace: "US",
        asins: ["B0TEST0001"],
      },
    },
  };
}
