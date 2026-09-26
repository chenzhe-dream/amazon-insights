import assert from "node:assert/strict";
import test, {before, after} from "node:test";
import {renderToStaticMarkup} from "react-dom/server";
import {createServer, type ViteDevServer} from "vite";
import type {ManualAlexaVocRecord} from "../../shared/agent-contracts";
import type {ExportModuleContext} from "../../app/project-export/export-module-context";
import type {Product} from "../../app/project-report-views/competitor-overview";
import {readPageSnapshotVoc} from "../../app/project-export/read-page-snapshot-voc";
import {buildCurrentPageAnalysis, buildCurrentPageAnalysisInputs} from "../../app/project-export/read-voc-definition-export";
import {hasProductLaunchAnalysis} from "../../app/product-launch-analysis";
import type {PageSnapshotVoc as View} from "../../app/project-export/page-snapshot-voc";
import type {ManualVocMatrixSection as ManualView} from "../../app/project-report-views/voc";

let server: ViteDevServer;
let PageSnapshotVoc: typeof View;
let ManualVocMatrixSection: typeof ManualView;
before(async () => {
  server = await createServer({configFile:false, server:{middlewareMode:true}, cacheDir:"test-results/page-snapshot-voc-vite"});
  const {PageSnapshotVoc: SnapshotView} = await server.ssrLoadModule("/app/project-export/page-snapshot-voc.tsx");
  const {SnapshotPresentationProvider} = await server.ssrLoadModule("/app/project-report-views/snapshot-presentation.tsx");
  PageSnapshotVoc = function FrozenVoc(props) {return <SnapshotPresentationProvider><SnapshotView {...props}/></SnapshotPresentationProvider>;};
  ({ManualVocMatrixSection} = await server.ssrLoadModule("/app/project-report-views/voc.tsx"));
});
after(async () => {await server?.close();});
const asin = "B000000001";
const products = [{asin, brand:"原品牌", title:"儿童漂移车", image:"https://m.media-amazon.com/images/I/car.jpg", price:99,
  sales:100, reviews:80, rating:4.5, productFamily:"generic"}] as Product[];
const manual: ManualAlexaVocRecord = {asin, marketplace:"US", revision:"2", contentHash:"a".repeat(64), source:"postgres", generation:null,
  capturedAt:"2026-09-24T10:00:00.000Z", normalizedRecord:{asin, captureStatus:"dialog", attention:["1. 关注操控体验"],
    positives:["【易于操控】35%：孩子可以轻松转向"], negatives:["【轮胎磨损】20%：需改进寿命"], unmet:["1. 可替换轮胎"],
    audiences:["人群分类｜特征", "儿童｜需要成人看护"], scenarios:["庭院｜平整路面"], motives:["生日礼物｜★★★★★｜有趣体验"],
    alexaReport:{asin,title:"儿童漂移车",rating:4.5,reviewCount:80,prompt:"七问",overallConclusion:"原始完整结论"}}};
function context(review: unknown = {asin, marketplace:"US", sampledReviews:25, mentionTopics:12, fetchedAt:"2026-09-23", status:"ready",
  blocks:[{key:"positives",label:"好评",rows:[{label:"易于操控",sharePct:36,reason:"25 条评论",metricKind:"review_sample_incidence",numerator:9,denominator:25}]}]}): ExportModuleContext {
  return {projectId:"p",organizationId:"o",marketplace:"US",asins:[asin],sourceAsins:[asin],currentRunId:null,capturedAt:"2026-09-24T10:00:00.000Z",
    version:{marketplace:"US",catalog:products,stageOutputs:{reviews:{stage:"reviews",stageStatus:"done",updatedAt:"2026-09-23T10:00:00.000Z",data:{analysisByAsin:{[asin]:review}}}}}} as never;
}
function reader(records: ManualAlexaVocRecord[] = [manual]) {
  const calls: string[] = [];
  return {calls, read:async (path:string, init?:RequestInit) => {
    assert.ok(!init?.method || init.method === "GET");
    assert.ok(path.startsWith("/api/alexa-voc?"), path); calls.push(path);
    return Response.json({records});
  }};
}

