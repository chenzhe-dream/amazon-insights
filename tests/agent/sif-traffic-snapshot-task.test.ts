import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { createSifConnector } from "../../server/connectors/mcp-connectors";
import { openSqliteAgentRepository } from "../../server/db/sqlite-repository";
import type { TrafficAnalysisInput } from "../../server/domain/traffic/traffic-analysis-contracts";
import type {
  ModelProvider,
  StructuredGenerationRequest,
} from "../../server/runtime/model-provider";
import { createTrafficAnalysisRuntime } from "../../server/runtime/traffic-analysis-runtime";
import { SifTrafficSnapshotTask } from "../../server/services/sif-traffic-snapshot-task";
import { ScopedSifTrafficSnapshotAdapter } from "../../server/services/scoped-sif-traffic-snapshot-adapter";

const NOW = "2026-08-17T08:00:00.000Z";
const CUTOFF = "2026-08-17T07:59:59.999Z";
const ASINS = ["B0AAAAAA01", "B0AAAAAA02", "B0AAAAAA03"] as const;
const generatedTrafficFiles = [
  "app/sif-listing-traffic-raw-data.ts",
  "app/sif-monthly-traffic-trend-raw-data.ts",
] as const;

test("collect-missing traffic job persists fake SIF data without generating app TypeScript", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "amazon-sif-traffic-task-"));
  const databasePath = join(directory, "agent.sqlite");
  let repository = openSqliteAgentRepository({
    path: databasePath,
    busyTimeoutMs: 5_000,
    nowProvider: () => new Date(NOW),
  });
  let repositoryOpen = true;
  t.after(() => {
    if (repositoryOpen) repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const subject = await seedTrafficJob(repository);
  const beforeFiles = generatedFileHashes();
  const calls: Array<{ operation: string; asin: string }> = [];
  const connector = createSifConnector({
    env: { SIF_MCP_SECRET: "fake-sif-secret" },
    fetchImpl: fakeSifFetch(calls),
    clock: () => new Date(NOW),
    sleep: async () => undefined,
    policy: {
      timeoutMs: 100,
      maxAttempts: 1,
      retryDelayMs: 0,
      maxConcurrent: 1,
      maxQueue: 16,
    },
  });
  const runtime = await createTrafficAnalysisRuntime({
    repository,
    config: runtimeConfig(),
    provider: new EchoTrafficProvider(),
    sifConnector: connector,
    clock: () => new Date(NOW),
  });
  t.after(() => runtime.stop());

  runtime.start();
  await waitForStage(repository, subject.stageId, "succeeded");
  await runtime.stop();

  assert.equal(calls.length, ASINS.length * 3);
  assert.deepEqual(
    new Set(calls.map(({ operation }) => operation)),
    new Set([
      "ops_get_listing_traffic_overview",
      "ops_get_listing_traffic_structure",
      "ops_get_asin_traffic_trend",
    ]),
  );
  assert.deepEqual(generatedFileHashes(), beforeFiles);

  const snapshots = await repository.listTrafficDataSnapshotsByRun({
    actorOrganizationId: subject.organizationId,
    runId: subject.runId,
  });
  assert.equal(snapshots.length, 1);
  const [snapshot] = snapshots;
  assert.ok(snapshot);
  assert.equal(snapshot.payload.input.competitors.length, ASINS.length);
  assert.deepEqual(
    snapshot.sources.map((source) => ({
      id: source.id,
      type: source.type,
      connectorId: "connectorId" in source ? source.connectorId : null,
      requestCount: "requests" in source ? source.requests.length : 0,
    })),
    [
      {
        id: "sif-listing-traffic",
        type: "connector",
        connectorId: "sif",
        requestCount: ASINS.length * 2,
      },
      {
        id: "sif-monthly-traffic-trend",
        type: "connector",
        connectorId: "sif",
        requestCount: ASINS.length,
      },
    ],
  );
  assert.deepEqual(
    snapshot.sources.map((source) => Object.keys(source).sort()),
    [
      [
        "capturedAt",
        "checksum",
        "connectorId",
        "id",
        "requests",
        "type",
      ],
      [
        "capturedAt",
        "checksum",
        "connectorId",
        "id",
        "requests",
        "type",
      ],
    ],
  );
  for (const source of snapshot.sources) {
    assert.ok("requests" in source);
    for (const request of source.requests) {
      assert.deepEqual(Object.keys(request).sort(), [
        "asin",
        "attemptCount",
        "checksum",
        "fetchedAt",
        "operation",
      ]);
    }
  }
  assert.doesNotMatch(
    JSON.stringify(snapshot.sources),
    /fake-sif-secret|protocol|https?:|header|authorization|raw(?:Body)?/i,
  );

  repository.close();
  repositoryOpen = false;
  repository = openSqliteAgentRepository({
    path: databasePath,
    busyTimeoutMs: 5_000,
    nowProvider: () => new Date(NOW),
  });
  repositoryOpen = true;
  const reopened = await repository.findTrafficDataSnapshotById({
    actorOrganizationId: subject.organizationId,
    snapshotId: snapshot.id,
  });
  assert.deepEqual(reopened, snapshot);
});

