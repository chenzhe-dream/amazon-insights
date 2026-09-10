import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { XydcVariantSection } from "../../app/xydc-variant-section";
import { chromium } from "playwright";
import { createServer } from "vite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { XydcVariantFamily } from "../../shared/xydc-variant-contract";

test("discovery failures remain visible beside completed child orders", () => {
  const families: XydcVariantFamily[] = ["B000000001", "B000000002"].map(inputAsin => ({
    inputAsin, parentAsin: inputAsin, country: "US", dimensions: [], children: [], sourceUpdatedAt: null,
    fetchedAt: new Date().toISOString(), status: "unavailable", reasonCode: "RPC_ERROR", cacheState: "fresh",
  }));
  const products = ["B000000001", "B000000002", "B000000003"].map(asin => ({ asin, brand: "", title: asin, image: "" }));
  const html = renderToStaticMarkup(createElement(XydcVariantSection, { products, families,
    market: { label: "US", domain: "amazon.com" }, progress: { currentRunId: "run", jobId: "job", leaseGeneration: 1, activeJob: true,
      progress: { state: "completed", ready: 4, cached: 0, total: 4, updatedAt: new Date(Date.now()-120_000).toISOString(), retryAt: null, safeReason: null } } }));
  assert.match(html, /变体发现失败.*2/);
  assert.match(html, /B000000001.*RPC_ERROR/);
  assert.match(html, /已发现子体/);
  assert.doesNotMatch(html, /已中断/);
  assert.doesNotMatch(html, /已识别变体关系/);
  assert.match(html, /尚未取得变体关系/);
});

test("products without any family cache remain visible in discovery coverage", () => {
  const products = ["B000000001", "B000000002"].map(asin => ({ asin, brand: "", title: asin, image: "" }));
  const html = renderToStaticMarkup(createElement(XydcVariantSection, { products, families: [], market: { label: "US", domain: "amazon.com" } }));
  assert.match(html, /商品变体发现.*0.*2/);
  assert.match(html, /尚未取得变体关系.*2/);
});

test("order progress shows actual two of three ready, including one cache reuse", () => {
  const props = { products: [], families: [], market: { label: "US", domain: "amazon.com" },
    progress: { currentRunId: "run", jobId: "job", leaseGeneration: 1, activeJob: true,
      progress: { state: "partial" as const, ready: 2, cached: 1, total: 3, updatedAt: new Date().toISOString(), retryAt: null, safeReason: null } } };
  const html = renderToStaticMarkup(createElement(XydcVariantSection, props));
  assert.match(html, /已就绪.*2.*3/);
  assert.match(html, /缓存复用.*1/);
  assert.match(html, /部分完成/);
  assert.match(html, /value="2" max="3"/);
  assert.doesNotMatch(html, /100%/);
});