test("VOC snapshot retains original matrix, percentages, stars, insight tables and native rules", async () => {
  const {read,calls} = reader();
  const data = await readPageSnapshotVoc(context(),read,products);
  const html = renderToStaticMarkup(<PageSnapshotVoc {...data}/>);
  for (const text of ["VOC 核心主题", "VOC 七维综合分析", "智能评论分析", "原品牌", "孩子可以轻松转向", "评论样本：25", "36%", "amazon-star-rating-fill", "买家喜爱优先级表", "差评问题优先级表", "未满足需求机会表", "产品定位方向表", "为什么这样判断"]) assert.ok(html.includes(text),text);
  assert.match(html, /<details/);
  assert.equal((html.match(/<details class="snapshot-voc-tab" open="">/g) ?? []).length,1);
  assert.equal((html.match(/<details class="snapshot-voc-tab">/g) ?? []).length,2);
  for (const title of ["竞品 VOC 汇总","竞品 VOC 洞察","VOC 产品定位"]) assert.ok(html.includes(`<h2>${title}</h2>`));
  assert.doesNotMatch(html, /<button|<script|历史已保存|VOC 分析来源绑定|exportFields|sessionOrgEpoch/);
  assert.equal(calls.length,2);
  const frozen = JSON.stringify(data);
  const oldBrand = products[0].brand; products[0].brand = "修改后的品牌";
  assert.equal(JSON.stringify(data),frozen); products[0].brand = oldBrand;
});

test("reviews remain candidate-only for launch analysis and summary still displays reviews", async () => {
  const {read} = reader([]);
  const data = await readPageSnapshotVoc(context(),read,products);
  assert.ok(data.analysisInputs?.sources.reviewFallbackCandidates);
  assert.equal(data.analysisInputs?.sources.reviewAnalysisByAsin,undefined);
  assert.equal(hasProductLaunchAnalysis(data.analysisInputs!.products,data.analysisInputs!.sources),false);
  assert.equal(buildCurrentPageAnalysis(context(),[]),null);
  const html = renderToStaticMarkup(<PageSnapshotVoc {...data}/>);
  assert.match(html,/易于操控/); assert.match(html,/暂无可用于当前 VOC 立项结论的已保存数据/);
  assert.doesNotMatch(html,/自动生成|请先在/);
  assert.doesNotMatch(html,/买家喜爱优先级表/);
});

test("opaque backend fields never add visible or hidden body content but business rows do", async () => {
  const ctx = context();
  const base = await readPageSnapshotVoc(ctx,reader().read,products);
  const beforeHtml = renderToStaticMarkup(<PageSnapshotVoc {...base}/>);
  const record = (ctx.version!.stageOutputs.reviews as unknown as {data:{analysisByAsin:Record<string,Record<string,unknown>>}}).data.analysisByAsin[asin];
  record.internalDecisions = Array.from({length:1000},()=>({source:"OPAQUE_SENTINEL",raw:{hidden:"secret"}}));
  const after = await readPageSnapshotVoc(ctx,reader().read,products);
  assert.equal(renderToStaticMarkup(<PageSnapshotVoc {...after}/>),beforeHtml);
  assert.doesNotMatch(JSON.stringify(after.reviewRecords),/OPAQUE_SENTINEL/);
  const added = structuredClone(manual); added.normalizedRecord.attention.push("业务新增关注项");
  assert.match(renderToStaticMarkup(<PageSnapshotVoc {...await readPageSnapshotVoc(ctx,reader([added]).read,products)}/>),/业务新增关注项/);
});

test("missing version preserves manual matrix without inventing current analysis", async () => {
  const ctx = {...context(),version:null};
  const data = await readPageSnapshotVoc(ctx,reader().read,products);
  assert.equal(data.analysisInputs,null);
  assert.equal(buildCurrentPageAnalysisInputs(ctx,[manual]),null);
  const html = renderToStaticMarkup(<PageSnapshotVoc {...data}/>);
  assert.match(html,/孩子可以轻松转向/); assert.match(html,/暂无已发布基础报告/);
  assert.doesNotMatch(html,/买家喜爱优先级表/);
});

