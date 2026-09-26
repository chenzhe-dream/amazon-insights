import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer, type ViteDevServer } from "vite";
import type { ManualAlexaVocRecord } from "../../shared/agent-contracts";
import type { ExportModuleContext } from "../../app/project-export/export-module-context";
import { readPageSnapshotDefinition } from "../../app/project-export/read-page-snapshot-definition";
import type { PageSnapshotChecklist as View } from "../../app/project-export/page-snapshot-checklist";

let server: ViteDevServer;
let PageSnapshotChecklist: typeof View;
let SnapshotPresentationProvider: typeof import("../../app/project-report-views/snapshot-presentation")["SnapshotPresentationProvider"];
before(async () => {
  server = await createServer({ configFile: false, server: { middlewareMode: true }, cacheDir: "test-results/page-snapshot-checklist-vite" });
  ({ PageSnapshotChecklist } = await server.ssrLoadModule("/app/project-export/page-snapshot-checklist.tsx"));
  ({ SnapshotPresentationProvider } = await server.ssrLoadModule("/app/project-report-views/snapshot-presentation.tsx"));
});
after(async () => { await server?.close(); });

const asin = "B000000001";
const manual: ManualAlexaVocRecord = { asin, marketplace: "US", revision: "2", contentHash: "a".repeat(64), source: "postgres", generation: null,
  capturedAt: "2026-09-24T10:00:00.000Z", normalizedRecord: { asin, captureStatus: "dialog", attention: ["1. 关注操控体验"],
    positives: ["【易于操控】35%：孩子可以轻松转向"], negatives: ["【轮胎磨损】20%：需改进寿命"], unmet: ["1. 可替换轮胎"],
    audiences: ["儿童｜需要成人看护"], scenarios: ["庭院｜平整路面"], motives: ["生日礼物｜★★★★★｜有趣体验"],
    alexaReport: { asin, title: "儿童漂移车", rating: 4.5, reviewCount: 80, prompt: "七问", overallConclusion: "原始完整结论" } } };
const product = { asin, brand: "原品牌", title: "儿童漂移车", price: 99, sales: 100, rating: 4.5, reviews: 80, rankCategory: "Toys & Games", productFamily: "generic" };
function context(): ExportModuleContext {
  return { projectId: "p", organizationId: "o", marketplace: "US", asins: [asin], sourceAsins: [asin], currentRunId: null,
    capturedAt: "2026-09-24T10:00:00.000Z", sharedReads: new Map(),
    version: { marketplace: "US", catalog: [{ ...product }], stageOutputs: {} } } as unknown as ExportModuleContext;
}
function reader(records: ManualAlexaVocRecord[] = [manual]) {
  const calls: string[] = [];
  return { calls, read: async (path: string, init?: RequestInit) => {
    assert.ok(!init?.method || init.method === "GET");
    assert.ok(path.startsWith("/api/alexa-voc?"), path); calls.push(path);
    return Response.json({ records });
  } };
}
const render = (data: Awaited<ReturnType<typeof readPageSnapshotDefinition>>) =>
  renderToStaticMarkup(<SnapshotPresentationProvider><PageSnapshotChecklist {...data} /></SnapshotPresentationProvider>);

test("frozen checklist renders all ten original sections and seeded price plus commission synchronously", async () => {
  const { read, calls } = reader();
  const html = render(await readPageSnapshotDefinition(context(), read));
  for (const number of ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"]) {
    assert.match(html, new RegExp(`第${number}部分`));
  }
  assert.equal((html.match(/class="launch-checklist-section-block"/g) ?? []).length, 10);
  assert.match(html, /调研数据回填（系统已抓取）/);
  assert.match(html, /value="\$104\.99"/);
  assert.match(html, /\$15\.75/);
  assert.match(html, /15%/);
  assert.equal(calls.length, 2);
});

test("manual items remain unchecked and read-only with one unsaved notice and no actions", async () => {
  const html = render(await readPageSnapshotDefinition(context(), reader().read));
  assert.equal(html.split("未包含其他页面未保存的人工填写与勾选").length - 1, 1);
  assert.match(html, /<input[^>]*type="checkbox"[^>]*disabled/);
  assert.match(html, /<input[^>]*class="launch-checklist-field-input is-inline"[^>]*readOnly/);
  assert.doesNotMatch(html, /<input[^>]*type="checkbox"[^>]*checked/);
  assert.doesNotMatch(html, /下载清单|保存到项目确认清单|合规专利硬门槛|完整十项清单<\/button>|role="tab"|导出时会合并系统值与人工输入/);
  assert.doesNotMatch(html, /<button|<script/);
});

test("missing catalog keeps numeric fields unknown and generic; absent inputs have concise pending copy", async () => {
  const missing = context(); missing.version!.catalog.splice(0);
  const data = await readPageSnapshotDefinition(missing, reader([]).read);
  assert.equal(data.analysisInputs!.products[0].productFamily, "generic");
  assert.equal(data.analysisInputs!.products[0].price, null);
  const html = render(data);
  assert.match(html, /商品资料缺失/);
  assert.match(html, /当前来源尚不足以生成完整确认清单/);
  assert.doesNotMatch(html, /\$0\.00/);
  const absent = render(await readPageSnapshotDefinition({ ...context(), version: null }, reader().read));
  assert.match(absent, /暂无已有分析输入/);
  assert.equal(absent.split("未包含其他页面未保存的人工填写与勾选").length - 1, 1);
});