test("existing-data traffic job never calls the configured SIF connector", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "amazon-existing-traffic-task-"));
  const repository = openSqliteAgentRepository({
    path: join(directory, "agent.sqlite"),
    busyTimeoutMs: 5_000,
    nowProvider: () => new Date(NOW),
  });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const subject = await seedTrafficJob(repository, "existing-data");
  let connectorCalls = 0;
  const connector = createSifConnector({
    env: { SIF_MCP_SECRET: "unused-fake-secret" },
    fetchImpl: async () => {
      connectorCalls += 1;
      throw new Error("existing-data must remain offline");
    },
    clock: () => new Date(NOW),
    sleep: async () => undefined,
    policy: {
      timeoutMs: 100,
      maxAttempts: 1,
      retryDelayMs: 0,
      maxConcurrent: 1,
      maxQueue: 16,
    },
  });
  const runtime = await createTrafficAnalysisRuntime({
    repository,
    config: runtimeConfig(),
    provider: new EchoTrafficProvider(),
    sifConnector: connector,
    clock: () => new Date(NOW),
  });
  t.after(() => runtime.stop());

  runtime.start();
  await waitForStage(repository, subject.stageId, "succeeded");
  await runtime.stop();

  assert.equal(connectorCalls, 0);
});

test("scoped traffic adapter reuses an authorized run snapshot without another connector write", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "amazon-scoped-sif-traffic-task-"));
  const repository = openSqliteAgentRepository({
    path: join(directory, "agent.sqlite"),
    busyTimeoutMs: 5_000,
    nowProvider: () => new Date(NOW),
  });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const subject = await seedTrafficJob(repository);
  const calls: Array<{ operation: string; asin: string }> = [];
  const connector = createSifConnector({
    env: { SIF_MCP_SECRET: "fake-sif-secret" },
    fetchImpl: fakeSifFetch(calls),
    clock: () => new Date(NOW),
    sleep: async () => undefined,
    policy: { timeoutMs: 100, maxAttempts: 1, retryDelayMs: 0, maxConcurrent: 1, maxQueue: 16 },
  });
  const adapter = new ScopedSifTrafficSnapshotAdapter({
    repository,
    task: new SifTrafficSnapshotTask({ repository, connector, clock: () => new Date(NOW) }),
  });
  const input = {
    actorId: subject.actorId,
    organizationId: subject.organizationId,
    projectId: subject.projectId,
    runId: subject.runId,
    marketplace: "US" as const,
    asins: ASINS,
  };
  const first = await adapter.createForAuthorizedRun(input);
  const callsAfterFirst = calls.length;
  const replay = await adapter.createForAuthorizedRun(input);

  assert.equal(first.reused, false);
  assert.equal(replay.reused, true);
  assert.equal(replay.snapshot.id, first.snapshot.id);
  assert.equal(callsAfterFirst, ASINS.length * 3);
  assert.equal(calls.length, callsAfterFirst);
  await assert.rejects(
    adapter.createForAuthorizedRun({ ...input, organizationId: randomUUID() }),
    /authorized sync scope/i,
  );
});

class EchoTrafficProvider implements ModelProvider {
  async generateStructured<T>(request: StructuredGenerationRequest<T>) {
    const input = request.input as TrafficAnalysisInput;
    return {
      value: {
        schemaVersion: "1.0.0",
        kind: "competitor-traffic-analysis",
        status: "complete",
        identity: {
          dataCutoffAt: input.dataCutoffAt,
          inputDigest: input.inputDigest,
        },
        summary: "流量规模、结构和趋势仅用于判断流量获取与运营能力。",
        competitors: input.competitors,
        decisionBoundaries: {
          profitability: "not-assessed",
          advertisingEfficiency: "requires-validation",
          roi: "not-assessed",
          projectApproval: "not-assessed",
        },
        dataBoundary:
          "当前结论反映竞品获取和运营流量的能力，不等同于广告转化效率或盈利能力。",
      } as T,
      responseId: "fake-sif-traffic-response",
      inputTokens: 100,
      outputTokens: 50,
    };
  }
}