test("scope, malformed sources, changed manual revisions and read errors reject preparation", async () => {
  await assert.rejects(readPageSnapshotVoc(context({asin:"B000000099",marketplace:"US"}),reader().read,products),/来源/);
  await assert.rejects(readPageSnapshotVoc(context({asin,marketplace:"UK"}),reader().read,products),/来源/);
  await assert.rejects(readPageSnapshotVoc(context({asin,marketplace:"US",status:"ready",blocks:"bad"}),reader().read,products));
  await assert.rejects(readPageSnapshotVoc(context(),reader().read,[]),/商品来源/);
  await assert.rejects(readPageSnapshotVoc(context(),async()=>new Response("failed",{status:500}),products),/读取失败/);
  let reads=0;
  await assert.rejects(readPageSnapshotVoc(context(),async()=>Response.json({records:[{...manual,revision:String(++reads)}]}),products),/读取期间变化/);
});

test("shared live manual presenter preserves all source statuses and retry entry", () => {
  const base = {products,market:"US" as const,effectiveVocByAsin:{}};
  for (const [status,expected] of [["loading","正在读取当前组织"],["missing","该 ASIN 尚未录入"],
    ["source-error","运行时 VOC 暂不可用"],["protocol-conflict","服务器返回冲突 revision"]] as const) {
    const html=renderToStaticMarkup(<ManualVocMatrixSection {...base} statusByAsin={{[asin]:status}} onRetry={()=>{}}/>);
    assert.ok(html.includes(expected));
    assert.equal(html.includes("重试读取 VOC"),status === "source-error" || status === "protocol-conflict");
  }
  const retained=renderToStaticMarkup(<ManualVocMatrixSection {...base} effectiveVocByAsin={{[asin]:manual}}
    statusByAsin={{[asin]:"source-error"}} onRetry={()=>{}}/>);
  assert.match(retained,/孩子可以轻松转向/); assert.match(retained,/读取失败 · 已保留页面版本/);
  const snapshot=renderToStaticMarkup(<ManualVocMatrixSection {...base} effectiveVocByAsin={{[asin]:manual}}
    statusByAsin={{[asin]:"ready"}}/>);
  assert.doesNotMatch(snapshot,/<button|重试读取 VOC/);
});

test("non-US snapshot skips manual API and keeps explicit saved review sources", async () => {
  const ctx = context();
  const jp = {...ctx,marketplace:"JP",version:{...ctx.version!,marketplace:"JP",stageOutputs:{}}} as ExportModuleContext;
  const data=await readPageSnapshotVoc(jp,async()=>{throw new Error("unexpected manual GET");},products);
  assert.equal(data.market,"JP"); assert.equal(data.analysisInputs,null);
  const html=renderToStaticMarkup(<PageSnapshotVoc {...data}/>);
  assert.match(html,/Manual Alexa VOC 当前仅支持美国站/);
  assert.doesNotMatch(html,/暂无数据0|OPAQUE_SENTINEL/);
});

test("repeated review labels retain each distinct original business record", async () => {
  const data=await readPageSnapshotVoc(context({asin,marketplace:"US",sampledReviews:10,fetchedAt:"2026-09-23",status:"ready",
    blocks:[{key:"motives",label:"购买动机",rows:[
      {label:"产品质量",sharePct:30,reason:"第一条",metricKind:"review_sample_incidence",numerator:3,denominator:10},
      {label:"产品质量",sharePct:50,reason:"第二条",metricKind:"review_sample_incidence",numerator:5,denominator:10},
    ]}]}),reader([]).read,products);
  const html=renderToStaticMarkup(<PageSnapshotVoc {...data}/>);
  assert.match(html,/【产品质量】约 30\.0% 评论样本提及/);
  assert.match(html,/【产品质量】约 50\.0% 评论样本提及/);
  assert.equal((html.match(/class="ss-review-theme-row"/g) ?? []).length,2);
  assert.equal(data.reviewRecords[asin].blocks[0].rows.length,2);
});
