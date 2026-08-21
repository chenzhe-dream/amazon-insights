import assert from "node:assert/strict";
import test from "node:test";

import { createAsinSyncJobStarter } from "../../app/lib/sync-server";

const organizationId = "10000000-0000-4000-8000-000000000001";
const actorId = "10000000-0000-4000-8000-000000000002";
const projectId = "10000000-0000-4000-8000-000000000003";
const runId = "10000000-0000-4000-8000-000000000004";
const asins = ["B07VY9Q95Q", "B0C4XRN398"];

function statusModule() {
  const ready = asins.map((asin) => ({
    asin, inCatalog: true, keywords: "ready", reviews: "ready", sales: "ready", childSales: "ready",
    priceStrategy: "ready", fba: "ready", listing: "ready", imageRemarks: "ready", category: "ready", traffic: "ready", voc: "ready",
  }));
  return {
    asinsNeedingCatalogSync: () => [], asinsNeedingMcpSync: () => [], asinsNeedingTrafficSync: () => [],
    asinsNeedingListingSync: () => [], asinsNeedingImageRemarksSync: () => [], getAsinDataStatus: () => ready,
    estimateAutoSyncSeconds: () => 0, estimateAlexaVocSeconds: () => 0,
  };
}

test("authorized scoped starts call the dynamic adapter once and reuse without another worker", async () => {
  let launches = 0;
  let creates = 0;
  const adapterCalls: unknown[] = [];
  const job = {
    jobId: "job-1", asins: [...asins].sort(), marketplace: "US", status: "queued", message: "Queued",
    currentStageId: "queue", stages: [], asinProgress: {}, createdAt: "2026-08-22T00:00:00.000Z", updatedAt: "2026-08-22T00:00:00.000Z",
  };
  const starter = createAsinSyncJobStarter({
    loadStatusModule: async () => statusModule(),
    loadJobStore: async () => ({
      createOrReuseSyncJob: () => ({ job, reused: creates++ > 0 }),
      createSyncJobStartCoordinator: ({ launch }) => ({
        start: async (input: Record<string, unknown>) => {
          const result = (input as { asins: string[] });
          const created = creates++ === 0;
          if (created) await launch({ ...job, asins: [...result.asins] });
          return { job, reused: !created };
        },
      }),
      patchSyncJob: () => job,
    }),
    launchSyncRunner: async () => { launches += 1; },
  });
  const input = { organizationId, actorId, projectId, runId, marketplace: "US" as const, asins: [...asins].reverse() };
  const options = { dynamicTrafficSnapshotAdapter: {
    async createForAuthorizedRun(value: unknown) { adapterCalls.push(value); },
  } };
  const first = await starter(input, options);
  await Promise.resolve();
  const replay = await starter(input, options);
  await Promise.resolve();

  assert.equal(first.reused, false);
  assert.equal(replay.reused, true);
  assert.equal(launches, 1);
  assert.equal(adapterCalls.length, 1);
  assert.deepEqual(adapterCalls[0], {
    actorId, organizationId, projectId, runId, marketplace: "US", asins: [...asins].sort(),
  });
});
