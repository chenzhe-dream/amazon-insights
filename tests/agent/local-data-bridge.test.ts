import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AnalysisProject } from "../../app/lib/project-server";
import { normalizeAsins, type AsinModuleStatus, type SyncJob } from "../../app/lib/sync-server";
import { buildAgentApp } from "../../server/app";
import { AuthenticationService } from "../../server/auth/authentication-service";
import type { AuthenticatedPrincipal } from "../../server/auth/authentication-service";
import { BoundedLoginRateLimiter } from "../../server/auth/login-rate-limiter";
import { digestSessionToken } from "../../server/auth/session";
import type { AgentAuthenticationConfig } from "../../server/config";
import { openSqliteAgentRepository } from "../../server/db/sqlite-repository";
import { SyncJobRunConflictError } from "../../server/db/sync-job-repository";
import { createDefaultLocalDataBridgeDeps, type LocalDataBridgeDeps } from "../../server/routes/local-data";
import { SyncProviderReadinessError } from "../../server/services/sync-provider-readiness-service";

const trustedOrigin = "http://127.0.0.1:31900";
const proxyToken = "local-ui-token";
const rawToken = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const asin = "B07VY9Q95Q";
const projectAsins = [asin, "B0BPXRVWYK", "B07DYG1C9B"];

const project: AnalysisProject = {
  id: "project-1",
  kind: "analysis",
  slug: "local-bridge",
  name: "Local bridge",
  majorCategory: null,
  categoryLabel: null,
  marketplace: "US",
  asins: projectAsins,
  note: null,
  createdBy: null,
  createdAt: "2026-08-15T00:00:00.000Z",
  updatedAt: "2026-08-15T00:00:00.000Z",
};

const status: AsinModuleStatus = {
  asin,
  inCatalog: true,
  keywords: "ready",
  reviews: "ready",
  sales: "ready",
  childSales: "ready",
  priceStrategy: "ready",
  fba: "ready",
  listing: "ready",
  imageRemarks: "ready",
  category: "ready",
  traffic: "ready",
  voc: "ready",
};

const job: SyncJob = {
  jobId: "job-1",
  asins: [asin],
  marketplace: "US",
  status: "queued",
  message: "Queued",
  currentStageId: "catalog",
  stages: [],
  asinProgress: {},
  createdAt: "2026-08-15T00:00:00.000Z",
  updatedAt: "2026-08-15T00:00:00.000Z",
};

function localEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    AGENT_SERVICE_PROXY_TOKEN: proxyToken,
    AGENT_SERVICE_HOST: "127.0.0.1",
    AGENT_SERVICE_TRUSTED_ORIGINS: trustedOrigin,
    AGENT_AUTH_ALLOW_ANONYMOUS_LOOPBACK: "1",
    AGENT_VOC_LOCAL_FAKE: "1",
    ...overrides,
  };
}

function headers() {
  return { origin: trustedOrigin, "x-agent-proxy-token": proxyToken };
}

const authConfig: AgentAuthenticationConfig = {
  mode: "authenticated",
  cookie: {
    name: "__Host-agent_session",
    secure: true,
    maxAgeSeconds: 28_800,
  },
  sessionTtlMs: 28_800_000,
  loginLimiter: {
    windowMs: 900_000,
    maxFailures: 5,
    maxEntries: 10_000,
  },
};

class FakeAuthService {
  constructor(
    readonly principal: AuthenticatedPrincipal | null,
    readonly publicUser: Record<string, unknown> | null = principal ? {
      id: principal.userId,
      organizationId: principal.organizationId,
      email: principal.email,
      displayName: principal.email,
      role: principal.role,
      status: "active",
      createdAt: "2026-08-15T00:00:00.000Z",
      updatedAt: "2026-08-15T00:00:00.000Z",
    } : null,
  ) {}

  async authenticate(token: string | null) {
    return token === rawToken ? this.principal : null;
  }

  async findPublicUser() {
    return this.publicUser;
  }
}

function authService(
  principal: AuthenticatedPrincipal | null,
  publicUser?: Record<string, unknown> | null,
) {
  return new FakeAuthService(principal, publicUser) as unknown as AuthenticationService;
}

