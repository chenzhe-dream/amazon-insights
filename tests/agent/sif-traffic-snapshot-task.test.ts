import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import type { RemoteMcpConnector } from "../../server/connectors/connector-contract";
import { createSifConnector } from "../../server/connectors/mcp-connectors";
import { openSqliteAgentRepository } from "../../server/db/sqlite-repository";
import type { TrafficAnalysisInput } from "../../server/domain/traffic/traffic-analysis-contracts";
import type {
  ModelProvider,
  StructuredGenerationRequest,
} from "../../server/runtime/model-provider";
import { createTrafficAnalysisRuntime } from "../../server/runtime/traffic-analysis-runtime";
import { WorkerTaskError } from "../../server/runtime/retry-policy";
import {
  SifTrafficSnapshotTask,
  SifTrafficSnapshotTaskError,
} from "../../server/services/sif-traffic-snapshot-task";
import { ScopedSifTrafficSnapshotAdapter } from "../../server/services/scoped-sif-traffic-snapshot-adapter";

const NOW = "2026-08-17T08:00:00.000Z";
const CUTOFF = "2026-08-17T07:59:59.999Z";
const ASINS = ["B0AAAAAA01", "B0AAAAAA02", "B0AAAAAA03"] as const;
const RETAINED_ASINS = ["B07ZPGD8YR", "B088LPLNPK", "B0G5N593D6"] as const;
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

test("retained B088 generated traffic shapes normalize without weakening the SIF schema", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "amazon-sif-b088-replay-"));
  const repository = openSqliteAgentRepository({
    path: join(directory, "agent.sqlite"),
    busyTimeoutMs: 5_000,
    nowProvider: () => new Date(NOW),
  });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const subject = await seedTrafficJob(repository, "collect-missing", RETAINED_ASINS);
  const calls: Array<{ operation: string; asin: string }> = [];
  const connector = createSifConnector({
    env: { SIF_MCP_SECRET: "fixture-secret" },
    fetchImpl: fakeSifFetch(calls, retainedB088OperationResult),
    clock: () => new Date(NOW),
    sleep: async () => undefined,
    policy: { timeoutMs: 100, maxAttempts: 1, retryDelayMs: 0, maxConcurrent: 1, maxQueue: 16 },
  });

  const snapshot = await new SifTrafficSnapshotTask({
    repository,
    connector,
    clock: () => new Date(NOW),
  }).createForRun({ ...subject, marketplace: "US", asins: RETAINED_ASINS, dataCutoffAt: CUTOFF });

  assert.equal(calls.length, RETAINED_ASINS.length * 3);
  assert.deepEqual(new Set(snapshot.payload.input.competitors.map(({ asin }) => asin)), new Set(RETAINED_ASINS));
  const retained = snapshot.payload.input.competitors.find(({ asin }) => asin === "B088LPLNPK");
  assert.deepEqual(
    retained?.monthlyTrend.map(({ natural, advertising }) => ({ natural, advertising })),
    [
      { natural: 46_924, advertising: 0 },
      { natural: 46_610, advertising: 0 },
    ],
  );
});

test("canonical monthly trend accepts only its explicit retained fetchedAt metadata", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "amazon-sif-fetched-at-replay-"));
  const repository = openSqliteAgentRepository({
    path: join(directory, "agent.sqlite"),
    busyTimeoutMs: 5_000,
    nowProvider: () => new Date(NOW),
  });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const subject = await seedTrafficJob(repository, "collect-missing", RETAINED_ASINS);
  const calls: Array<{ operation: string; asin: string }> = [];
  const connector = directSifConnector(calls, (operation, asin, position) => {
    const result = fakeOperationResult(operation, asin, position);
    return operation === "ops_get_asin_traffic_trend"
      ? { ...result, fetchedAt: "2026-08-23" }
      : result;
  });

  const snapshot = await new SifTrafficSnapshotTask({
    repository,
    connector,
    clock: () => new Date(NOW),
  }).createForRun({ ...subject, marketplace: "US", asins: RETAINED_ASINS, dataCutoffAt: CUTOFF });

  assert.equal(calls.length, RETAINED_ASINS.length * 3);
  assert.deepEqual(
    new Set(snapshot.payload.input.competitors.map(({ asin }) => asin)),
    new Set(RETAINED_ASINS),
  );
});

