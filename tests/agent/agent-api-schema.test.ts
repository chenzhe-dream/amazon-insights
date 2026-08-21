import assert from "node:assert/strict";
import test from "node:test";

import { LocalDataSyncJobPublicSchema } from "../../shared/agent-contracts";

const now = "2026-08-20T09:00:00.000Z";

test("local sync job public schema rejects internal queue and launcher fields", () => {
  const internalJob = {
    jobId: "sync-job-public",
    asins: ["B0SYNC0001"],
    marketplace: "US",
    status: "running",
    message: "Running",
    currentStageId: "catalog",
    stages: [
      {
        id: "catalog",
        label: "Catalog",
        kind: "auto",
        status: "running",
        estimatedSeconds: 30,
      },
    ],
    asinProgress: {
      B0SYNC0001: {
        catalog: {
          status: "ready",
          reason: null,
          updatedAt: now,
        },
      },
    },
    createdAt: now,
    updatedAt: now,
    scope: {
      projectId: null,
      runId: null,
    },
    leasedBy: "worker-a",
    leaseGeneration: 1,
    command: ["node", "scripts/run-asin-sync-job.mjs"],
    logPath: "data/sync-jobs/sync-job-public.log",
    credentials: { sellerSprite: "secret" },
    upstreamPayload: { raw: true },
  };

  assert.equal(LocalDataSyncJobPublicSchema.safeParse(internalJob).success, false);

  const publicJob = { ...internalJob };
  delete (publicJob as Partial<typeof internalJob>).leasedBy;
  delete (publicJob as Partial<typeof internalJob>).leaseGeneration;
  delete (publicJob as Partial<typeof internalJob>).command;
  delete (publicJob as Partial<typeof internalJob>).logPath;
  delete (publicJob as Partial<typeof internalJob>).credentials;
  delete (publicJob as Partial<typeof internalJob>).upstreamPayload;

  assert.equal(LocalDataSyncJobPublicSchema.safeParse(publicJob).success, true);
});
