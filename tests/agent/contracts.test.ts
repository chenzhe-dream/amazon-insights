import assert from "node:assert/strict";
import test from "node:test";

import {
  AgentRunAuditSchema,
  AgentRunSchema,
  AnalysisReportSchema,
  AnalysisRunSchema,
  ApiErrorResponseSchema,
  CreateProjectRequestSchema,
  DataSnapshotSchema,
  EntityIdSchema,
  LocalDataSyncJobSchema,
  findHttpContract,
  RequestIdSchema,
  RunStageSchema,
  SnapshotSourceSchema,
  UserSchema,
  v1Contracts,
} from "../../shared/agent-contracts";

const now = "2026-08-14T08:00:00.000Z";
const userId = "10000000-0000-4000-8000-000000000001";
const organizationId = "10000000-0000-4000-8000-000000000002";
const projectId = "10000000-0000-4000-8000-000000000003";
const runId = "10000000-0000-4000-8000-000000000004";
const stageId = "10000000-0000-4000-8000-000000000005";
const snapshotId = "10000000-0000-4000-8000-000000000006";
const jobAttemptId = "10000000-0000-4000-8000-000000000009";

const skill = {
  id: "define-amazon-voc-positioning",
  version: "1.0.0",
  contentHash: "a".repeat(64),
};

test("strict entity contracts reject unknown fields and status values", () => {
  assert.equal(
    UserSchema.safeParse({
      id: userId,
      organizationId,
      email: "member@example.com",
      displayName: "Member",
      role: "member",
      status: "active",
      createdAt: now,
      updatedAt: now,
      secret: "must-not-be-accepted",
    }).success,
    false,
  );

  assert.equal(
    AnalysisRunSchema.safeParse({
      id: runId,
      projectId,
      mode: "existing-data",
      status: "mystery",
      createdBy: userId,
      dataCutoffAt: now,
      createdAt: now,
      updatedAt: now,
    }).success,
    false,
  );

  assert.equal(
    RunStageSchema.safeParse({
      id: stageId,
      runId,
      stage: "voc-positioning",
      status: "almost-done",
      progress: 50,
      attemptCount: 0,
      startedAt: null,
      completedAt: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    }).success,
    false,
  );
});

test("entity IDs use the same UUIDv4 policy as proxy path IDs", () => {
  assert.equal(EntityIdSchema.safeParse(userId).success, true);
  assert.equal(
    EntityIdSchema.safeParse("018f1f7e-7b2d-7c3a-8f4e-123456789abc")
      .success,
    false,
  );

  const uppercaseId = "ABCDEF12-3456-4ABC-8DEF-ABCDEF123456";
  assert.equal(EntityIdSchema.safeParse(uppercaseId).success, true);
  assert.equal(
    findHttpContract("GET", `/v1/projects/${uppercaseId}`)?.path,
    "/v1/projects/:projectId",
  );
});

test("request IDs accept only bounded safe ASCII correlation characters", () => {
  assert.equal(RequestIdSchema.safeParse("browser-request-123").success, true);
  assert.equal(RequestIdSchema.safeParse("trace.id_1:span-2").success, true);
  assert.equal(RequestIdSchema.safeParse("café").success, false);
  assert.equal(RequestIdSchema.safeParse("a".repeat(129)).success, false);
  assert.equal(RequestIdSchema.safeParse("   ").success, false);
});

test("project creation rejects invalid, duplicate, or out-of-range ASINs", () => {
  const validBase = {
    name: "Scooter competitors",
    marketplace: "US",
  };

  assert.equal(
    CreateProjectRequestSchema.safeParse({
      ...validBase,
      asins: ["B0ABC12345", "not-an-asin", "B0DEF67890"],
    }).success,
    false,
  );
  assert.equal(
    CreateProjectRequestSchema.safeParse({
      ...validBase,
      asins: ["B0ABC12345", "B0ABC12345", "B0DEF67890"],
    }).success,
    false,
  );
  assert.equal(
    CreateProjectRequestSchema.safeParse({
      ...validBase,
      asins: ["B0ABC12345", "B0DEF67890"],
    }).success,
    false,
  );
});