test("malformed B088 operation records only safe per-operation diagnostics and persists no snapshot", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "amazon-sif-b088-diagnostic-"));
  const repository = openSqliteAgentRepository({
    path: join(directory, "agent.sqlite"),
    busyTimeoutMs: 5_000,
    nowProvider: () => new Date(NOW),
  });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const subject = await seedTrafficJob(repository, "collect-missing", RETAINED_ASINS);
  const calls: Array<{ operation: string; asin: string }> = [];
  const unsafeSentinel = "raw-provider-body-credential-sentinel";
  const connector = createSifConnector({
    env: { SIF_MCP_SECRET: "fixture-secret" },
    fetchImpl: fakeSifFetch(calls, (operation, asin, position) => {
      const result = retainedB088OperationResult(operation, asin, position);
      return asin === "B088LPLNPK" && operation === "ops_get_asin_traffic_trend"
        ? { ...result, nf: [{ score: unsafeSentinel }] }
        : result;
    }),
    clock: () => new Date(NOW),
    sleep: async () => undefined,
    policy: { timeoutMs: 100, maxAttempts: 1, retryDelayMs: 0, maxConcurrent: 1, maxQueue: 16 },
  });

  await assert.rejects(
    new SifTrafficSnapshotTask({ repository, connector, clock: () => new Date(NOW) })
      .createForRun({ ...subject, marketplace: "US", asins: RETAINED_ASINS, dataCutoffAt: CUTOFF }),
    (error: unknown) => {
      assert.ok(error instanceof WorkerTaskError);
      assert.equal(error.category, "data-quality");
      assert.deepEqual(
        {
          asin: Reflect.get(error, "asin"),
          operation: Reflect.get(error, "operation"),
          reasonCode: Reflect.get(error, "reasonCode"),
        },
        {
          asin: "B088LPLNPK",
          operation: "ops_get_asin_traffic_trend",
          reasonCode: "SIF_TRAFFIC_SCHEMA_INVALID",
        },
      );
      assert.doesNotMatch(error.message, /raw-provider|credential|header|authorization/i);
      return true;
    },
  );
  assert.equal(calls.length, 6);
  assert.equal((await repository.listTrafficDataSnapshotsByRun({
    actorOrganizationId: subject.organizationId,
    runId: subject.runId,
  })).length, 0);
});

