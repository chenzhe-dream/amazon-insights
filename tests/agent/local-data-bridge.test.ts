import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { AnalysisProject } from "../../app/lib/project-server";
import type { AsinModuleStatus, SyncJob } from "../../app/lib/sync-server";
import { buildAgentApp } from "../../server/app";
import type { LocalDataBridgeDeps } from "../../server/routes/local-data";

const trustedOrigin = "http://127.0.0.1:31900";
const proxyToken = "local-ui-token";
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
  listing: "ready",
  imageRemarks: "ready",
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
    AGENT_SERVICE_TRUSTED_ORIGINS: trustedOrigin,
    AGENT_VOC_LOCAL_FAKE: "1",
    ...overrides,
  };
}

function headers() {
  return { origin: trustedOrigin, "x-agent-proxy-token": proxyToken };
}

function fakeDeps(): LocalDataBridgeDeps {
  return {
    async fetchProjects() { return [project]; },
    async fetchProject(id) { return id === project.id ? project : null; },
    async createAnalysisProject() { return project; },
    async updateAnalysisProject(id) { return id === project.id ? project : null; },
    async deleteAnalysisProject(id) { return id === project.id; },
    async normalizeAsins(values) {
      return Array.isArray(values) && values.every(value => value === asin) ? [asin] : null;
    },
    async fetchAsinDataStatus() { return [status]; },
    async startAsinSyncJob() {
      return { job, mcpAsinsPending: [], estimatedAutoSeconds: 0, estimatedAlexaSeconds: 0 };
    },
    async readJob(id) { return id === job.jobId ? job : null; },
  };
}

test("local fake bridge adapts legacy project and sync operations over Agent HTTP", async (t) => {
  const app = buildAgentApp({ env: localEnv(), localDataBridgeDeps: fakeDeps() });
  t.after(() => app.close());

  const list = await app.inject({ method: "GET", url: "/v1/local-data/projects?kind=analysis", headers: headers() });
  assert.equal(list.statusCode, 200);
  assert.deepEqual(list.json(), { projects: [project] });

  const created = await app.inject({ method: "POST", url: "/v1/local-data/projects", headers: { ...headers(), "content-type": "application/json" }, payload: { kind: "analysis", name: project.name, marketplace: "US", asins: projectAsins } });
  assert.equal(created.statusCode, 201);
  assert.deepEqual(created.json(), { project });

  const read = await app.inject({ method: "GET", url: "/v1/local-data/projects/project-1", headers: headers() });
  assert.equal(read.statusCode, 200);
  assert.deepEqual(read.json(), { project });

  const updated = await app.inject({ method: "PATCH", url: "/v1/local-data/projects/project-1", headers: { ...headers(), "content-type": "application/json" }, payload: { name: "Renamed" } });
  assert.equal(updated.statusCode, 200);
  assert.deepEqual(updated.json(), { project });

  const deleted = await app.inject({ method: "DELETE", url: "/v1/local-data/projects/project-1", headers: headers() });
  assert.equal(deleted.statusCode, 200);
  assert.deepEqual(deleted.json(), { ok: true });

  const readiness = await app.inject({ method: "GET", url: `/v1/local-data/sync-asins?asins=${asin}`, headers: headers() });
  assert.equal(readiness.statusCode, 200);
  assert.deepEqual(readiness.json(), { asins: [asin], items: [status], needsSync: false, vocPending: [], catalogPending: [] });

  const started = await app.inject({ method: "POST", url: "/v1/local-data/sync-asins", headers: { ...headers(), "content-type": "application/json" }, payload: { asins: [asin], marketplace: "US" } });
  assert.equal(started.statusCode, 202);
  assert.deepEqual(started.json(), { jobId: job.jobId, status: job.status, message: job.message, mcpAsinsPending: [], estimatedAutoSeconds: 0, estimatedAlexaSeconds: 0, stages: [] });

  const polled = await app.inject({ method: "GET", url: "/v1/local-data/sync-asins/job-1", headers: headers() });
  assert.equal(polled.statusCode, 200);
  assert.deepEqual(polled.json(), job);
});

test("local bridge rejects invalid input, missing records, and non-local registration", async (t) => {
  const app = buildAgentApp({ env: localEnv(), localDataBridgeDeps: fakeDeps() });
  const withoutFake = buildAgentApp({ env: localEnv({ AGENT_VOC_LOCAL_FAKE: undefined }) });
  t.after(async () => { await app.close(); await withoutFake.close(); });

  const invalid = await app.inject({ method: "POST", url: "/v1/local-data/sync-asins", headers: { ...headers(), "content-type": "application/json" }, payload: { asins: ["bad"], marketplace: "US" } });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().error.code, "VALIDATION_ERROR");

  const missingProject = await app.inject({ method: "GET", url: "/v1/local-data/projects/missing", headers: headers() });
  assert.equal(missingProject.statusCode, 404);
  const missingJob = await app.inject({ method: "GET", url: "/v1/local-data/sync-asins/missing", headers: headers() });
  assert.equal(missingJob.statusCode, 404);

  const absent = await withoutFake.inject({ method: "GET", url: "/v1/local-data/projects?kind=analysis", headers: headers() });
  assert.equal(absent.statusCode, 404);
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