test("mounted progress hook owns delayed discovery, visibility, scope changes and final refresh", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "xydc-progress-vite-"));
  const entry = `
import React, {useCallback,useLayoutEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {useXydcOrderProgress} from '/app/lib/use-xydc-order-progress.ts';
import {createRuntimeAnalysisScopeGuard,readAndCommitRuntimeAnalysisData} from '/app/lib/runtime-analysis-data.ts';
window.fixture={requests:[],commits:[],hidden:false};
Object.defineProperty(document,'visibilityState',{get:()=>window.fixture.hidden?'hidden':'visible'});
const snapshot={catalog:[],keywords:{analysisByAsin:{},enrichmentByKeyword:{}},reviews:{analysisByAsin:{},ratingByAsin:{}},salesTrend:{trendByAsin:{}},fba:{feeByAsin:{}},listing:{contentByAsin:{}},category:{trendByNode:{}},childSales:{rowsByAsin:{}},priceStrategy:{strategyByAsin:{}},imageRemarks:{remarksByAsin:{},outcomesByAsin:{}}};
function Harness(){
 const [scope,setScope]=useState('A:session1'); const [state,setState]=useState(null);
 const guard=useRef(createRuntimeAnalysisScopeGuard());
 useLayoutEffect(()=>{guard.current.activate(scope);return()=>guard.current.activate(null)},[scope]);
 const refresh=useCallback(async(signal,current)=>{
  const token=guard.current.capture();
  const result=await readAndCommitRuntimeAnalysisData(scope,['B000000001','B000000002','B000000003'],{
   signal,isCurrent:()=>current()&&guard.current.isCurrent(token),
   fetchImpl:()=>new Promise(resolve=>window.fixture.requests.push({scope,signal,resolve})),
   commit:s=>{window.fixture.commits.push(scope);setState({scope,view:s.xydcOrderProgress})}
  });return result?.xydcOrderProgress;
 },[scope]);
 useXydcOrderProgress({scopeKey:scope,enabled:true,view:state?.scope===scope?state.view:null,refresh});
 window.fixture.switchScope=next=>flushSync(()=>setScope(next));
 return React.createElement('div',null,scope);
}
window.fixture.visibility=hidden=>{window.fixture.hidden=hidden;document.dispatchEvent(new Event('visibilitychange'))};
window.fixture.release=(index,terminal=false)=>{const r=window.fixture.requests[index];r.resolve(Response.json({...snapshot,xydcOrderProgress:{currentRunId:r.scope.replace(':','-'),jobId:'job',leaseGeneration:1,activeJob:true,progress:terminal?{state:'partial',ready:2,cached:1,total:3,updatedAt:new Date().toISOString(),retryAt:null,safeReason:null}:null}}))};
createRoot(document.getElementById('root')).render(React.createElement(Harness));`;
  const server = await createServer({ configFile: false, cacheDir, root: process.cwd(), server: { host: "127.0.0.1", port: 0 }, plugins: [{
    name: "xydc-progress-lifetime-fixture",
    resolveId(id) { if (id === "/__progress.tsx") return "\0progress"; },
    load(id) { if (id === "\0progress") return entry; },
    configureServer(vite) { vite.middlewares.use((req, res, next) => {
      if (req.url !== "/__progress.html") return next();
      res.setHeader("Content-Type", "text/html"); res.end('<div id="root"></div><script type="module" src="/__progress.tsx"></script>');
    }); },
  }] });
  await server.listen();
  const address = server.httpServer!.address();
  assert.ok(address && typeof address !== "string");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${address.port}/__progress.html`);
    await page.waitForFunction("window.fixture?.requests.length === 1");
    await page.clock.install();
    await page.clock.runFor(10_000);
    assert.equal(await page.evaluate("window.fixture.requests.length"), 1);
    await page.evaluate("window.fixture.visibility(true); window.fixture.release(0)");
    await page.clock.runFor(10_000);
    assert.equal(await page.evaluate("window.fixture.commits.length"), 0);
    assert.equal(await page.evaluate("window.fixture.requests[0].signal.aborted"), true);
    await page.evaluate("window.fixture.visibility(false)");
    await page.waitForFunction("window.fixture.requests.length === 2");
    await page.evaluate("window.fixture.switchScope('B:session2')");
    await page.waitForFunction("window.fixture.requests.length === 3");
    await page.evaluate("window.fixture.release(1); window.fixture.release(2)");
    await page.waitForFunction("window.fixture.commits.length === 1");
    assert.deepEqual(await page.evaluate("window.fixture.commits"), ["B:session2"]);
    await page.clock.runFor(5_000);
    await page.waitForFunction("window.fixture.requests.length === 4");
    await page.evaluate("window.fixture.release(3,true)");
    await page.waitForFunction("window.fixture.requests.length === 5");
    await page.evaluate("window.fixture.release(4,true)");
    await page.clock.runFor(60_000);
    assert.equal(await page.evaluate("window.fixture.requests.length"), 5);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await server.close(); await rm(cacheDir, { recursive: true, force: true }); }
});