test("listing overview diagnostics retain only fixed shape evidence", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "amazon-sif-overview-diagnostic-"));
  const repository = openSqliteAgentRepository({
    path: join(directory, "agent.sqlite"),
    busyTimeoutMs: 5_000,
    nowProvider: () => new Date(NOW),
  });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const subject = await seedTrafficJob(repository, "collect-missing", RETAINED_ASINS);
  const privateValueSentinel = "private-overview-provider-value";
  const validOverview = {
    overview: {
      nf: { score: 7, ratio: 0.7 },
      ad: { score: 3, ratio: 0.3 },
    },
    ad: {},
    recommend: {},
    total: 10,
    data_notice: "fixture notice",
  };
  const expected = (candidateType: string, fields: Record<string, Record<string, unknown>>, firstInvalid: Record<string, unknown>) => ({
    kind: "listing-overview",
    candidateType,
    fields,
    firstInvalid,
  });
  const baseFields = {
    overview: { present: true, type: "object" },
    ad: { present: true, type: "object" },
    recommend: { present: true, type: "object" },
    total: { present: true, type: "number" },
    data_notice: { present: true, type: "string" },
    "overview.nf": { present: true, type: "object" },
    "overview.ad": { present: true, type: "object" },
    "overview.nf.score": { present: true, type: "number" },
    "overview.nf.ratio": { present: true, type: "number" },
    "overview.ad.score": { present: true, type: "number" },
    "overview.ad.ratio": { present: true, type: "number" },
  };
  const missing = { present: false, type: "missing" };
  const scenarios = [
    {
      name: "root non-object",
      candidate: null,
      expected: expected("null", Object.fromEntries(Object.keys(baseFields).map((field) => [field, missing])), {
        field: "root", reason: "unknown-shape",
      }),
    },
    {
      name: "missing overview",
      candidate: { ad: {}, recommend: {}, total: 10, [privateValueSentinel]: privateValueSentinel },
      expected: expected("object", {
        ...baseFields,
        overview: missing,
        data_notice: missing,
        "overview.nf": missing,
        "overview.ad": missing,
        "overview.nf.score": missing,
        "overview.nf.ratio": missing,
        "overview.ad.score": missing,
        "overview.ad.ratio": missing,
      }, { field: "overview", reason: "type" }),
    },
    {
      name: "wrong overview",
      candidate: { ...validOverview, overview: [] },
      expected: expected("object", {
        ...baseFields,
        overview: { present: true, type: "array" },
        "overview.nf": missing,
        "overview.ad": missing,
        "overview.nf.score": missing,
        "overview.nf.ratio": missing,
        "overview.ad.score": missing,
        "overview.ad.ratio": missing,
      }, { field: "overview", reason: "type" }),
    },
    {
      name: "wrong ad",
      candidate: { ...validOverview, ad: [] },
      expected: expected("object", { ...baseFields, ad: { present: true, type: "array" } }, { field: "ad", reason: "type" }),
    },
    {
      name: "wrong recommend",
      candidate: { ...validOverview, recommend: [] },
      expected: expected("object", { ...baseFields, recommend: { present: true, type: "array" } }, { field: "recommend", reason: "type" }),
    },
    {
      name: "missing distribution score",
      candidate: { ...validOverview, overview: { ...validOverview.overview, nf: { ratio: 0.7 } } },
      expected: expected("object", { ...baseFields, "overview.nf.score": missing }, { field: "overview.nf.score", reason: "type" }),
    },
    {
      name: "missing distribution ratio",
      candidate: { ...validOverview, overview: { ...validOverview.overview, nf: { score: 7 } } },
      expected: expected("object", { ...baseFields, "overview.nf.ratio": missing }, { field: "overview.nf.ratio", reason: "type" }),
    },
    {
      name: "wrong distribution score",
      candidate: { ...validOverview, overview: { ...validOverview.overview, nf: { score: privateValueSentinel, ratio: 0.7 } } },
      expected: expected("object", { ...baseFields, "overview.nf.score": { present: true, type: "string" } }, { field: "overview.nf.score", reason: "type" }),
    },
    {
      name: "wrong distribution ratio",
      candidate: { ...validOverview, overview: { ...validOverview.overview, nf: { score: 7, ratio: privateValueSentinel } } },
      expected: expected("object", { ...baseFields, "overview.nf.ratio": { present: true, type: "string" } }, { field: "overview.nf.ratio", reason: "type" }),
    },
    {
      name: "nonfinite distribution score",
      candidate: { ...validOverview, overview: { ...validOverview.overview, nf: { score: Number.POSITIVE_INFINITY, ratio: 0.7 } } },
      expected: expected("object", { ...baseFields }, { field: "overview.nf.score", reason: "nonfinite" }),
    },
    {
      name: "nonfinite distribution ratio",
      candidate: { ...validOverview, overview: { ...validOverview.overview, nf: { score: 7, ratio: Number.POSITIVE_INFINITY } } },
      expected: expected("object", { ...baseFields }, { field: "overview.nf.ratio", reason: "nonfinite" }),
    },
    {
      name: "negative distribution score",
      candidate: { ...validOverview, overview: { ...validOverview.overview, ad: { score: -3, ratio: 0.3 } } },
      expected: expected("object", { ...baseFields }, { field: "overview.ad.score", reason: "negative" }),
    },
    {
      name: "negative distribution ratio",
      candidate: { ...validOverview, overview: { ...validOverview.overview, ad: { score: 3, ratio: -0.3 } } },
      expected: expected("object", { ...baseFields }, { field: "overview.ad.ratio", reason: "negative" }),
    },
  ] as const;

  for (const scenario of scenarios) {
    const calls: Array<{ operation: string; asin: string }> = [];
    const connector = directSifConnector(calls, (operation, asin, position) =>
      asin === "B07ZPGD8YR" && operation === "ops_get_listing_traffic_overview"
        ? scenario.candidate
        : fakeOperationResult(operation, asin, position));
    await assert.rejects(
      new SifTrafficSnapshotTask({ repository, connector, clock: () => new Date(NOW) })
        .createForRun({ ...subject, marketplace: "US", asins: RETAINED_ASINS, dataCutoffAt: CUTOFF }),
      (error: unknown) => {
        assert.ok(error instanceof SifTrafficSnapshotTaskError, scenario.name);
        assert.deepEqual(error.shapeDiagnostic, scenario.expected, scenario.name);
        assert.doesNotMatch(JSON.stringify(error.shapeDiagnostic), /private-overview-provider-value|body|header|authorization/i, scenario.name);
        return true;
      },
    );
    assert.equal((await repository.listTrafficDataSnapshotsByRun({
      actorOrganizationId: subject.organizationId,
      runId: subject.runId,
    })).length, 0, scenario.name);
  }
});