function memberPrincipal(): AuthenticatedPrincipal {
  return {
    kind: "user",
    userId: "10000000-0000-4000-8000-000000000001",
    organizationId: "10000000-0000-4000-8000-000000000002",
    email: "member@example.com",
    role: "member",
    sessionId: "10000000-0000-4000-8000-000000000003",
  };
}

function adminPrincipal(): AuthenticatedPrincipal {
  return { ...memberPrincipal(), email: "admin@example.com", role: "admin" };
}

function authenticatedHeaders() {
  return {
    ...headers(),
    cookie: `__Host-agent_session=${rawToken}`,
  };
}

function authenticatedLocalEnv(overrides: Record<string, string | undefined> = {}) {
  return localEnv({
    AGENT_AUTH_ALLOW_ANONYMOUS_LOOPBACK: undefined,
    ...overrides,
  });
}

function fakeDeps(statusItems: AsinModuleStatus[] = [status]): LocalDataBridgeDeps {
  return {
    async fetchProjects() { return [project]; },
    async fetchProject(id) { return id === project.id ? project : null; },
    async createAnalysisProject() { return project; },
    async updateAnalysisProject(id) { return id === project.id ? project : null; },
    async deleteAnalysisProject(id) { return id === project.id; },
    async normalizeAsins(values) {
      return Array.isArray(values) && values.every(value => value === asin) ? [asin] : null;
    },
    async fetchAsinDataStatus() { return statusItems; },
    async startAsinSyncJob() {
      return { job, reused: false, mcpAsinsPending: [], estimatedAutoSeconds: 0, estimatedAlexaSeconds: 0 };
    },
    async readJob(id) { return id === job.jobId ? job : null; },
    async resumeAsinSyncJob(id) {
      return id === job.jobId
        ? { job, reused: false, resumedStages: ["keywords"] }
        : null;
    },
  };
}

function countingDeps(calls: { count: number }): LocalDataBridgeDeps {
  const increment = () => {
    calls.count += 1;
  };
  return {
    async fetchProjects() { increment(); return [project]; },
    async fetchProject() { increment(); return project; },
    async createAnalysisProject() { increment(); return project; },
    async updateAnalysisProject() { increment(); return project; },
    async deleteAnalysisProject() { increment(); return true; },
    async normalizeAsins() { increment(); return [asin]; },
    async fetchAsinDataStatus() { increment(); return [status]; },
    async startAsinSyncJob() {
      increment();
      return { job, reused: false, mcpAsinsPending: [], estimatedAutoSeconds: 0, estimatedAlexaSeconds: 0 };
    },
    async readJob() { increment(); return job; },
    async resumeAsinSyncJob() { increment(); return { job, reused: false, resumedStages: ["keywords"] }; },
  };
}

test("only an authenticated administrator can explicitly resume failed stages", async (t) => {
  const deps = fakeDeps();
  const adminApp = buildAgentApp({
    env: authenticatedLocalEnv(),
    authConfig,
    authService: authService(adminPrincipal()),
    localDataBridgeDeps: deps,
  });
  const memberApp = buildAgentApp({
    env: authenticatedLocalEnv(),
    authConfig,
    authService: authService(memberPrincipal()),
    localDataBridgeDeps: deps,
  });
  t.after(() => Promise.all([adminApp.close(), memberApp.close()]));

  const resumed = await adminApp.inject({
    method: "POST",
    url: `/v1/admin/sync-asins/${job.jobId}/resume`,
    headers: authenticatedHeaders(),
  });
  assert.equal(resumed.statusCode, 202);
  assert.deepEqual(resumed.json(), {
    job: { ...job, resumableStages: [] },
    resumedStages: ["keywords"],
    reused: false,
  });

  const forbidden = await memberApp.inject({
    method: "POST",
    url: `/v1/admin/sync-asins/${job.jobId}/resume`,
    headers: authenticatedHeaders(),
  });
  assert.equal(forbidden.statusCode, 403);
});

