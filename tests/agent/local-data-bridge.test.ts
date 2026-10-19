import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
import type { RuntimeAgentRepository } from "../../server/db/repository";
import {
  SyncJobRunConflictError,
  type SyncJobRecord,
  type SyncJobRepository,
} from "../../server/db/sync-job-repository";
import { createDefaultLocalDataBridgeDeps, type LocalDataBridgeDeps } from "../../server/routes/local-data";
import { SyncJobService } from "../../server/services/sync-job-service";
import { SyncProviderReadinessError } from "../../server/services/sync-provider-readiness-service";
import { LocalDataSyncJobSchema } from "../../shared/agent-contracts";

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
  latestAnalystName: null,
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

const missingStatus: AsinModuleStatus = { ...Object.fromEntries(Object.keys(status).map(key => [key, key === "asin" ? asin : key === "inCatalog" ? false : "missing"])) } as AsinModuleStatus;

const job: SyncJob = {
  jobId: "job-1",
  jobVersion: 1,
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

test("UK readiness never falls back to the shared US ASIN cache", async (t) => {
  const deps = fakeDeps();
  deps.fetchProject = async () => ({ ...project, marketplace: "UK", asins: [asin] });
  deps.readCurrentDisplayVersion = async () => null;
  deps.fetchAsinDataStatus = async () => { throw new Error("shared US cache must not be read"); };
  const app = buildAgentApp({ env: authenticatedLocalEnv(), authConfig,
    authService: authService(memberPrincipal()), localDataBridgeDeps: deps });
  t.after(() => app.close());
  const response = await app.inject({ method: "GET",
    url: `/v1/local-data/sync-asins?asins=${asin}&projectId=10000000-0000-4000-8000-000000000004&marketplace=UK`, headers: authenticatedHeaders() });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().items[0].inCatalog, false);
  assert.equal(response.json().items[0].sales, "missing");
  assert.equal(response.json().needsSync, true);
});

test("published readiness validates project, site, organization and exact cohort", async (t) => {
  const projectId = "10000000-0000-4000-8000-000000000004";
  const organizationId = memberPrincipal().organizationId;
  for (const mismatch of [null, "marketplace", "projectId", "organizationId", "asins"] as const) {
    const deps = fakeDeps();
    deps.normalizeAsins = async values => Array.isArray(values) ? values : null;
    deps.fetchProject = async () => ({ ...project, id: projectId, marketplace: "UK", asins: [asin] });
    deps.readCurrentDisplayVersion = async () => ({ versionId: "version", organizationId, projectId,
      jobId: job.jobId, runId: "run", marketplace: "UK", asins: [asin], catalog: [], stageOutputs: {},
      gaps: [], contentHash: "hash", sourceCompletedAt: job.createdAt, publishedAt: job.createdAt });
    deps.readJob = async () => ({ ...job, marketplace: "UK", asins: [asin],
      scope: { organizationId, projectId, marketplace: "UK", asins: [asin], runId: "run",
        ...(mismatch ? { [mismatch]: mismatch === "asins" ? ["B000000001"] : "other" } : {}) },
      asinProgress: { [asin]: { sales_trend: { status: "ready", reason: null, updatedAt: job.createdAt } } } });
    const app = buildAgentApp({ env: authenticatedLocalEnv(), authConfig,
      authService: authService(memberPrincipal()), localDataBridgeDeps: deps });
    t.after(() => app.close());
    const url = `/v1/local-data/sync-asins?asins=${asin}&projectId=${projectId}&marketplace=UK`;
    const response = await app.inject({ method: "GET", url, headers: authenticatedHeaders() });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().items[0].sales, mismatch ? "missing" : "ready", String(mismatch));
    assert.equal(response.json().items[0].reviews, "missing");
    const wrongSite = await app.inject({ method: "GET", url: url.replace("marketplace=UK", "marketplace=US"), headers: authenticatedHeaders() });
    assert.equal(wrongSite.statusCode, 400);
    const wrongAsins = await app.inject({ method: "GET", url: url.replace(`asins=${asin}`, `asins=${asin},${asin}`), headers: authenticatedHeaders() });
    assert.equal(wrongAsins.statusCode, 400);
  }
});

test("renaming a local analysis project updates the matching database project name", async (t) => {
  const deps = fakeDeps();
  const events: string[] = [];
  deps.fetchProject = async () => ({ ...project, name: "Original name" });
  deps.updateAnalysisProject = async (_id, patch) => {
    events.push("local");
    return { ...project, name: String(patch.name) };
  };
  Object.assign(deps, {
    async syncProjectName(input: {
      organizationId: string;
      previous: AnalysisProject;
      project: AnalysisProject;
    }) {
      events.push("database");
      assert.equal(input.organizationId, memberPrincipal().organizationId);
      assert.equal(input.previous.name, "Original name");
      assert.equal(input.project.name, "Renamed project");
      assert.deepEqual(input.project.asins, projectAsins);
    },
  });
  const app = buildAgentApp({ env: authenticatedLocalEnv(), authConfig,
    authService: authService(memberPrincipal()), localDataBridgeDeps: deps });
  t.after(() => app.close());
  const response = await app.inject({ method: "PATCH", url: `/v1/local-data/projects/${project.id}`,
    headers: authenticatedHeaders(), payload: { name: "Renamed project" } });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(events, ["local", "database"]);
});