test("legacy B07 trend projection discards opaque extras before the next ASIN", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "amazon-sif-b07-shape-diagnostic-"));
  const repository = openSqliteAgentRepository({
    path: join(directory, "agent.sqlite"),
    busyTimeoutMs: 5_000,
    nowProvider: () => new Date(NOW),
  });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const subject = await seedTrafficJob(repository, "collect-missing", RETAINED_ASINS);
  const calls: Array<{ operation: string; asin: string }> = [];
  const privateValueSentinel = "private-provider-value-sentinel";
  const connector = createSifConnector({
    env: { SIF_MCP_SECRET: "fixture-secret" },
    fetchImpl: fakeSifFetch(calls, (operation, asin, position) => {
      const result = fakeOperationResult(operation, asin, position);
      if (asin !== "B07ZPGD8YR" || operation !== "ops_get_asin_traffic_trend") {
        return result;
      }
      assert.ok("nfScore" in result && "adScore" in result);
      return {
        dates: result.dates,
        nf: result.nfScore,
        ad: result.adScore,
        data_notice: result.data_notice,
        private_metadata: privateValueSentinel,
      };
    }),
    clock: () => new Date(NOW),
    sleep: async () => undefined,
    policy: { timeoutMs: 100, maxAttempts: 1, retryDelayMs: 0, maxConcurrent: 1, maxQueue: 16 },
  });

  const snapshot = await new SifTrafficSnapshotTask({
    repository,
    connector,
    clock: () => new Date(NOW),
  }).createForRun({ ...subject, marketplace: "US", asins: RETAINED_ASINS, dataCutoffAt: CUTOFF });

  assert.equal(calls.length, RETAINED_ASINS.length * 3);
  assert.doesNotMatch(
    JSON.stringify(snapshot),
    /private_metadata|private-provider-value|fixture-secret|header|authorization/i,
  );
});

test("monthly trend diagnostics retain only projected fetchedAt failures", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "amazon-sif-fetched-at-diagnostic-"));
  const repository = openSqliteAgentRepository({
    path: join(directory, "agent.sqlite"),
    busyTimeoutMs: 5_000,
    nowProvider: () => new Date(NOW),
  });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const subject = await seedTrafficJob(repository, "collect-missing", RETAINED_ASINS);
  const scenarios = [
    {
      name: "full-timestamp",
      candidate: {
        dates: ["2026-01"],
        nfScore: [{ score: 1 }],
        adScore: [{ score: 1 }],
        fetchedAt: "2026-08-23T20:37:22.914Z",
      },
      expected: {
        fetchedAt: { present: true, type: "string", dateOnlyValid: false },
        firstInvalid: { field: "fetchedAt", index: null, reason: "unknown-shape" },
      },
    },
    {
      name: "wrong-type",
      candidate: {
        dates: ["2026-01"],
        nfScore: [{ score: 1 }],
        adScore: [{ score: 1 }],
        fetchedAt: 1,
      },
      expected: {
        fetchedAt: { present: true, type: "number", dateOnlyValid: false },
        firstInvalid: { field: "fetchedAt", index: null, reason: "type" },
      },
    },
  ] as const;

  for (const scenario of scenarios) {
    const calls: Array<{ operation: string; asin: string }> = [];
    const connector = directSifConnector(calls, (operation, asin, position) =>
      asin === "B07ZPGD8YR" && operation === "ops_get_asin_traffic_trend"
        ? scenario.candidate
        : fakeOperationResult(operation, asin, position));
    await assert.rejects(
      new SifTrafficSnapshotTask({ repository, connector, clock: () => new Date(NOW) })
        .createForRun({ ...subject, marketplace: "US", asins: RETAINED_ASINS, dataCutoffAt: CUTOFF }),
      (error: unknown) => {
        assert.ok(error instanceof SifTrafficSnapshotTaskError, scenario.name);
        assert.deepEqual(error.shapeDiagnostic?.fields.fetchedAt, scenario.expected.fetchedAt, scenario.name);
        assert.deepEqual(error.shapeDiagnostic?.firstInvalid, scenario.expected.firstInvalid, scenario.name);
        assert.doesNotMatch(
          JSON.stringify(error.shapeDiagnostic),
          /private_metadata|private_context|private-provider-body-secret|body|header|authorization/i,
          scenario.name,
        );
        return true;
      },
    );
    assert.deepEqual(calls, [
      { asin: "B07ZPGD8YR", operation: "ops_get_listing_traffic_overview" },
      { asin: "B07ZPGD8YR", operation: "ops_get_listing_traffic_structure" },
      { asin: "B07ZPGD8YR", operation: "ops_get_asin_traffic_trend" },
    ], scenario.name);
  }
});

