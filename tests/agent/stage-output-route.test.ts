import assert from "node:assert/strict";
import test from "node:test";

import { buildAgentApp } from "../../server/app";
import type { AuthenticatedPrincipal } from "../../server/auth/authentication-service";
import type { AgentAuthenticationConfig } from "../../server/config";
import type { LocalDataBridgeDeps } from "../../server/routes/local-data";
import type { SyncJobRepository } from "../../server/db/sync-job-repository";
import { SyncJobService } from "../../server/services/sync-job-service";

const origin = "http://127.0.0.1:31900";
const proxyToken = "stage-output-route-test-token";
const sessionToken = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
const organizationId = "10000000-0000-4000-8000-000000000001";
const projectId = "10000000-0000-4000-8000-000000000002";
const runId = "10000000-0000-4000-8000-000000000003";
const jobId = "sync-job-stage-output";
const stage = "sales_trend" as const;
const exactRoute = `/v1/projects/${projectId}/runs/${runId}/sync-jobs/${jobId}/stages/${stage}/output`;

const authConfig: AgentAuthenticationConfig = {
  mode: "authenticated",
  cookie: { name: "__Host-agent_session", secure: true, maxAgeSeconds: 28_800 },
  sessionTtlMs: 28_800_000,
  loginLimiter: { windowMs: 900_000, maxFailures: 5, maxEntries: 10_000 },
};

class FakeAuthService {
  constructor(private readonly principal: AuthenticatedPrincipal) {}
  async authenticate(token: string | null) {
    return token === sessionToken ? this.principal : null;
  }
}

function authenticatedHeaders() {
  return {
    origin,
    "x-agent-proxy-token": proxyToken,
    cookie: `__Host-agent_session=${sessionToken}`,
  };
}

function output() {
  return {
    jobId,
    projectId,
    runId,
    jobVersion: 1,
    outputVersion: 1,
    contentHash: "a".repeat(64),
    updatedAt: "2026-08-25T09:00:00.000Z",
    stage,
    stageStatus: "done" as const,
    data: { trendByAsin: { B0TEST0001: { volume: [] } } },
  };
}

function appWith(
  readStageOutput: NonNullable<LocalDataBridgeDeps["readStageOutput"]>,
  principalOrganizationId = organizationId,
) {
  const counters = { providers: 0, builds: 0, reloads: 0, jobs: 0, runs: 0, stages: 0, attempts: 0 };
  const deps: LocalDataBridgeDeps = {
    async fetchProjects() { return []; },
    async fetchProject() { return null; },
    async createAnalysisProject() { throw new Error("unused"); },
    async updateAnalysisProject() { return null; },
    async deleteAnalysisProject() { return false; },
    async normalizeAsins() { return null; },
    async fetchAsinDataStatus() { return []; },
    async startAsinSyncJob() { counters.jobs += 1; throw new Error("unused"); },
    async readJob() { counters.jobs += 1; return null; },
    async resumeAsinSyncJob() { throw new Error("unused"); },
    readStageOutput,
  };
  const principal: AuthenticatedPrincipal = {
    kind: "user",
    userId: "10000000-0000-4000-8000-000000000004",
    organizationId: principalOrganizationId,
    email: "member@example.com",
    role: "member",
    sessionId: "10000000-0000-4000-8000-000000000005",
  };
  return {
    app: buildAgentApp({
      env: { AGENT_SERVICE_PROXY_TOKEN: proxyToken, AGENT_SERVICE_TRUSTED_ORIGINS: origin, AGENT_AUTH_ALLOW_ANONYMOUS_LOOPBACK: undefined },
      authConfig,
      authService: new FakeAuthService(principal) as never,
      localDataBridgeDeps: deps,
    }),
    counters,
  };
}

function routeWithMismatch(mutation: "organization" | "project" | "run" | "job" | "stage") {
  switch (mutation) {
    case "organization": return exactRoute;
    case "project": return exactRoute.replace(projectId, "10000000-0000-4000-8000-000000000006");
    case "run": return exactRoute.replace(runId, "10000000-0000-4000-8000-000000000007");
    case "job": return exactRoute.replace(jobId, "other-sync-job");
    case "stage": return exactRoute.replace(stage, "traffic");
  }
}

test("sync job service delegates stage reads using the exact scope", async () => {
  let received: unknown;
  const service = new SyncJobService({
    async readStageOutput(input: Parameters<SyncJobRepository["readStageOutput"]>[0]) {
      received = input;
      return output();
    },
  } as unknown as SyncJobRepository);

  assert.deepEqual(await service.readStageOutput({ organizationId, projectId, runId, jobId, stage }), output());
  assert.deepEqual(received, { organizationId, projectId, runId, jobId, stage });
});

for (const mutation of ["organization", "project", "run", "job", "stage"] as const) {
  test(`stage output hides ${mutation} mismatch`, async (t) => {
    const { app } = appWith(async (input) => {
      const exactScope = input.organizationId === organizationId && input.projectId === projectId && input.runId === runId && input.jobId === jobId && input.stage === stage;
      return exactScope ? output() : null;
    }, mutation === "organization" ? "10000000-0000-4000-8000-000000000008" : organizationId);
    t.after(() => app.close());
    const response = await app.inject({ method: "GET", url: routeWithMismatch(mutation), headers: authenticatedHeaders() });
    assert.equal(response.statusCode, 404);
    assert.deepEqual(
      { code: response.json().error.code, message: response.json().error.message },
      { code: "NOT_FOUND", message: "Stage output not found" },
    );
  });
}

for (const condition of ["legacy", "non-terminal"] as const) {
  test(`stage output hides ${condition} jobs`, async (t) => {
    const { app } = appWith(async () => null);
    t.after(() => app.close());
    const response = await app.inject({ method: "GET", url: exactRoute, headers: authenticatedHeaders() });
    assert.equal(response.statusCode, 404);
    assert.deepEqual(
      { code: response.json().error.code, message: response.json().error.message },
      { code: "NOT_FOUND", message: "Stage output not found" },
    );
  });
}

test("stage output GET is side-effect free", async (t) => {
  const { app, counters } = appWith(async (input) => {
    assert.deepEqual(input, { organizationId, projectId, runId, jobId, stage });
    return output();
  });
  t.after(() => app.close());
  const response = await app.inject({ method: "GET", url: exactRoute, headers: authenticatedHeaders() });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), output());
  assert.deepEqual(counters, { providers: 0, builds: 0, reloads: 0, jobs: 0, runs: 0, stages: 0, attempts: 0 });
});