test("legacy repair routes require the repository-loaded active primary administrator", async (t) => {
  const calls = { preview: 0, apply: 0 };
  const repair = {
    jobId: "legacy-job",
    version: "opaque-version",
    candidates: [{ asin, module: "keywords", connectorId: "sif", nextStatus: "pending", reason: "LEGACY_UNVERIFIED" }],
  } as const;
  const deps = {
    ...fakeDeps(),
    async previewLegacyStatusRepair() { calls.preview += 1; return repair; },
    async applyLegacyStatusRepair() { calls.apply += 1; return repair; },
  } satisfies LocalDataBridgeDeps;
  const primary = adminPrincipal();
  const primaryApp = buildAgentApp({
    env: authenticatedLocalEnv(), authConfig,
    authService: authService(primary), localDataBridgeDeps: deps,
  });
  const secondaryApp = buildAgentApp({
    env: authenticatedLocalEnv(), authConfig,
    authService: authService(primary, {
      id: primary.userId,
      organizationId: primary.organizationId,
      email: "other-admin@example.com",
      displayName: "Other Admin",
      role: "admin",
      status: "active",
      createdAt: "2026-08-15T00:00:00.000Z",
      updatedAt: "2026-08-15T00:00:00.000Z",
    }),
    localDataBridgeDeps: deps,
  });
  const disabledApp = buildAgentApp({
    env: authenticatedLocalEnv(), authConfig,
    authService: authService(primary, null), localDataBridgeDeps: deps,
  });
  t.after(() => Promise.all([primaryApp.close(), secondaryApp.close(), disabledApp.close()]));

  const preview = await primaryApp.inject({
    method: "POST",
    url: "/v1/admin/sync-asins/legacy-job/legacy-repair/preview",
    headers: authenticatedHeaders(),
  });
  assert.equal(preview.statusCode, 200, preview.body);
  const apply = await primaryApp.inject({
    method: "POST",
    url: "/v1/admin/sync-asins/legacy-job/legacy-repair/apply",
    headers: { ...authenticatedHeaders(), "content-type": "application/json" },
    payload: { version: repair.version },
  });
  assert.equal(apply.statusCode, 200, apply.body);

  for (const app of [secondaryApp, disabledApp]) {
    const rejected = await app.inject({
      method: "POST",
      url: "/v1/admin/sync-asins/legacy-job/legacy-repair/preview",
      headers: { ...authenticatedHeaders(), "x-user-email": "admin@example.com" },
    });
    assert.equal(rejected.statusCode, 403);
  }
  assert.deepEqual(calls, { preview: 1, apply: 1 });
});

test("local fake bridge adapts legacy project and sync operations over Agent HTTP", async (t) => {
  const app = buildAgentApp({
    env: authenticatedLocalEnv(),
    authConfig,
    authService: authService(memberPrincipal()),
    localDataBridgeDeps: fakeDeps(),
  });
  t.after(() => app.close());

  const list = await app.inject({ method: "GET", url: "/v1/local-data/projects?kind=analysis", headers: authenticatedHeaders() });
  assert.equal(list.statusCode, 200);
  assert.deepEqual(list.json(), { projects: [project] });

  const created = await app.inject({ method: "POST", url: "/v1/local-data/projects", headers: { ...authenticatedHeaders(), "content-type": "application/json" }, payload: { kind: "analysis", name: project.name, marketplace: "US", asins: projectAsins } });
  assert.equal(created.statusCode, 201);
  assert.deepEqual(created.json(), { project });

  const read = await app.inject({ method: "GET", url: "/v1/local-data/projects/project-1", headers: authenticatedHeaders() });
  assert.equal(read.statusCode, 200);
  assert.deepEqual(read.json(), { project });

  const updated = await app.inject({ method: "PATCH", url: "/v1/local-data/projects/project-1", headers: { ...authenticatedHeaders(), "content-type": "application/json" }, payload: { name: "Renamed" } });
  assert.equal(updated.statusCode, 200);
  assert.deepEqual(updated.json(), { project });

  const deleted = await app.inject({ method: "DELETE", url: "/v1/local-data/projects/project-1", headers: authenticatedHeaders() });
  assert.equal(deleted.statusCode, 200);
  assert.deepEqual(deleted.json(), { ok: true });

  const readiness = await app.inject({ method: "GET", url: `/v1/local-data/sync-asins?asins=${asin}`, headers: authenticatedHeaders() });
  assert.equal(readiness.statusCode, 200);
  assert.deepEqual(readiness.json(), { asins: [asin], items: [status], needsSync: false, vocPending: [], catalogPending: [] });

  const started = await app.inject({ method: "POST", url: "/v1/local-data/sync-asins", headers: { ...authenticatedHeaders(), "content-type": "application/json" }, payload: { asins: [asin], marketplace: "US" } });
  assert.equal(started.statusCode, 202);
  assert.deepEqual(started.json(), { jobId: job.jobId, status: job.status, message: job.message, mcpAsinsPending: [], estimatedAutoSeconds: 0, estimatedAlexaSeconds: 0, stages: [], reused: false, scope: { projectId: null, runId: null } });

  const polled = await app.inject({ method: "GET", url: "/v1/local-data/sync-asins/job-1", headers: authenticatedHeaders() });
  assert.equal(polled.statusCode, 200);
  assert.deepEqual(polled.json(), { ...job, resumableStages: [] });
});