test("complete official trend response projects consumed fields and discards all extras", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "amazon-sif-official-shape-diagnostic-"));
  const repository = openSqliteAgentRepository({
    path: join(directory, "agent.sqlite"),
    busyTimeoutMs: 5_000,
    nowProvider: () => new Date(NOW),
  });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const subject = await seedTrafficJob(repository, "collect-missing", RETAINED_ASINS);
  const secretSentinel = "private-provider-body-secret-sentinel";
  const candidate = {
    dates: ["2026-01", "2026-02"],
    fetchedAt: "2026-08-23",
    asin: "B07ZPGD8YR",
    totalScore: [{ score: 3 }, { score: 4 }],
    nfScore: [{ score: 2 }, { score: 3 }],
    adScore: [{ score: 1 }, { score: 1 }],
    spScore: [{ score: 1 }, { score: 1 }],
    recSpScore: [{ score: 0 }, { score: 0 }],
    sbScore: [{ score: 0 }, { score: 0 }],
    sbvScore: [{ score: 0 }, { score: 0 }],
    trend_analysis: {},
    dealPrice: [],
    buyboxPrice: [],
    primePrice: [],
    ldPrice: [],
    couponInfo: [],
    promotion: [],
    buyboxSeller: [],
    bsr: [],
    subBsr: {},
    star: [],
    review: [],
    seller: [],
    woot: [],
    titleImg: [],
    boughtInPastMonth: [],
    catId: null,
    catName: null,
    pasin: true,
    data_notice: "retained notice",
    _formatted: { rendered_block: secretSentinel },
    _next_step: { options: [secretSentinel] },
    private_metadata: secretSentinel,
    private_context: { body: secretSentinel },
    opaque_flag: secretSentinel,
    opaque_array: [secretSentinel],
  };
  assert.equal(Object.keys(candidate).length, 36);
  const calls: Array<{ operation: string; asin: string }> = [];
  const connector = directSifConnector(calls, (operation, asin, position) =>
    asin === "B07ZPGD8YR" && operation === "ops_get_asin_traffic_trend"
      ? candidate
      : fakeOperationResult(operation, asin, position));

  const snapshot = await new SifTrafficSnapshotTask({
    repository,
    connector,
    clock: () => new Date(NOW),
  }).createForRun({ ...subject, marketplace: "US", asins: RETAINED_ASINS, dataCutoffAt: CUTOFF });

  assert.equal(calls.length, RETAINED_ASINS.length * 3);
  assert.deepEqual(
    snapshot.payload.input.competitors.find(({ asin }) => asin === "B07ZPGD8YR")?.monthlyTrend,
    [
      { month: "2026-01", natural: 2, advertising: 1, total: 3 },
      { month: "2026-02", natural: 3, advertising: 1, total: 4 },
    ],
  );
  assert.doesNotMatch(
    JSON.stringify(snapshot),
    /private_metadata|private_context|opaque_flag|opaque_array|private-provider-body-secret|rendered_block|options|body|header|authorization/i,
  );
});

test("monthly trend source hashes ignore nested unknown score keys", async (t) => {
  const directories = [
    mkdtempSync(join(tmpdir(), "amazon-sif-nested-hash-a-")),
    mkdtempSync(join(tmpdir(), "amazon-sif-nested-hash-b-")),
  ];
  const repositories = directories.map((directory) => openSqliteAgentRepository({
    path: join(directory, "agent.sqlite"),
    busyTimeoutMs: 5_000,
    nowProvider: () => new Date(NOW),
  }));
  t.after(() => {
    for (const repository of repositories) repository.close();
    for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  });

  const fingerprints = [];
  for (const [index, repository] of repositories.entries()) {
    const subject = await seedTrafficJob(repository, "collect-missing", RETAINED_ASINS);
    const nestedOpaqueValue = `nested-opaque-${index}`;
    const connector = directSifConnector([], (operation, asin, position) =>
      asin === "B07ZPGD8YR" && operation === "ops_get_asin_traffic_trend"
        ? {
            dates: ["2026-01"],
            nfScore: [{ score: 1, nestedOpaqueValue }],
            adScore: [{ score: 2, nestedOpaqueValue }],
          }
        : fakeOperationResult(operation, asin, position));
    const snapshot = await new SifTrafficSnapshotTask({
      repository,
      connector,
      clock: () => new Date(NOW),
    }).createForRun({ ...subject, marketplace: "US", asins: RETAINED_ASINS, dataCutoffAt: CUTOFF });
    const monthlySource = snapshot.sources.find(({ id }) => id === "sif-monthly-traffic-trend");
    assert.ok(monthlySource && "requests" in monthlySource);
    fingerprints.push({
      contentHash: snapshot.contentHash,
      sourceChecksum: monthlySource.checksum,
      requestChecksums: monthlySource.requests.map(({ checksum }) => checksum),
    });
    assert.doesNotMatch(JSON.stringify(snapshot), /nestedOpaqueValue|nested-opaque/i);
  }

  assert.deepEqual(fingerprints[0], fingerprints[1]);
});

