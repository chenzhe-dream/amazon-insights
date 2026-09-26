import { readPageSnapshotSources as readExportContent } from "../../app/project-export/read-page-snapshot-sources";
import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyExportEligibility, type ExportRequest } from "../../app/project-export/read-export-content";
import { exportOrganizationId, exportProjectFixture, exportSessionFixture, exportSessionIdentity, exportVersionFixture, exportSourceProjectFixture, exportTranslationFixture } from "./helpers/project-export-fixture";

function fixture() {
  const state = { project: exportProjectFixture(), session: exportSessionFixture(), version: exportVersionFixture(),
    favorite: true, versionStatus: 200, calls: [] as string[] };
  const fetcher = async (path: string, init?: RequestInit) => {
    assert.ok(!init?.method || init.method === "GET");
    init?.signal?.throwIfAborted();
    state.calls.push(path);
    if (path === "/v1/auth/session") return Response.json(state.session);
    if (path === "/v1/local-data/project-favorites") return Response.json({ projectIds: state.favorite ? [state.project.id] : [] });
    if (path === `/v1/local-data/projects/${state.project.id}`) return Response.json({ project: state.project });
    if (path === `/v1/projects/${state.project.sourceProjectId}`) return Response.json({ project: exportSourceProjectFixture() });
    if (path.includes("/selling-point-translations/")) return Response.json(exportTranslationFixture(new URL(path, "http://test").pathname.split("/").at(-1)!));
    if (path === `/v1/local-data/projects/${state.project.sourceProjectId}/current-display-version`) {
      return state.versionStatus === 404 ? Response.json({ error: { code: "PROJECT_REPORT_NOT_PUBLISHED", message: "missing", requestId: "test" } }, {status:404})
        : Response.json(state.version, { status: state.versionStatus });
    }
    throw new Error("Unexpected endpoint: " + path);
  };
  const request: ExportRequest = { sessionIdentity: exportSessionIdentity, organizationId: exportOrganizationId,
    libraryProjectId: state.project.id, moduleIds: ["competitor-overview"], signal: new AbortController().signal };
  return { state, fetcher, request };
}
test("export follows explicit source binding and freezes results with GET only", async () => {
  const { state, request, fetcher } = fixture();
  const content = await readExportContent(request, fetcher);
  assert.equal(content.project.id, state.project.id);
  assert.equal(content.sourceProjectId, state.project.sourceProjectId);
  assert.equal(content.moduleIds[0], "competitor-overview");
  const frozen = JSON.stringify(content);
  state.version.catalog[0].title = "线上后来修改";
  assert.equal(JSON.stringify(content), frozen);
  assert.ok(state.calls.some(path => path.includes(state.project.sourceProjectId + "/current-display-version")));
  assert.ok(!state.calls.some(path => path.includes("/sync-asins") || path.includes("/runs")));
  const count = state.calls.length;
  await verifyExportEligibility(request, content, fetcher);
  assert.ok(!state.calls.slice(count).some(path => path.endsWith("/current-display-version")), "download verification must not refresh body");
});
test("cross-project scope and read failures cannot become missing data", async () => {
  const { state, request, fetcher } = fixture();
  state.version.projectId = "99999999-9999-4999-8999-999999999999";
  await assert.rejects(readExportContent(request, fetcher), /范围|匹配/);
  state.version = exportVersionFixture(); state.versionStatus = 500;
  await assert.rejects(readExportContent(request, fetcher), /失败/);
  state.versionStatus = 404;
  const content = await readExportContent(request, fetcher);
  assert.equal(content.overview, null);
  assert.match(JSON.stringify(content), /暂无已发布/);
});
test("unknown modules, hidden modules, session mismatch, removed favorites and cancellation reject", async () => {
  const { state, request, fetcher } = fixture();
  await assert.rejects(readExportContent({...request, moduleIds: []},fetcher), /选择/);
  await assert.rejects(readExportContent({...request, moduleIds: ["voc"]},fetcher), /接入|权限/);
  state.session.visibleModules = [];
  await assert.rejects(readExportContent(request,fetcher), /权限/);
  state.session = exportSessionFixture(); state.session.sessionIdentity = "t".repeat(43);
  await assert.rejects(readExportContent(request,fetcher), /登录|会话/);
  state.session = exportSessionFixture(); state.favorite = false;
  await assert.rejects(readExportContent(request,fetcher), /收藏/);
  await assert.rejects(readExportContent({...request,signal:AbortSignal.abort()},fetcher), /abort/i);
});

