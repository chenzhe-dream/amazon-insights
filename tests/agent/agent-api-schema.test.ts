import assert from "node:assert/strict";
import test from "node:test";

import {
  findHttpContract,
  LocalDataSyncJobPublicSchema,
} from "../../shared/agent-contracts";

const now = "2026-08-20T09:00:00.000Z";

test("local sync job public schema rejects internal queue and launcher fields", () => {
  const internalJob = {
    jobId: "sync-job-public",
    jobVersion: 1,
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

  const legacyPublicJob = { ...publicJob };
  delete (legacyPublicJob as Partial<typeof legacyPublicJob>).jobVersion;
  const legacyParsed = LocalDataSyncJobPublicSchema.safeParse(legacyPublicJob);
  assert.equal(legacyParsed.success, true);
  if (legacyParsed.success) {
    assert.equal(legacyParsed.data.jobVersion, 1);
  }

  for (const invalidJobVersion of [0, -1, 1.5]) {
    assert.equal(LocalDataSyncJobPublicSchema.safeParse({
      ...publicJob,
      jobVersion: invalidJobVersion,
    }).success, false);
  }
});

test("stage output route has the exact scoped path and keeps retry stages separate", () => {
  const projectId = "10000000-0000-4000-8000-000000000001";
  const runId = "10000000-0000-4000-8000-000000000002";
  const scope = `/v1/projects/${projectId}/runs/${runId}`;

  for (const stage of ["keywords", "reviews", "sales_trend", "fba", "listing", "category", "traffic"]) {
    assert.equal(
      findHttpContract("GET", `${scope}/sync-jobs/sync-job-public/stages/${stage}/output`)?.response !== undefined,
      true,
    );
  }
  assert.equal(
    findHttpContract("POST", `/v1/runs/${runId}/stages/keywords/retry`),
    undefined,
  );
  assert.equal(
    findHttpContract(
      "GET",
      "/v1/local-data/projects/10000000-0000-4000-8000-000000000001/runs/10000000-0000-4000-8000-000000000002/sync-asins/sync-job-public/stages/sales_trend",
    ),
    undefined,
  );
});
