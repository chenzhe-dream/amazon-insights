import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { readHistoricalSyncPointer } from "../../app/features/projects/historical-sync-pointer";
import type { AnalysisProject } from "../../app/features/projects/project-library-panel";

const project: AnalysisProject = {
  id: "project /1", name: "Historical project", majorCategory: null,
  categoryLabel: null, marketplace: "US", asins: ["B000000001", "B000000002"],
  note: null, createdBy: null, createdAt: "2026-09-10", updatedAt: "2026-09-10",
};
const runId = "run /1";
const jobId = "job /1";

function payloads(): unknown[] {
  return [
    { project: { id: project.id, currentRunId: runId } },
    { run: { id: runId, projectId: project.id, idempotencyKey: jobId } },
    { jobId, asins: [...project.asins], marketplace: "US", scope: { projectId: project.id, runId } },
  ];
}

function mockRequests(t: TestContext, bodies: unknown[], options: { statusAt?: number; rejectAt?: number; invalidJsonAt?: number } = {}) {
  const paths: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const index = paths.length;
    paths.push(String(input));
    if (index === options.rejectAt) throw new Error("network unavailable");
    assert.ok(index < bodies.length, "unexpected request");
    return new Response(index === options.invalidJsonAt ? "invalid JSON" : JSON.stringify(bodies[index]), {
      status: index === options.statusAt ? 500 : 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  return paths;
}

test("returns a matching historical pointer using encoded read paths", async (t) => {
  const paths = mockRequests(t, payloads());
  assert.deepEqual(await readHistoricalSyncPointer(project), { projectId: project.id, runId, jobId });
  assert.deepEqual(paths, [
    `/api/agent/v1/projects/${encodeURIComponent(project.id)}`,
    `/api/agent/v1/runs/${encodeURIComponent(runId)}`,
    `/api/agent/v1/local-data/sync-asins/${encodeURIComponent(jobId)}`,
  ]);
});

test("retains default US marketplace and ASIN set semantics", async (t) => {
  const bodies = payloads();
  bodies[2] = { jobId, asins: [project.asins[1], project.asins[0], project.asins[0]], marketplace: "US", scope: { projectId: project.id, runId } };
  mockRequests(t, bodies);
  assert.deepEqual(await readHistoricalSyncPointer({ ...project, marketplace: "" }), { projectId: project.id, runId, jobId });
});

const invalidCases: { name: string; index: number; body: unknown }[] = [
  { name: "missing project", index: 0, body: {} },
  { name: "null project payload", index: 0, body: null },
  { name: "different project", index: 0, body: { project: { id: "other", currentRunId: runId } } },
  ...[undefined, "", 123].map(currentRunId => ({ name: `invalid run pointer ${currentRunId}`, index: 0, body: { project: { id: project.id, currentRunId } } })),
  { name: "missing run", index: 1, body: {} },
  { name: "different run", index: 1, body: { run: { id: "other", projectId: project.id, idempotencyKey: jobId } } },
  { name: "run belongs to another project", index: 1, body: { run: { id: runId, projectId: "other", idempotencyKey: jobId } } },
  ...[undefined, "", 123].map(idempotencyKey => ({ name: `invalid job pointer ${idempotencyKey}`, index: 1, body: { run: { id: runId, projectId: project.id, idempotencyKey } } })),
  { name: "null job", index: 2, body: null },
  ...Object.entries({
    "different job": { jobId: "other" },
    "missing scope": { scope: undefined },
    "different scope run": { scope: { projectId: project.id, runId: "other" } },
    "different scope project": { scope: { projectId: "other", runId } },
    "missing scope project": { scope: { runId } },
    "different marketplace": { marketplace: "DE" },
    "missing marketplace": { marketplace: undefined },
    "different ASIN": { asins: ["B000000003", project.asins[1]] },
    "incomplete ASIN set": { asins: [project.asins[0]] },
    "missing ASINs": { asins: undefined },
  }).map(([name, patch]) => ({ name, index: 2, body: { ...(payloads()[2] as object), ...patch } })),
];

for (const { name, index, body } of invalidCases) {
  test(`returns null and stops for ${name}`, async (t) => {
    const bodies = payloads();
    bodies[index] = body;
    const paths = mockRequests(t, bodies);
    assert.equal(await readHistoricalSyncPointer(project), null);
    assert.equal(paths.length, index + 1);
  });
}

for (const failure of ["statusAt", "rejectAt", "invalidJsonAt"] as const) {
  for (const index of [0, 1, 2]) {
    test(`returns null for ${failure} at request ${index + 1}`, async (t) => {
      const paths = mockRequests(t, payloads(), { [failure]: index });
      assert.equal(await readHistoricalSyncPointer(project), null);
      assert.equal(paths.length, index + 1);
    });
  }
}