test("failed database name sync restores the previous local name", async (t) => {
  const deps = fakeDeps();
  let localName = "Original name";
  let localAsins = [...projectAsins];
  deps.fetchProject = async () => ({ ...project, name: localName, asins: localAsins });
  deps.updateAnalysisProject = async (_id, patch) => {
    if (patch.name !== undefined) localName = String(patch.name);
    if (Array.isArray(patch.asins)) localAsins = patch.asins as string[];
    return { ...project, name: localName, asins: localAsins };
  };
  Object.assign(deps, { async syncProjectName() { throw new Error("database name update failed"); } });
  const app = buildAgentApp({ env: authenticatedLocalEnv(), authConfig,
    authService: authService(memberPrincipal()), localDataBridgeDeps: deps });
  t.after(() => app.close());
  const response = await app.inject({ method: "PATCH", url: `/v1/local-data/projects/${project.id}`,
    headers: authenticatedHeaders(), payload: { name: "Renamed project", asins: [...projectAsins].reverse() } });
  assert.equal(response.statusCode, 500);
  assert.equal(localName, "Original name");
  assert.deepEqual(localAsins, projectAsins);
});

test("database name sync checks organization and ordered ASIN scope before writing", async () => {
  let writes = 0;
  const stored = {
    id: project.id, organizationId: memberPrincipal().organizationId,
    name: "Original name", marketplace: project.marketplace, asins: [...projectAsins],
  };
  const repository = {
    async findProjectById() { return stored; },
    async updateProjectMetadata(input: { name: string }) {
      writes++;
      stored.name = input.name;
      return stored;
    },
  } as unknown as RuntimeAgentRepository;
  const sync = createDefaultLocalDataBridgeDeps(repository, { bypassProviderReadiness: true }).syncProjectName!;
  const input = {
    organizationId: memberPrincipal().organizationId,
    previous: { ...project, name: "Original name" },
    project: { ...project, name: "Renamed project" },
  };
  await sync(input);
  assert.equal(stored.name, "Renamed project");
  assert.equal(writes, 1);
  await assert.rejects(sync({ ...input, organizationId: "foreign-organization" }), /scope/i);
  await assert.rejects(sync({ ...input, project: { ...input.project, asins: [...projectAsins].reverse() } }), /scope/i);
  assert.equal(writes, 1);
});

test("current sync job read is organization scoped and returns the completed display job", async (t) => {
  const deps = fakeDeps();
  deps.readLatestCompletedSyncJob = async ({ organizationId, projectId }) => {
    assert.equal(organizationId, memberPrincipal().organizationId);
    assert.equal(projectId, project.id);
    return { jobId: "new-job", runId: "run-1" };
  };
  const app = buildAgentApp({ env: authenticatedLocalEnv(), authConfig,
    authService: authService(memberPrincipal()), localDataBridgeDeps: deps });
  t.after(() => app.close());
  const current = await app.inject({ method: "GET",
    url: `/v1/local-data/projects/${project.id}/current-sync-job`, headers: authenticatedHeaders() });
  assert.equal(current.statusCode, 200);
  assert.deepEqual(current.json(), { jobId: "new-job", runId: "run-1" });
});

test("current display version read is scoped and never starts collection", async (t) => {
  const deps = fakeDeps();
  const calls = { reads: 0, starts: 0 };
  let returnForeign = false;
  Object.assign(deps, {
    async readCurrentDisplayVersion({ organizationId, projectId }: { organizationId: string; projectId: string }) {
      calls.reads++;
      assert.equal(organizationId, memberPrincipal().organizationId);
      assert.equal(projectId, project.id);
      return {
        versionId: "version-1", organizationId: returnForeign ? "foreign-org" : organizationId, projectId, runId: "run-1", jobId: "job-1",
        marketplace: "US", asins: projectAsins, catalog: [], stageOutputs: {}, gaps: [],
        contentHash: "hash-1", sourceCompletedAt: "2026-09-21T00:00:00.000Z", publishedAt: "2026-09-21T00:00:01.000Z",
      };
    },
    async startAsinSyncJob() { calls.starts++; throw new Error("GET must not start collection"); },
  });
  const app = buildAgentApp({ env: authenticatedLocalEnv(), authConfig,
    authService: authService(memberPrincipal()), localDataBridgeDeps: deps });
  t.after(() => app.close());
  const response = await app.inject({ method: "GET",
    url: `/v1/local-data/projects/${project.id}/current-display-version`, headers: authenticatedHeaders() });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json().versionId, "version-1");
  returnForeign = true;
  const foreign = await app.inject({ method: "GET",
    url: `/v1/local-data/projects/${project.id}/current-display-version`, headers: authenticatedHeaders() });
  assert.equal(foreign.statusCode, 404);
  assert.deepEqual(calls, { reads: 2, starts: 0 });
});

test("missing report storage is a service error; an empty scoped read is explicitly unpublished", async (t) => {
  const deps = fakeDeps();
  delete deps.readCurrentDisplayVersion;
  const app = buildAgentApp({ env: authenticatedLocalEnv(), authConfig,
    authService: authService(memberPrincipal()), localDataBridgeDeps: deps });
  t.after(() => app.close());
  const response = await app.inject({ method: "GET",
    url: `/v1/local-data/projects/${project.id}/current-display-version`, headers: authenticatedHeaders() });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().error.code, "CONFIGURATION_ERROR");
  const empty = buildAgentApp({ env: authenticatedLocalEnv(), authConfig,
    authService: authService(memberPrincipal()), localDataBridgeDeps: {
      ...fakeDeps(), readCurrentDisplayVersion: async () => null,
    } });
  t.after(() => empty.close());
  const missing = await empty.inject({ method: "GET",
    url: `/v1/local-data/projects/${project.id}/current-display-version`, headers: authenticatedHeaders() });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().error.code, "PROJECT_REPORT_NOT_PUBLISHED");
});