test("versioned snapshots and agent runs require schema and provenance", () => {
  const snapshot = {
    id: snapshotId,
    runId,
    marketplace: "US",
    asins: ["B0ABC12345", "B0DEF67890", "B0GHI13579"],
    dataCutoffAt: now,
    sources: [
      {
        type: "manual-voc",
        reference: "upload:sha256:abc",
        capturedAt: now,
        checksum: "b".repeat(64),
      },
    ],
    createdAt: now,
  };

  assert.equal(DataSnapshotSchema.safeParse(snapshot).success, false);
  assert.equal(
    DataSnapshotSchema.safeParse({
      ...snapshot,
      schemaVersion: "1.0.0",
      contentHash: "c".repeat(64),
    }).success,
    true,
  );
  assert.equal(
    DataSnapshotSchema.safeParse({
      ...snapshot,
      schemaVersion: "1.0.0",
      contentHash: "C".repeat(64),
    }).success,
    false,
  );
  assert.equal(
    SnapshotSourceSchema.safeParse({
      ...snapshot.sources[0],
      checksum: "B".repeat(64),
    }).success,
    false,
  );

  const agentRun = {
    schemaVersion: "1.0.0",
    id: "10000000-0000-4000-8000-000000000007",
    runId,
    stage: "voc-positioning",
    status: "succeeded",
    skill,
    snapshotIds: [snapshotId],
    model: { provider: "openai", model: "configured-model" },
    inputSummary: { contentHash: "c".repeat(64), recordCount: 3 },
    outputSchemaVersion: "1.0.0",
    output: { summary: "Validated output" },
    validationStatus: "passed",
    error: null,
    dataCutoffAt: now,
    startedAt: now,
    completedAt: now,
  };

  assert.equal(AgentRunSchema.safeParse(agentRun).success, true);
  assert.equal(
    AgentRunSchema.safeParse({ ...agentRun, snapshotIds: [] }).success,
    false,
  );
});

test("AgentRun audit v1.1 is strict, lifecycle-safe, and legacy compatible", () => {
  const legacyAgentRun = {
    schemaVersion: "1.0.0",
    id: "10000000-0000-4000-8000-000000000007",
    runId,
    stage: "voc-positioning",
    status: "succeeded",
    skill,
    snapshotIds: [snapshotId],
    model: { provider: "openai", model: "configured-model" },
    inputSummary: { contentHash: "c".repeat(64), recordCount: 3 },
    outputSchemaVersion: "1.0.0",
    output: { summary: "Validated output" },
    validationStatus: "passed",
    error: null,
    dataCutoffAt: now,
    startedAt: now,
    completedAt: now,
  };
  const audit = {
    ...legacyAgentRun,
    schemaVersion: "1.1.0",
    stageId,
    jobAttemptId,
    executionFingerprint: "d".repeat(64),
    outputSchemaDigest: "e".repeat(64),
    model: {
      provider: "openai",
      model: "configured-model",
      responseId: "resp_1",
    },
    inputTokens: 100,
    outputTokens: 25,
    estimatedCostMicros: 321,
    durationMs: 90,
    attemptCount: 2,
    usageCompleteness: "complete",
    terminalMetadata: { kind: "succeeded" },
    attempts: [
      {
        ordinal: 0,
        kind: "initial",
        transientRetryCount: 0,
        formatRepair: false,
        accounting: "settled",
        errorClassification: "model-output",
      },
      {
        ordinal: 1,
        kind: "format-repair",
        transientRetryCount: 0,
        formatRepair: true,
        accounting: "settled",
        errorClassification: null,
      },
    ],
  };

  assert.equal(AgentRunSchema.safeParse(legacyAgentRun).success, true);
  assert.equal(AgentRunAuditSchema.safeParse(audit).success, true);
  assert.equal(AgentRunSchema.safeParse(audit).success, true);
  assert.equal(
    AgentRunAuditSchema.safeParse({ ...audit, estimatedCostMicros: 1.5 })
      .success,
    false,
  );
  assert.equal(
    AgentRunAuditSchema.safeParse({
      ...audit,
      inputTokens: Number.MAX_SAFE_INTEGER,
      outputTokens: 1,
    }).success,
    false,
  );
  assert.equal(
    AgentRunAuditSchema.safeParse({
      ...audit,
      snapshotIds: [snapshotId, snapshotId],
    }).success,
    false,
  );
  assert.equal(
    AgentRunAuditSchema.safeParse({ ...audit, unexpected: true }).success,
    false,
  );
  assert.equal(
    AgentRunAuditSchema.safeParse({
      ...audit,
      executionFingerprint: "D".repeat(64),
    }).success,
    false,
  );
  assert.equal(
    AgentRunAuditSchema.safeParse({
      ...audit,
      executionFingerprint: undefined,
    }).success,
    false,
  );

  const pending = {
    ...audit,
    status: "running",
    model: { provider: "openai", model: "configured-model" },
    output: null,
    validationStatus: "pending",
    inputTokens: null,
    outputTokens: null,
    estimatedCostMicros: null,
    durationMs: null,
    attemptCount: null,
    usageCompleteness: null,
    terminalMetadata: null,
    attempts: [],
    completedAt: null,
  };
  assert.equal(AgentRunAuditSchema.safeParse(pending).success, true);
  assert.equal(
    AgentRunAuditSchema.safeParse({
      ...pending,
      output: { leakedEarly: true },
    }).success,
    false,
  );

  const partial = {
    ...audit,
    usageCompleteness: "partial",
    attempts: [
      audit.attempts[0],
      {
        ordinal: 1,
        kind: "transient-retry",
        transientRetryCount: 1,
        formatRepair: true,
        accounting: "projected",
        errorClassification: "upstream-temporary",
      },
    ],
  };
  assert.equal(AgentRunAuditSchema.safeParse(partial).success, true);
  assert.equal(
    AgentRunAuditSchema.safeParse({
      ...audit,
      usageCompleteness: "complete",
      attempts: partial.attempts,
    }).success,
    false,
  );

  const unavailable = {
    ...audit,
    inputTokens: null,
    outputTokens: null,
    estimatedCostMicros: null,
    usageCompleteness: "unavailable",
    attempts: audit.attempts.map((attempt) => ({
      ...attempt,
      accounting: "unavailable",
      errorClassification: "unavailable",
    })),
  };
  assert.equal(AgentRunAuditSchema.safeParse(unavailable).success, true);
  assert.equal(
    AgentRunAuditSchema.safeParse({
      ...unavailable,
      estimatedCostMicros: 0,
    }).success,
    false,
  );
  assert.equal(
    AgentRunAuditSchema.safeParse({
      ...audit,
      attempts: [
        {
          ordinal: 0,
          kind: "initial",
          transientRetryCount: 0,
          formatRepair: false,
          accounting: "settled",
          errorClassification: "raw-provider-message",
        },
      ],
      attemptCount: 1,
    }).success,
    false,
  );

  const failed = {
    ...audit,
    status: "failed",
    model: { provider: "openai", model: "configured-model" },
    output: null,
    validationStatus: "failed",
    error: {
      code: "UPSTREAM_PERMANENT",
      message: "Model provider request failed",
      requestId: "agent-run:failure",
      retryable: false,
    },
    terminalMetadata: {
      kind: "failed",
      classification: "upstream-permanent",
    },
  };
  assert.equal(AgentRunAuditSchema.safeParse(failed).success, true);
  assert.equal(
    AgentRunAuditSchema.safeParse({ ...failed, durationMs: null }).success,
    true,
  );
  assert.equal(
    AgentRunAuditSchema.safeParse({ ...failed, error: null }).success,
    false,
  );
  assert.equal(
    AgentRunAuditSchema.safeParse({ ...audit, completedAt: null }).success,
    false,
  );
});

