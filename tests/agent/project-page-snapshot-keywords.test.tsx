import assert from "node:assert/strict";
import test, {before, after} from "node:test";
import {renderToStaticMarkup} from "react-dom/server";
import {createServer, type ViteDevServer} from "vite";
import type {ExportModuleContext} from "../../app/project-export/export-module-context";
import {readPageSnapshotKeywords} from "../../app/project-export/read-page-snapshot-keywords";
import type {PageSnapshotKeywords as PageSnapshotKeywordsType} from "../../app/project-export/page-snapshot-keywords";

let server: ViteDevServer;
let PageSnapshotKeywords: typeof PageSnapshotKeywordsType;
before(async () => {
  server = await createServer({configFile:false,server:{middlewareMode:true},cacheDir:"test-results/page-snapshot-keywords-vite"});
  const {SnapshotPresentationProvider} = await server.ssrLoadModule("/app/project-report-views/snapshot-presentation.tsx");
  const {PageSnapshotKeywords: View} = await server.ssrLoadModule("/app/project-export/page-snapshot-keywords.tsx");
  PageSnapshotKeywords = function FrozenKeywords(props) {return <SnapshotPresentationProvider><View {...props}/></SnapshotPresentationProvider>;};
});
after(async () => {await server?.close();});

const asin = "B000000001";
const other = "B000000002";
const products = [{asin,brand:"原厂",title:"儿童滑板车"},{asin:other,brand:"竞品",title:"儿童滑板车"}];
const keyword = (word: string, volume: number | null = null) => ({keyword:word,trafficShare:1,searchVolume:volume,abaRank:null,
  cpcMedian:null,cpcLow:null,cpcHigh:null,naturalRatio:null,trafficDependency:null,organicRank:null,rankEvolution:null,
  keywordHealth:null,top3ClickShare:null,top3ConversionShare:null,clickConversionRate:null});
const record = (rows: ReturnType<typeof keyword>[]) => ({asin,marketplace:"US",fetchedAt:"2026-09-23",status:"ready" as const,
  queryWindow:{time_type:"lately",time_value:"30",listingSearch:true},totalKeywordsInPeriod:300,topKeywordsAnalyzed:rows.length,keywords:rows});
const enriched = {keyword:"toddler scooter",fetchedAt:"2026-09-24",status:"ready",searchTrend:[
  {month:"2026-05",volume:1001,abaRank:22},{month:"2026-06",volume:1202,abaRank:20},
  {month:"2026-07",volume:1303,abaRank:18}],bidLow:null,bidMedian:null,bidHigh:null,
  clickConversionRate:null,top3ClickShare:null,top3ConversionShare:null};
function context(data: unknown = {analysisByAsin:{[asin]:record([keyword("toddler scooter")])},enrichmentByKeyword:{"toddler scooter":enriched}}): ExportModuleContext {
  return {projectId:"p",organizationId:"o",marketplace:"US",asins:[asin,other],sourceAsins:[asin,other],currentRunId:null,
    capturedAt:"2026-09-24T10:00:00Z",version:{marketplace:"US",stageOutputs:{keywords:{data}},catalog:[]} as never};
}

