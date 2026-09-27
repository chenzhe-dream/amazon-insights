import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdir,writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';

test('original sorting orders complete groups, preserves price bands and selection, and toggles every metric',{timeout:60000},async t=>{
 const out='test-results/shape-final-sorting';await mkdir(out,{recursive:true});
 const product=(i:number,brand:string,shape:string,price:number,units:number)=>({rank:i,asin:`B00000000${i}`,title:'Lamp',brand,productShape:shape,imageUrl:'',price,monthlySalesVolume:units,monthlySalesAmount:price*units,
  sales:{last3Months:units,last6Months:units,y2025:units,y2024:units,monthsAvailable:24},monthlyTrend:{volume:[],amount:[]},categoryRank:'',productCategory:'',productShapeHint:null,bsrRank:null,deliveryType:'',reviewCount:0,starRating:null,seller:'',sellerOrigin:null,onlineDate:'2024-01',grossProfitMargin:65,priceBand:`$${price}-${price+10}`});
 const products=[product(1,'Alpha','A shape',20,60),product(2,'Alpha','A shape',10,50),product(3,'Beta','B shape',30,100)];
 const report={marketplace:'US',nodeId:'123',categoryName:'Fixture',fetchedAt:'2026-09-27T00:00:00Z',calculationVersion:'shape-known-coverage/2',stats:{},history:{volume:[],amount:[],avgPrice:[],listingMonopoly:[],brandMonopoly:[],sellerMonopoly:[]},products,topLinkCount:3};
 await writeFile(out+'/entry.jsx',`import React from'react';import{createRoot}from'react-dom/client';import{MarketShapeReferenceView}from'/app/market-shape-reference/view';import'/app/globals.css';import'/app/warm-theme.css';import'/app/comparison-layout.css';import'/app/market-research.css';import'/app/market-shape-reference.css';createRoot(document.getElementById('root')).render(<div className="market-ui-reference launch-page market-research-page"><MarketShapeReferenceView report={${JSON.stringify(report)}} assignments={{}} selectedAsins={${JSON.stringify(products.map(p=>p.asin))}} onAssignment={()=>{}} onSelected={()=>{}}/></div>);`);
 const server=await createServer({configFile:false,cacheDir:out+'/vite',plugins:[react()],define:{'process.env':'{}'},server:{host:'127.0.0.1',port:0,hmr:false,forwardConsole:false}});await server.listen();
 const browser=await chromium.launch();t.after(async()=>{await browser.close();await server.close()});const page=await browser.newPage({viewport:{width:1500,height:1000}}),origin=server.resolvedUrls!.local[0],errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async route=>{if(!route.request().url().startsWith(origin))return route.abort();if(route.request().isNavigationRequest())return route.fulfill({contentType:'text/html',body:await server.transformIndexHtml('/',`<html><body><div id="root"></div><script type="module" src="/${out}/entry.jsx"></script></body></html>`)});return route.continue()});
 await page.goto(origin);
 const section=(name:string)=>page.locator('section').filter({has:page.getByRole('heading',{name,exact:true})});
 const brand=section('品牌 · 价格带分析'),shape=section('商品形态 · 价格带分析');
 const labels=()=>brand.locator('tbody tr:not(.shape-price-total-row) > th').allTextContents();
 assert.deepEqual(await labels(),['Alpha · $10-20','Alpha · $20-30','Beta · $30-40']);
 await brand.getByLabel('品牌价格带切换排序方向').click();
 assert.deepEqual(await labels(),['Beta · $30-40','Alpha · $10-20','Alpha · $20-30']);
 await brand.getByLabel('品牌价格带排序',{exact:true}).selectOption('label');
 assert.deepEqual(await labels(),['Alpha · $10-20','Alpha · $20-30','Beta · $30-40']);
 await brand.getByRole('button',{name:'2025年单链月均排序',exact:true}).click();
 assert.equal(await brand.getByLabel('品牌价格带排序',{exact:true}).inputValue(),'avgY2025MonthlyPerLink');
 // Beta's per-link average exceeds Alpha's average, although Alpha's total is larger.
 assert.deepEqual(await labels(),['Beta · $30-40','Alpha · $10-20','Alpha · $20-30']);
 const shapeLabels=()=>shape.locator('tr.shape-price-subtotal-row > th').allTextContents();
 assert.deepEqual(await shapeLabels(),['A shape · 合计','B shape · 合计']);
 await shape.getByLabel('形态价格带排序',{exact:true}).selectOption('linkCount');
 await shape.getByLabel('形态价格带切换排序方向').click();
 assert.deepEqual(await shapeLabels(),['B shape · 合计','A shape · 合计']);
 assert.deepEqual(await shape.locator('tr.shape-price-band-row > th').allTextContents(),['$30-40','$10-20','$20-30']);
 const sales=section('商品形态 · 销量占比分析');
 for(const metric of ['label','last3Months','last3MonthsSharePct','last6Months','last6MonthsSharePct','y2025','y2025SharePct','y2024','y2024SharePct','linkCount','avgLast6MonthsMonthlyPerLink','avgY2025MonthlyPerLink']){
  await sales.getByLabel('形态销量排序',{exact:true}).selectOption(metric);await sales.getByLabel('形态销量切换排序方向').click();
 }
 for(const p of products)assert.ok(await page.getByLabel(`选择 ${p.asin}`,{exact:true}).isChecked());
 await shape.scrollIntoViewIfNeeded();await shape.screenshot({path:out+'/groups-desktop.png'});
 await page.setViewportSize({width:390,height:844});await shape.screenshot({path:out+'/groups-mobile.png'});assert.deepEqual(errors,[]);
});
