import assert from "node:assert/strict";
import test from "node:test";

import type { AnalysisReport } from "../../shared/agent-contracts";
import {
  ANALYSIS_REPORT_STAGES,
  buildSavedAnalysisReportView,
  readSavedAnalysisReport,
  serializeSavedAnalysisReportView,
} from "../../app/lib/saved-analysis-reports";

const RUN_ID = "10000000-0000-4000-8000-000000000001";
const SNAPSHOT_ID = "10000000-0000-4000-8000-000000000002";
const AGENT_RUN_ID = "10000000-0000-4000-8000-000000000003";
const CONTENT_HASH = "a".repeat(64);

function savedReport(input: {
  id: string;
  stage: AnalysisReport["stage"];
  version: number;
  status?: AnalysisReport["status"];
  result: Record<string, unknown>;
}): AnalysisReport {
  return {
    schemaVersion: "1.0.0",
    id: input.id,
    runId: RUN_ID,
    agentRunId: AGENT_RUN_ID,
    version: input.version,
    stage: input.stage,
    status: input.status ?? "complete",
    skill: {
      id: `saved-${input.stage}`,
      version: "1.0.0",
      contentHash: CONTENT_HASH,
    },
    snapshotIds: [SNAPSHOT_ID],
    model: { provider: "fixture", model: "fixture-model" },
    dataCutoffAt: "2026-08-17T00:00:00.000Z",
    evidence: [{
      id: `evidence-${input.stage}-${input.version}`,
      type: "report",
      sourceId: SNAPSHOT_ID,
      capturedAt: "2026-08-17T00:00:00.000Z",
    }],
    result: input.result,
    createdAt: `2026-08-17T00:0${input.version}:00.000Z`,
  };
}

const TRAFFIC_V1 = savedReport({
  id: "20000000-0000-4000-8000-000000000001",
  stage: "traffic-analysis",
  version: 1,
  result: { conclusion: "traffic-v1" },
});
const VOC_V1 = savedReport({
  id: "20000000-0000-4000-8000-000000000002",
  stage: "voc-positioning",
  version: 1,
  result: { conclusion: "voc-v1" },
});
const VOC_V2 = savedReport({
  id: "20000000-0000-4000-8000-000000000003",
  stage: "voc-positioning",
  version: 2,
  result: { conclusion: "voc-v2" },
});
const VOC_V3_STALE = savedReport({
  id: "20000000-0000-4000-8000-000000000005",
  stage: "voc-positioning",
  version: 3,
  status: "stale",
  result: { conclusion: "voc-v3-stale" },
});
const PRODUCT_V1 = savedReport({
  id: "20000000-0000-4000-8000-000000000004",
  stage: "product-definition",
  version: 1,
  result: { conclusion: "product-v1" },
});

test("selected saved versions drive the displayed view and exported JSON", () => {
  const reports = [VOC_V2, TRAFFIC_V1, PRODUCT_V1, VOC_V1];
  const view = buildSavedAnalysisReportView(RUN_ID, reports, {
    "voc-positioning": VOC_V1.id,
  });

  assert.deepEqual(view.stages.map(({ stage }) => stage), ANALYSIS_REPORT_STAGES);
  assert.equal(view.stages[0]?.selected?.id, TRAFFIC_V1.id);
  assert.equal(view.stages[1]?.selected?.id, VOC_V1.id);
  assert.equal(view.stages[1]?.selected?.version, 1);
  assert.equal(view.stages[2]?.selected?.id, PRODUCT_V1.id);

  const exported = JSON.parse(serializeSavedAnalysisReportView(view));
  assert.equal(exported.runId, RUN_ID);
  assert.equal(exported.reports["voc-positioning"].id, VOC_V1.id);
  assert.equal(exported.reports["voc-positioning"].version, 1);
  assert.deepEqual(exported.reports["voc-positioning"].result, VOC_V1.result);
  assert.deepEqual(exported.reports["voc-positioning"].skill, VOC_V1.skill);
});

test("refresh defaults each stage to latest complete and degrades a missing stage to null", () => {
  const reports = [VOC_V1, VOC_V3_STALE, VOC_V2, TRAFFIC_V1];
  const refreshed = buildSavedAnalysisReportView(RUN_ID, reports);

  assert.equal(refreshed.stages[0]?.selected?.id, TRAFFIC_V1.id);
  assert.equal(refreshed.stages[1]?.selected?.id, VOC_V2.id);
  assert.deepEqual(refreshed.stages[1]?.history.map(({ version }) => version), [3, 2, 1]);
  assert.equal(refreshed.stages[2]?.selected, null);
  const exported = JSON.parse(serializeSavedAnalysisReportView(refreshed));
  assert.equal(exported.reports["voc-positioning"].id, VOC_V2.id);
  assert.equal(exported.reports["product-definition"], null);
  assert.equal(
    serializeSavedAnalysisReportView(buildSavedAnalysisReportView(RUN_ID, reports)),
    serializeSavedAnalysisReportView(refreshed),
  );
});

test("a report from another run is rejected instead of appearing in the view or export", () => {
  assert.throws(
    () => buildSavedAnalysisReportView(RUN_ID, [{
      ...TRAFFIC_V1,
      runId: "30000000-0000-4000-8000-000000000001",
    }]),
    /does not belong to the selected run/,
  );
});

test("explicit version selection reads the immutable report detail endpoint", async () => {
  const calls: Array<{ method: string; url: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ method: init?.method ?? "GET", url: String(input) });
    return Response.json({ report: VOC_V1 });
  };

  const report = await readSavedAnalysisReport(VOC_V1.id, fetchImpl);

  assert.equal(report.id, VOC_V1.id);
  assert.deepEqual(calls, [{
    method: "GET",
    url: `/v1/reports/${VOC_V1.id}`,
  }]);
});