test("published analysis keeps over 200 words, all months, native full values, mix and taxonomy", () => {
  const rows = [keyword("toddler scooter"),...Array.from({length:229},(_,index)=>keyword(`scooter word ${index+1}`))];
  const source = readPageSnapshotKeywords(context({analysisByAsin:{[asin]:record(rows)},enrichmentByKeyword:{"toddler scooter":enriched,
    secret:{...enriched,keyword:"secret",searchTrend:[{month:"private",volume:999,abaRank:1}]}}}),products);
  const html = renderToStaticMarkup(<PageSnapshotKeywords {...source} page="keyword-analysis"/>);
  const insight = renderToStaticMarkup(<PageSnapshotKeywords {...source} page="keyword-insight"/>);
  assert.equal(source.sources.analysisByAsin?.[asin].keywords.length,230);
  assert.match(html,/scooter word 229/);
  assert.match(html,/2026-05/);assert.match(html,/2026-06/);assert.match(html,/2026-07/);
  assert.match(html,/1,001/);assert.match(html,/1,202/);assert.match(html,/1,303/);
  assert.match(html,/<svg[^>]+aria-label="月搜索趋势"/);
  assert.match(html,/<details[^>]*><summary>查看全部月份<\/summary>/);
  assert.match(html,/<summary>全部分类占比<\/summary>/);
  assert.match(html,/<summary>展开词表<\/summary>/);
  assert.doesNotMatch(html, /<details class="snapshot-keywords-tab|<h2>关键词洞察<\/h2>/);
  assert.match(insight, /<h2>关键词洞察<\/h2>/);
  for (const phrase of ["标签分布概览","竞品关键词结构对比","流量词对比","关键词含义分类标准","近30天 · 站内搜索","2026-09-24"])
    assert.ok(html.includes(phrase),phrase);
  assert.doesNotMatch(html,/private|选择关键词|复制当前列表|复制已选|含义筛选|2026-08-13|keywords:sync|<button/);
});

test("absent published data and missing metrics remain missing without global keyword defaults", () => {
  const empty = readPageSnapshotKeywords({...context(),version:null},products);
  const html = renderToStaticMarkup(<PageSnapshotKeywords {...empty} page="keyword-analysis"/>);
  assert.match(html,/暂无已发布的关键词结果/);
  assert.match(html,/来源时间未记录/);
  assert.doesNotMatch(html,/2026-08-13|62787|npm run keywords:sync|C级：继续观察/);
  const source = readPageSnapshotKeywords(context({analysisByAsin:{[asin]:record([keyword("missing volume")])},enrichmentByKeyword:{}}),products);
  const missingHtml = renderToStaticMarkup(<PageSnapshotKeywords {...source} page="keyword-analysis"/>);
  assert.match(missingHtml,/missing volume/);
  assert.doesNotMatch(missingHtml,/0\.0%.*missing volume|2026-08-13/);
  assert.equal(source.sources.analysisByAsin?.[asin].keywords[0].searchVolume,null);
  assert.equal(source.sources.enrichmentByKeyword?.["missing volume"],undefined);
});

test("wrong ASIN or site, malformed maps and mismatched enrichment reject the source", () => {
  const base = record([keyword("toddler scooter")]);
  assert.throws(()=>readPageSnapshotKeywords(context({analysisByAsin:{[asin]:{...base,asin:other}}}),products),/范围不匹配/);
  assert.throws(()=>readPageSnapshotKeywords(context({analysisByAsin:{[asin]:{...base,marketplace:"UK"}}}),products),/范围不匹配/);
  assert.throws(()=>readPageSnapshotKeywords({...context(),marketplace:"UK"},products),/范围不匹配/);
  assert.throws(()=>readPageSnapshotKeywords(context({analysisByAsin:[]}),products));
  assert.throws(()=>readPageSnapshotKeywords(context({analysisByAsin:{[asin]:base},enrichmentByKeyword:{"toddler scooter":{...enriched,marketplace:"UK"}}}),products),/范围不匹配/);
  assert.throws(()=>readPageSnapshotKeywords(context({analysisByAsin:{[asin]:base},enrichmentByKeyword:{"toddler scooter":{...enriched,keyword:"other"}}}),products),/来源不匹配/);
  assert.throws(()=>readPageSnapshotKeywords(context(),[products[0],products[0]]),/范围不匹配/);
});

test("malformed or absent source timestamps never promote stale global metadata", () => {
  const source = readPageSnapshotKeywords(context({analysisByAsin:{[asin]:{...record([keyword("fresh")]),fetchedAt:"bad-date",queryWindow:null}}}),products);
  const html = renderToStaticMarkup(<PageSnapshotKeywords {...source} page="keyword-analysis"/>);
  assert.match(html,/来源时间未记录/);
  assert.match(html,/来源周期未记录/);
  assert.doesNotMatch(html,/bad-date|2026-08-13|keywords:sync/);
});

test("seven-day and unknown source windows never claim thirty days or twelve saved periods", () => {
  const sevenDay = readPageSnapshotKeywords(context({analysisByAsin:{[asin]:{
    ...record([keyword("seven day word")]),queryWindow:{time_type:"lately",time_value:"7",listingSearch:true},
  }},enrichmentByKeyword:{}}),products);
  const sevenHtml = renderToStaticMarkup(<PageSnapshotKeywords {...sevenDay} page="keyword-analysis"/>);
  assert.match(sevenHtml,/近7天 · 站内搜索/);
  assert.match(sevenHtml,/已有月份/);
  assert.doesNotMatch(sevenHtml,/近30天|近12期|近 12 个月搜索量|listingSearch lately/);

  const unknown = readPageSnapshotKeywords(context({analysisByAsin:{[asin]:{
    ...record([keyword("unknown period word")]),queryWindow:null,
  }},enrichmentByKeyword:{}}),products);
  const unknownHtml = renderToStaticMarkup(<PageSnapshotKeywords {...unknown} page="keyword-analysis"/>);
  assert.match(unknownHtml,/来源周期未记录/);
  assert.doesNotMatch(unknownHtml,/近30天|近12期|近 12 个月搜索量|listingSearch lately/);
});