async function seedTrafficJob(
  repository: ReturnType<typeof openSqliteAgentRepository>,
  mode: "collect-missing" | "existing-data" = "collect-missing",
) {
  const organizationId = randomUUID();
  const actorId = randomUUID();
  const projectId = randomUUID();
  const runId = randomUUID();
  const stageId = randomUUID();
  await repository.createUser({
    id: actorId,
    organizationId,
    email: `${actorId}@example.com`,
    displayName: "SIF traffic actor",
    role: "admin",
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
  });
  await repository.createProject({
    id: projectId,
    organizationId,
    name: "SIF traffic snapshot task",
    marketplace: "US",
    asins: [...ASINS],
    createdBy: actorId,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await repository.createAnalysisRun({
    id: runId,
    projectId,
    mode,
    status: "running",
    createdBy: actorId,
    dataCutoffAt: CUTOFF,
    idempotencyScope: `sif-traffic-task:${runId}`,
    idempotencyKey: "create",
    createdAt: NOW,
    updatedAt: NOW,
  });
  await repository.createRunStage({
    id: stageId,
    runId,
    stage: "traffic-analysis",
    status: "queued",
    progress: 0,
    attemptCount: 0,
    startedAt: null,
    completedAt: null,
    lastError: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await repository.enqueueJob({
    id: randomUUID(),
    stageId,
    attemptNumber: 1,
    maxAttempts: 1,
    availableAt: NOW,
    createdAt: NOW,
  });
  return { organizationId, actorId, projectId, runId, stageId };
}

function runtimeConfig() {
  return {
    providerName: "fake-sif-traffic",
    model: {
      name: "fake-sif-traffic-model",
      estimatedInputTokens: 4_000,
      maxOutputTokens: 2_000,
      timeoutMs: 5_000,
      pricing: {
        inputUsdPerMillionTokens: 1,
        outputUsdPerMillionTokens: 1,
      },
    },
    budgetLimits: {
      call: { maxTokens: 100_000, maxCostMicros: 1_000_000 },
      run: { maxTokens: 100_000, maxCostMicros: 1_000_000 },
      organizationUtcDay: {
        maxTokens: 1_000_000,
        maxCostMicros: 10_000_000,
      },
    },
    worker: {
      ownerId: "sif-traffic-worker",
      leaseDurationMs: 120_000,
      heartbeatIntervalMs: 60_000,
      pollIntervalMs: 10,
      stopTimeoutMs: 1_000,
      retryPolicy: {
        maxAttempts: 1,
        initialDelayMs: 10,
        maxDelayMs: 10,
        jitterRatio: 0,
      },
    },
  } as const;
}

function fakeSifFetch(
  calls: Array<{ operation: string; asin: string }>,
): typeof fetch {
  return async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as {
      params: { name: string; arguments: { asin: string } };
    };
    const operation = body.params.name;
    const asin = body.params.arguments.asin;
    calls.push({ operation, asin });
    const position = ASINS.indexOf(asin as (typeof ASINS)[number]) + 1;
    const data = fakeOperationResult(operation, asin, position);
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "text", text: JSON.stringify(data) }] },
      }),
      { status: 200 },
    );
  };
}

function fakeOperationResult(operation: string, asin: string, position: number) {
  if (operation === "ops_get_listing_traffic_overview") {
    const total = position * 10_000;
    return {
      overview: {
        nf: { score: total * 0.7, ratio: 0.7 },
        ad: { score: total * 0.3, ratio: 0.3 },
      },
      ad: {
        sp: { name: "SP", score: total * 0.2, ratio: 2 / 3 },
        recommend: {
          name: "SP Recommend",
          score: total * 0.1,
          ratio: 1 / 3,
        },
      },
      recommend: {
        related: { name: "Related products", score: total * 0.05, ratio: 1 },
      },
      total,
      data_notice: "Data updated through 2026-08-16",
    };
  }
  if (operation === "ops_get_listing_traffic_structure") {
    const total = position * 10_000;
    return {
      chars: {
        dims: [
          {
            img: "",
            features: ["Default"],
            sumScore: total,
            ratio: 1,
            val: asin,
          },
        ],
        nfs: [{ score: total * 0.7 }],
        sps: [{ score: total * 0.2 }],
        recs: [{ score: total * 0.1 }],
        sbs: [{ score: 0 }],
        sbvs: [{ score: 0 }],
      },
      data_notice: "Data updated through 2026-08-16",
    };
  }
  if (operation === "ops_get_asin_traffic_trend") {
    return {
      dates: ["2026-07", "2026-08"],
      nfScore: [{ score: position * 6_000 }, { score: position * 7_000 }],
      adScore: [{ score: position * 2_000 }, { score: position * 3_000 }],
      data_notice: "Data updated through 2026-08-16",
    };
  }
  throw new Error(`Unexpected fake SIF operation: ${operation}`);
}

function generatedFileHashes() {
  return Object.fromEntries(
    generatedTrafficFiles.map((file) => [
      file,
      createHash("sha256")
        .update(readFileSync(resolve(file)))
        .digest("hex"),
    ]),
  );
}

async function waitForStage(
  repository: ReturnType<typeof openSqliteAgentRepository>,
  stageId: string,
  expected: "succeeded" | "failed",
) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const stage = await repository.findRunStage(stageId);
    if (stage?.status === expected) return;
    if (stage?.status === "failed") {
      assert.equal(stage.status, expected, JSON.stringify(stage.lastError));
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  const stage = await repository.findRunStage(stageId);
  assert.equal(stage?.status, expected, JSON.stringify(stage?.lastError));
}
