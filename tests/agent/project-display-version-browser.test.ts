import assert from "node:assert/strict";
import { test } from "node:test";

import { readCurrentProjectDisplayVersion } from "../../app/lib/project-display-version-browser";
import { ProjectableSyncStageSchema } from "../../shared/agent-contracts";

const scope = {
  organizationId: "22222222-2222-4222-8222-222222222222",
  projectId: "75a3f965-07e8-468e-aec7-bce265515023",
  marketplace: "US",
  asins: ["B07YGQVKDY", "B0DPQGFM8Q", "B0GY86VNQ2"],
};

function version() {
  return {
    versionId: "11111111-1111-4111-8111-111111111111",
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    runId: "33333333-3333-4333-8333-333333333333",
    jobId: "44444444-4444-4444-8444-444444444444",
    marketplace: scope.marketplace,
    asins: [...scope.asins].reverse(),
    catalog: [],
    catalogEvidence: { sourceKind: "generated-file", sourceRef: "app/competitor-data.ts#refreshedCatalog",
      sourceSha256: "b".repeat(64), sourceUpdatedAt: "2026-09-23T05:44:00.000Z",
      capturedAt: "2026-09-23T06:00:00.000Z", sourceJobId: "55555555-5555-4555-8555-555555555555" },
    stageOutputs: Object.fromEntries(ProjectableSyncStageSchema.options.map(stage => [stage,
      { stage, stageStatus: "missing-output", reasonCode: "OUTPUT_UNAVAILABLE" }])),
    gaps: [{ asin: "B0DPQGFM8Q", field: "child_sales", reasonCode: "CONNECTOR_FAILED" }],
    contentHash: "a".repeat(64),
    sourceCompletedAt: "2026-09-21T03:12:47.080Z",
    publishedAt: "2026-09-23T00:00:00.000Z",
  };
}

test("current project display version validates project and exact ASIN scope", async () => {
  const read = await readCurrentProjectDisplayVersion(scope, async path => {
    assert.equal(path, `/v1/local-data/projects/${scope.projectId}/current-display-version`);
    return Response.json(version());
  });
  assert.equal(read?.versionId, version().versionId);
  assert.equal(read?.catalogEvidence?.sourceJobId, "55555555-5555-4555-8555-555555555555");
  assert.equal(read?.stageOutputs.image_remarks?.stageStatus, "missing-output");
  await assert.rejects(readCurrentProjectDisplayVersion(scope, async () => Response.json({
    ...version(), asins: [scope.asins[0]],
  })), /范围/);
});

test("an unavailable version stays absent instead of adopting an old job", async () => {
  assert.equal(await readCurrentProjectDisplayVersion(scope, async () => Response.json({}, { status: 404 })), null);
});
