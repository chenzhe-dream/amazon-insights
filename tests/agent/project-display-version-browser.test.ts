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
  assert.equal(await readCurrentProjectDisplayVersion(scope, async () => Response.json({
    error: { code: "PROJECT_REPORT_NOT_PUBLISHED", message: "No current report", requestId: "test" },
  }, { status: 404 })), null);
});

test("browser accepts a source-tagged overlay only for the exact current gallery URL and slot", async () => {
  const response = version();
  const imageUrl = "https://example.test/image.jpg";
  const stage = (name: string, data: unknown) => ({ stage: name, stageStatus: "done", data,
    projectId: response.projectId, runId: response.runId, jobId: response.jobId,
    jobVersion: 1, outputVersion: 1, contentHash: "c".repeat(64), updatedAt: response.publishedAt });
  response.stageOutputs.listing = stage("listing", { contentByAsin: { [scope.asins[0]!]: { galleryImages: [imageUrl] } } });
  response.stageOutputs.image_remarks = stage("image_remarks", { remarksByAsin: {}, outcomesByAsin: {} });
  const entry = { asin: scope.asins[0]!, index: 0, imageUrl, remark: "补充备注", imageTypes: [],
    confidence: "high", videoThumbnail: false, displayListingStageContentHash: "c".repeat(64),
    source: { sourceKind: "supplemental-analysis", sourceRef: "source.ts",
      sourceArtifactSha256: "a".repeat(64), sourceManifestSha256: "b".repeat(64),
      listingStageContentHash: "c".repeat(64), originalJobId: response.jobId,
      capturedAt: response.publishedAt } };
  const valid = { ...response, imageRemarkOverlay: [entry] };
  assert.equal((await readCurrentProjectDisplayVersion(scope, async () => Response.json(valid)))?.imageRemarkOverlay?.length, 1);
  await assert.rejects(readCurrentProjectDisplayVersion(scope, async () => Response.json({
    ...valid, imageRemarkOverlay: [{ ...entry, imageUrl: "https://example.test/other.jpg" }],
  })), /来源不匹配/);
});
