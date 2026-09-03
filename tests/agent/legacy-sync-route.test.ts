import assert from "node:assert/strict";
import test from "node:test";

import * as legacySyncRoute from "../../app/api/sync-asins/route";
import type { AgentServiceClient } from "../../app/lib/agent-service-client";

const asins = ["B07DYG1C9B", "B07VY9Q95Q", "B0BPXRVWYK"];

test("the legacy Web sync endpoint delegates an unscoped start to the authenticated Agent", async () => {
  const delegate = (legacySyncRoute as typeof legacySyncRoute & {
    proxyLegacySyncAsinsRequest?: (request: Request, client: AgentServiceClient) => Promise<Response>;
  }).proxyLegacySyncAsinsRequest;
  assert.equal(typeof delegate, "function");
  if (!delegate) return;

  let calls = 0;
  let delegated: { method: string; path: string; body: string | undefined } | null = null;
  const agent: AgentServiceClient = async request => {
    calls += 1;
    delegated = { method: request.method, path: request.path, body: request.body };
    return {
      status: 202,
      headers: new Headers({ "content-type": "application/json" }),
      body: {
        jobId: "job-1", status: "queued", message: "Queued", mcpAsinsPending: [],
        estimatedAutoSeconds: 0, estimatedAlexaSeconds: 0, stages: [], reused: false,
      },
    };
  };

  const response = await delegate(
    new Request("https://web.example/api/sync-asins", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ asins, marketplace: "US" }),
    }),
    agent,
  );

  assert.equal(response.status, 202);
  assert.equal(calls, 1);
  assert.deepEqual(delegated, {
    method: "POST",
    path: "/v1/local-data/sync-asins",
    body: JSON.stringify({ asins, marketplace: "US" }),
  });
  assert.equal((delegated?.body ?? "").includes("organizationId"), false);
});
