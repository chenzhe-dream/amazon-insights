import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalRuleReportHandlers } from "../../app/lib/local-rule-report-server";
import { createLocalRuleReportStore, assertLocalRuleReportIntegrity } from "../../server/services/local-rule-report-store";
import type { AgentServiceClient, AgentServiceRequest } from "../../app/lib/agent-service-client";
import type { LocalRuleReport } from "../../shared/local-rule-report";
import { buildProductStructureCacheKey } from "../../shared/product-structure-rules";
import { canonicalizeProductDefinitionOutput, type ProductDefinitionInput } from "../../server/domain/product/product-definition-contracts";

const projectId = "10000000-0000-4000-8000-000000000001", organizationId = "10000000-0000-4000-8000-000000000002", userId = "10000000-0000-4000-8000-000000000003";
const asins = ["B000000001", "B000000002", "B000000003"], date = "2026-09-16T00:00:00.000Z";
const user = { id: userId, organizationId, email: "test@example.com", displayName: "test", role: "member", status: "active", createdAt: date, updatedAt: date };
const project = { id: projectId, organizationId, name: "test", marketplace: "US", asins, createdBy: userId, currentRunId: null, createdAt: date, updatedAt: date };
const products = asins.map(asin => ({ asin, brand: "Test", title: "Snow scooter with skis, no wheels", subRankCategory: "Snow scooters" }));
const body = { projectId, asins, products, reviewFallback: false };
function post(value: unknown) { return new Request("http://app.local/api/local-rule-reports", { method: "POST", headers: { origin: "http://app.local", "content-type": "application/json" }, body: JSON.stringify(value) }); }
function get() { return new Request(`http://app.local/api/local-rule-reports?${new URLSearchParams({ projectId, asins: asins.join(",") })}`); }
function client(options: { org?: string; hidden?: boolean; deny?: boolean; revision?: string } = {}) {
  return (async (request: AgentServiceRequest) => {
    let value: unknown;
    if (request.path === "/v1/auth/session") value = { authenticated: true, user: { ...user, organizationId: options.org ?? organizationId }, sessionIdentity: "a".repeat(43), visibleModules: options.hidden ? ["overview"] : ["definition"] };
    else if (request.path.startsWith("/v1/projects/")) {
      if (options.deny) return { status: 403, body: { error: "denied" }, headers: new Headers() };
      value = { project };
    } else value = { records: asins.map(asin => ({ asin, marketplace: "US", revision: options.revision ?? "1", contentHash: (options.revision ?? "1").repeat(64), source: "postgres", generation: null, capturedAt: date,
      normalizedRecord: { asin, attention: ["滑雪时保持稳定"], positives: ["雪地滑行顺畅"], negatives: ["脚踏容易打滑"], unmet: ["改善防滑脚踏"], audiences: ["成人"], scenarios: ["雪地滑行"], motives: ["户外娱乐"], captureStatus: "dialog", alexaReport: { title: "评价分析", asin, rating: 4, reviewCount: 20, prompt: "seven questions", overallConclusion: "改善防滑", captureStatus: "dialog" } } })) };
    return { status: 200, body: value, headers: new Headers() };
  }) as AgentServiceClient;
}

test("A14 AI report canonicalization never fabricates or accepts model-supplied rule history", () => {
  const input = { voc: { reportId: projectId, version: 1 }, keywords: { snapshotId: userId, contentHash: "1".repeat(64) }, dataCutoffAt: date } as ProductDefinitionInput;
  const output = canonicalizeProductDefinitionOutput({ ruleTrace: { ruleSetVersion: "invented" }, ruleSetVersion: "invented", ruleDefinitions: [] }, input) as Record<string, unknown>;
  assert.equal(output.ruleTrace, undefined);
  assert.equal(output.ruleSetVersion, undefined);
  assert.equal(output.ruleDefinitions, undefined);
});

test("A11 rule cache identity isolates every analysis dimension and normalizes ASIN order", () => {
  const scope = { organizationId, projectId, marketplace: "US", asins, inputRevision: "1" };
  const original = buildProductStructureCacheKey(scope, "v1");
  assert.equal(original, buildProductStructureCacheKey({ ...scope, asins: [...asins].reverse() }, "v1"));
  for (const changed of [{ organizationId: "other" }, { projectId: "other" }, { marketplace: "CA" }, { asins: [asins[0]] }, { inputRevision: "2" }]) assert.notEqual(original, buildProductStructureCacheKey({ ...scope, ...changed }, "v1"));
  assert.notEqual(original, buildProductStructureCacheKey(scope, "v2"));
});

