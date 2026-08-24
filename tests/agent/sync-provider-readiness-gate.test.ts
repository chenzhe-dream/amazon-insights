import assert from "node:assert/strict";
import test from "node:test";

import type { ConnectorId } from "../../server/connectors/connector-contract";
import type { ConnectorStatusRecord } from "../../server/db/repository";
import type { SyncJobRecord, SyncJobRepository } from "../../server/db/sync-job-repository";
import {
  SyncProviderReadinessError,
  SyncProviderReadinessService,
} from "../../server/services/sync-provider-readiness-service";
import { SyncJobService } from "../../server/services/sync-job-service";

const ORGANIZATION_ID = "20000000-0000-4000-8000-000000000001";
const NOW = "2026-08-23T08:00:00.000Z";
const PROBED_AT = "2026-08-23T08:01:00.000Z";
const SECRET_SENTINEL = "provider-readiness-secret-sentinel";

function credential(connectorId: ConnectorId, overrides: Record<string, unknown> = {}) {
  return {
    connectorId,
    configured: true,
    managed: true,
    source: "managed" as const,
    version: 1,
    updatedAt: NOW,
    ...overrides,
  };
}

function probe(connector: ConnectorId, overrides: Partial<ConnectorStatusRecord> = {}): ConnectorStatusRecord {
  return {
    id: `probe-${connector}`,
    organizationId: ORGANIZATION_ID,
    connector,
    configured: true,
    health: "available",
    lastCheckedAt: PROBED_AT,
    lastError: null,
    updatedAt: PROBED_AT,
    ...overrides,
  };
}

function gate(options: {
  credentials?: readonly ReturnType<typeof credential>[];
  probes?: readonly ConnectorStatusRecord[];
}) {
  const credentials = options.credentials ?? [
    credential("sellerSprite"),
    credential("sif"),
    credential("sorftime"),
  ];
  const probes = new Map((options.probes ?? [
    probe("sellerSprite"),
    probe("sif"),
    probe("sorftime"),
  ]).map((item) => [item.connector, item]));
  return new SyncProviderReadinessService({
    credentialServiceResolver: () => ({
      listSafeStates: async () => credentials,
    }),
    connectorStatuses: {
      findConnectorStatus: async (_organizationId, connectorId) => probes.get(connectorId) ?? null,
    },
  });
}

test("readiness reports finite secret-free causes for every rejected boundary", async () => {
  const cases = [
    {
      name: "not configured",
      service: gate({ credentials: [
        credential("sellerSprite"),
        credential("sif", { configured: false, managed: false, source: "none", version: null, updatedAt: null }),
        credential("sorftime"),
      ] }),
      causeCode: "NOT_CONFIGURED",
    },
    {
      name: "probe required",
      service: gate({ probes: [probe("sellerSprite"), probe("sorftime")] }),
      causeCode: "PROBE_REQUIRED",
    },
    {
      name: "probe stale for managed version",
      service: gate({ probes: [probe("sellerSprite"), probe("sif", { lastCheckedAt: "2026-08-23T07:59:00.000Z" }), probe("sorftime")] }),
      causeCode: "PROBE_REQUIRED",
    },
    {
      name: "probe failed",
      service: gate({ probes: [probe("sellerSprite"), probe("sif", {
        health: "unavailable",
        lastError: { code: "probe-failed", message: `${SECRET_SENTINEL} authentication failed` },
      }), probe("sorftime")] }),
      causeCode: "PROBE_FAILED",
    },
    {
      name: "provider degraded",
      service: gate({ probes: [probe("sellerSprite"), probe("sif", {
        health: "unavailable",
        lastError: { code: "probe-failed", message: "Provider degraded: dns (DNS_NOT_FOUND)" },
      }), probe("sorftime")] }),
      causeCode: "PROVIDER_DEGRADED",
    },
  ] as const;

  for (const item of cases) {
    await assert.rejects(
      item.service.assertReady({
        organizationId: ORGANIZATION_ID,
        automaticStages: ["keywords"],
      }),
      (error: unknown) => {
        assert.ok(error instanceof SyncProviderReadinessError, item.name);
        assert.deepEqual(error.details, [{ connectorId: "sif", causeCode: item.causeCode }]);
        assert.doesNotMatch(JSON.stringify(error), new RegExp(SECRET_SENTINEL));
        return true;
      },
    );
  }
});