test("local bridge treats each independent readiness field as needing sync", async (t) => {
  for (const field of ["childSales", "priceStrategy", "fba", "category"] as const) {
    const app = buildAgentApp({
      env: authenticatedLocalEnv(),
      authConfig,
      authService: authService(memberPrincipal()),
      localDataBridgeDeps: fakeDeps([{ ...status, [field]: "missing" }]),
    });
    t.after(() => app.close());

    const readiness = await app.inject({ method: "GET", url: `/v1/local-data/sync-asins?asins=${asin}`, headers: authenticatedHeaders() });
    assert.equal(readiness.statusCode, 200);
    assert.equal(readiness.json().needsSync, true, field);
  }
});

test("local bridge rejects invalid input and missing records", async (t) => {
  const app = buildAgentApp({
    env: authenticatedLocalEnv(),
    authConfig,
    authService: authService(memberPrincipal()),
    localDataBridgeDeps: fakeDeps(),
  });
  t.after(() => app.close());

  const invalid = await app.inject({ method: "POST", url: "/v1/local-data/sync-asins", headers: { ...authenticatedHeaders(), "content-type": "application/json" }, payload: { asins: ["bad"], marketplace: "US" } });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().error.code, "VALIDATION_ERROR");

  const missingProject = await app.inject({ method: "GET", url: "/v1/local-data/projects/missing", headers: authenticatedHeaders() });
  assert.equal(missingProject.statusCode, 404);
  const missingJob = await app.inject({ method: "GET", url: "/v1/local-data/sync-asins/missing", headers: authenticatedHeaders() });
  assert.equal(missingJob.statusCode, 404);
});

test("sync starts normalize ASIN order and retain authenticated scope without accepting an organization from the client", async (t) => {
  let capturedPrincipal: AuthenticatedPrincipal | null = null;
  const deps = fakeDeps();
  deps.authorizeSyncScope = async (principal, input) => {
    capturedPrincipal = principal.kind === "user" ? principal : null;
    return {
      organizationId: principal.kind === "user" ? principal.organizationId : "",
      projectId: input.projectId ?? null,
      runId: input.runId ?? null,
    };
  };
  const app = buildAgentApp({
    env: authenticatedLocalEnv(),
    authConfig,
    authService: authService(memberPrincipal()),
    localDataBridgeDeps: deps,
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/v1/local-data/sync-asins",
    headers: { ...authenticatedHeaders(), "content-type": "application/json" },
    payload: {
      asins: [asin, asin],
      marketplace: "US",
      projectId: "10000000-0000-4000-8000-000000000003",
      runId: "10000000-0000-4000-8000-000000000004",
    },
  });

  assert.equal(response.statusCode, 202);
  assert.equal(response.json().reused, false);
  assert.equal(capturedPrincipal?.organizationId, memberPrincipal().organizationId);
});

test("sync admission limit rejections return a safe rate-limit contract response", async (t) => {
  const deps = fakeDeps();
  deps.startAsinSyncJob = async () => {
    throw new Error("User queued sync job limit reached");
  };
  const app = buildAgentApp({
    env: authenticatedLocalEnv(),
    authConfig,
    authService: authService(memberPrincipal()),
    localDataBridgeDeps: deps,
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/v1/local-data/sync-asins",
    headers: { ...authenticatedHeaders(), "content-type": "application/json" },
    payload: { asins: [asin], marketplace: "US" },
  });

  assert.equal(response.statusCode, 429);
  assert.equal(response.json().error.code, "RATE_LIMITED");
  assert.match(response.json().error.message, /queued sync job limit/i);
});

