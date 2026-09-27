import assert from "node:assert/strict";
import {before, after, test} from "node:test";
import {chromium, type Browser} from "playwright";
import {createServer, type ViteDevServer} from "vite";
import react from "@vitejs/plugin-react";

let browser: Browser, server: ViteDevServer, origin: string;
before(async () => {
  server = await createServer({configFile:false, cacheDir:"test-results/navigation-pages-vite", define:{"process.env":"{}"},
    plugins:[react()], server:{host:"127.0.0.1",port:0}});
  await server.listen();
  const address = server.httpServer!.address(); assert.ok(address && typeof address !== "string");
  origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({headless:true});
});
after(async () => {await browser?.close(); await server?.close();});

test("ten selected pages each retain a titled boundary and missing state", async t => {
  const page = await browser.newPage({viewport:{width:1440,height:900}}); t.after(() => page.close());
  await page.goto(origin + "/tests/agent/helpers/page-snapshot-harness.html");
  const html = await page.evaluate(async () => {
    const {resolveSnapshotSelection} = await import(/* @vite-ignore */ "/app/project-export/" + "snapshot-navigation-catalog.ts");
    const {renderPageSnapshot} = await import(/* @vite-ignore */ "/app/project-export/" + "page-snapshot-host.tsx");
    const pageIds = ["overview","images","voc-summary","voc-insight","voc-positioning","keyword-analysis","keyword-insight","definition","checklist","traffic"] as const;
    const selection = resolveSnapshotSelection({pageIds,includeVariants:true},undefined);
    return renderPageSnapshot({project:{id:"project",name:"十页项目",marketplace:"US",asins:[]},sourceProjectId:"project",
      capturedAt:"2026-09-26T08:00:00Z",sourceLabel:"已有来源",selection,moduleIds:[...selection.moduleIds],overview:null},new AbortController().signal);
  });
  await page.setContent(html);
  assert.equal(await page.locator("[data-snapshot-page]").count(),10);
  for (const [id, title] of [["overview","竞品参数总览"],["images","主辅图"],["voc-summary","竞品 VOC 汇总"],
    ["voc-insight","竞品 VOC 洞察"],["voc-positioning","产品定义结论"],["keyword-analysis","竞品关键词分析"],
    ["keyword-insight","关键词洞察"],["definition","新品定义"],["checklist","立项前确认清单"],["traffic","竞品流量分析"]]) {
    const section = page.locator(`[data-snapshot-page="${id}"]`);
    assert.equal(await section.count(),1);
    assert.ok((await section.textContent())!.includes(title));
    assert.match((await section.textContent())!,/暂无/);
  }
  assert.equal(await page.locator("[data-snapshot-page]:visible").count(),1);
  await page.locator('[data-snapshot-group="keywords-group"] > summary').click();
  await page.locator('label[for="snapshot-page-keyword-insight"]').click();
  assert.equal(await page.locator('[data-snapshot-page="keyword-insight"]').isVisible(),true);
});

test("one selected keyword child contains no other child body and charts are laid out before capture", async t => {
  const page = await browser.newPage({viewport:{width:1440,height:900}}); t.after(() => page.close());
  await page.goto(origin + "/tests/agent/helpers/page-snapshot-harness.html");
  const result = await page.evaluate(async () => {
    const {resolveSnapshotSelection} = await import(/* @vite-ignore */ "/app/project-export/" + "snapshot-navigation-catalog.ts");
    const {readPageSnapshotKeywords} = await import(/* @vite-ignore */ "/app/project-export/" + "read-page-snapshot-keywords.ts");
    const {renderPageSnapshot} = await import(/* @vite-ignore */ "/app/project-export/" + "page-snapshot-host.tsx");
    const asin = "B000000001";
    const keyword = {keyword:"unique keyword month",trafficShare:1,searchVolume:100,abaRank:null,cpcMedian:null,cpcLow:null,cpcHigh:null,
      naturalRatio:null,trafficDependency:null,organicRank:null,rankEvolution:null,keywordHealth:null,top3ClickShare:null,
      top3ConversionShare:null,clickConversionRate:null};
    const keywords = readPageSnapshotKeywords({projectId:"p",organizationId:"o",marketplace:"US",asins:[asin],sourceAsins:[asin],
      currentRunId:null,capturedAt:"2026-09-26T08:00:00Z",sharedReads:new Map(),version:{marketplace:"US",catalog:[],stageOutputs:{keywords:{
        data:{analysisByAsin:{[asin]:{asin,marketplace:"US",fetchedAt:"2026-09-23",status:"ready",queryWindow:{time_type:"lately",time_value:"30",listingSearch:true},
          totalKeywordsInPeriod:230,topKeywordsAnalyzed:230,keywords:[keyword,...Array.from({length:229},(_,i)=>({...keyword,keyword:`wide keyword row ${i+1}`}))]}},enrichmentByKeyword:{"unique keyword month":{keyword:"unique keyword month",
          fetchedAt:"2026-09-24",status:"ready",searchTrend:[{month:"2026-05",volume:1001,abaRank:22},{month:"2026-06",volume:1202,abaRank:20}],
          bidLow:null,bidMedian:null,bidHigh:null,clickConversionRate:null,top3ClickShare:null,top3ConversionShare:null}}}}}}} as never,
      [{asin,brand:"原厂",title:"产品"}]);
    const selection = resolveSnapshotSelection({pageIds:["keyword-analysis"],includeVariants:false},undefined);
    const html = await renderPageSnapshot({project:{id:"p",name:"单页",marketplace:"US",asins:[asin]},sourceProjectId:"p",
      capturedAt:"2026-09-26T08:00:00Z",sourceLabel:"已有来源",selection,moduleIds:[...selection.moduleIds],overview:null,keywords},new AbortController().signal);
    return {html};
  });
  assert.doesNotMatch(result.html, /snapshot-page-keyword-insight|data-snapshot-page="keyword-insight"|<h2>关键词洞察<\/h2>/);
  assert.match(result.html,/2026-05/); assert.match(result.html,/2026-06/);
  await page.setContent(result.html);
  const chart = page.locator('[data-snapshot-page="keyword-analysis"] svg[aria-label="月搜索趋势"]').first();
  assert.ok(await chart.count());
  const box = await chart.boundingBox(); assert.ok(box && box.width > 0 && box.height > 0);
  const bounds = await page.locator('[data-snapshot-page="keyword-analysis"]').evaluate(section => {
    const right = section.getBoundingClientRect().right;
    return [...section.querySelectorAll('.snapshot-keywords,.launch-page,.card')].map(node => ({right:node.getBoundingClientRect().right, pageRight:right}));
  });
  assert.ok(bounds.length > 0);
  assert.ok(bounds.every(item => item.right <= item.pageRight + 2), JSON.stringify(bounds.filter(item => item.right > item.pageRight + 2).slice(0,3)));
});
