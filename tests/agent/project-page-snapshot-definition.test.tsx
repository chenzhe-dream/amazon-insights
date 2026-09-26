import assert from "node:assert/strict";
import test, {before, after} from "node:test";
import {renderToStaticMarkup} from "react-dom/server";
import {createServer, type ViteDevServer} from "vite";
import type {ManualAlexaVocRecord} from "../../shared/agent-contracts";
import type {ExportModuleContext} from "../../app/project-export/export-module-context";
import {readPageSnapshotDefinition} from "../../app/project-export/read-page-snapshot-definition";
import {buildProductLaunchAnalysis, hasProductLaunchAnalysis} from "../../app/product-launch-analysis";
import {buildFinalProductDefinition} from "../../app/final-product-definition";
import type {PageSnapshotDefinition as View} from "../../app/project-export/page-snapshot-definition";
import type {LocalProductDefinitionSection as Section} from "../../app/local-product-definition-section";

let server: ViteDevServer;
let PageSnapshotDefinition: typeof View;
let LocalProductDefinitionSection: typeof Section;
let SnapshotPresentationProvider: typeof import("../../app/project-report-views/snapshot-presentation")["SnapshotPresentationProvider"];
before(async () => {
  server = await createServer({configFile:false, server:{middlewareMode:true}, cacheDir:"test-results/page-snapshot-definition-vite"});
  ({PageSnapshotDefinition} = await server.ssrLoadModule("/app/project-export/page-snapshot-definition.tsx"));
  ({LocalProductDefinitionSection} = await server.ssrLoadModule("/app/local-product-definition-section.tsx"));
  ({SnapshotPresentationProvider} = await server.ssrLoadModule("/app/project-report-views/snapshot-presentation.tsx"));
});
after(async () => {await server?.close();});
const asin = "B000000001";
const manual: ManualAlexaVocRecord = {asin, marketplace:"US", revision:"2", contentHash:"a".repeat(64), source:"postgres", generation:null,
  capturedAt:"2026-09-24T10:00:00.000Z", normalizedRecord:{asin, captureStatus:"dialog", attention:["1. 关注操控体验"],
    positives:["【易于操控】35%：孩子可以轻松转向"], negatives:["【轮胎磨损】20%：需改进寿命"], unmet:["1. 可替换轮胎"],
    audiences:["儿童｜需要成人看护"], scenarios:["庭院｜平整路面"], motives:["生日礼物｜★★★★★｜有趣体验"],
    alexaReport:{asin,title:"儿童漂移车",rating:4.5,reviewCount:80,prompt:"七问",overallConclusion:"原始完整结论"}}};
const product = {asin,brand:"原品牌",title:"儿童漂移车",price:99,sales:100,rating:4.5,reviews:80,productFamily:"generic"};
function context(): ExportModuleContext {
  return {projectId:"p",organizationId:"o",marketplace:"US",asins:[asin],sourceAsins:[asin],currentRunId:null,
    capturedAt:"2026-09-24T10:00:00.000Z",sharedReads:new Map(),
    version:{marketplace:"US",catalog:[{...product}],stageOutputs:{}}} as unknown as ExportModuleContext;
}
function reader(records: ManualAlexaVocRecord[] = [manual]) {
  const calls: string[] = [];
  return {calls, read:async (path:string, init?:RequestInit) => {
    assert.ok(!init?.method || init.method === "GET");
    assert.ok(path.startsWith("/api/alexa-voc?"),path); calls.push(path);
    return Response.json({records});
  }};
}
const render = (data: Awaited<ReturnType<typeof readPageSnapshotDefinition>>) =>
  renderToStaticMarkup(<SnapshotPresentationProvider><PageSnapshotDefinition {...data}/></SnapshotPresentationProvider>);

test("current definition keeps all original sections, final table and native disclosure without history", async () => {
  const ctx = context(); const {read,calls} = reader();
  const data = await readPageSnapshotDefinition(ctx,read);
  assert.ok(data.analysisInputs);
  assert.equal(hasProductLaunchAnalysis(data.analysisInputs.products,data.analysisInputs.sources),true);
  const html = render(data);
  for (const label of ["1. 最终产品定义结论","2. 机会等级与决策","3. VOC 与关键词交叉验证表",
    "4. 最终产品定义表","5. 功能与配置分层","6. 关键词承接方案","7. 产品方案优先级",
    "8. 风险与下一步验证","9. 数据边界","VOC依据","关键词依据","产品动作","优先级","待验证",
    "查看完整定位原文"]) assert.ok(html.includes(label),label);
  assert.match(html,/<details/);
  assert.doesNotMatch(html, /历史已保存|返回当前分析|保存规则结果|<script/);
  assert.equal(calls.length,2);
  const frozen=JSON.stringify(data); product.brand="后来更改";
  assert.equal(JSON.stringify(data),frozen); product.brand="原品牌";
});