test("a different explicit run receives a finite conflict without exposing the active run", async (t) => {
  const requestedRunId = "10000000-0000-4000-8000-000000000004";
  const hiddenRunId = "10000000-0000-4000-8000-000000000005";
  const deps = fakeDeps();
  deps.authorizeSyncScope = async (principal, input) => ({
    organizationId: principal.kind === "user" ? principal.organizationId : "",
    projectId: input.projectId ?? null,
    runId: input.runId ?? null,
    actorId: principal.kind === "user" ? principal.userId : null,
  });
  deps.startAsinSyncJob = async () => {
    throw new SyncJobRunConflictError();
  };
  const app = buildAgentApp({
    env: authenticatedLocalEnv(),
    authConfig,
    authService: authService(memberPrincipal()),
    localDataBridgeDeps: deps,
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/v1/local-data/sync-asins",
    headers: { ...authenticatedHeaders(), "content-type": "application/json" },
    payload: {
      asins: [asin],
      marketplace: "US",
      projectId: "10000000-0000-4000-8000-000000000003",
      runId: requestedRunId,
    },
  });

  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error.code, "CONFLICT");
  assert.doesNotMatch(response.body, new RegExp(`${requestedRunId}|${hiddenRunId}`));
});

test("provider readiness rejection is structured and does not affect read-only readiness GET", async (t) => {
  const deps = fakeDeps();
  deps.startAsinSyncJob = async () => {
    throw new SyncProviderReadinessError([
      { connectorId: "sif", causeCode: "PROBE_REQUIRED" },
    ]);
  };
  const app = buildAgentApp({
    env: authenticatedLocalEnv(),
    authConfig,
    authService: authService(memberPrincipal()),
    localDataBridgeDeps: deps,
  });
  t.after(() => app.close());

  const read = await app.inject({
    method: "GET",
    url: `/v1/local-data/sync-asins?asins=${asin}`,
    headers: authenticatedHeaders(),
  });
  assert.equal(read.statusCode, 200);

  const start = await app.inject({
    method: "POST",
    url: "/v1/local-data/sync-asins",
    headers: { ...authenticatedHeaders(), "content-type": "application/json" },
    payload: { asins: [asin], marketplace: "US" },
  });
  assert.equal(start.statusCode, 503);
  assert.equal(start.json().error.code, "CONFIGURATION_ERROR");
  assert.deepEqual(start.json().error.details, [
    { path: "connectors.sif", message: "PROBE_REQUIRED" },
  ]);
  assert.doesNotMatch(start.body, /secret|credential-sentinel/i);
});

test("ASIN identity normalization deduplicates and sorts the requested set", () => {
  assert.deepEqual(
    normalizeAsins(["B0BPXRVWYK", asin, "B0BPXRVWYK"]),
    [asin, "B0BPXRVWYK"],
  );
});

test("default sync scope authorization requires the authenticated organization to own the project and run", async () => {
  const ownedProjectId = "10000000-0000-4000-8000-000000000003";
  const ownedRunId = "10000000-0000-4000-8000-000000000004";
  const deps = createDefaultLocalDataBridgeDeps({
    async findProjectById(id: string) {
      return id === ownedProjectId
        ? { id, organizationId: memberPrincipal().organizationId }
        : { id, organizationId: "10000000-0000-4000-8000-000000000099" };
    },
    async findAnalysisRun(id: string) {
      return id === ownedRunId ? { id, projectId: ownedProjectId } : null;
    },
  } as never);

  assert.deepEqual(
    await deps.authorizeSyncScope!(memberPrincipal(), { projectId: ownedProjectId, runId: ownedRunId }),
    { organizationId: memberPrincipal().organizationId, projectId: ownedProjectId, runId: ownedRunId, actorId: memberPrincipal().userId },
  );
  assert.equal(
    await deps.authorizeSyncScope!(memberPrincipal(), { projectId: "10000000-0000-4000-8000-000000000099" }),
    null,
  );
  assert.deepEqual(
    await deps.authorizeSyncScope!(memberPrincipal(), {}),
    { organizationId: memberPrincipal().organizationId, projectId: null, runId: null, actorId: memberPrincipal().userId },
  );
});

