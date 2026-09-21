import {existsSync} from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {keywordReconciledPageRun,keywordRunId} from './helpers/market-keyword-page-fixture';
import {canonicalJsonSha256 as digest} from '../../server/runtime/model-request-accounting';
const reference=process.env.MARKET_UI_REFERENCE_ROOT?.replaceAll('\\','/')??'C:/Users/EDY/.codex/project-notes/amazon-insights/ui-parity-20260914/reference';

test('keyword result reference and candidate render the same synthetic evidence at identical viewport',{timeout:120000},async t=>{
 if(!existsSync(reference+'/app/market-traffic-keyword-section.tsx')){t.skip('Set MARKET_UI_REFERENCE_ROOT to the supplied frontend');return;}
 const root=process.cwd().replaceAll('\\','/'),out='test-results/market-ui-parity/keyword-results';await mkdir(out,{recursive:true});
 const sample=keywordReconciledPageRun(),facts=sample.run.facts!;
 for(const [index,member] of facts.members.entries()){
  member.reference.searchVolume=(index+1)*120;
  member.pageMetrics.monthlySearchVolume.value=member.reference.searchVolume;
  member.pageMetrics.weeklySearchRank={value:1000+index*200,reason:null};
  member.trend.status='ready';
  member.trend.months=Array.from({length:8},(_,i)=>({month:`2026-${String(i+1).padStart(2,'0')}`,searchVolume:{value:(index+1)*(50+i*10),reason:null},searchRank:{value:1000+index*200,reason:null},recommendedBid:{value:1.25,reason:null},yoyGrowth:{value:null,reason:'missing-baseline',baselineMonth:`2025-${String(i+1).padStart(2,'0')}`,baselineValue:null,formulaVersion:'calendar-month-growth/v1'},recentGrowth:{value:null,reason:'missing-baseline',baselineMonth:i?`2026-${String(i).padStart(2,'0')}`:'2025-12',baselineValue:null,formulaVersion:'calendar-month-growth/v1'}}));
 }
 const {factsId:_old,...basis}=facts;void _old;facts.factsId=`market-keyword-facts:${digest(basis)}`;
 const report={productName:'shelf lamp',marketplace:'US',queryMode:'keyword_extends',totalCount:facts.members.length,fetchedPages:1,trendEnrichedCount:facts.members.length,keywords:facts.members.map(m=>({keyword:m.keyword,weeklySearchRank:m.pageMetrics.weeklySearchRank.value,weeklySearchVolume:null,monthlySearchVolume:m.reference.searchVolume,cpcExactBid:m.pageMetrics.recommendedCpcUsd.value,peakSeason:null,trend:m.trend.months.map(p=>({month:p.month,volume:p.searchVolume.value,abaRank:p.searchRank.value,cpc:p.recommendedBid.value})),yearlySearchVolume:{}}))};
 const server=await createServer({configFile:false,cacheDir:out+'/vite',define:{'process.env':'{}'},optimizeDeps:{noDiscovery:true,include:['react','react-dom/client','react/jsx-runtime']},plugins:[{name:'reference-css-runtime',enforce:'pre',async load(id){if(id.startsWith(reference)&&id.endsWith('/globals.css'))return (await readFile(id,'utf8')).replace('@import "tailwindcss";','');}},react()],resolve:{dedupe:['react','react-dom']},server:{host:'127.0.0.1',port:0,hmr:false,fs:{allow:[root,reference]},forwardConsole:false}});await server.listen();
 const browser=await chromium.launch({headless:true});t.after(async()=>{await browser.close();await server.close();});const origin=server.resolvedUrls!.local[0].replace(/\/$/,''),observations=[];
 for(const mode of ['reference','candidate']){
  const page=await browser.newPage({viewport:{width:1440,height:1050}});page.setDefaultTimeout(30000);const errors:string[]=[],unexpected:string[]=[],requests:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  const entry=mode==='reference'?`import React from 'react';import {createRoot} from 'react-dom/client';import {MarketTrafficKeywordSection} from '/@fs/${reference}/app/market-traffic-keyword-section.tsx';import '/@fs/${reference}/app/globals.css';import '/@fs/${reference}/app/warm-theme.css';import '/@fs/${reference}/app/comparison-layout.css';createRoot(document.getElementById('root')).render(<div className="launch-page market-research-page"><MarketTrafficKeywordSection marketplace="US"/></div>);`:`import React from 'react';import {createRoot} from 'react-dom/client';import {MarketKeywordSection} from '/app/market-keyword-section.tsx';import '/app/globals.css';import '/app/warm-theme.css';import '/app/comparison-layout.css';import '/app/market-ui-reference.css';import '/app/market-research.css';createRoot(document.getElementById('root')).render(<div className="market-ui-reference"><MarketKeywordSection selection={{nodeIdPath:'1:2:3',fromMonth:'2026-07',toMonth:'2026-08'}} onSelectionChange={()=>{}} maxMonth="2026-08"/></div>);`;
  const entryPath=`${out}/${mode}.jsx`;await writeFile(entryPath,entry);
  await page.route('**/*',async route=>{const req=route.request(),url=new URL(req.url());if(url.origin!==origin){unexpected.push(req.url());return route.abort();}if(req.isNavigationRequest())return route.fulfill({contentType:'text/html',body:await server.transformIndexHtml('/',`<!doctype html><html><body style="margin:0;padding:24px;background:#f4f7fb"><div id="root"></div><script type="module" src="/${entryPath}"></script></body></html>`)});
   if(url.pathname.startsWith('/api/')){requests.push(`${req.method()} ${url.pathname}`);if(mode==='reference'&&url.pathname==='/api/sorftime-product-keywords')return route.fulfill({json:{report}});if(mode==='candidate'&&req.method()==='GET'&&url.pathname.endsWith('/keywords'))return route.fulfill({json:sample});unexpected.push(`${req.method()} ${url.pathname}`);return route.fulfill({status:500,json:{error:'Unexpected fixture request'}});}return route.continue();});
  await page.goto(origin+(mode==='candidate'?`/?keywordRun=${keywordRunId}`:''),{waitUntil:'domcontentloaded',timeout:30000});await page.getByRole('textbox',{name:'产品核心名',exact:true}).fill('shelf lamp');
  if(mode==='reference')await page.getByRole('button',{name:'查询',exact:true}).click();
  await page.locator('.shape-price-table tbody tr').first().waitFor();await page.getByRole('heading',{name:'五维综合结论',exact:true}).waitFor();
  await page.screenshot({path:`${out}/${mode}-desktop-top.png`});await page.screenshot({path:`${out}/${mode}-desktop-full.png`,fullPage:true});
  const tableHeaders=await page.locator('.shape-price-table').first().locator(':scope > thead > tr > th').allTextContents();
  const query=await page.locator('.ss-market-query').evaluate(el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return {x:r.x,y:r.y,width:r.width,height:r.height,padding:s.padding,borderRadius:s.borderRadius};});
  if(mode==='candidate'){
   assert.ok(query.height<=310,`Keyword query should remain compact before reports, got ${query.height}px`);
   const gap=await page.locator('[aria-label="关键词事实明细"]').evaluate(el=>el.nextElementSibling!.getBoundingClientRect().top-el.getBoundingClientRect().bottom);
   assert.ok(gap>=14,'The fact table and demand report must be separate spaced report cards');
   assert.equal(await page.getByRole('button',{name:'保存分类并重新计算',exact:true}).isVisible(),false,'Manual editing should be opt-in below the report');
  }
  await page.getByRole('heading',{name:'五维综合结论',exact:true}).evaluate(el=>el.scrollIntoView({block:'start'}));await page.screenshot({path:`${out}/${mode}-desktop-demand.png`});
  await page.setViewportSize({width:390,height:844});await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:`${out}/${mode}-mobile-top.png`});await page.screenshot({path:`${out}/${mode}-mobile-full.png`,fullPage:true});
  const mobileWidth=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,viewport:innerWidth}));if(mode==='candidate')assert.ok(mobileWidth.scroll<=mobileWidth.viewport+1);
  observations.push({mode,tableHeaders,query,mobileWidth,errors,unexpected,requests});assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);await page.close();
 }
 await writeFile(out+'/observations.json',JSON.stringify(observations,null,2));
});
