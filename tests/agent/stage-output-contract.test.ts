import assert from "node:assert/strict";
import test from "node:test";

import {
  LocalDataSyncJobPublicSchema,
  LocalDataStageOutputResponseSchema,
} from "../../shared/agent-contracts";

const projectId = "10000000-0000-4000-8000-000000000001";
const runId = "10000000-0000-4000-8000-000000000002";

test("historical public jobs remain unversioned instead of becoming canonical version one", () => {
  const parsed = LocalDataSyncJobPublicSchema.parse({
    jobId: "legacy-job",
    asins: ["B0TEST0001"],
    marketplace: "US",
    status: "completed",
    message: "legacy terminal",
    currentStageId: "keywords",
    stages: [{ id: "keywords", label: "Keywords", kind: "auto", status: "done", estimatedSeconds: 1 }],
    asinProgress: {},
    createdAt: "2026-08-24T09:00:00.000Z",
    updatedAt: "2026-08-24T09:01:00.000Z",
    publication: { status: "not-required" },
  });

  assert.equal(Object.hasOwn(parsed, "jobVersion"), false);
});

function stageProjection(
  output: {
    stage: "sales_trend";
    data: { trendByAsin: Record<string, unknown> };
  },
) {
  return {
    jobId: "sync-job-stage-output",
    projectId,
    runId,
    jobVersion: 1,
    outputVersion: 1,
    contentHash: "a".repeat(64),
    updatedAt: "2026-08-25T09:00:00.000Z",
    stageStatus: "done" as const,
    ...output,
  };
}

test("stage output accepts one normalized data branch and rejects mixed or unknown fields", () => {
  const valid = stageProjection({
    stage: "sales_trend",
    data: { trendByAsin: { B0TEST0001: { status: "ready", volume: [] } } },
  });

  assert.equal(LocalDataStageOutputResponseSchema.safeParse(valid).success, true);
  assert.equal(LocalDataStageOutputResponseSchema.safeParse({
    ...valid,
    gap: { state: "failed", reasonCode: "CONNECT_TIMEOUT" },
  }).success, false);
  assert.equal(LocalDataStageOutputResponseSchema.safeParse({
    ...valid,
    sourcePath: "app/sorftime-sales-trend-data.ts",
  }).success, false);
});