test("missing and foreign run IDs are indistinguishable and never start a scoped sync job", async (t) => {
  const ownedProjectId = "10000000-0000-4000-8000-000000000003";
  const missingRunId = "10000000-0000-4000-8000-000000000004";
  const foreignRunId = "10000000-0000-4000-8000-000000000005";
  const startCalls = { count: 0 };
  const scopedDeps = {
    ...fakeDeps(),
    async startAsinSyncJob() {
      startCalls.count += 1;
      return { job, reused: false, mcpAsinsPending: [], estimatedAutoSeconds: 0, estimatedAlexaSeconds: 0 };
    },
    authorizeSyncScope: createDefaultLocalDataBridgeDeps({
      async findProjectById(id: string) {
        return id === ownedProjectId
          ? { id, organizationId: memberPrincipal().organizationId }
          : { id, organizationId: "10000000-0000-4000-8000-000000000099" };
      },
      async findAnalysisRun(id: string) {
        return id === foreignRunId
          ? { id, projectId: "10000000-0000-4000-8000-000000000099" }
          : null;
      },
    } as never).authorizeSyncScope,
  } satisfies LocalDataBridgeDeps;
  const app = buildAgentApp({
    env: authenticatedLocalEnv(),
    authConfig,
    authService: authService(memberPrincipal()),
    localDataBridgeDeps: scopedDeps,
  });
  t.after(() => app.close());

  const request = (runId: string) => app.inject({
    method: "POST",
    url: "/v1/local-data/sync-asins",
    headers: { ...authenticatedHeaders(), "content-type": "application/json" },
    payload: { asins: [asin], marketplace: "US", projectId: ownedProjectId, runId },
  });
  const [missing, foreign] = await Promise.all([request(missingRunId), request(foreignRunId)]);

  assert.equal(missing.statusCode, 404);
  assert.equal(foreign.statusCode, 404);
  assert.deepEqual(
    { code: missing.json().error.code, message: missing.json().error.message },
    { code: foreign.json().error.code, message: foreign.json().error.message },
  );
  assert.equal(startCalls.count, 0);
});

test("a bridge without a scope authorizer rejects every supplied scope without starting a job", async (t) => {
  const startCalls = { count: 0 };
  const deps = {
    ...fakeDeps(),
    async startAsinSyncJob() {
      startCalls.count += 1;
      return { job, reused: false, mcpAsinsPending: [], estimatedAutoSeconds: 0, estimatedAlexaSeconds: 0 };
    },
  } satisfies LocalDataBridgeDeps;
  const app = buildAgentApp({
    env: authenticatedLocalEnv(),
    authConfig,
    authService: authService(memberPrincipal()),
    localDataBridgeDeps: deps,
  });
  t.after(() => app.close());

  const request = (scope: { projectId?: string; runId?: string }) => app.inject({
    method: "POST",
    url: "/v1/local-data/sync-asins",
    headers: { ...authenticatedHeaders(), "content-type": "application/json" },
    payload: { asins: [asin], marketplace: "US", ...scope },
  });
  const [projectOnly, runOnly, both] = await Promise.all([
    request({ projectId: "10000000-0000-4000-8000-000000000003" }),
    request({ runId: "10000000-0000-4000-8000-000000000004" }),
    request({ projectId: "10000000-0000-4000-8000-000000000003", runId: "10000000-0000-4000-8000-000000000004" }),
  ]);

  for (const response of [projectOnly, runOnly, both]) assert.equal(response.statusCode, 404);
  assert.deepEqual(
    { code: projectOnly.json().error.code, message: projectOnly.json().error.message },
    { code: runOnly.json().error.code, message: runOnly.json().error.message },
  );
  assert.deepEqual(
    { code: projectOnly.json().error.code, message: projectOnly.json().error.message },
    { code: both.json().error.code, message: both.json().error.message },
  );
  assert.equal(startCalls.count, 0);
});

