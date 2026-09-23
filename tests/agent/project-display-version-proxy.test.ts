import assert from "node:assert/strict";
import test from "node:test";
import { proxyAgentRequest } from "../../app/api/agent/[...path]/route";
import { createAgentServiceClient } from "../../app/lib/agent-service-client";
import { readCurrentProjectDisplayVersion } from "../../app/lib/project-display-version-browser";
import { ProjectableSyncStageSchema } from "../../shared/agent-contracts";

const id = "75a3f965-07e8-468e-aec7-bce265515023";
const org = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const jobId = "44444444-4444-4444-8444-444444444444";
const scope = { organizationId: org, projectId: id, marketplace: "US", asins: ["B07YGQVKDY"] };
const route = `/v1/local-data/projects/${id}/current-display-version`;
function report() {
  const metadata = { projectId: id, runId, jobId, jobVersion: 1, outputVersion: 1,
    contentHash: "a".repeat(64), updatedAt: "2026-09-23T00:00:00.000Z" };
  const outputs: Record<string, unknown> = Object.fromEntries(ProjectableSyncStageSchema.options.map(stage =>
    [stage, { stage, stageStatus: "missing-output", reasonCode: "OUTPUT_UNAVAILABLE" }]));
  outputs.listing = { ...metadata, stage: "listing", stageStatus: "done", data: { contentByAsin: {
    B07YGQVKDY: { galleryImages: Array.from({length: 7}, (_, i) => `https://m.media-amazon.com/images/I/test${i}.jpg`) },
  } } };
  outputs.image_remarks = { ...metadata, stage: "image_remarks", stageStatus: "done", data: {
    remarksByAsin: { B07YGQVKDY: Array.from({length: 7}, (_, i) => ({ remark: `remark ${i}` })) }, outcomesByAsin: {},
  } };
  return { ...scope, versionId: "11111111-1111-4111-8111-111111111111", runId, jobId,
    catalog: [{ asin: "B07YGQVKDY", title: "Persisted catalog" }],
    catalogEvidence: { sourceKind: "generated-file", sourceRef: "app/competitor-data.ts#refreshedCatalog",
      sourceSha256: "b".repeat(64), sourceUpdatedAt: "2026-09-23T00:00:00.000Z", capturedAt: "2026-09-23T00:00:00.000Z", sourceJobId: jobId },
    stageOutputs: outputs, gaps: [], contentHash: "a".repeat(64),
    sourceCompletedAt: "2026-09-23T00:00:00.000Z", publishedAt: "2026-09-23T00:00:00.000Z" };
}
async function throughProxy(path: string, body: unknown, status = 200) {
  let calls = 0;
  const client = createAgentServiceClient({
    env: { AGENT_SERVICE_INTERNAL_URL: "http://agent.test", AGENT_SERVICE_PROXY_TOKEN: "fixture-token" },
    fetchImplementation: async (url, init) => {
      calls++;
      assert.equal(String(url), `http://agent.test${path}`);
      assert.equal(new Headers(init?.headers).get("cookie"), "session=fixture");
      assert.equal(init?.method, "GET");
      return Response.json(body, { status });
    },
  });
  const response = await proxyAgentRequest(new Request(`http://web.test/api/agent${path}`, {
    headers: { cookie: "session=fixture" },
  }), { params: Promise.resolve({ path: path.slice(1).split("/") }) }, client);
  return { response, calls };
}

test("saved report crosses the real Web proxy and client with all image slots and remarks intact", async () => {
  const body = report();
  const {response, calls} = await throughProxy(route, body);
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(calls, 1);
  assert.deepEqual(await response.clone().json(), body);
  const parsed = await readCurrentProjectDisplayVersion(scope, async () => response);
  assert.equal(parsed?.versionId, body.versionId);
  assert.equal(Object.keys(parsed!.stageOutputs).length, 10);
});
test("current sync pointer crosses the Web proxy and client", async () => {
  const {response, calls} = await throughProxy(`/v1/local-data/projects/${id}/current-sync-job`, {jobId, runId});
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(calls, 1);
  assert.deepEqual(await response.json(), {jobId, runId});
});
test("only an explicit unpublished-report response is absence; infrastructure failures are errors", async () => {
  for (const [status, code] of [[404, "NOT_FOUND"], [401, "AUTHENTICATION_REQUIRED"], [403, "FORBIDDEN"], [503, "CONFIGURATION_ERROR"]] as const) {
    const {response, calls} = await throughProxy(route, {error: {code, message: "fixture failure", requestId: "fixture"}}, status);
    assert.equal(calls, 1);
    await assert.rejects(readCurrentProjectDisplayVersion(scope, async () => response));
  }
  const {response, calls} = await throughProxy(route, {error: {code: "PROJECT_REPORT_NOT_PUBLISHED", message: "No report", requestId: "fixture"}}, 404);
  assert.equal(calls, 1);
  assert.equal(await readCurrentProjectDisplayVersion(scope, async () => response), null);
  await assert.rejects(readCurrentProjectDisplayVersion(scope, async () => Response.json({}, {status: 404})));
});
test("proxy rejects malformed and oversized reports without showing them as absence", async () => {
  for (const body of [{...report(), stageOutputs: {}}, {...report(), catalog: ["x".repeat(1_100_000)]}]) {
    const {response, calls} = await throughProxy(route, body);
    assert.equal(calls, 1);
    assert.equal(response.status, 502);
    await assert.rejects(readCurrentProjectDisplayVersion(scope, async () => response));
  }
});