test("download invalidates changed project scope without refreshing frozen report", async () => {
  const { state, request, fetcher } = fixture();
  const content = { ...await readExportContent(request, fetcher), project: {
    ...state.project, asins: [...state.project.asins, "B000000004"],
  } };
  await assert.rejects(verifyExportEligibility(request, content, fetcher), /来源已变化/);
});

test("catalog, listing and category sources cannot cross marketplace or ASIN scope", async () => {
  const {state,request,fetcher}=fixture();
  Object.assign(state.version.catalog[0],{marketplace:"UK"});
  await assert.rejects(readExportContent(request,fetcher),/来源范围不匹配/);
  state.version=exportVersionFixture();
  const v=state.version;
  const stage=(name:string,data:unknown)=>({stage:name,stageStatus:"done",data,projectId:v.projectId,runId:v.runId,jobId:v.jobId,
    jobVersion:1,outputVersion:1,contentHash:"c".repeat(64),updatedAt:v.publishedAt});
  Object.assign(state.version.stageOutputs,{listing:stage("listing",{contentByAsin:{[state.project.asins[0]]:{asin:"B099999999",marketplace:"US",mainImage:"https://example.com/other.jpg"}}})});
  await assert.rejects(readExportContent(request,fetcher),/来源范围不匹配/);
  state.version=exportVersionFixture();
  Object.assign(state.version.stageOutputs,{category:stage("category",{trendByNode:{other:{nodeId:"other",marketplace:"UK",status:"ready",asins:state.project.asins}}})});
  await assert.rejects(readExportContent(request,fetcher),/站点不匹配/);
});

test("optional translation failures retain snapshot originals; mismatched originals still fail", async () => {
  const { request, fetcher } = fixture();
  let mode = "configuration";
  const read = (path: string, init?: RequestInit) => {
    if (!path.includes("/selling-point-translations/")) return fetcher(path, init);
    if (mode === "mismatch") return Promise.resolve(Response.json({
      ...exportTranslationFixture(new URL(path, "http://test").pathname.split("/").at(-1)!), original: ["属于另一次同步的卖点"],
    }));
    return Promise.resolve(Response.json({error:{code: mode === "configuration" ? "CONFIGURATION_ERROR" : "INFRASTRUCTURE_ERROR",
      message:"翻译服务不可用"}},{status:503}));
  };
  assert.match(JSON.stringify(await readExportContent(request, read)), /翻译服务尚未配置/);
  mode = "temporary";
  assert.match(JSON.stringify(await readExportContent(request, read)), /保留已有原文/);
  mode = "mismatch";
  await assert.rejects(readExportContent(request, read), /原文不匹配/);
});

test('selling translation reads pin the preview report version and preserve every original on missing translation', async () => {
  const { state, request, fetcher } = fixture();
  Object.assign(state.version.catalog[0], { listingBullets: ['Original one', 'Original two'] });
  const read = async (path: string, init?: RequestInit) => {
    if (!path.includes('/selling-point-translations/')) return fetcher(path, init);
    const url = new URL(path, 'http://test');
    assert.equal(url.searchParams.get('versionId'), state.version.versionId);
    const asin = url.pathname.split('/').at(-1)!;
    return Response.json({ ...exportTranslationFixture(asin), state: 'missing',
      ...(asin === state.project.asins[0] ? { original: ['Original one', 'Original two'], sourceComplete: true } : {}) });
  };
  const text = JSON.stringify(await readExportContent(request, read));
  assert.match(text, /Original one/); assert.match(text, /Original two/);
});

test("changed mutable translations and revoked session during preparation invalidate the result", async () => {
  const { state, request, fetcher } = fixture();
  let count = 0;
  const changing = (path: string, init?: RequestInit) => {
    if (!path.includes("/selling-point-translations/")) return fetcher(path, init);
    count++;
    return Promise.resolve(Response.json({ ...exportTranslationFixture(new URL(path, "http://test").pathname.split("/").at(-1)!),
      sourceHash: count > state.project.asins.length ? "new" : "old",
    }));
  };
  await assert.rejects(readExportContent(request, changing), /读取期间变化/);
  const revoked = async (path: string, init?: RequestInit) => {
    const response = await fetcher(path, init);
    if (path.endsWith("/current-display-version")) state.session.visibleModules = [];
    return response;
  };
  await assert.rejects(readExportContent(request, revoked), /权限/);
});