test('collection source binding persists only an authorized analysis project with matching scope', async () => {
  const sourceId='30000000-0000-4000-8000-000000000001';
  const source={...project,id:sourceId};
  const collection={...project,id:'30000000-0000-4000-8000-000000000002',kind:'keyword-compare' as const};
  const deps=fakeDeps();let saved:Record<string,unknown>|null=null;let allowed=true;
  deps.fetchProject=async id=>id===sourceId?source:id===collection.id?collection:null;
  deps.authorizeSyncScope=async()=>allowed?{organizationId:memberPrincipal().organizationId,projectId:sourceId}:null;
  deps.createAnalysisProject=async body=>{saved=body;return {...collection,...body} as AnalysisProject;};
  deps.updateAnalysisProject=async (_id,body)=>{saved=body;return {...collection,...body} as AnalysisProject;};
  const app=buildAgentApp({env:authenticatedLocalEnv(),authConfig,authService:authService(memberPrincipal()),localDataBridgeDeps:deps});
  try {
    const payload={name:'Saved comparison',kind:'keyword-compare',asins:projectAsins,marketplace:'US',sourceProjectId:sourceId};
    const created=await app.inject({method:'POST',url:'/v1/local-data/projects',headers:authenticatedHeaders(),payload});
    assert.equal(created.statusCode,201,created.body);assert.equal(created.json().project.sourceProjectId,sourceId);assert.equal(saved?.['sourceProjectId'],sourceId);
    allowed=false;saved=null;
    const foreign=await app.inject({method:'POST',url:'/v1/local-data/projects',headers:authenticatedHeaders(),payload});
    assert.equal(foreign.statusCode,404);assert.equal(saved,null);
    allowed=true;
    const wrongSite=await app.inject({method:'POST',url:'/v1/local-data/projects',headers:authenticatedHeaders(),payload:{...payload,marketplace:'UK'}});
    assert.equal(wrongSite.statusCode,400);assert.equal(saved,null);
    const linked=await app.inject({method:'PATCH',url:`/v1/local-data/projects/${collection.id}`,headers:authenticatedHeaders(),payload:{sourceProjectId:sourceId}});
    assert.equal(linked.statusCode,200,linked.body);assert.equal(linked.json().project.sourceProjectId,sourceId);
  } finally {await app.close();}
});

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
    candidates: [{ asin, module: "keywords", connectorId: "sif" as const, nextStatus: "pending" as const, reason: "LEGACY_UNVERIFIED" as const }],
  };
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
  assert.equal(deleted.statusCode, 403);

  const readiness = await app.inject({ method: "GET", url: `/v1/local-data/sync-asins?asins=${asin}&marketplace=US`, headers: authenticatedHeaders() });
  assert.equal(readiness.statusCode, 200);
  assert.deepEqual(readiness.json(), { asins: [asin], items: [missingStatus], needsSync: true, vocPending: [asin], catalogPending: [asin] });

  const started = await app.inject({ method: "POST", url: "/v1/local-data/sync-asins", headers: { ...authenticatedHeaders(), "content-type": "application/json" }, payload: { asins: [asin], marketplace: "US" } });
  assert.equal(started.statusCode, 202);
  assert.deepEqual(started.json(), { jobId: job.jobId, status: job.status, message: job.message, mcpAsinsPending: [], estimatedAutoSeconds: 0, estimatedAlexaSeconds: 0, stages: [], reused: false, scope: { projectId: null, runId: null } });

  const polled = await app.inject({ method: "GET", url: "/v1/local-data/sync-asins/job-1", headers: authenticatedHeaders() });
  assert.equal(polled.statusCode, 200);
  const polledJob = polled.json();
  assert.equal(Object.hasOwn(polledJob, "resumableStages"), true);
  assert.deepEqual(polledJob, { ...job, resumableStages: [] });
});

test("local sync POST and GET preserve a strict catalog provider plan", async (t) => {
  const plannedJob: SyncJob = {
    ...job,
    stages: [{
      id: "catalog",
      label: "商品底库",
      kind: "auto",
      status: "pending",
      estimatedSeconds: 18,
      startedAt: null,
      completedAt: null,
      catalogProviderPlan: {
        preferredConnectorId: "sorftime",
        unavailableConnectorIds: ["sellerSprite"],
      },
    }],
  };
  const deps = fakeDeps();
  deps.startAsinSyncJob = async () => ({
    job: plannedJob,
    reused: false,
    mcpAsinsPending: [asin],
    estimatedAutoSeconds: 18,
    estimatedAlexaSeconds: 0,
  });
  deps.readJob = async (id) => id === plannedJob.jobId ? plannedJob : null;
  const app = buildAgentApp({
    env: authenticatedLocalEnv(),
    authConfig,
    authService: authService(memberPrincipal()),
    localDataBridgeDeps: deps,
  });
  t.after(() => app.close());

  const started = await app.inject({
    method: "POST",
    url: "/v1/local-data/sync-asins",
    headers: { ...authenticatedHeaders(), "content-type": "application/json" },
    payload: { asins: [asin], marketplace: "US" },
  });
  assert.equal(started.statusCode, 202, started.body);
  assert.deepEqual(started.json().stages, plannedJob.stages);

  const polled = await app.inject({
    method: "GET",
    url: `/v1/local-data/sync-asins/${plannedJob.jobId}`,
    headers: authenticatedHeaders(),
  });
  assert.equal(polled.statusCode, 200);
  assert.deepEqual(polled.json().stages, plannedJob.stages);
});

