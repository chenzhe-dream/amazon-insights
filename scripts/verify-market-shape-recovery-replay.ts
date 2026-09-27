import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {chromium} from 'playwright';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {MarketShapeRunResponseSchema} from '../shared/market-shape-public-contracts';
import {toShapeReferenceReport} from '../app/lib/market-shape-reference-adapter';
import {buildReferenceShapeAnalysis} from '../app/market-shape-reference/rules';
const file=process.argv[2];if(!file)throw Error('Pass a saved shape run JSON file; this replay never connects to a provider or production database.');
const {run}=MarketShapeRunResponseSchema.parse(JSON.parse(await readFile(file,'utf8')));
assert.ok(run.source?.sorftimePool&&run.source.productHistory&&run.source.productAmountHistory&&run.categoryDashboard);
const report=toShapeReferenceReport({calculationVersion:'shape-known-coverage/2',scope:run.scope,pool:run.source.sorftimePool,productImages:run.source.productImages,productHistory:run.source.productHistory,productAmountHistory:run.source.productAmountHistory,categoryDashboard:run.categoryDashboard});
const out='test-results/shape-recovery';await mkdir(out,{recursive:true});
const server=await createServer({configFile:false,cacheDir:out+'/vite',define:{'process.env':'{}'},plugins:[react()],server:{host:'127.0.0.1',port:0,hmr:false,forwardConsole:false}});await server.listen();
const browser=await chromium.launch();const results:unknown[]=[];
try{
 const origin=server.resolvedUrls!.local[0],page=await browser.newPage({viewport:{width:1500,height:1100}}),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async route=>{if(!route.request().url().startsWith(origin))return route.abort();if(route.request().isNavigationRequest())return route.fulfill({contentType:'text/html',body:await server.transformIndexHtml('/',`<html><body><div id="root"></div><script type="module" src="/${out}/entry-${new URL(route.request().url()).searchParams.get('sample')}.jsx"></script></body></html>`)});return route.continue()});
 for(const count of [100,140,150,300]){
  const sample={...report,products:Array.from({length:count},(_,i)=>({...report.products[i%report.products.length],asin:i<report.products.length?report.products[i].asin:`T${String(i).padStart(9,'0')}`}))};
  const start=performance.now(),analysis=buildReferenceShapeAnalysis(sample,{}),ruleMs=performance.now()-start;
  const serial=performance.now(),payload=JSON.stringify(sample),serialMs=performance.now()-serial;
  await writeFile(out+`/entry-${count}.jsx`,`import React,{useState}from'react';import{createRoot}from'react-dom/client';import{MarketShapeReferenceView}from'/app/market-shape-reference/view';import'/app/globals.css';import'/app/warm-theme.css';import'/app/comparison-layout.css';import'/app/market-research.css';import'/app/market-shape-reference.css';const report=${payload};function App(){const[a,setA]=useState({});const[s,setS]=useState(report.products.map(p=>p.asin));return <div className="market-ui-reference launch-page market-research-page"><MarketShapeReferenceView report={report} assignments={a} selectedAsins={s} onAssignment={(asin,label)=>setA(old=>({...old,[asin]:label}))} onSelected={setS}/></div>};window.replayBegin=performance.now();createRoot(document.getElementById('root')).render(<App/>);`);
  await page.goto(origin+'?sample='+count);await page.getByRole('heading',{name:'市场结构综合结论',exact:true}).waitFor();
  const renderMs=await page.evaluate(()=>performance.now()-(window as any).replayBegin);
  assert.equal(await page.locator('input[aria-label$=" 人工形态"]').count(),count);
  if(count===140){const year=page.locator('section').filter({has:page.getByRole('heading',{name:'上架年份 · 销量结构分析',exact:true})});await year.scrollIntoViewIfNeeded();await page.screenshot({path:out+'/real-140-year-desktop.png'});await page.setViewportSize({width:390,height:844});await page.getByLabel(`${sample.products[0].asin} 人工形态`,{exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:out+'/real-140-edit-mobile.png'});await page.setViewportSize({width:1500,height:1100});}
  results.push({count,source:count===report.products.length?'saved real result':'synthetic capacity replay from saved product rows',ruleMs,serialMs,bytes:Buffer.byteLength(payload),renderMs,totals:analysis.synthesis.totalSales,coverage:analysis.synthesis.coverage});
 }
 assert.deepEqual(errors,[]);await writeFile(out+'/render-performance.json',JSON.stringify({results,errors},null,2));console.log(JSON.stringify({results,errors},null,2));
}finally{await browser.close();await server.close()}