test("required connector calculation deduplicates healthy automatic stages", async () => {
  await gate({}).assertReady({
    organizationId: ORGANIZATION_ID,
    automaticStages: [
      "catalog", "keywords", "traffic", "reviews", "sales_trend", "child_sales",
      "price_strategy", "fba", "listing", "category",
    ],
  });
});

test("sync admission creates a partial job when SellerSprite is unavailable but SIF and Sorftime are ready", async () => {
  const counters = { admit: 0, workerLaunch: 0, readiness: 0 };
  const repository = syncJobs(counters);
  const readinessGate = gate({ probes: [
    probe("sellerSprite", {
      health: "unavailable",
      lastError: { code: "probe-failed", message: "Connector request timed out" },
    }),
    probe("sif"),
    probe("sorftime"),
  ] });
  const service = new SyncJobService(repository, {
    providerReadiness: plannedGate(readinessGate, counters) as never,
    loadStatusModule: async () => allProviderStatusModule(),
    now: () => NOW,
  });
  const started = await service.start(scope());
  assert.equal(started.job.status, "queued");
  assert.equal(started.job.stages.find((stage) => stage.id === "catalog")?.status, "partial");
  assert.match(started.job.stages.find((stage) => stage.id === "catalog")?.detail ?? "", /SellerSprite.*数据源不可用/);
  assert.equal(started.job.stages.find((stage) => stage.id === "keywords")?.status, "pending");
  assert.equal(started.job.stages.find((stage) => stage.id === "reviews")?.status, "pending");
  assert.deepEqual(counters, { admit: 1, workerLaunch: 1, readiness: 1 });
});

test("sync admission only preflights unavailable stages that are missing for this request", async () => {
  const counters = { admit: 0, workerLaunch: 0, readiness: 0 };
  const service = new SyncJobService(syncJobs(counters), {
    providerReadiness: plannedGate(gate({ probes: [
      probe("sellerSprite"),
      probe("sif", {
        health: "unavailable",
        lastError: { code: "probe-failed", message: "offline" },
      }),
      probe("sorftime"),
    ] }), counters) as never,
    loadStatusModule: async () => keywordsMissingTrafficReadyStatusModule(),
    now: () => NOW,
  });

  const started = await service.start(scope());

  assert.equal(started.job.stages.find((stage) => stage.id === "keywords")?.status, "partial");
  assert.equal(started.job.stages.find((stage) => stage.id === "traffic")?.status, "pending");
  assert.doesNotMatch(started.job.stages.find((stage) => stage.id === "traffic")?.detail ?? "", /数据源不可用/);
  assert.deepEqual(counters, { admit: 1, workerLaunch: 1, readiness: 1 });
});

