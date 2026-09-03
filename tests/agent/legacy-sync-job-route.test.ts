import assert from "node:assert/strict";
import test from "node:test";

import * as legacySyncJobRoute from "../../app/api/sync-asins/[jobId]/route";
import type { AgentServiceClient } from "../../app/lib/agent-service-client";

type LegacyJobRead = (
  request: Request,
  context: { params: Promise<{ jobId: string }> },
  client: AgentServiceClient,
) => Promise<Response>;

test("the legacy Web job-read endpoint delegates same-org, missing, and foreign reads to the Agent", async () => {
  const read = (legacySyncJobRoute as typeof legacySyncJobRoute & {
    proxyLegacySyncJobRequest?: LegacyJobRead;
  }).proxyLegacySyncJobRequest;
  assert.equal(typeof read, "function");
  if (!read) return;

  const calls: string[] = [];
  const missing = { error: { code: "NOT_FOUND", message: "Sync job not found", requestId: "request-1" } };
  const agent: AgentServiceClient = async request => {
    calls.push(request.path);
    if (request.path.endsWith("/same")) {
      return {
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        body: {
          jobId: "same", asins: ["B07DYG1C9B"], marketplace: "US", status: "running", message: "Running",
          currentStageId: "catalog", stages: [], asinProgress: {},
          scope: { projectId: "10000000-0000-4000-8000-000000000003", runId: "10000000-0000-4000-8000-000000000004" },
          createdAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-20T00:00:00.000Z",
        },
      };
    }
    return { status: 404, headers: new Headers({ "content-type": "application/json" }), body: missing };
  };
  const request = (jobId: string) => read(
    new Request(`https://web.example/api/sync-asins/${jobId}`),
    { params: Promise.resolve({ jobId }) },
    agent,
  );

  const [same, absent, foreign] = await Promise.all([request("same"), request("missing"), request("foreign")]);

  assert.equal(same.status, 200);
  assert.deepEqual(await same.json(), {
    jobId: "same", asins: ["B07DYG1C9B"], marketplace: "US", status: "running", message: "Running",
    currentStageId: "catalog", stages: [], asinProgress: {},
    scope: { projectId: "10000000-0000-4000-8000-000000000003", runId: "10000000-0000-4000-8000-000000000004" },
    createdAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-20T00:00:00.000Z",
  });
  assert.equal(JSON.stringify(await request("same").then(response => response.json())).includes("organizationId"), false);
  assert.deepEqual(await absent.json(), await foreign.json());
  assert.deepEqual(calls, [
    "/v1/local-data/sync-asins/same",
    "/v1/local-data/sync-asins/missing",
    "/v1/local-data/sync-asins/foreign",
    "/v1/local-data/sync-asins/same",
  ]);
});