test("malformed projected trend core fields fail closed without snapshot writes", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "amazon-sif-projected-core-"));
  const repository = openSqliteAgentRepository({
    path: join(directory, "agent.sqlite"),
    busyTimeoutMs: 5_000,
    nowProvider: () => new Date(NOW),
  });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const subject = await seedTrafficJob(repository, "collect-missing", RETAINED_ASINS);
  const opaqueSentinel = "opaque-provider-value-sentinel";
  const points25 = Array.from({ length: 25 }, () => ({ score: 1 }));
  const scenarios = [
    {
      name: "missing dates",
      candidate: { nfScore: [{ score: 1 }], adScore: [{ score: 1 }], opaque: opaqueSentinel },
    },
    {
      name: "wrong score array type",
      candidate: { dates: ["2026-01"], nfScore: {}, adScore: [{ score: 1 }], opaque: opaqueSentinel },
    },
    {
      name: "invalid month",
      candidate: { dates: ["2026-13"], nfScore: [{ score: 1 }], adScore: [{ score: 1 }], opaque: opaqueSentinel },
    },
    {
      name: "negative score",
      candidate: { dates: ["2026-01"], nfScore: [{ score: -1 }], adScore: [{ score: 1 }], opaque: opaqueSentinel },
    },
    {
      name: "non-finite score",
      candidate: { dates: ["2026-01"], nfScore: [{ score: Number.POSITIVE_INFINITY }], adScore: [{ score: 1 }], opaque: opaqueSentinel },
    },
    {
      name: "more than 24 points",
      candidate: { dates: Array.from({ length: 25 }, (_, index) => `2026-${String((index % 12) + 1).padStart(2, "0")}`), nfScore: points25, adScore: points25, opaque: opaqueSentinel },
      expectedFirstInvalid: { field: "dates", index: 24, reason: "length-mismatch" },
    },
  ] as const;

  for (const scenario of scenarios) {
    const calls: Array<{ operation: string; asin: string }> = [];
    const connector = directSifConnector(calls, (operation, asin, position) =>
      asin === "B07ZPGD8YR" && operation === "ops_get_asin_traffic_trend"
        ? scenario.candidate
        : fakeOperationResult(operation, asin, position));
    await assert.rejects(
      new SifTrafficSnapshotTask({ repository, connector, clock: () => new Date(NOW) })
        .createForRun({ ...subject, marketplace: "US", asins: RETAINED_ASINS, dataCutoffAt: CUTOFF }),
      (error: unknown) => {
        assert.ok(error instanceof SifTrafficSnapshotTaskError, scenario.name);
        assert.equal(error.reasonCode, "SIF_TRAFFIC_SCHEMA_INVALID", scenario.name);
        assert.doesNotMatch(
          JSON.stringify(error.shapeDiagnostic),
          /opaque|opaque-provider-value|body|header|authorization/i,
          scenario.name,
        );
        if (scenario.name === "missing dates") {
          assert.deepEqual(error.shapeDiagnostic?.fields.dates, {
            present: false,
            type: "missing",
          });
        }
        if (scenario.expectedFirstInvalid) {
          assert.deepEqual(error.shapeDiagnostic?.firstInvalid, scenario.expectedFirstInvalid);
        }
        return true;
      },
    );
    assert.equal((await repository.listTrafficDataSnapshotsByRun({
      actorOrganizationId: subject.organizationId,
      runId: subject.runId,
    })).length, 0, scenario.name);
  }
});