test("repair start forwards parent identity and returns a no-work response without a job", async (t) => {
  const deps = fakeDeps();
  let captured: unknown;
  deps.authorizeSyncScope = async (principal, input) => ({ organizationId: principal.kind === "user" ? principal.organizationId : "", projectId: input.projectId });
  deps.startAsinSyncJob = async input => { captured = input; return { noWork: true, message: "暂无待补抓数据" }; };
  const app = buildAgentApp({ env: authenticatedLocalEnv(), authConfig, authService: authService(memberPrincipal()), localDataBridgeDeps: deps });
  t.after(() => app.close());
  const response = await app.inject({ method: "POST", url: "/v1/local-data/sync-asins", headers: { ...authenticatedHeaders(), "content-type": "application/json" }, payload: { asins: [asin], projectId: "10000000-0000-4000-8000-000000000003", mode: "repair-incomplete", parentJobId: "parent" } });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json(), { noWork: true, message: "暂无待补抓数据" });
  assert.equal((captured as { mode: string }).mode, "repair-incomplete");
  assert.equal((captured as { parentJobId: string }).parentJobId, "parent");
});

test("authenticated sync GET preserves canonical resumability without leaking it across organizations", async (t) => {
  const principal = memberPrincipal();
  const record: SyncJobRecord = {
    jobId: "canonical-traffic-job",
    organizationId: principal.organizationId,
    projectId: "10000000-0000-4000-8000-000000000010",
    runId: "10000000-0000-4000-8000-000000000011",
    actorId: principal.userId,
    fingerprint: "canonical-traffic-fingerprint",
    asins: [asin],
    marketplace: "US",
    status: "completed",
    message: "Completed with canonical traffic pending",
    currentStageId: "build",
    stages: [],
    asinProgress: {},
    leasedBy: null,
    leaseGeneration: 3,
    leaseExpiresAt: null,
    error: null,
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:01:00.000Z",
    completedAt: "2026-08-24T00:01:00.000Z",
    dynamicSnapshot: "pending",
    resumableStages: ["traffic"],
    scope: {
      organizationId: principal.organizationId,
      projectId: "10000000-0000-4000-8000-000000000010",
      runId: "10000000-0000-4000-8000-000000000011",
      marketplace: "US",
      asins: [asin],
    },
  };
  const repository: SyncJobRepository = {
    async readStageOutput() { return null; },
    async admit() { throw new Error("unused"); },
    async findById(jobId) { return jobId === record.jobId ? record : null; },
    async resume() { throw new Error("unused"); },
    async claimNext() { throw new Error("unused"); },
    async heartbeat() { throw new Error("unused"); },
    async recordProgress() { throw new Error("unused"); },
    async complete() { throw new Error("unused"); },
    async fail() { throw new Error("unused"); },
  };
  const service = new SyncJobService(repository);
  const deps = {
    ...fakeDeps(),
    readJob: (jobId: string) => service.read(jobId),
  };
  const allowed = buildAgentApp({
    env: authenticatedLocalEnv(),
    authConfig,
    authService: authService(principal),
    localDataBridgeDeps: deps,
  });
  const foreign = buildAgentApp({
    env: authenticatedLocalEnv(),
    authConfig,
    authService: authService({
      ...principal,
      organizationId: "10000000-0000-4000-8000-000000000099",
    }),
    localDataBridgeDeps: deps,
  });
  t.after(() => Promise.all([allowed.close(), foreign.close()]));

  const visible = await allowed.inject({
    method: "GET",
    url: `/v1/local-data/sync-asins/${record.jobId}`,
    headers: authenticatedHeaders(),
  });
  assert.equal(visible.statusCode, 200);
  assert.deepEqual(visible.json().resumableStages, ["traffic"]);

  const hidden = await foreign.inject({
    method: "GET",
    url: `/v1/local-data/sync-asins/${record.jobId}`,
    headers: authenticatedHeaders(),
  });
  assert.equal(hidden.statusCode, 404);
  assert.doesNotMatch(hidden.body, /canonical-traffic-job|traffic/);
});

test("authenticated sync GET projects publication only after job ownership is established", async (t) => {
  const calls: string[] = [];
  const currentView = { jobVersion: 9, stageContentHashes: { keywords: "e".repeat(64) } };
  const publication = {
    status: "applied" as const,
    requestId: "c".repeat(64),
    artifactId: "d".repeat(64),
    requestedAt: "2026-08-25T00:00:00.000Z",
    appliedAt: "2026-08-25T00:00:05.000Z",
  };
  const scopedJob: SyncJob = {
    ...job,
    jobVersion: 9,
    scope: {
      organizationId: memberPrincipal().organizationId,
      projectId: "10000000-0000-4000-8000-000000000003",
      runId: "10000000-0000-4000-8000-000000000004",
      marketplace: "US",
      asins: [asin],
    },
  };
  const deps = {
    ...fakeDeps(),
    async readJob(jobId: string) {
      calls.push(`job:${jobId}`);
      return jobId === scopedJob.jobId ? scopedJob : null;
    },
    async readPublicationView(jobId: string, organizationId: string) {
      calls.push(`view:${jobId}:${organizationId}`);
      return currentView;
    },
    async readPublication(jobId: string, view: typeof currentView | null) {
      calls.push(`publication:${jobId}:${view?.jobVersion ?? "missing"}`);
      return publication;
    },
  } as LocalDataBridgeDeps & {
    readPublication(jobId: string, view: typeof currentView | null): Promise<typeof publication>;
  };
  const allowed = buildAgentApp({
    env: authenticatedLocalEnv(),
    authConfig,
    authService: authService(memberPrincipal()),
    localDataBridgeDeps: deps,
  });
  const foreign = buildAgentApp({
    env: authenticatedLocalEnv(),
    authConfig,
    authService: authService({ ...memberPrincipal(), organizationId: "10000000-0000-4000-8000-000000000099" }),
    localDataBridgeDeps: deps,
  });
  t.after(() => Promise.all([allowed.close(), foreign.close()]));

  const visible = await allowed.inject({
    method: "GET",
    url: `/v1/local-data/sync-asins/${scopedJob.jobId}`,
    headers: authenticatedHeaders(),
  });
  assert.equal(visible.statusCode, 200);
  assert.deepEqual(visible.json().publication, publication);
  assert.deepEqual(calls, [
    `job:${scopedJob.jobId}`,
    `view:${scopedJob.jobId}:${scopedJob.scope?.organizationId}`,
    `publication:${scopedJob.jobId}:9`,
  ]);

  calls.length = 0;
  const hidden = await foreign.inject({
    method: "GET",
    url: `/v1/local-data/sync-asins/${scopedJob.jobId}`,
    headers: authenticatedHeaders(),
  });
  assert.equal(hidden.statusCode, 404);
  assert.deepEqual(calls, [`job:${scopedJob.jobId}`]);
  assert.doesNotMatch(hidden.body, /publication|secret|C:\\|target|WEB_PUBLICATION|applied/i);

  calls.length = 0;
  const missing = await allowed.inject({
    method: "GET",
    url: "/v1/local-data/sync-asins/missing",
    headers: authenticatedHeaders(),
  });
  assert.equal(missing.statusCode, 404);
  assert.deepEqual(calls, ["job:missing"]);
});