test("sync admission remains available with only SIF and rejects when every required provider is unavailable", async () => {
  const partialCounters = { admit: 0, workerLaunch: 0, readiness: 0 };
  const partial = new SyncJobService(syncJobs(partialCounters), {
    providerReadiness: plannedGate(gate({ probes: [
      probe("sellerSprite", { health: "unavailable", lastError: { code: "probe-failed", message: "offline" } }),
      probe("sif"),
      probe("sorftime", { health: "unavailable", lastError: { code: "probe-failed", message: "offline" } }),
    ] }), partialCounters) as never,
    loadStatusModule: async () => allProviderStatusModule(),
    now: () => NOW,
  });

  const started = await partial.start(scope());
  assert.deepEqual(
    started.job.stages.filter((stage) => stage.status === "partial").map((stage) => stage.id),
    ["catalog", "reviews", "sales_trend", "child_sales", "price_strategy", "fba", "listing", "category"],
  );
  assert.deepEqual(partialCounters, { admit: 1, workerLaunch: 1, readiness: 1 });

  const noneCounters = { admit: 0, workerLaunch: 0, readiness: 0 };
  const noneReady = new SyncJobService(syncJobs(noneCounters), {
    providerReadiness: plannedGate(gate({ probes: [
      probe("sellerSprite", { health: "unavailable", lastError: { code: "probe-failed", message: "offline" } }),
      probe("sif", { health: "unavailable", lastError: { code: "probe-failed", message: "offline" } }),
      probe("sorftime", { health: "unavailable", lastError: { code: "probe-failed", message: "offline" } }),
    ] }), noneCounters) as never,
    loadStatusModule: async () => allProviderStatusModule(),
    now: () => NOW,
  });
  await assert.rejects(noneReady.start(scope()), (error: unknown) => {
    assert.ok(error instanceof SyncProviderReadinessError);
    assert.equal(error.details.length, 3);
    return true;
  });
  assert.deepEqual(noneCounters, { admit: 0, workerLaunch: 0, readiness: 1 });
});

test("sync service defensively maps authoritative resumable stages including an empty list", async () => {
  const sourceStages = ["traffic"];
  const input: Parameters<SyncJobRepository["admit"]>[0] = {
    jobId: "canonical-traffic-job",
    organizationId: ORGANIZATION_ID,
    projectId: "10000000-0000-4000-8000-000000000010",
    runId: "10000000-0000-4000-8000-000000000011",
    actorId: "10000000-0000-4000-8000-000000000001",
    fingerprint: "canonical-traffic-fingerprint",
    asins: ["B0CCYMV1T1"],
    marketplace: "US",
    createdAt: NOW,
    stages: [],
    currentStageId: "build",
    message: "Completed with canonical traffic pending",
  };
  let record: SyncJobRecord = {
    ...queuedJob(input),
    status: "completed",
    completedAt: NOW,
    resumableStages: sourceStages,
  };
  const repository = syncJobs({ admit: 0, workerLaunch: 0 });
  repository.findById = async () => record;
  const service = new SyncJobService(repository);

  const mapped = await service.read(record.jobId);
  assert.deepEqual(mapped?.resumableStages, ["traffic"]);
  assert.notEqual(mapped?.resumableStages, sourceStages);
  sourceStages[0] = "mutated-after-read";
  assert.deepEqual(mapped?.resumableStages, ["traffic"]);

  record = { ...record, resumableStages: [] };
  const empty = await service.read(record.jobId);
  assert.equal(Object.hasOwn(empty ?? {}, "resumableStages"), true);
  assert.deepEqual(empty?.resumableStages, []);
});

test("scoped sync service creates a canonical run and fingerprints the project boundary", async () => {
  const admitted: Parameters<SyncJobRepository["admit"]>[0][] = [];
  const repository = syncJobs({ admit: 0, workerLaunch: 0 });
  repository.admit = async (input) => {
    admitted.push(input);
    return { job: queuedJob(input), disposition: "created" };
  };
  const service = new SyncJobService(repository, {
    bypassProviderReadiness: true,
    loadStatusModule: async () => statusModule(),
    now: () => NOW,
  });
  const actorId = "10000000-0000-4000-8000-000000000001";
  const projectA = "10000000-0000-4000-8000-000000000010";
  const projectB = "10000000-0000-4000-8000-000000000011";

  await service.start({ ...scope(), actorId, projectId: projectA });
  await service.start({ ...scope(), actorId, projectId: projectA });
  await service.start({ ...scope(), actorId, projectId: projectB });

  assert.equal(admitted.length, 3);
  assert.equal(admitted[0]?.fingerprint, admitted[1]?.fingerprint);
  assert.notEqual(admitted[0]?.fingerprint, admitted[2]?.fingerprint);
  for (const input of admitted) {
    assert.ok(input.canonicalRun);
    assert.equal(input.runId, input.canonicalRun.runId);
    assert.equal(input.canonicalRun.dataCutoffAt, NOW);
  }
});