test("trend diagnostics bound core failures without retaining discarded fields", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "amazon-sif-official-array-diagnostic-"));
  const repository = openSqliteAgentRepository({
    path: join(directory, "agent.sqlite"),
    busyTimeoutMs: 5_000,
    nowProvider: () => new Date(NOW),
  });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const subject = await seedTrafficJob(repository, "collect-missing", RETAINED_ASINS);
  const scenarios = [
    {
      name: "mixed",
      candidate: {
        dates: ["2026-01", "2026-02"],
        nfScore: [{ score: 1 }, 2],
        adScore: [{ score: 1 }, { score: 1 }],
      },
      expected: { field: "nfScore", index: 1, reason: "type" },
    },
    {
      name: "nonfinite",
      candidate: {
        dates: ["2026-01", "2026-02"],
        nfScore: [{ score: 1 }, { score: Number.POSITIVE_INFINITY }],
        adScore: [{ score: 1 }, { score: 1 }],
      },
      expected: { field: "nfScore", index: 1, reason: "nonfinite" },
    },
    {
      name: "negative",
      candidate: {
        dates: ["2026-01", "2026-02"],
        nfScore: [{ score: 1 }, { score: -1 }],
        adScore: [{ score: 1 }, { score: 1 }],
      },
      expected: { field: "nfScore", index: 1, reason: "negative" },
    },
  ] as const;

  for (const scenario of scenarios) {
    const calls: Array<{ operation: string; asin: string }> = [];
    const connector = directSifConnector(calls, (operation, asin, position) =>
      asin === "B07ZPGD8YR" && operation === "ops_get_asin_traffic_trend"
        ? scenario.candidate
        : fakeOperationResult(operation, asin, position));
    await assert.rejects(
      new SifTrafficSnapshotTask({ repository, connector, clock: () => new Date(NOW) })
        .createForRun({ ...subject, marketplace: "US", asins: RETAINED_ASINS, dataCutoffAt: CUTOFF }),
      (error: unknown) => {
        assert.ok(error instanceof SifTrafficSnapshotTaskError, scenario.name);
        assert.deepEqual(error.shapeDiagnostic!.firstInvalid, scenario.expected, scenario.name);
        assert.doesNotMatch(JSON.stringify(error.shapeDiagnostic), /must-not-leak|private|body|header|authorization/i);
        return true;
      },
    );
  }

  const calls: Array<{ operation: string; asin: string }> = [];
  const connector = directSifConnector(calls, (operation, asin, position) =>
    asin === "B07ZPGD8YR" && operation === "ops_get_asin_traffic_trend"
      ? {
          dates: ["2026-01", "2026-02"],
          nfScore: [{ score: 1 }],
          adScore: [{ score: 1 }, { score: 1 }],
          _formatted: {},
        }
      : fakeOperationResult(operation, asin, position));
  await assert.rejects(
    new SifTrafficSnapshotTask({ repository, connector, clock: () => new Date(NOW) })
      .createForRun({ ...subject, marketplace: "US", asins: RETAINED_ASINS, dataCutoffAt: CUTOFF }),
    (error: unknown) => {
      assert.ok(error instanceof SifTrafficSnapshotTaskError);
      assert.deepEqual(error.shapeDiagnostic!.coreLengthMismatch, {
        field: "nfScore",
        expectedLength: 2,
        actualLength: 1,
        firstInvalidIndex: 1,
      });
      return true;
    },
  );
});