test("local bridge registers sync GET and POST routes with the real provider", async (t) => {
  const app = buildAgentApp({
    env: authenticatedLocalEnv({ AGENT_VOC_LOCAL_FAKE: undefined }),
    authConfig,
    authService: authService(memberPrincipal()),
    localDataBridgeDeps: fakeDeps(),
  });
  t.after(() => app.close());

  const readiness = await app.inject({
    method: "GET",
    url: `/v1/local-data/sync-asins?asins=${asin}`,
    headers: authenticatedHeaders(),
  });
  assert.equal(readiness.statusCode, 200);
  assert.deepEqual(readiness.json(), {
    asins: [asin],
    items: [status],
    needsSync: false,
    vocPending: [],
    catalogPending: [],
  });

  const started = await app.inject({
    method: "POST",
    url: "/v1/local-data/sync-asins",
    headers: {
      ...authenticatedHeaders(),
      "content-type": "application/json",
    },
    payload: { asins: [asin], marketplace: "US" },
  });
  assert.equal(started.statusCode, 202);
  assert.deepEqual(started.json(), {
    jobId: job.jobId,
    status: job.status,
    message: job.message,
    mcpAsinsPending: [],
    estimatedAutoSeconds: 0,
    estimatedAlexaSeconds: 0,
    stages: [],
    reused: false,
    scope: { projectId: null, runId: null },
  });
});

test("anonymous loopback cannot access local-data projects or sync deps", async (t) => {
  const calls = { count: 0 };
  const app = buildAgentApp({
    env: localEnv(),
    localDataBridgeDeps: countingDeps(calls),
  });
  t.after(() => app.close());

  for (const request of [
    { method: "GET", url: "/v1/local-data/projects?kind=analysis" },
    { method: "POST", url: "/v1/local-data/projects", payload: { kind: "analysis", name: project.name, marketplace: "US", asins: projectAsins } },
    { method: "PATCH", url: "/v1/local-data/projects/project-1", payload: { name: "Renamed" } },
    { method: "DELETE", url: "/v1/local-data/projects/project-1" },
    { method: "GET", url: `/v1/local-data/sync-asins?asins=${asin}` },
    { method: "POST", url: "/v1/local-data/sync-asins", payload: { asins: [asin], marketplace: "US" } },
    { method: "GET", url: "/v1/local-data/sync-asins/job-1" },
  ] as const) {
    const response = await app.inject({
      method: request.method,
      url: request.url,
      headers: {
        ...headers(),
        ...(request.payload ? { "content-type": "application/json" } : {}),
      },
      payload: request.payload,
    });
    assert.equal(response.statusCode, 401, `${request.method} ${request.url}`);
    assert.equal(response.json().error.code, "AUTHENTICATION_REQUIRED");
  }

  assert.equal(calls.count, 0);
});

