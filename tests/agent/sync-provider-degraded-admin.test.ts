import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ConnectorStatusRecord, ConnectorStatusRepository } from "../../server/db/repository";
import type { SyncJobLease, SyncJobRecord, SyncJobRepository } from "../../server/db/sync-job-repository";
import { SyncJobWorkerHandler } from "../../server/services/sync-job-worker-handler";

test("worker publishes a safe provider-degraded connector state for the admin panel", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "sync-degraded-admin-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const connectorStatuses = new CapturingConnectorStatuses();
  const syncJobs = new MemorySyncJobs();
  const lease = fakeLease();
  const handler = new SyncJobWorkerHandler({
    syncJobs,
    connectorStatuses,
    now: () => "2026-08-23T00:01:00.000Z",
    mirrorDirectory: directory,
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
        providerDegraded: [{
          connector: "sif",
          failureKind: "dns",
          causeCode: "DNS_NOT_FOUND",
        }],
      });
      return { status: "completed-with-gaps", message: "部分 provider 已降级" };
    },
  });

  await handler.handle(lease);

  assert.equal(connectorStatuses.records.length, 1);
  assert.deepEqual(connectorStatuses.records[0], {
    id: connectorStatuses.records[0]?.id,
    organizationId: lease.job.organizationId,
    connector: "sif",
    configured: true,
    health: "unavailable",
    lastCheckedAt: "2026-08-23T00:01:00.000Z",
    lastError: {
      code: "probe-failed",
      message: "Provider degraded: dns (DNS_NOT_FOUND)",
    },
    updatedAt: "2026-08-23T00:01:00.000Z",
  });
  assert.doesNotMatch(JSON.stringify(connectorStatuses.records), /https?:|secret|authorization|database/i);
});

class CapturingConnectorStatuses implements ConnectorStatusRepository {
  readonly records: ConnectorStatusRecord[] = [];
  async upsertConnectorStatus(status: ConnectorStatusRecord) {
    this.records.push(status);
    return status;
  }
  async findConnectorStatus() { return null; }
  async listConnectorStatuses() { return []; }
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
