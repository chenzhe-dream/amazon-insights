import assert from "node:assert/strict";
import test from "node:test";

import { PATCH } from "../../app/api/projects/[id]/route";
import type { AgentServiceClient } from "../../app/lib/agent-service-client";

test("legacy Web project PATCH delegates rename to the scoped Agent route", async () => {
  const id = "10000000-0000-4000-8000-000000000001";
  const paths: string[] = [];
  const client = (async request => {
    paths.push(`${request.method} ${request.path}`);
    assert.deepEqual(JSON.parse(String(request.body)), { name: "新项目名" });
    return { status: 200, headers: new Headers(), body: { project: { id, name: "新项目名" } } };
  }) as AgentServiceClient;
  const response = await (PATCH as (...args: unknown[]) => Promise<Response>)(
    new Request(`http://localhost/api/projects/${id}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "新项目名" }),
    }),
    { params: Promise.resolve({ id }) },
    client,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(paths, [`PATCH /v1/local-data/projects/${id}`]);
});