test("monthly trend shape diagnostics use fixed reasons and the first invalid array index", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "amazon-sif-shape-reasons-"));
  const repository = openSqliteAgentRepository({
    path: join(directory, "agent.sqlite"),
    busyTimeoutMs: 5_000,
    nowProvider: () => new Date(NOW),
  });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const subject = await seedTrafficJob(repository, "collect-missing", RETAINED_ASINS);
  const privateValueSentinel = "private-provider-value-sentinel";
  const scenarios = [
    {
      name: "type",
      candidate: {
        dates: ["2026-01", { private: privateValueSentinel }],
        nf: [{ score: 1 }, { score: 1 }],
        ad: [{ score: 1 }, { score: 1 }],
      },
      expected: { field: "dates", index: 1, reason: "type" },
    },
    {
      name: "nonfinite",
      candidate: {
        dates: ["2026-01", "2026-02"],
        nf: [{ score: 1 }, { score: Number.POSITIVE_INFINITY }],
        ad: [{ score: 1 }, { score: 1 }],
      },
      expected: { field: "nf", index: 1, reason: "nonfinite" },
    },
    {
      name: "negative",
      candidate: {
        dates: ["2026-01", "2026-02"],
        nf: [{ score: 1 }, { score: -1 }],
        ad: [{ score: 1 }, { score: 1 }],
      },
      expected: { field: "nf", index: 1, reason: "negative" },
    },
    {
      name: "length-mismatch",
      candidate: {
        dates: ["2026-01", "2026-02"],
        nf: [{ score: 1 }],
        ad: [{ score: 1 }, { score: 1 }],
        private_metadata: privateValueSentinel,
      },
      expected: { field: "nf", index: 1, reason: "length-mismatch" },
    },
    {
      name: "unknown-shape",
      candidate: {
        dates: ["2026-01"],
        nfScore: [{ score: 1 }],
        ad: [{ score: 1 }],
      },
      expected: { field: "root", index: null, reason: "unknown-shape" },
    },
    {
      name: "invalid-fetched-at",
      candidate: {
        dates: ["2026-01"],
        nfScore: [{ score: 1 }],
        adScore: [{ score: 1 }],
        fetchedAt: "2026-13-40",
      },
      expected: { field: "fetchedAt", index: null, reason: "unknown-shape" },
    },
  ] as const;

  for (const scenario of scenarios) {
    const calls: Array<{ operation: string; asin: string }> = [];
    const connector = directSifConnector(calls, (operation, asin, position) =>
      asin === "B07ZPGD8YR" && operation === "ops_get_asin_traffic_trend"
        ? scenario.candidate
        : fakeOperationResult(operation, asin, position));
    await assert.rejects(
      new SifTrafficSnapshotTask({ repository, connector, clock: () => new Date(NOW) })
        .createForRun({ ...subject, marketplace: "US", asins: RETAINED_ASINS, dataCutoffAt: CUTOFF }),
      (error: unknown) => {
        assert.ok(error instanceof SifTrafficSnapshotTaskError, scenario.name);
        assert.deepEqual(error.shapeDiagnostic?.firstInvalid, scenario.expected, scenario.name);
        assert.doesNotMatch(
          JSON.stringify(error.shapeDiagnostic),
          /private_metadata|private-provider-value|fixture-secret|header|authorization/i,
          scenario.name,
        );
        return true;
      },
    );
    assert.deepEqual(calls, [
      { asin: "B07ZPGD8YR", operation: "ops_get_listing_traffic_overview" },
      { asin: "B07ZPGD8YR", operation: "ops_get_listing_traffic_structure" },
      { asin: "B07ZPGD8YR", operation: "ops_get_asin_traffic_trend" },
    ], scenario.name);
  }
  assert.equal((await repository.listTrafficDataSnapshotsByRun({
    actorOrganizationId: subject.organizationId,
    runId: subject.runId,
  })).length, 0);
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
  asins: readonly string[] = ASINS,
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
    asins: [...asins],
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
  resultFor: typeof fakeOperationResult = fakeOperationResult,
): typeof fetch {
  return async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as {
      params: { name: string; arguments: { asin: string } };
    };
    const operation = body.params.name;
    const asin = body.params.arguments.asin;
    calls.push({ operation, asin });
    const standardPosition = ASINS.indexOf(asin as (typeof ASINS)[number]);
    const retainedPosition = RETAINED_ASINS.indexOf(asin as (typeof RETAINED_ASINS)[number]);
    const position = (standardPosition >= 0 ? standardPosition : retainedPosition) + 1;
    const data = resultFor(operation, asin, position);
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

function directSifConnector(
  calls: Array<{ operation: string; asin: string }>,
  resultFor: typeof fakeOperationResult,
): RemoteMcpConnector {
  return {
    id: "sif",
    async execute(request) {
      const asin = String(request.input.asin);
      const position = RETAINED_ASINS.indexOf(
        asin as (typeof RETAINED_ASINS)[number],
      ) + 1;
      calls.push({ operation: request.operation, asin });
      return {
        data: resultFor(request.operation, asin, position),
        source: {
          connectorId: "sif",
          operation: request.operation,
          fetchedAt: NOW,
          attemptCount: 1,
        },
      };
    },
    async probe() {
      return {
        connectorId: "sif",
        configured: true,
        available: true,
        reason: null,
        checkedAt: NOW,
      };
    },
  };
}

function retainedB088OperationResult(operation: string, asin: string, position: number) {
  if (asin !== "B088LPLNPK") return fakeOperationResult(operation, asin, position);
  if (operation === "ops_get_listing_traffic_overview") {
    return {
      overview: {
        nf: { score: 23_971.19557553, ratio: 1 },
        ad: { score: 0, ratio: 0 },
      },
      ad: {},
      recommend: {},
      total: 23_971.195575530903,
      data_notice: "Data updated through 2026-08-22",
    };
  }
  if (operation === "ops_get_listing_traffic_structure") {
    return {
      chars: {
        dims: [
          { img: "fixture", features: ["Orange"], sumScore: 19_671.91505985, ratio: 0.82064806, val: asin },
          { img: "fixture", features: ["Green"], sumScore: 4_299.28051568, ratio: 0.17935194, val: "B088LT68QM" },
        ],
        nfs: [{ score: 19_671.91505985 }, { score: 4_299.28051568 }],
        sps: [{ score: 0 }, { score: 0 }],
        recs: [{ score: 0 }, { score: 0 }],
        sbs: [{ score: 0 }, { score: 0 }],
        sbvs: [{ score: 0 }, { score: 0 }],
      },
      data_notice: "Data updated through 2026-08-22",
    };
  }
  if (operation === "ops_get_asin_traffic_trend") {
    return {
      fetchedAt: "2026-08-23",
      dates: ["2026-03", "2026-04"],
      nf: [{ score: 46_924.15087425621 }, { score: 46_610.47602638128 }],
      ad: [{ score: 0 }, { score: 0 }],
      data_notice: "Data updated through 2026-08-22",
    };
  }
  throw new Error(`Unexpected retained B088 operation: ${operation}`);
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