test("publication status service reads one bounded exact mirror reference", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "sync-publication-status-"));
  const mirrorDirectory = join(directory, "mirrors");
  const spoolDirectory = join(directory, "spool");
  const jobId = "job-1";
  const reference = {
    generation: 1,
    requestId: "0".repeat(64),
    artifactId: "d".repeat(64),
    jobVersion: 9,
    stageContentHashes: { keywords: "e".repeat(64) },
    requestedAt: "2026-08-25T00:00:00.000Z",
  };
  const currentView = { jobVersion: reference.jobVersion, stageContentHashes: reference.stageContentHashes };
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(mirrorDirectory, { recursive: true });
  const { createWebReloadTarget, writeWebReloadRequest } = await import("../../scripts/lib/web-reload-request.mjs");
  const request = await writeWebReloadRequest({
    jobId,
    jobVersion: reference.jobVersion,
    artifactId: reference.artifactId,
    stageContentHashes: reference.stageContentHashes,
    buildCompletedAt: reference.requestedAt,
    target: createWebReloadTarget({ worktree: directory, webHost: "127.0.0.1", webPort: 3101 }),
  }, { spoolDir: spoolDirectory });
  const exactReference = { ...reference, requestId: request.id };
  writeFileSync(join(mirrorDirectory, `${jobId}.json`), JSON.stringify({ publication: exactReference }), "utf8");
  const { SyncPublicationStatusService } = await import("../../server/services/sync-publication-status-service");
  const service = new SyncPublicationStatusService({ mirrorDirectory, spoolDirectory });

  assert.deepEqual(await service.read(jobId, currentView), {
    status: "pending",
    requestId: request.id,
    artifactId: reference.artifactId,
    requestedAt: reference.requestedAt,
  });
  const appliedPath = join(spoolDirectory, "applied", `${request.id}.json`);
  renameSync(request.path, appliedPath);
  const applied = await service.read(jobId, currentView);
  assert.equal(applied.status, "applied");
  if (applied.status === "applied") {
    assert.deepEqual(
      { requestId: applied.requestId, artifactId: applied.artifactId, requestedAt: applied.requestedAt },
      { requestId: request.id, artifactId: reference.artifactId, requestedAt: reference.requestedAt },
    );
    assert.equal(Number.isNaN(Date.parse(applied.appliedAt)), false);
  }
  const failedPath = join(spoolDirectory, "failed", `${request.id}.json`);
  renameSync(appliedPath, failedPath);
  const failed = await service.read(jobId, currentView);
  assert.equal(failed.status, "failed");
  if (failed.status === "failed") {
    assert.deepEqual(
      { requestId: failed.requestId, artifactId: failed.artifactId, requestedAt: failed.requestedAt, code: failed.code },
      { requestId: request.id, artifactId: reference.artifactId, requestedAt: reference.requestedAt, code: "WEB_PUBLICATION_FAILED" },
    );
    assert.equal(Number.isNaN(Date.parse(failed.failedAt)), false);
  }
  assert.deepEqual(await service.read("../invalid", currentView), { status: "not-required" });
  writeFileSync(join(mirrorDirectory, `${jobId}.json`), JSON.stringify({
    publication: { ...exactReference, target: "C:/secret" },
  }), "utf8");
  assert.deepEqual(await service.read(jobId, currentView), { status: "not-required" });
  writeFileSync(join(mirrorDirectory, `${jobId}.json`), "x".repeat(2 * 1024 * 1024 + 1), "utf8");
  assert.deepEqual(await service.read(jobId, currentView), { status: "not-required" });
});

