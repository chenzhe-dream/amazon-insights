import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {chromium} from 'playwright';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {shapePageRun,shapeStructureRevision,shapeRunId} from './helpers/market-shape-page-fixture';
import {explanationPageRun,explanationLink} from './helpers/market-shape-explanation-page-fixture';
const reference=process.env.MARKET_UI_REFERENCE_ROOT?.replaceAll('\\','/')??'C:/Users/EDY/.codex/project-notes/amazon-insights/ui-parity-20260914/reference';

test('shape results render against supplied dashboard at the same viewport using isolated synthetic data',{timeout:120000,skip:!existsSync(reference+'/app/sorftime-category-dashboard-view.tsx')?'Set MARKET_UI_REFERENCE_ROOT to the supplied frontend for visual comparison':false},async t=>{
 const root=process.cwd().replaceAll('\\','/'),out='test-results/market-ui-parity/shape-results';await mkdir(out,{recursive:true});
 const server=await createServer({configFile:false,cacheDir:out+'/vite',define:{'process.env':'{}'},optimizeDeps:{noDiscovery:true,include:['react','react-dom/client','react/jsx-runtime']},plugins:[{name:'shape-reference-css',enforce:'pre',async load(id){if(id.startsWith(reference)&&id.endsWith('/globals.css'))return(await readFile(id,'utf8')).replace('@import "tailwindcss";','')}},react()],resolve:{dedupe:['react','react-dom']},server:{host:'127.0.0.1',port:0,hmr:false,fs:{allow:[root,reference]},forwardConsole:false}});await server.listen();
 const browser=await chromium.launch({headless:true});t.after(async()=>{await browser.close();await server.close()});const origin=server.resolvedUrls!.local[0].replace(/\/$/,'');
 const current=shapePageRun();current.run.latestRevision=shapeStructureRevision();
 const explanation=explanationPageRun('succeeded',current.run.latestRevision.revisionId);
 const report={marketplace:'US',sorftimeSite:'US',nodeId:'1:2:3',categoryName:'1:2:3',fetchedAt:'2026-09-13T00:00:00Z',note:'合成样本，仅用于版式对比',stats:{top100MonthlyVolume:0,top100MonthlyAmount:0,top3ProductSharePct:null,top3BrandSharePct:null,top3SellerSharePct:null,amazonOwnedSharePct:null,averagePrice:null,medianPrice:null,returnRatePct:null},history:{volume:[{month:'2026-08',value:0}],amount:[],avgPrice:[],listingMonopoly:[],brandMonopoly:[],sellerMonopoly:[]},products:[{rank:1,asin:'B000000001',title:'Shelf lamp',brand:'Fixture',imageUrl:'',monthlySalesVolume:0,monthlySalesAmount:0,sales:{last3Months:0,last6Months:0,y2024:0,y2025:0,monthsAvailable:1},monthlyTrend:{volume:[{month:'2026-08',value:0}],amount:[]},price:20,categoryRank:'',productCategory:'',productShape:'层架式',productShapeHint:null,bsrRank:null,deliveryType:'',reviewCount:0,starRating:null,seller:'',sellerOrigin:null,onlineDate:null,grossProfitMargin:null,priceBand:'$20-40'}],productSalesTotals:{last3Months:0,last6Months:0,y2024:0,y2025:0,monthsAvailable:1},topLinkCount:100};
 const observations=[];
 for(const mode of ['reference','candidate']){
  const page=await browser.newPage({viewport:{width:1440,height:1050}});const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  const entry=mode==='reference'?`import React from 'react';import {createRoot} from 'react-dom/client';import {SorftimeCategoryDashboardView} from '/@fs/${reference}/app/sorftime-category-dashboard-view.tsx';import '/@fs/${reference}/app/globals.css';import '/@fs/${reference}/app/warm-theme.css';import '/@fs/${reference}/app/comparison-layout.css';createRoot(document.getElementById('root')).render(<div className="launch-page market-research-page"><SorftimeCategoryDashboardView report={${JSON.stringify(report)}} siteLabel="美国站(com)" topLinkCount={100} topLinkLoading={false} isFavorited={false} onTopLinkCountChange={()=>{}}/></div>);`:`import React from 'react';import {createRoot} from 'react-dom/client';import {MarketShapeSection} from '/app/market-shape-section.tsx';import '/app/globals.css';import '/app/warm-theme.css';import '/app/comparison-layout.css';import '/app/market-research.css';import '/app/market-shape-reference.css';createRoot(document.getElementById('root')).render(<div className="market-ui-reference"><div className="launch-page market-research-page"><MarketShapeSection selection={{nodeIdPath:'1:2:3',fromMonth:'2026-08',toMonth:'2026-08'}} onSelectionChange={()=>{}} maxMonth="2026-08"/></div></div>);`;
  const entryPath=`${out}/${mode}.jsx`;await writeFile(entryPath,entry);
  await page.route('**/*',async route=>{const req=route.request(),url=new URL(req.url());if(url.origin!==origin)return route.abort();if(req.isNavigationRequest())return route.fulfill({contentType:'text/html',body:await server.transformIndexHtml('/',`<!doctype html><html><body style="margin:0;padding:24px;background:#f4f7fb"><div id="root"></div><script type="module" src="/${entryPath}"></script></body></html>`)});if(url.pathname.startsWith('/api/'))return route.fulfill(url.pathname.endsWith('/shape-explanation')?{json:explanation}:url.pathname.endsWith('/shape-price')?{json:current}:url.pathname.includes('/shape-price/revisions/')?{json:{revision:current.run.latestRevision,explanations:[explanationLink()]}}:{status:404,json:{}});return route.continue()});
  await page.goto(`${origin}/?shapeRun=${shapeRunId}`);const dashboard=page.locator('.category-node-trend-card');await dashboard.waitFor();
  if(mode==='candidate') await page.locator('.market-structure-synthesis-verdict-card').getByText('证据不足，暂不能形成综合结论',{exact:true}).waitFor();
  await dashboard.screenshot({path:`${out}/${mode}-dashboard-desktop.png`});
  await page.locator('.top-sales-section').screenshot({path:`${out}/${mode}-table-desktop.png`});
  await page.screenshot({path:`${out}/${mode}-full-desktop.png`,fullPage:true});
  await page.locator('.market-structure-synthesis').screenshot({path:`${out}/${mode}-conclusion-desktop.png`});
  const headings=await page.locator('h3').allTextContents();
  const expected=['上架年份分析','商品形态 · 销量占比分析','商品形态 · 价格带分析','品牌 · 价格带分析','类目商品链接调研 · 最终结论'];
  for(let index=1;index<expected.length;index++) assert.ok(headings.indexOf(expected[index-1])<headings.indexOf(expected[index]),JSON.stringify({mode,headings}));
  observations.push({mode,errors,dashboard:await dashboard.evaluate(el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return{width:r.width,height:r.height,padding:s.padding,border:s.border,borderRadius:s.borderRadius}})});
  await page.setViewportSize({width:390,height:844});await page.locator('.market-structure-synthesis').screenshot({path:`${out}/${mode}-conclusion-mobile.png`});await page.locator('.top-sales-section').screenshot({path:out+'/'+mode+'-table-mobile.png'});await page.screenshot({path:`${out}/${mode}-full-mobile.png`,fullPage:true});if(mode==='candidate'){assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),JSON.stringify(await page.evaluate(()=>({width:document.documentElement.scrollWidth,items:[...document.querySelectorAll("body *")].filter(el=>el.getBoundingClientRect().right>innerWidth+2&&getComputedStyle(el).overflowX==="visible").slice(0,15).map(el=>({cls:el.className,width:el.getBoundingClientRect().width,right:el.getBoundingClientRect().right}))}))))}
  assert.deepEqual(errors,[]);await page.close();
 }
 await writeFile(`${out}/observations.json`,JSON.stringify(observations,null,2));
});