test("reports reject missing schemaVersion or missing Skill/snapshot provenance", () => {
  const report = {
    schemaVersion: "1.0.0",
    id: "10000000-0000-4000-8000-000000000008",
    runId,
    agentRunId: "10000000-0000-4000-8000-000000000007",
    version: 1,
    stage: "voc-positioning",
    status: "complete",
    skill,
    snapshotIds: [snapshotId],
    model: { provider: "openai", model: "configured-model" },
    dataCutoffAt: now,
    evidence: [
      {
        id: "evidence-1",
        type: "snapshot",
        sourceId: snapshotId,
        capturedAt: now,
      },
    ],
    result: { summary: "Evidence-backed result" },
    createdAt: now,
  };

  const withoutSchemaVersion = Object.fromEntries(
    Object.entries(report).filter(([key]) => key !== "schemaVersion"),
  );
  assert.equal(
    AnalysisReportSchema.safeParse(withoutSchemaVersion).success,
    false,
  );
  assert.equal(
    AnalysisReportSchema.safeParse({
      ...report,
      skill: undefined,
    }).success,
    false,
  );
  assert.equal(
    AnalysisReportSchema.safeParse({
      ...report,
      snapshotIds: [],
    }).success,
    false,
  );
  assert.equal(
    AnalysisReportSchema.safeParse(report).success,
    true,
  );
  assert.equal(
    AnalysisReportSchema.safeParse({ ...report, evidence: [] }).success,
    false,
  );
  assert.equal(
    AnalysisReportSchema.safeParse({ ...report, result: null }).success,
    false,
  );
});

