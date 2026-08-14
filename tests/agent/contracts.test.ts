import assert from "node:assert/strict";
import test from "node:test";

import {
  AgentRunSchema,
  AnalysisReportSchema,
  AnalysisRunSchema,
  ApiErrorResponseSchema,
  CreateProjectRequestSchema,
  DataSnapshotSchema,
  EntityIdSchema,
  findHttpContract,
  RequestIdSchema,
  RunStageSchema,
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
    DataSnapshotSchema.safeParse({ ...snapshot, schemaVersion: "1.0.0" })
      .success,
    true,
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

test("the versioned contract registry covers the complete declared HTTP surface", () => {
  assert.deepEqual(
    v1Contracts.map(({ method, path }) => `${method} ${path}`),
    [
      "GET /health",
      "GET /v1/capabilities",
      "POST /v1/auth/login",
      "POST /v1/auth/logout",
      "POST /v1/projects",
      "GET /v1/projects/:projectId",
      "POST /v1/projects/:projectId/runs",
      "GET /v1/runs/:runId",
      "POST /v1/runs/:runId/cancel",
      "POST /v1/runs/:runId/stages/:stage/retry",
      "GET /v1/runs/:runId/reports",
      "GET /v1/reports/:reportId",
    ],
  );
});