function scope() {
  return {
    organizationId: ORGANIZATION_ID,
    actorId: "10000000-0000-4000-8000-000000000001",
    projectId: null,
    runId: null,
    asins: ["B0CCYMV1T1"],
    marketplace: "US",
  };
}

function statusModule() {
  const item = {
    asin: "B0CCYMV1T1",
    inCatalog: true,
    keywords: "missing" as const,
    reviews: "ready" as const,
    sales: "ready" as const,
    childSales: "ready" as const,
    priceStrategy: "ready" as const,
    fba: "ready" as const,
    listing: "ready" as const,
    imageRemarks: "ready" as const,
    category: "ready" as const,
    traffic: "ready" as const,
    voc: "ready" as const,
  };
  return {
    getAsinDataStatus: () => [item],
    asinsNeedingMcpSync: () => [item],
    asinsNeedingListingSync: () => [],
    asinsNeedingImageRemarksSync: () => [],
    asinsNeedingTrafficSync: () => [],
    asinsNeedingCatalogSync: () => [],
    estimateAutoSyncSeconds: () => 1,
    estimateAlexaVocSeconds: () => 0,
  };
}

function allProviderStatusModule() {
  const status = statusModule();
  const item = {
    ...status.getAsinDataStatus([])[0],
    inCatalog: false,
    keywords: "missing" as const,
    reviews: "missing" as const,
    sales: "missing" as const,
    childSales: "missing" as const,
    priceStrategy: "missing" as const,
    fba: "missing" as const,
    listing: "missing" as const,
    category: "missing" as const,
    traffic: "missing" as const,
  };
  return {
    ...status,
    getAsinDataStatus: () => [item],
    asinsNeedingMcpSync: () => [item],
    asinsNeedingCatalogSync: () => [item.asin],
  };
}

function keywordsMissingTrafficReadyStatusModule() {
  const status = statusModule();
  const item = {
    ...status.getAsinDataStatus([])[0],
    reviews: "missing" as const,
  };
  return {
    ...status,
    getAsinDataStatus: () => [item],
    asinsNeedingMcpSync: () => [item],
  };
}

function plannedGate(
  service: SyncProviderReadinessService,
  counters: { readiness: number },
) {
  return {
    async plan(input: { organizationId: string; automaticStages: readonly string[] }) {
      counters.readiness += 1;
      return await (service as unknown as {
        plan(value: { organizationId: string; automaticStages: readonly string[] }): Promise<unknown>;
      }).plan(input);
    },
    async assertReady(input: { organizationId: string; automaticStages: readonly string[] }) {
      counters.readiness += 1;
      await service.assertReady(input);
    },
  };
}

function syncJobs(counters: { admit: number; workerLaunch: number }): SyncJobRepository {
  return {
    async admit(input) {
      counters.admit += 1;
      counters.workerLaunch += 1;
      return { job: queuedJob(input), disposition: "created" };
    },
    async findById() { return null; },
    async resume() { return null; },
    async claimNext() { return null; },
    async heartbeat() { throw new Error("unused"); },
    async recordProgress() { throw new Error("unused"); },
    async complete() { throw new Error("unused"); },
    async fail() { throw new Error("unused"); },
  };
}

function queuedJob(input: Parameters<SyncJobRepository["admit"]>[0]): SyncJobRecord {
  return {
    ...input,
    status: "queued",
    asinProgress: {},
    leasedBy: null,
    leaseGeneration: 0,
    leaseExpiresAt: null,
    error: null,
    updatedAt: input.createdAt,
    scope: {
      organizationId: input.organizationId,
      projectId: input.projectId,
      runId: input.runId,
      marketplace: input.marketplace,
      asins: input.asins,
    },
  };
}