test("the standard API error is strict and request-correlated", () => {
  assert.equal(
    ApiErrorResponseSchema.safeParse({
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid ASIN",
        requestId: "request-123",
        details: [{ path: "asins.1", message: "Invalid ASIN" }],
      },
    }).success,
    true,
  );
  assert.equal(
    ApiErrorResponseSchema.safeParse({
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid ASIN",
        requestId: "request-123",
        internalUrl: "http://127.0.0.1:3100",
      },
    }).success,
    false,
  );
});

test("sync job contracts expose only safe structured per-ASIN result statuses", () => {
  const job = {
    jobId: "job-1",
    asins: ["B0C4XRN398"],
    marketplace: "US",
    status: "completed-with-gaps",
    message: "同步完成，部分模块存在缺口。",
    currentStageId: "image_remarks",
    stages: [],
    asinProgress: {
      B0C4XRN398: {
        traffic: { status: "ready", reason: null, updatedAt: now },
        image_remarks: { status: "timeout", reason: "图片分析超过 90 秒", updatedAt: now },
        alexa_voc: { status: "manual", reason: "需人工录入", updatedAt: now },
      },
    },
    createdAt: now,
    updatedAt: now,
  };
  assert.equal(LocalDataSyncJobSchema.safeParse(job).success, true);
  assert.equal(LocalDataSyncJobSchema.safeParse({
    ...job,
    asinProgress: { B0C4XRN398: { traffic: { status: "missing", reason: null, updatedAt: now } } },
  }).success, false);
});

test("traffic snapshot reads use a bounded normalized contract", async () => {
  const { TrafficSnapshotReadResponseSchema } = await import("../../shared/agent-contracts");
  const payload = {
    version: "1",
    state: "ready",
    marketplace: "US",
    asins: ["B0C4XRN398"],
    source: "sif",
    collectedAt: now,
    traffic: {
      competitors: [{
        asin: "B0C4XRN398",
        brand: "Example",
        trafficRank: 1,
        trafficVolume: 1200,
        naturalVolume: 800,
        naturalShare: 66.7,
        advertisingVolume: 400,
        advertisingShare: 33.3,
        top1Share: 60,
        top3Share: 100,
        hhi: 5200,
        effectiveChildren: 2,
        childCount: 3,
        recommendationTraffic: 90,
        maxAdvertisingChannel: "SP(常规)",
        maxAdvertisingChannelShare: 70,
        effectiveAdvertisingChannels: 2,
        pullGrade: "中",
        naturalGrade: "中强",
        advertisingGrade: "中",
        recommendationGrade: "中",
        variantGrade: "中",
        health: "健康",
        monthlyTrend: [{ month: "2026-08", natural: 800, advertising: 400, total: 1200 }],
      }],
    },
  };
  assert.equal(TrafficSnapshotReadResponseSchema.safeParse(payload).success, true);
  assert.equal(TrafficSnapshotReadResponseSchema.safeParse({ ...payload, snapshotId: "internal" }).success, false);
  assert.equal(TrafficSnapshotReadResponseSchema.safeParse({ ...payload, contentHash: "a".repeat(64) }).success, false);
  assert.equal(TrafficSnapshotReadResponseSchema.safeParse({ ...payload, payload: {} }).success, false);
});

test("the versioned contract registry covers the complete declared HTTP surface", () => {
  assert.deepEqual(
    v1Contracts.map(({ method, path }) => `${method} ${path}`),
    [
      "GET /health",
      "GET /v1/capabilities",
      "GET /v1/connectors",
      "PUT /v1/connectors/:connectorId/credential",
      "DELETE /v1/connectors/:connectorId/credential",
      "POST /v1/connectors/:connectorId/probe",
      "POST /v1/auth/login",
      "POST /v1/auth/logout",
      "GET /v1/auth/session",
      "POST /v1/auth/password",
      "POST /v1/feedback",
      "POST /v1/projects",
      "GET /v1/projects/:projectId",
      "POST /v1/projects/:projectId/runs",
      "GET /v1/runs/:runId",
      "POST /v1/runs/:runId/cancel",
      "POST /v1/runs/:runId/stages/:stage/retry",
      "GET /v1/runs/:runId/reports",
      "GET /v1/reports/:reportId",
      "POST /v1/local-voc",
      "POST /v1/runs/:runId/voc-import",
      "GET /v1/local-data/projects",
      "POST /v1/local-data/projects",
      "GET /v1/local-data/projects/:id",
      "PATCH /v1/local-data/projects/:id",
      "DELETE /v1/local-data/projects/:id",
      "GET /v1/local-data/sync-asins",
      "POST /v1/local-data/sync-asins",
      "GET /v1/local-data/sync-asins/:jobId",
      "GET /v1/runs/:runId/traffic-snapshot",
    ],
  );
});