test("full original text, action steps and rule basis remain readable through native details", async () => {
  const data = await readPageSnapshotDefinition(context(),reader().read);
  const analysis = buildProductLaunchAnalysis(data.analysisInputs!.products,data.analysisInputs!.sources);
  const report = buildFinalProductDefinition({categoryLabel:analysis.meta.categoryLabel,productCount:analysis.meta.productCount,
    dataMonth:analysis.meta.dataMonth,vocPositioning:analysis.vocPositioning,keyword:analysis.keywordConclusions,
    priceBand:analysis.productDefinition.targetPrice,hasVocData:true});
  const longText = "完整原文末尾标记".repeat(80);
  report.oneLiner=longText;
  report.definitionRows[0].action="第一步；第二步；第三步；第四步；第五步；完整动作末尾标记";
  const html=renderToStaticMarkup(<SnapshotPresentationProvider><LocalProductDefinitionSection
    products={data.analysisInputs!.products} sources={data.analysisInputs!.sources} savedAnalysis={analysis} savedReport={report}/>
  </SnapshotPresentationProvider>);
  assert.ok(html.includes(longText));
  assert.match(html,/完整动作末尾标记/);
  assert.match(html,/<details[^>]*>[\s\S]*查看完整定位原文/);
  assert.match(html,/为什么这样判断|规则/);
});

test("shared memo uses two stable GETs; revision changes and read failures reject", async () => {
  const ctx=context(); const {read,calls}=reader();
  await readPageSnapshotDefinition(ctx,read);
  await readPageSnapshotDefinition(ctx,read);
  assert.equal(calls.length,2);
  let reads=0;
  await assert.rejects(readPageSnapshotDefinition({...ctx,sharedReads:new Map()},async()=>Response.json({records:[{...manual,revision:String(++reads)}]})),/读取期间变化/);
  await assert.rejects(readPageSnapshotDefinition({...ctx,sharedReads:new Map()},async()=>new Response("failed",{status:500})),/读取失败/);
});

test("review candidates do not opt in; missing catalog is generic with null numeric fields and clear notice", async () => {
  const ctx=context();
  ctx.version!.catalog.splice(0);
  Object.assign(ctx.version!.stageOutputs,{reviews:{stage:"reviews",stageStatus:"done",updatedAt:"2026-09-23T10:00:00.000Z",data:{
    analysisByAsin:{[asin]:{asin,marketplace:"US",sampledReviews:25,fetchedAt:"2026-09-23",status:"ready",blocks:[]}}
  }}});
  const data=await readPageSnapshotDefinition(ctx,reader([]).read);
  assert.equal(data.analysisInputs!.products[0].productFamily,"generic");
  assert.equal(data.analysisInputs!.products[0].price,null);
  assert.equal(data.analysisInputs!.products[0].sales,null);
  assert.match(render(data),/商品资料缺失/);
  assert.match(render(data),/暂无已有分析输入/);
  assert.ok(data.analysisInputs!.sources.reviewFallbackCandidates?.[asin]);
  assert.equal(data.analysisInputs!.sources.reviewAnalysisByAsin,undefined);
  assert.equal(hasProductLaunchAnalysis(data.analysisInputs!.products,data.analysisInputs!.sources),false);
});

test("no published version stays pending; wrong site, duplicate product and mismatched manual scope fail", async () => {
  const ctx=context();
  assert.match(render(await readPageSnapshotDefinition({...ctx,version:null},reader().read)),/暂无已有分析输入/);
  const wrongSite=context(); Object.assign(wrongSite.version!.catalog[0] as object,{marketplace:"UK"});
  await assert.rejects(readPageSnapshotDefinition(wrongSite,reader().read),/站点来源/);
  const duplicate=context(); duplicate.version!.catalog.push({...product});
  await assert.rejects(readPageSnapshotDefinition(duplicate,reader().read),/来源重复/);
  await assert.rejects(readPageSnapshotDefinition(context(),reader([{...manual,asin:"B000000099"}]).read),/来源范围/);
});