test("expired, revoked, and disabled-user sessions fail before local-data deps", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "local-data-auth-"));
  const repository = openSqliteAgentRepository({
    path: join(directory, "agent.sqlite"),
    busyTimeoutMs: 5_000,
  });
  const calls = { count: 0 };
  const auth = new AuthenticationService({
    repository,
    limiter: new BoundedLoginRateLimiter(authConfig.loginLimiter),
    sessionTtlMs: authConfig.sessionTtlMs,
    now: () => new Date("2026-08-18T00:00:00.000Z"),
  });
  const app = buildAgentApp({
    env: authenticatedLocalEnv(),
    authConfig,
    authService: auth,
    localDataBridgeDeps: countingDeps(calls),
  });
  t.after(async () => {
    await app.close();
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const fixtures = [
    {
      userId: "10000000-0000-4000-8000-000000000011",
      sessionId: "10000000-0000-4000-8000-000000000012",
      raw: "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
      status: "active" as const,
      expiresAt: "2026-08-17T23:59:59.000Z",
      revokedAt: null,
    },
    {
      userId: "10000000-0000-4000-8000-000000000021",
      sessionId: "10000000-0000-4000-8000-000000000022",
      raw: "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD",
      status: "active" as const,
      expiresAt: "2026-08-19T00:00:00.000Z",
      revokedAt: "2026-08-18T00:00:00.000Z",
    },
    {
      userId: "10000000-0000-4000-8000-000000000031",
      sessionId: "10000000-0000-4000-8000-000000000032",
      raw: "EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE",
      status: "disabled" as const,
      expiresAt: "2026-08-19T00:00:00.000Z",
      revokedAt: null,
    },
  ];

  for (const fixture of fixtures) {
    await repository.createUser({
      id: fixture.userId,
      organizationId: "10000000-0000-4000-8000-000000000099",
      email: `${fixture.userId}@example.com`,
      displayName: "Session fixture",
      role: "member",
      status: fixture.status,
      createdAt: "2026-08-17T00:00:00.000Z",
      updatedAt: "2026-08-17T00:00:00.000Z",
    });
    await repository.createSession({
      id: fixture.sessionId,
      userId: fixture.userId,
      tokenHash: digestSessionToken(fixture.raw),
      expiresAt: fixture.expiresAt,
      revokedAt: fixture.revokedAt,
      createdAt: "2026-08-17T00:00:00.000Z",
      lastSeenAt: null,
    });

    const response = await app.inject({
      method: "GET",
      url: "/v1/local-data/projects?kind=analysis",
      headers: {
        ...headers(),
        cookie: `__Host-agent_session=${fixture.raw}`,
      },
    });

    assert.equal(response.statusCode, 401);
    assert.equal(response.json().error.code, "AUTHENTICATION_REQUIRED");
  }

  assert.equal(calls.count, 0);
});

test("analysis workspace and its sync funnel use the local Agent bridge", () => {
  const page = readFileSync("app/page.tsx", "utf8");
  const workspace = page.slice(
    page.indexOf("const ensureAnalysisWorkspace"),
    page.indexOf("const runAnalysis"),
  );
  const syncReadiness = page.slice(
    page.indexOf("const startSyncIfNeeded"),
    page.indexOf("const ensureAnalysisWorkspace"),
  );
  const funnel = readFileSync("app/asin-sync-funnel.tsx", "utf8");

  assert.match(page, /localAgentFetch/);
  assert.match(workspace, /\/v1\/local-data\/projects/);
  assert.doesNotMatch(workspace, /\/api\/projects/);
  assert.match(syncReadiness, /\/v1\/local-data\/sync-asins/);
  assert.doesNotMatch(syncReadiness, /\/api\/sync-asins/);
  assert.match(funnel, /\/v1\/local-data\/sync-asins/);
  assert.doesNotMatch(funnel, /\/api\/sync-asins/);
  assert.match(page, /submitVocRun/);
  assert.match(page, /vocRunIdFromSearch/);
  assert.match(page, /searchWithVocRunId/);
  assert.match(page, /observeVocRun/);
  assert.match(page, /cancelVocRun/);
  assert.match(page, /retryVocStage/);
  assert.match(page, /onObservation:/);
  assert.match(page, /vocRun\.stage\?\.progress/);
  assert.match(page, /vocRun\.stage\?\.lastError/);
  assert.match(page, /vocRun\.reports/);
  assert.match(page, /buildSavedAnalysisReportView/);
  assert.match(page, /readSavedAnalysisReport/);
  assert.match(page, /serializeSavedAnalysisReportView/);
  assert.match(page, /traffic-analysis/);
  assert.match(page, /voc-positioning/);
  assert.match(page, /product-definition/);
  assert.match(page, /暂无已保存报告/);
  assert.match(page, /downloadSavedAnalysisReports/);
  assert.match(page, /onClick=\{downloadSavedAnalysisReports\}/);
  assert.match(page, /取消运行/);
  assert.match(page, /重试 VOC 阶段/);
  assert.match(page, /不会自动采集外部数据/);
  assert.match(page, /npm run agent:dev/);
  const rawVocStart = page.indexOf('{activeTab === "voc" &&');
  const launchStart = page.indexOf('{activeTab === "launch"', rawVocStart);
  const reportCard = page.indexOf("data-voc-run");
  assert.ok(rawVocStart >= 0);
  assert.ok(reportCard > rawVocStart && reportCard < launchStart);
  assert.doesNotMatch(page, /fetch\(`\$\{localVocAgentUrl\}\/v1\/local-voc/);
});