test("A14 saves and reopens original server-generated result and version without current reevaluation", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-rule-report-"));
  try {
    const store = createLocalRuleReportStore(root);
    const handlers = createLocalRuleReportHandlers({ store, client: client() });
    const response = await handlers.POST(post(body));
    assert.equal(response.status, 201, JSON.stringify(await response.clone().json()));
    const { report } = await response.json() as { report: LocalRuleReport };
    assert.equal(report.products[0].title, products[0].title);
    assert.match(report.inputSourceNote, /页面输入/);
    assert.ok(report.analysis.positivePriorityRows.length);
    assert.ok(report.analysis.ruleTrace?.decisions.length);
    const reopened = await createLocalRuleReportHandlers({ store, client: client({ revision: "2" }) }).GET(get());
    const historical = (await reopened.json()).reports[0] as LocalRuleReport;
    assert.equal(historical.sourceAvailability?.state, "historical");
    assert.deepEqual(historical.analysis.ruleTrace?.decisions, report.analysis.ruleTrace?.decisions);
    assert.deepEqual(historical.analysis.ruleTrace?.ruleDefinitions, report.analysis.ruleTrace?.ruleDefinitions);
    assert.deepEqual(historical.analysis.positivePriorityRows, report.analysis.positivePriorityRows);
    assert.equal(historical.analysis.ruleTrace?.sources.some(source => source.kind === "voc"), false);
    assert.equal((await store.list("other-org", projectId, asins)).length, 0);
    assert.equal((await store.list(organizationId, "other-project", asins)).length, 0);
    assert.equal((await store.list(organizationId, projectId, [asins[0]])).length, 0);
    const historic = structuredClone(report);
    historic.id = "historic-snapshot";
    historic.ruleSetVersion = "historic/v0";
    for (const trace of [historic.analysis.ruleTrace, historic.finalDefinition.ruleTrace]) {
      if (!trace) continue;
      trace.ruleSetVersion = historic.ruleSetVersion;
      trace.ruleDefinitions.forEach(rule => { rule.version = "old"; rule.name = "生成时规则说明"; });
      trace.decisions.forEach(decision => { decision.ruleSetVersion = historic.ruleSetVersion; Object.keys(decision.ruleVersions).forEach(id => decision.ruleVersions[id] = "old"); });
      trace.sources = []; // A15 references can outlive available source excerpts.
    }
    await store.save(historic);
    assert.deepEqual((await store.list(organizationId, projectId, asins)).find(r => r.id === historic.id), historic);
    const legacy = structuredClone(report);
    legacy.id = "legacy-no-trace";
    delete legacy.analysis.ruleTrace; delete legacy.finalDefinition.ruleTrace;
    await store.save(legacy);
    const old = (await store.list(organizationId, projectId, asins)).find(r => r.id === legacy.id)!;
    assert.equal(old.analysis.ruleTrace, undefined);
    const foreign = structuredClone(report);
    foreign.analysis.ruleTrace!.sources.push({ id: "foreign", text: "hidden", kind: "voc", scope: "asin", asin: "B999999999" });
    assert.throws(() => assertLocalRuleReportIntegrity(foreign), /source scope/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("A15 actual VOC deletion or denied read hides saved excerpts across nested traces without changing disk snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-rule-report-delete-"));
  try {
    const store = createLocalRuleReportStore(root), base = client();
    const response = await createLocalRuleReportHandlers({ store, client: base }).POST(post(body));
    const original = (await response.json()).report as LocalRuleReport;
    assert.ok(original.analysis.ruleTrace?.sources.some(source => source.kind === "voc"));
    for (const status of [200, 403, 503]) {
      const unavailableClient = (async (request: AgentServiceRequest) => request.path.startsWith("/v1/manual-alexa-voc?") ? { status, body: status === 200 ? { records: [] } : { error: "unavailable" }, headers: new Headers() } : base(request)) as AgentServiceClient;
      const result = await createLocalRuleReportHandlers({ store, client: unavailableClient }).GET(get());
      const visible = (await result.json()).reports[0] as LocalRuleReport;
      assert.equal(visible.sourceAvailability?.state, "unavailable");
      assert.deepEqual(visible.analysis.ruleTrace?.decisions, original.analysis.ruleTrace?.decisions);
      assert.equal(visible.ruleSetVersion, original.ruleSetVersion);
      for (const trace of [visible.analysis.ruleTrace, visible.analysis.vocPositioning.ruleTrace, visible.finalDefinition.ruleTrace]) {
        assert.equal(trace?.sources.some(source => source.kind === "voc"), false);
        assert.equal(trace?.contexts?.some(context => [...context.evidence, ...context.needs].some(source => source.kind === "voc")), false);
      }
      assert.deepEqual((await store.list(organizationId, projectId, asins))[0], original);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("failed or partial stage HTTP 200 never saves a silently incomplete analysis", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-rule-report-gap-"));
  try {
    const store = createLocalRuleReportStore(root), base = client(), runId = "10000000-0000-4000-8000-000000000004";
    for (const stageStatus of ["failed", "partial"] as const) {
      const scopedClient = (async (request: AgentServiceRequest) => {
        if (request.path === `/v1/runs/${runId}`) return { status: 200, headers: new Headers(), body: { run: { id: runId, projectId, mode: "existing-data", status: "succeeded", createdBy: userId, dataCutoffAt: date, createdAt: date, updatedAt: date }, stages: [] } };
        if (request.path.includes("/stages/keywords/output")) return { status: 200, headers: new Headers(), body: { projectId, runId, jobId: "gap-job", stage: "keywords", stageStatus, jobVersion: 1, outputVersion: 1, contentHash: "a".repeat(64), updatedAt: date, gap: { state: stageStatus, reasonCode: "UPSTREAM_EMPTY" }, ...(stageStatus === "partial" ? { data: { analysisByAsin: {}, enrichmentByKeyword: {} } } : {}) } };
        return base(request);
      }) as AgentServiceClient;
      const response = await createLocalRuleReportHandlers({ store, client: scopedClient }).POST(post({ ...body, baseSyncRunId: runId, jobId: "gap-job" }));
      assert.equal(response.status, 422);
      assert.match((await response.json()).error, /不完整|失败/);
      assert.deepEqual(await store.list(organizationId, projectId, asins), []);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("A15 saved scoped stage binding is rechecked after upstream artifact deletion", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-rule-report-stage-delete-"));
  try {
    const store = createLocalRuleReportStore(root), base = client(), runId = "10000000-0000-4000-8000-000000000004";
    let removed = false;
    const scopedClient = (async (request: AgentServiceRequest) => {
      if (request.path === `/v1/runs/${runId}`) return { status: 200, headers: new Headers(), body: { run: { id: runId, projectId, mode: "existing-data", status: "succeeded", createdBy: userId, dataCutoffAt: date, createdAt: date, updatedAt: date }, stages: [] } };
      if (request.path.includes("/stages/keywords/output")) return removed ? { status: 404, body: { error: "artifact deleted" }, headers: new Headers() } : { status: 200, headers: new Headers(), body: { projectId, runId, jobId: "done-job", stage: "keywords", stageStatus: "done", jobVersion: 1, outputVersion: 1, contentHash: "a".repeat(64), updatedAt: date, data: { analysisByAsin: {}, enrichmentByKeyword: {} } } };
      return base(request);
    }) as AgentServiceClient;
    const handlers = createLocalRuleReportHandlers({ store, client: scopedClient });
    const response = await handlers.POST(post({ ...body, baseSyncRunId: runId, jobId: "done-job" }));
    assert.equal(response.status, 201);
    const original = (await response.json()).report as LocalRuleReport;
    assert.equal(original.sourceBindings?.stages[0]?.jobId, "done-job");
    removed = true;
    const reopened = (await (await handlers.GET(get())).json()).reports[0] as LocalRuleReport;
    assert.equal(reopened.sourceAvailability?.state, "unavailable");
    assert.deepEqual(reopened.analysis.ruleTrace?.decisions, original.analysis.ruleTrace?.decisions);
    assert.deepEqual((await store.list(organizationId, projectId, asins))[0], original);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("A15 report endpoints reuse session, module, organization and project authorization", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-rule-report-auth-"));
  try {
    const store = createLocalRuleReportStore(root);
    for (const options of [{ hidden: true }, { org: "10000000-0000-4000-8000-000000000099" }, { deny: true }]) {
      const handlers = createLocalRuleReportHandlers({ store, client: client(options) });
      assert.equal((await handlers.GET(get())).status, 403);
      assert.equal((await handlers.POST(post(body))).status, 403);
    }
    const handlers = createLocalRuleReportHandlers({ store, client: client() });
    assert.equal((await handlers.POST(post({ ...body, products: [...products, { asin: "B999999999", brand: "foreign" }] }))).status, 403);
    assert.equal((await handlers.POST(post({ ...body, ruleTrace: { ruleSetVersion: "forged" } }))).status, 400);
    assert.equal((await handlers.POST(new Request("http://app.local/api/local-rule-reports", { method: "POST", body: JSON.stringify(body) }))).status, 403);
    assert.deepEqual(await store.list(organizationId, projectId, asins), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("A15 expired scoped stage sources fail explicitly instead of borrowing global artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-rule-report-source-"));
  try {
    const base = client(), runId = "10000000-0000-4000-8000-000000000004";
    const scopedClient = (async (request: AgentServiceRequest) => {
      if (request.path === `/v1/runs/${runId}`) return { status: 404, body: { error: "source unavailable" }, headers: new Headers() };
      return base(request);
    }) as AgentServiceClient;
    const store = createLocalRuleReportStore(root);
    const response = await createLocalRuleReportHandlers({ store, client: scopedClient }).POST(post({ ...body, baseSyncRunId: runId, jobId: "expired-job" }));
    assert.equal(response.status, 404);
    assert.deepEqual(await store.list(organizationId, projectId, asins), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

