import assert from "node:assert/strict";
import test, {before, after} from "node:test";
import {renderToStaticMarkup} from "react-dom/server";
import {createServer, type ViteDevServer} from "vite";
import type {Product} from "../../app/project-report-views/competitor-overview";
import type {TrafficDisplayData} from "../../app/sif-listing-traffic-data";
import type {TrafficSnapshotSources} from "../../app/project-export/read-page-snapshot-traffic";
import type {TrafficReportView as Report} from "../../app/project-report-views/traffic";
import type {PageSnapshotTraffic as Snapshot} from "../../app/project-export/page-snapshot-traffic";

let server:ViteDevServer;
let TrafficReportView:typeof Report;
let PageSnapshotTraffic:typeof Snapshot;
let SnapshotPresentationProvider:typeof import("../../app/project-report-views/snapshot-presentation").SnapshotPresentationProvider;
before(async()=>{
  server=await createServer({configFile:false,server:{middlewareMode:true},cacheDir:"test-results/page-snapshot-traffic-vite"});
  ({TrafficReportView}=await server.ssrLoadModule("/app/project-report-views/traffic.tsx"));
  ({PageSnapshotTraffic}=await server.ssrLoadModule("/app/project-export/page-snapshot-traffic.tsx"));
  ({SnapshotPresentationProvider}=await server.ssrLoadModule("/app/project-report-views/snapshot-presentation.tsx"));
});
after(async()=>{await server?.close();});

const asin="B000000001";
const products=[{asin,brand:"灯具品牌",title:"测试灯具",image:"",price:39,sales:100,reviews:40,rating:4.5}] as Product[];
const children=Array.from({length:7},(_,i)=>({asin:`B${String(i+2).padStart(9,"0")}`,label:`子体 ${i+1}`,image:"",totalScore:700-i*90,sharePct:20-i,organic:100,sp:50,spRecommend:20,sb:10,sbv:5}));
const overview={totalScore:950,naturalAd:[{label:"自然流量",score:600,ratio:63.2},{label:"广告流量",score:350,ratio:36.8}],adChannels:[{label:"SP(常规)",score:300,ratio:85.7}],recommendationSources:Array.from({length:7},(_,i)=>({label:`推荐位 ${i+1}`,score:70-i,ratio:20-i})),children,updatedThrough:"2026-09-01",childCount:7};
function fixture(months=6):TrafficSnapshotSources {
  const trafficData:TrafficDisplayData={overview:{[asin]:overview},monthlyTrend:{},meta:{source:"fixture",period:"近30天",country:"US",updatedThrough:"2026-09-01",status:"ready",emptyMessage:"暂无"}};
  return {products,market:"US",trafficData,monthlyTrendByAsin:{[asin]:{asin,points:Array.from({length:months},(_,i)=>({month:`${2025+Math.floor(i/12)}-${String(i%12+1).padStart(2,"0")}`,label:`${i%12+1}月`,natural:i===7?null:100+i,ad:i===7?null:20+i,total:i===7?null:120+i*2}))}}};
}
const renderSnapshot=(props:TrafficSnapshotSources)=>renderToStaticMarkup(<SnapshotPresentationProvider><PageSnapshotTraffic {...props}/></SnapshotPresentationProvider>);

test("shared traffic view keeps original matrix, colors, Top3 cards and conclusion",()=>{
  const data=fixture();
  const page=renderToStaticMarkup(<TrafficReportView {...data}/>);
  const frozen=renderSnapshot(data);
  for (const label of ["父 ASIN 流量结构","Listing自然 / 广告流量分布","广告流量分布","推荐专栏流量分布","子体流量结构","月流量趋势对比","推广能力判断","灯具品牌","SP(常规)","600","350"]) {
    assert.ok(page.includes(label),label); assert.ok(frozen.includes(label),label);
  }
  assert.match(frozen,/background:#55BB6A/);
  assert.match(frozen,/推荐位 6/);
  assert.doesNotMatch(frozen,/推荐位 7/);
  assert.match(page,/子体 3/);
  assert.doesNotMatch(page,/子体 4/);
  assert.match(page,/<button[^>]*>展开其余 4 个子体<\/button>/);
  assert.match(frozen,/<details class="traffic-child-details"><summary>展开其余 4 个子体<\/summary>/);
  assert.match(frozen,/子体 7/);
  assert.match(frozen,/推荐来源仅展示已保存的前 6 项/);
  assert.doesNotMatch(frozen,/<button|<script|exportFields|历史已保存/);
});

test("20 months stay in the original chart area and native detail table preserves unknown values",()=>{
  const html=renderSnapshot(fixture(20));
  assert.equal((html.match(/class="monthly-traffic-bar"/g)??[]).length,20);
  assert.match(html,/2025-01/); assert.match(html,/2026-08/);
  assert.match(html,/<details class="traffic-monthly-details"><summary>查看全部 20 条已保存月份明细/);
  assert.match(html,/2025-08：自然 —，广告 —，合计 —/);
  assert.match(html,/<td>2025-08<\/td><td>—<\/td><td>—<\/td><td>—<\/td>/);
  assert.match(html,/width="980"/);
  assert.match(html,/展示当前来源已保存的月份/);
  assert.doesNotMatch(html,/8月为当月未完结数据/);
});

test("many competitors widen the native chart instead of overlapping brand groups",()=>{
  const data=fixture(20);
  data.products=Array.from({length:8},(_,i)=>({...products[0],asin:`B${String(i+1).padStart(9,"0")}`,brand:`较长的品牌名称 ${i+1}`}));
  data.monthlyTrendByAsin=Object.fromEntries(data.products.map(product=>[product.asin,{...fixture(20).monthlyTrendByAsin[asin],asin:product.asin}]));
  const html=renderSnapshot(data);
  assert.match(html,/width="2182"/);
  assert.match(html,/min-width:2182px/);
  assert.match(html,/较长的品牌名称 8/);
  assert.equal((html.match(/class="monthly-traffic-bar"/g)??[]).length,160);
});

test("missing details and months remain visibly unavailable without sample values",()=>{
  const data=fixture(0);
  data.trafficData={...data.trafficData,overview:{[asin]:null}};
  const html=renderSnapshot(data);
  assert.match(html,/暂无已保存月流量结构数据/);
  assert.match(html,/traffic-dist-empty/);
  assert.doesNotMatch(html,/子体 1|2025-01|推荐位 1|总分 0/);
});

test("partial monthly values show a missing marker without inventing a zero stack",()=>{
  const data=fixture(1);
  data.monthlyTrendByAsin[asin].points[0]={month:"2026-09",label:"9月",natural:10,ad:null,total:null};
  const html=renderSnapshot(data);
  assert.match(html,/2026-09：自然 10，广告 —，合计 —/);
  assert.match(html,/class="monthly-traffic-missing">—<\/text>/);
  assert.doesNotMatch(html,/height="238"/);
  assert.match(html,/<td>2026-09<\/td><td>10<\/td><td>—<\/td><td>—<\/td>/);
});
