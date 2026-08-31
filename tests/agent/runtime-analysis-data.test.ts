import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentServiceClient, AgentServiceRequest } from "../../app/lib/agent-service-client";
import { createRuntimeAnalysisDataHandler } from "../../app/lib/runtime-analysis-data-server";

const projectId = "10000000-0000-4000-8000-000000000001";
const organizationId = "10000000-0000-4000-8000-000000000002";
const userId = "10000000-0000-4000-8000-000000000003";
const asins = ["B000000001", "B000000002", "B000000003"];

function projectBody() {
  return {
    project: {
      id: projectId,
      organizationId,
      name: "test",
      marketplace: "US" as const,
      asins,
      createdBy: userId,
      currentRunId: null,
      createdAt: "2026-08-31T00:00:00.000Z",
      updatedAt: "2026-08-31T00:00:00.000Z",
    },
  };
}

function agentClient(
  implementation: (request: AgentServiceRequest) => Promise<{ status: number; headers: Headers; body: unknown }>,
) {
  return implementation as unknown as AgentServiceClient;
}

test("runtime snapshot preserves project authorization and filters the requested ASINs", async () => {
  const requests: AgentServiceRequest[] = [];
  const readSnapshot = (requestedAsins: readonly string[]) => ({
    catalog: requestedAsins.map(asin => ({ asin })),
    keywords: { analysisByAsin: {}, enrichmentByKeyword: {} },
    reviews: { analysisByAsin: { [requestedAsins[0]!]: { status: "ready" } }, ratingByAsin: {} },
    salesTrend: { trendByAsin: {} },
    fba: { feeByAsin: { [requestedAsins[0]!]: { status: "ready" } } },
    listing: { contentByAsin: {} },
    category: { trendByNode: {} },
  });
  const handler = createRuntimeAnalysisDataHandler({
    client: agentClient(async request => {
      requests.push(request);
      return { status: 200, headers: new Headers(), body: projectBody() };
    }),
    readSnapshot,
  });
  const result = await handler(new Request(
    `http://app.local/api/runtime-analysis-data?projectId=${projectId}&asins=${asins.join(",")}`,
    { headers: { cookie: "session=opaque" } },
  ));
  const body = await result.json() as { catalog: Array<{ asin: string }> };

  assert.equal(result.status, 200);
  assert.deepEqual(body.catalog.map(item => item.asin), asins);
  assert.deepEqual(requests.map(request => ({ method: request.method, path: request.path })), [{
    method: "GET",
    path: `/v1/projects/${projectId}`,
  }]);
  assert.equal(new Headers(requests[0]?.headers).get("cookie"), "session=opaque");
  assert.equal(new Headers(requests[0]?.headers).get("origin"), "http://app.local");
  assert.equal(JSON.stringify(body).includes("formal-stack.env"), false);
  assert.equal(JSON.stringify(body).includes("cookie"), false);
});

for (const upstreamStatus of [401, 404] as const) {
  test(`runtime snapshot preserves upstream ${upstreamStatus}`, async () => {
    const handler = createRuntimeAnalysisDataHandler({
      client: agentClient(async () => ({
        status: upstreamStatus,
        headers: new Headers(),
        body: { error: "denied" },
      })),
      readSnapshot: () => { throw new Error("must not read files"); },
    });
    const result = await handler(new Request(
      `http://app.local/api/runtime-analysis-data?projectId=${projectId}&asins=${asins.join(",")}`,
    ));

    assert.equal(result.status, upstreamStatus);
    assert.deepEqual(await result.json(), { error: "denied" });
  });
}

test("runtime snapshot rejects an ASIN scope mismatch before reading files", async () => {
  let reads = 0;
  const handler = createRuntimeAnalysisDataHandler({
    client: agentClient(async () => ({ status: 200, headers: new Headers(), body: projectBody() })),
    readSnapshot: () => { reads += 1; throw new Error("unexpected"); },
  });
  const result = await handler(new Request(
    `http://app.local/api/runtime-analysis-data?projectId=${projectId}&asins=B000000004,B000000005,B000000006`,
  ));

  assert.equal(result.status, 409);
  assert.equal(reads, 0);
});
