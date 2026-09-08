import assert from "node:assert/strict";
import { test } from "node:test";
import { createRuntimeAnalysisDataHandler } from "../../app/lib/runtime-analysis-data-server";
import type { AgentServiceClient } from "../../app/lib/agent-service-client";
import { createRuntimeAnalysisScopeGuard, readAndCommitRuntimeAnalysisData } from "../../app/lib/runtime-analysis-data";

const project = {
  id: "10000000-0000-4000-8000-000000000001", organizationId: "10000000-0000-4000-8000-000000000002",
  currentRunId: "10000000-0000-4000-8000-000000000003", createdBy: "10000000-0000-4000-8000-000000000004",
  name: "fixture", marketplace: "US", asins: ["B000000001", "B000000002", "B000000003"],
  createdAt: "2026-09-08T00:00:00.000Z", updatedAt: "2026-09-08T00:00:00.000Z",
};
const snapshot = {
  catalog: [], keywords: { analysisByAsin: {}, enrichmentByKeyword: {} }, reviews: { analysisByAsin: {}, ratingByAsin: {} },
  salesTrend: { trendByAsin: {} }, fba: { feeByAsin: {} }, listing: { contentByAsin: {} }, category: { trendByNode: {} },
  childSales: { rowsByAsin: {} }, priceStrategy: { strategyByAsin: {} }, imageRemarks: { remarksByAsin: {}, outcomesByAsin: {} },
};

test("authenticated runtime read supplies only server-confirmed scope to progress reader", async () => {
  let observed: unknown;
  const dependencies = {
    client: (async () => ({ status: 200, body: { project }, headers: new Headers() })) as AgentServiceClient,
    readSnapshot: () => snapshot,
    readProgress: async (scope: unknown) => {
      observed = scope;
      return { currentRunId: project.currentRunId, jobId: "job", leaseGeneration: 1, activeJob: true, progress: null };
    },
  };
  const response = await createRuntimeAnalysisDataHandler(dependencies)(new Request(
    `http://app.local/api/runtime-analysis-data?projectId=${project.id}&asins=${project.asins}&jobId=forged&organizationId=forged`,
  ));
  assert.equal(response.status, 200);
  assert.deepEqual(observed, { organizationId: project.organizationId, projectId: project.id, currentRunId: project.currentRunId,
    country: "US", asins: project.asins });
  assert.deepEqual((await response.json()).xydcOrderProgress, { currentRunId: project.currentRunId, jobId: "job", leaseGeneration: 1, activeJob: true, progress: null });
});

test("historic snapshots explicitly have no task progress", async () => {
  const response = await createRuntimeAnalysisDataHandler({
    client: (async () => ({ status: 200, body: { project }, headers: new Headers() })) as AgentServiceClient,
    readSnapshot: () => snapshot,
  })(new Request(`http://app.local/api/runtime-analysis-data?projectId=${project.id}&asins=${project.asins}`));
  assert.equal((await response.json()).xydcOrderProgress, null);
});

for (const change of ["hidden", "project", "session", "run", "logout", "unmount"]) {
  test(`shared runtime setter rejects a delayed fetch after ${change}`, async () => {
    const controller = new AbortController();
    let current = true;
    let commits = 0;
    let release: ((response: Response) => void) | undefined;
    const pending = readAndCommitRuntimeAnalysisData(project.id, project.asins, {
      signal: controller.signal, isCurrent: () => current, commit: () => { commits++; },
      fetchImpl: (async () => new Promise<Response>(resolve => { release = resolve; })) as typeof fetch,
    });
    if (change === "hidden" || change === "unmount") controller.abort(); else current = false;
    release!(Response.json(snapshot));
    assert.equal(await pending, null);
    assert.equal(commits, 0);
  });
}

test("the actual scope guard rejects A to B to A, market, session, and run changes before shared commit", async () => {
  for (const other of ["B:US:session:run", "A:CA:session:run", "A:US:new-session:run", "A:US:session:new-run", null]) {
    const guard = createRuntimeAnalysisScopeGuard();
    guard.activate("A:US:session:run");
    const captured = guard.capture();
    let release: ((response: Response) => void) | undefined;
    let commits = 0;
    const pending = readAndCommitRuntimeAnalysisData(project.id, project.asins, {
      isCurrent: () => guard.isCurrent(captured), commit: () => { commits++; },
      fetchImpl: (async () => new Promise<Response>(resolve => { release = resolve; })) as typeof fetch,
    });
    guard.activate(other);
    guard.activate("A:US:session:run");
    release!(Response.json(snapshot));
    assert.equal(await pending, null);
    assert.equal(commits, 0);
  }
});