test("publication spool reader failures become a strict bound failure without internal details", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "sync-publication-reader-failure-"));
  const mirrorDirectory = join(directory, "mirrors");
  const spoolDirectory = join(directory, "spool-sentinel");
  const jobId = "job-1";
  const reference = {
    generation: 1,
    requestId: "c".repeat(64),
    artifactId: "d".repeat(64),
    jobVersion: 9,
    stageContentHashes: { keywords: "e".repeat(64) },
    requestedAt: "2026-08-25T00:00:00.000Z",
  };
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(mirrorDirectory, { recursive: true });
  writeFileSync(join(mirrorDirectory, `${jobId}.json`), JSON.stringify({ publication: reference }), "utf8");
  writeFileSync(spoolDirectory, "reader-spool-sentinel", "utf8");
  const { SyncPublicationStatusService } = await import("../../server/services/sync-publication-status-service");
  const service = new SyncPublicationStatusService({ mirrorDirectory, spoolDirectory });

  const failed = await service.read(jobId, {
    jobVersion: reference.jobVersion,
    stageContentHashes: reference.stageContentHashes,
  });
  assert.equal(failed.status, "failed");
  if (failed.status === "failed") {
    assert.deepEqual(
      { requestId: failed.requestId, artifactId: failed.artifactId, requestedAt: failed.requestedAt, code: failed.code },
      { requestId: reference.requestId, artifactId: reference.artifactId, requestedAt: reference.requestedAt, code: "WEB_PUBLICATION_FAILED" },
    );
    assert.equal(Number.isNaN(Date.parse(failed.failedAt)), false);
  }
  assert.doesNotMatch(JSON.stringify(failed), /reader-spool-sentinel|ENOTDIR|spool-sentinel|path|message/i);

  const scopedJob: SyncJob = {
    ...job,
    scope: {
      organizationId: memberPrincipal().organizationId,
      projectId: "10000000-0000-4000-8000-000000000003",
      runId: "10000000-0000-4000-8000-000000000004",
      marketplace: "US",
      asins: [asin],
    },
  };
  const app = buildAgentApp({
    env: authenticatedLocalEnv(),
    authConfig,
    authService: authService(memberPrincipal()),
    localDataBridgeDeps: {
      ...fakeDeps(),
      async readJob(id) { return id === jobId ? scopedJob : null; },
      async readPublicationView() {
        return { jobVersion: reference.jobVersion, stageContentHashes: reference.stageContentHashes };
      },
      readPublication: (id, currentView) => service.read(id, currentView ?? undefined),
    },
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: "GET",
    url: `/v1/local-data/sync-asins/${jobId}`,
    headers: authenticatedHeaders(),
  });
  assert.equal(response.statusCode, 200);
  assert.equal(LocalDataSyncJobSchema.safeParse(response.json()).success, true);
  assert.deepEqual(
    {
      status: response.json().publication?.status,
      requestId: response.json().publication?.requestId,
      artifactId: response.json().publication?.artifactId,
      requestedAt: response.json().publication?.requestedAt,
      code: response.json().publication?.code,
    },
    {
      status: "failed",
      requestId: reference.requestId,
      artifactId: reference.artifactId,
      requestedAt: reference.requestedAt,
      code: "WEB_PUBLICATION_FAILED",
    },
  );
  assert.equal(Number.isNaN(Date.parse(response.json().publication?.failedAt)), false);
  assert.doesNotMatch(
    JSON.stringify(response.json().publication),
    /reader-spool-sentinel|ENOTDIR|spool-sentinel|path|message/i,
  );
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

    const readiness = await app.inject({ method: "GET", url: `/v1/local-data/sync-asins?asins=${asin}&marketplace=US`, headers: authenticatedHeaders() });
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
  const capturedPrincipals: AuthenticatedPrincipal[] = [];
  const deps = fakeDeps();
  deps.authorizeSyncScope = async (principal, input) => {
    if (principal.kind === "user") capturedPrincipals.push(principal);
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
  assert.equal(capturedPrincipals[0]?.organizationId, memberPrincipal().organizationId);
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

test("provider readiness admits a partial job with 202 and does not affect read-only readiness GET", async (t) => {
  const partialJob: SyncJob = {
    ...job,
    stages: [{
      id: "catalog",
      label: "卖家精灵商品底库",
      kind: "auto",
      status: "partial",
      estimatedSeconds: 18,
      detail: "SellerSprite 数据源不可用，本阶段已跳过。",
      startedAt: null,
      completedAt: "2026-08-23T08:00:00.000Z",
    }],
  };
  const deps = fakeDeps();
  deps.startAsinSyncJob = async () => ({
    job: partialJob,
    reused: false,
    mcpAsinsPending: [asin],
    estimatedAutoSeconds: 18,
    estimatedAlexaSeconds: 0,
  });
  const app = buildAgentApp({
    env: authenticatedLocalEnv(),
    authConfig,
    authService: authService(memberPrincipal()),
    localDataBridgeDeps: deps,
  });
  t.after(() => app.close());

  const start = await app.inject({
    method: "POST",
    url: "/v1/local-data/sync-asins",
    headers: { ...authenticatedHeaders(), "content-type": "application/json" },
    payload: { asins: [asin], marketplace: "US" },
  });
  assert.equal(start.statusCode, 202);
  assert.equal(start.json().stages[0]?.status, "partial");
});

test("provider readiness rejects when all required providers are unavailable without affecting readiness GET", async (t) => {
  const deps = fakeDeps();
  deps.startAsinSyncJob = async () => {
    throw new SyncProviderReadinessError([
      { connectorId: "sellerSprite", causeCode: "PROBE_FAILED" },
      { connectorId: "sif", causeCode: "PROBE_REQUIRED" },
      { connectorId: "sorftime", causeCode: "NOT_CONFIGURED" },
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
    url: `/v1/local-data/sync-asins?asins=${asin}&marketplace=US`,
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
    { path: "connectors.sellerSprite", message: "PROBE_FAILED" },
    { path: "connectors.sif", message: "PROBE_REQUIRED" },
    { path: "connectors.sorftime", message: "NOT_CONFIGURED" },
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
    url: `/v1/local-data/sync-asins?asins=${asin}&marketplace=US`,
    headers: authenticatedHeaders(),
  });
  assert.equal(readiness.statusCode, 200);
  assert.deepEqual(readiness.json(), {
    asins: [asin],
    items: [missingStatus],
    needsSync: true,
    vocPending: [asin],
    catalogPending: [asin],
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
    { method: "GET", url: `/v1/local-data/sync-asins?asins=${asin}&marketplace=US` },
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
    assert.equal(response.statusCode, request.method === "DELETE" ? 403 : 401, `${request.method} ${request.url}`);
    assert.equal(response.json().error.code, request.method === "DELETE" ? "FORBIDDEN" : "AUTHENTICATION_REQUIRED");
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
  assert.match(page, /from "\.\/lib\/app-tabs"/);
  assert.doesNotMatch(page, /\bsubmitVocRun\b/);
  assert.match(page, /vocRunIdFromSearch/);
  assert.doesNotMatch(page, /\bsearchWithVocRunId\b/);
  assert.doesNotMatch(page, /\brunVocAnalysis\b/);
  assert.doesNotMatch(page, /VOC 独立分析/);
  assert.doesNotMatch(page, /开始 VOC 独立分析/);
  assert.match(page, /observeVocRun/);
  assert.match(page, /cancelVocRun/);
  assert.match(page, /retryVocStage/);
  assert.match(page, /onObservation:/);
  assert.match(page, /vocRun\.reports/);
  assert.match(page, /buildSavedAnalysisReportView/);
  assert.match(page, /readSavedAnalysisReport/);
  assert.match(page, /serializeSavedAnalysisReportView/);
  assert.match(page, /traffic-analysis/);
  assert.match(page, /voc-positioning/);
  assert.match(page, /product-definition/);
  assert.match(page, /暂无已保存报告/);
  assert.match(page, /downloadSavedAnalysisReports/);
  assert.doesNotMatch(page, /onClick=\{downloadSavedAnalysisReports\}/);
  assert.doesNotMatch(page, /导出对比报告/);
  assert.match(page, /取消运行/);
  assert.match(page, /重试 VOC 阶段/);
  assert.match(page, /不会自动采集外部数据/);
  assert.match(page, /npm run agent:dev/);
  const urlIdentity = page.slice(
    page.indexOf("const syncJobId"),
    page.indexOf("const workspaceReady"),
  );
  assert.match(urlIdentity, /baseSyncRunIdFromSearch\(searchParams\.toString\(\)\)/);
  assert.match(urlIdentity, /runId: baseSyncRunId/);
  const vocRecoveryStart = page.indexOf("const runId = vocRunIdFromSearch(appSearch)");
  const vocRecoveryEnd = page.indexOf("}, [appSearch", vocRecoveryStart);
  const vocRecovery = page.slice(vocRecoveryStart, vocRecoveryEnd);
  assert.ok(vocRecoveryStart >= 0 && vocRecoveryEnd > vocRecoveryStart, "VOC URL recovery remains a bounded production effect");
  assert.match(vocRecovery, /void waitForVocRun\(runId, \{ signal: controller.signal/);
  assert.match(vocRecovery, /if \(!controller.signal.aborted\) setVocRun\(observation\)/);
  assert.match(vocRecovery, /controller.abort\(\)/);
  const projectLoadHref = page.slice(
    page.indexOf("function buildProjectLoadHref"),
    page.indexOf("function setProjectParam"),
  );
  const projectSwitch = page.slice(
    page.indexOf("const applyProject"),
    page.indexOf("useEffect(() =>", page.indexOf("const applyProject")),
  );
  const baseAnalysisStart = page.slice(
    page.indexOf("const runAnalysis"),
    page.indexOf("const continueVocRun"),
  );
  assert.match(projectLoadHref, /clearVocRunFromSearch\(params\)/);
  assert.match(projectSwitch, /params = clearVocRunFromSearch\(params\)/);
  assert.match(projectSwitch, /clearVocRunFromSearch\(params\)[\s\S]*?setVocRun\(null\)/);
  assert.match(baseAnalysisStart, /clearVocRunFromSearch\(clearSyncJobFromSearch\(window\.location\.search\)\)[\s\S]*?setVocRun\(null\)/);
  const rawVocStart = page.indexOf('{activeTab === "voc" &&');
  const launchStart = page.indexOf('{activeTab === "launch"', rawVocStart);
  const reportCard = page.indexOf("data-voc-run");
  assert.ok(rawVocStart >= 0);
  assert.ok(reportCard > rawVocStart && reportCard < launchStart);
  const rawVocPage = page.slice(rawVocStart, reportCard);
  assert.match(rawVocPage, /<AlexaVocImportPanel/);
  assert.match(rawVocPage, /effectiveVocByAsin=\{manualVoc\.effectiveVocByAsin\}/);
  assert.match(rawVocPage, /onImported=\{manualVoc\.onImported\}/);
  assert.doesNotMatch(page, /fetch\(`\$\{localVocAgentUrl\}\/v1\/local-voc/);
});

test("shared project deletion rejects members before storage and permits admins", async t => {
  for (const principal of [memberPrincipal(), adminPrincipal()]) {
    const calls = { count: 0 };
    const app = buildAgentApp({ env: authenticatedLocalEnv(), authConfig,
      authService: authService(principal), localDataBridgeDeps: { ...countingDeps(calls), authorizeProjectDeletion: async () => true } });
    t.after(() => app.close());
    const response = await app.inject({ method: "DELETE", url: "/v1/local-data/projects/project-1", headers: authenticatedHeaders() });
    assert.equal(response.statusCode, principal.role === "admin" ? 200 : 403);
    assert.equal(calls.count, principal.role === "admin" ? 1 : 0);
  }
});

test("project deletion fails closed for foreign and unbound legacy records and rejects spoofed scope", async t => {
  const principal = adminPrincipal();
  for (const organizationId of [principal.organizationId, "foreign-org", null]) {
    const binding = organizationId ? { organizationId } : null;
    const deps = createDefaultLocalDataBridgeDeps({ findProjectById: async () => null, findLegacyProjectOwnerBinding: async () => binding } as never);
    assert.equal(await deps.authorizeProjectDeletion!(principal, project.id), organizationId === principal.organizationId);
    const calls = { count: 0 };
    const app = buildAgentApp({ env: authenticatedLocalEnv(), authConfig, authService: authService(principal),
      localDataBridgeDeps: { ...countingDeps(calls), authorizeProjectDeletion: deps.authorizeProjectDeletion } });
    t.after(() => app.close());
    for (const suffix of ["?role=admin&organizationId=forged", ""]) {
      const response = await app.inject({ method: "DELETE", url: `/v1/local-data/projects/project-1${suffix}`, headers: { ...authenticatedHeaders(), "x-user-role": "admin" } });
      assert.equal(response.statusCode, suffix ? 400 : organizationId === principal.organizationId ? 200 : 403);
    }
    assert.equal(calls.count, organizationId === principal.organizationId ? 1 : 0);
  }
});

test("project deletion uses canonical team ownership before legacy bindings", async t => {
  const principal = adminPrincipal();
  for (const scenario of [
    { team: principal.organizationId, legacy: null, allowed: true },
    { team: principal.organizationId, legacy: "foreign-org", allowed: true },
    { team: "foreign-org", legacy: principal.organizationId, allowed: false },
    { team: "foreign-org", legacy: null, allowed: false },
  ]) {
    let legacyReads = 0;
    const deps = createDefaultLocalDataBridgeDeps({
      findProjectById: async (id: string) => {
        assert.equal(id, project.id);
        return { id, organizationId: scenario.team };
      },
      findLegacyProjectOwnerBinding: async () => {
        legacyReads += 1;
        return scenario.legacy ? { organizationId: scenario.legacy } : null;
      },
    } as never);
    const calls = { count: 0 };
    const app = buildAgentApp({ env: authenticatedLocalEnv(), authConfig, authService: authService(principal),
      localDataBridgeDeps: { ...countingDeps(calls), authorizeProjectDeletion: deps.authorizeProjectDeletion } });
    t.after(() => app.close());
    const response = await app.inject({ method: "DELETE", url: `/v1/local-data/projects/${project.id}`, headers: authenticatedHeaders() });
    assert.equal(response.statusCode, scenario.allowed ? 200 : 403);
    assert.equal(calls.count, scenario.allowed ? 1 : 0);
    assert.equal(legacyReads, 0, "canonical project ownership must be authoritative");
    assert.equal(await deps.authorizeProjectDeletion!(memberPrincipal(), project.id), false);
  }
});

test("canonical project deletion does not require the legacy binding repository", async () => {
  const principal = adminPrincipal();
  const deps = createDefaultLocalDataBridgeDeps({
    findProjectById: async () => ({ id: project.id, organizationId: principal.organizationId }),
  } as never);
  assert.equal(await deps.authorizeProjectDeletion!(principal, project.id), true);
  assert.equal(await createDefaultLocalDataBridgeDeps().authorizeProjectDeletion!(principal, project.id), false);
});

test("unauthenticated and spoofed member deletion never reaches storage", async t => {
  for (const principal of [null, memberPrincipal()]) {
    const calls = { count: 0 };
    const app = buildAgentApp({ env: authenticatedLocalEnv(), authConfig, authService: authService(principal),
      localDataBridgeDeps: { ...countingDeps(calls), authorizeProjectDeletion: async () => true } });
    t.after(() => app.close());
    const response = await app.inject({ method: "DELETE", url: "/v1/local-data/projects/project-1?role=admin",
      headers: { ...authenticatedHeaders(), "x-user-role": "admin", "content-type": "application/json" }, payload: { role: "admin" } });
    assert.equal(response.statusCode, principal ? 403 : 401);
    assert.equal(calls.count, 0);
  }
});


test("project HTTP pagination validates input and scopes favorites to the authenticated team", async t => {
  const deps = fakeDeps();
  deps.fetchProjects = async () => Array.from({ length: 23 }, (_, i) => ({ ...project, id: `project-${String(i).padStart(2, "0")}` }));
  deps.listFavoriteProjectIds = organizationId => { assert.equal(organizationId, memberPrincipal().organizationId); return ["project-22"]; };
  const app = buildAgentApp({ env: authenticatedLocalEnv(), authConfig, authService: authService(memberPrincipal()), localDataBridgeDeps: deps });
  t.after(() => app.close());
  const result = await app.inject({ method: "GET", url: "/v1/local-data/projects?kind=analysis&page=2&pageSize=10", headers: authenticatedHeaders() });
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.json().projects.length, 10); assert.equal(result.json().projects[0].id, "project-10");
  assert.equal(result.json().pagination.total, 23);
  const favorites = await app.inject({ method: "GET", url: "/v1/local-data/projects?kind=analysis&page=9&view=favorites", headers: authenticatedHeaders() });
  assert.equal(favorites.statusCode, 200, favorites.body);
  assert.equal(favorites.json().projects[0].id, "project-22"); assert.equal(favorites.json().pagination.page, 1);
  const sorted = await app.inject({ method: "GET", url: "/v1/local-data/projects?sort=created_asc&page=2&pageSize=10", headers: authenticatedHeaders() });
  assert.equal(sorted.statusCode, 200, sorted.body);
  assert.equal(sorted.json().pagination.page, 2);
  const invalidSort = await app.inject({ method: "GET", url: "/v1/local-data/projects?sort=invalid", headers: authenticatedHeaders() });
  assert.equal(invalidSort.statusCode, 400);
  const invalid = await app.inject({ method: "GET", url: "/v1/local-data/projects?pageSize=500", headers: authenticatedHeaders() });
  assert.equal(invalid.statusCode, 400);
});
