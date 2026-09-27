import {buildShapeCategoryDashboard,normalizeShapeCategorySource} from '../../server/services/market-shape-category-collector';
import {SHAPE_CATEGORY_METRICS} from '../../shared/market-shape-category-contracts';
import {productHistoryPeriods} from '../../server/services/market-product-history-collector';
import assert from 'node:assert/strict';
import test from 'node:test';
import {chromium} from 'playwright';
import {createServer} from 'vite';
import {mkdir} from 'node:fs/promises';
import react from '@vitejs/plugin-react';
import {shapePageRun,shapeRevision,shapeRunId} from './helpers/market-shape-page-fixture';

test('original shape flow collects by category before any manual shape name and saves it afterward',{timeout:60000},async t=>{
 const server=await createServer({configFile:false,cacheDir:'test-results/shape-original-flow-vite',define:{'process.env':'{}'},plugins:[react()],server:{host:'127.0.0.1',port:0,hmr:false,forwardConsole:false}});await server.listen();
 const browser=await chromium.launch({headless:true});t.after(async()=>{await browser.close();await server.close()});
 const origin=server.resolvedUrls!.local[0].replace(/\/$/,''),page=await browser.newPage({viewport:{width:1280,height:900}}),current=shapePageRun();
 current.run.source!.summary={basis:'collected-source',scope:current.run.scope,selectedAsins:['B000000001'],eligibleAsins:['B000000001'],totalUnits:10,referenceRevenue:123.45,monthly:[{month:'2026-08',totalUnits:10}],products:[{asin:'B000000001',observations:[{month:'2026-08',units:10,issues:[]}]}],periods:['last-3','last-6','year-2025','year-2024'].map(id=>({id,issues:['period-not-collected'],products:[{asin:'B000000001',units:null}]}))};
 const evidence=(name:string)=>({sourceRef:'market-source:'+'1'.repeat(64),inputSnapshotId:current.run.source!.referenceSnapshotId,payloadPath:['data',0,name] as any});
 const missing=(name:string)=>({rawValue:null,value:null,issues:['missing'] as ['missing'],evidence:evidence(name)});
 current.run.source!.products[0].metadata={basis:'reference-observation',referenceMonth:'2026-08',imageUrl:{rawValue:'https://m.media-amazon.com/images/I/fixture.jpg',value:'https://m.media-amazon.com/images/I/fixture.jpg',issues:[],evidence:evidence('imageUrl')},revenue:missing('totalRevenue'),rating:missing('rating'),ratingCount:missing('ratings'),sellerName:missing('sellerName'),sellerType:missing('sellerType'),listedAt:missing('shelfDate')};
 current.run.semanticStatus='skipped';current.run.suggestions={status:'unavailable',items:[]};current.run.latestRevision=null;
 const errors:string[]=[],starts:unknown[]=[],revisions:unknown[]=[];let studies=0;
 page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());if(url.hostname==='m.media-amazon.com')return route.fulfill({contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf1sAAAAASUVORK5CYII=','base64')});if(url.origin!==origin)return route.abort();
  if(request.isNavigationRequest())return route.fulfill({contentType:'text/html',body:await server.transformIndexHtml('/',`<!doctype html><html><body><div id="root"></div><script type="module" src="/tests/agent/helpers/market-shape-browser-harness.tsx"></script></body></html>`)});
  if(!url.pathname.startsWith('/api/'))return route.continue();
  if(request.method()==='POST'&&url.pathname.endsWith('/shape-price/query')){
   const body=request.postDataJSON();starts.push(body.params);current.run.params=body.params;
   current.run.scope={...current.run.scope,...body.scope};
   return route.fulfill({json:current});
  }
  if(request.method()==='POST'&&url.pathname.endsWith('/shape-price/revisions')){
   const body=request.postDataJSON();revisions.push(body);
   const revision={...shapeRevision(),taxonomyVersion:body.taxonomyVersion,labels:body.labels,assignments:body.assignments,groups:[{...shapeRevision().groups[0],labelId:body.assignments[0].labelId}]};
   current.run.latestRevision=revision;current.run.history=[{revisionId:revision.revisionId,ordinal:1,createdAt:revision.createdAt}];
   return route.fulfill({status:201,json:{revision}});
  }
  if(url.pathname.endsWith(`/runs/${shapeRunId}/shape-price`))return route.fulfill({json:current});
  return route.fulfill({status:404,json:{error:'unexpected test route'}});
 });
 await page.goto(origin+'/');
 assert.equal(await page.getByLabel('本次形态目录（每行：名称|判断依据）').count(),0);
 await page.getByRole('button',{name:'筛选市场',exact:true}).click();
 const row=page.getByLabel('B000000001 人工形态');await row.waitFor();
 assert.equal(studies,0);assert.equal(starts.length,1);assert.deepEqual((starts[0] as {catalog:{allowedLabels:unknown[]}}).catalog.allowedLabels,[]);
 await page.getByText('123.45',{exact:true}).waitFor();
 assert.equal(await page.getByText('等待人工确认并保存',{exact:true}).count(),0);
 await page.getByRole('img',{name:'B000000001 商品图片',exact:true}).scrollIntoViewIfNeeded();
 await page.waitForFunction(()=>{const image=document.querySelector('img[alt="B000000001 商品图片"]') as HTMLImageElement;return image?.complete&&image.naturalWidth>0});
 assert.ok(await page.getByText('未采集该区间',{exact:true}).count()>0);
 // Monthly values must be visible without opening a disclosure.
 assert.equal(await page.getByRole('region',{name:'形态人工确认表'}).locator('details').filter({hasText:'月度销量'}).count(),0);
 await page.getByRole('region',{name:'形态人工确认表'}).getByText('2026-08：10',{exact:true}).waitFor({timeout:3000});
 await page.getByText('当前仅有 1 个月数据，展示单月数据点，尚不能判断增长或下降趋势。',{exact:true}).waitFor({timeout:3000});
 await mkdir('test-results/market-shape-original-flow',{recursive:true});
 await page.screenshot({path:'test-results/market-shape-original-flow/collected-dashboard.png',fullPage:true});
 assert.equal(revisions.length,0);
 const points=[{month:'2026-06',units:10,issues:[]},{month:'2026-07',units:0,issues:[]},{month:'2026-08',units:20,issues:[]}];
 current.run.source!.productHistory={provider:'sorftime',metric:'SalesVolume',referenceMonth:'2026-08',products:[{asin:'B000000001',status:'ready',points,periods:productHistoryPeriods(points,'2026-08'),sourceRef:'market-source:'+'2'.repeat(64),inputSnapshotId:'market-input:'+'3'.repeat(64),fetchedAt:'2026-09-24T00:00:00Z',errorCode:null}]};
 await page.reload();await row.waitFor();
 await page.getByLabel('B000000001 月度销量').getByText('2026-07：0',{exact:true}).waitFor();
 await page.getByRole('cell',{name:'30',exact:true}).waitFor();
 assert.ok(await page.getByRole('cell',{name:'缺少完整月份',exact:true}).count()>0);
 await page.getByRole('cell',{name:'30',exact:true}).scrollIntoViewIfNeeded();
 await page.screenshot({path:'test-results/market-shape-original-flow/historical-sales.png',fullPage:true});
 current.run.categoryDashboard=buildShapeCategoryDashboard(SHAPE_CATEGORY_METRICS.map(metric=>({metric,status:'ready',sourceRef:'test',fetchedAt:'2026-09-24T00:00:00.000Z',...normalizeShapeCategorySource(metric,metric==='report'?{data:{category_stats_report:{top100_monthly_sales_volume:'200',top100_monthly_sales_amount:'300',top3_product_sales_volume_share:'17.52%',return_rate:'5.4%'}}}:{data:['2026-06=10','2026-07=0','2026-08=20']},'2026-08')})),'USD','2026-08');
 await page.reload();await page.getByRole('img',{name:'类目月销量与估算销售额趋势',exact:true}).waitFor();await page.getByRole('img',{name:'Top3 销售额占比趋势',exact:true}).waitFor();
 await page.getByText('17.52%',{exact:true}).waitFor();await page.screenshot({path:'test-results/market-shape-original-flow/category-dashboard.png',fullPage:true});
 await row.fill('层架式');
 await page.getByRole('button',{name:'确认并重新计算'}).click();
 await page.getByRole('region',{name:'形态价格带版本报告'}).waitFor();
 assert.equal(revisions.length,1);
 await page.getByLabel('B000000001 月度销量').getByText('2026-08：20',{exact:true}).waitFor();
 await page.getByRole('cell',{name:'30',exact:true}).waitFor();
 const saved=revisions[0] as {labels:Array<{labelId:string;label:string;definition:string}>;assignments:Array<{asin:string;labelId:string}>};
 assert.equal(saved.labels[0].label,'层架式');assert.equal(saved.assignments[0].labelId,saved.labels[0].labelId);
 await mkdir('test-results/market-shape-original-flow',{recursive:true});
 await page.screenshot({path:'test-results/market-shape-original-flow/desktop.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 await page.screenshot({path:'test-results/market-shape-original-flow/mobile.png',fullPage:true});
 await page.reload();await row.waitFor();assert.equal(await row.inputValue(),'层架式');
 assert.deepEqual(errors,[]);
});
