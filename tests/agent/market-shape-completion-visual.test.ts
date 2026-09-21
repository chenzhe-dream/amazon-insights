import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdir,writeFile,copyFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {shapePageRun,shapeRunId} from './helpers/market-shape-page-fixture';
import {collectMarketProductPool} from '../../server/services/market-product-pool-collector';
import {createMarketInputSnapshot} from '../../server/domain/market-research/snapshot';
import {createMarketShapeRevision,buildMarketShapePriceCatalog} from '../../server/domain/market-research/shape-price-catalog';
import {readMarketProductMonth} from '../../server/domain/market-research/product-month-evidence';
import {projectMarketShapeSourceMetadata} from '../../server/domain/market-research/shape-source-metadata';
import {marketShapePublicRevision} from '../../server/services/market-shape-read-service';
import {canonicalJsonSha256} from '../../server/runtime/model-request-accounting';
import {MarketShapeRunResponseSchema} from '../../shared/market-shape-public-contracts';

test('synthetic shape completion loads production styles and contains the full page at desktop and 390px',{timeout:90000},async t=>{
 const out='test-results/market-completion-visual/shape';await mkdir(out,{recursive:true});
 const current=shapePageRun(),scope={...current.run.scope,fromMonth:'2026-03'},asins=['B000000001','B000000002','B000000003'],fetchedAt='2026-09-13T00:00:00.000Z';
 const months=['03','04','05','06','07','08'].map(m=>`2026-${m}`),series=[[90,100,110,120,140,160],[0,30,50,70,80,90],[20,null,25,30,35,40]];
 const observations=await Promise.all(months.map(async(month,monthIndex)=>{
  const result=await collectMarketProductPool({scope,month,poolSize:3,newProductMonths:6,jobId:'synthetic-visual',now:()=>new Date(fetchedAt),connector:{id:'sellerSprite',probe:async()=>{throw Error('No external calls');},execute:async()=>({data:{code:'OK',marketplace:'US',nodeIdPath:scope.nodeIdPath,month,currency:'USD',data:asins.map((asin,i)=>({asin,title:['合成 · 三层置物落地灯','合成 · 弧形阅读落地灯','合成 · 历史缺月灯具'][i],brand:['Luma Fixture','North Fixture',null][i],price:[39.9,59.9,49.9][i],totalUnits:series[i][monthIndex],totalRevenue:[6123.45,5031.2,null][i],ranking:i+1,rating:[4.7,4.3,null][i],ratings:[381,126,null][i],sellerName:['Fixture Home','Fixture Lighting',null][i],sellerType:['FBA','FBM',null][i],shelfDate:['2025-11-12','2026-03-01',null][i]}))},source:{connectorId:'sellerSprite',operation:'market_product_concentration',fetchedAt,attemptCount:1}})}});
  assert.ok(result.evidence);const source=result.evidence,sourceRef='market-source:'+canonicalJsonSha256(source);
  const snapshot=createMarketInputSnapshot({scope,kind:'products',sourceVersion:'market-source-handlers/v1',ruleVersion:'source-normalization/v1',collectedAt:fetchedAt,expectedRecordIds:asins,records:result.products.map(product=>({id:product.asin,scope,data:{collection:'product-month',month,product,sourceRef}}))});
  return {month,snapshot,sourceRef,source};
 }));
 const reference=observations.at(-1)!,sources=Object.fromEntries(observations.map(o=>[o.sourceRef,o.source])),labels=[{labelId:'shelf',label:'层架式',definition:'人工确认带置物层架'},{labelId:'arc',label:'弧形',definition:'人工确认弧形灯臂'}];
 const revision=createMarketShapeRevision({scope,basisSnapshotId:reference.snapshot.snapshotId,parentRevisionId:null,selectedAsins:asins,taxonomyVersion:'synthetic-visual/v1',labels,assignments:[{asin:asins[0],labelId:'shelf'},{asin:asins[1],labelId:'arc'}],authorId:scope.organizationId,createdAt:fetchedAt,note:'合成数据，仅验证展示与布局，不用于市场决策'});
 const catalog=await buildMarketShapePriceCatalog({reference,history:observations.slice(0,-1),sources,revision,bands:[{id:'low',minInclusive:0,maxExclusive:40},{id:'mid',minInclusive:40,maxExclusive:60},{id:'high',minInclusive:60,maxExclusive:null}],dataCutoffAt:fetchedAt,version:'market-shape-price-catalog/v3'});
 const report=marketShapePublicRevision({ordinal:1,catalog,semanticStatus:'not-integrated'}),checked=await readMarketProductMonth(reference,sources);
 current.run.scope=scope;current.run.params.catalog={task:'market-product-shape-suggestion',taxonomyVersion:revision.taxonomyVersion,allowedLabels:labels};current.run.latestRevision=report;current.run.history=[{revisionId:report.revisionId,ordinal:1,createdAt:fetchedAt}];current.run.suggestions={status:'unavailable',items:[]};
 current.run.source={...current.run.source!,referenceSnapshotId:reference.snapshot.snapshotId,fetchedAt,products:checked.products.map(p=>({asin:p.asin,title:p.title,brand:p.brand,price:p.price,units:p.units,metadata:projectMarketShapeSourceMetadata(checked,p.asin,true)}))};
 MarketShapeRunResponseSchema.parse(current);assert.equal(report.totalUnits,1040);assert.equal(report.periodProjection!.periods.find(p=>p.id==='last-3')!.segments[0].stats.units,660);
 await writeFile(`${out}/synthetic-fixture.json`,JSON.stringify(current,null,2));
 // Match the existing reference-parity harness and the production layout's
 // stylesheet imports. No inline product-layout or overflow overrides.
 await copyFile('node_modules/next/dist/next-devtools/server/font/geist-latin.woff2',`${out}/geist-latin.woff2`);
 await copyFile('node_modules/next/dist/next-devtools/server/font/geist-mono-latin.woff2',`${out}/geist-mono-latin.woff2`);
 await writeFile(`${out}/fonts.css`,"@font-face{font-family:Geist;src:url('./geist-latin.woff2') format('woff2');font-style:normal;font-weight:100 900;font-display:swap}@font-face{font-family:'Geist Mono';src:url('./geist-mono-latin.woff2') format('woff2');font-style:normal;font-weight:100 900;font-display:swap}:root{--font-geist-sans:Geist;--font-geist-mono:'Geist Mono'}");
 await writeFile(`${out}/entry.jsx`,"import React from 'react';import {createRoot} from 'react-dom/client';import {MarketShapeSection} from '/app/market-shape-section.tsx';import '/test-results/market-completion-visual/shape/fonts.css';import '/app/globals.css';import '/app/warm-theme.css';import '/app/comparison-layout.css';import '/app/market-research.css';import '/app/market-shape-reference.css';createRoot(document.getElementById('root')).render(<div className=\"market-ui-reference\"><div className=\"launch-page market-research-page\"><p className=\"source-badge\">合成数据 · 形态后端补齐视觉验证（非真实市场结果）</p><MarketShapeSection selection={{nodeIdPath:'1:2:3',fromMonth:'2026-03',toMonth:'2026-08'}} onSelectionChange={()=>{}} maxMonth=\"2026-08\"/></div></div>);");
 const server=await createServer({configFile:false,cacheDir:`${out}/vite`,define:{'process.env':'{}'},plugins:[react()],server:{host:'127.0.0.1',port:0,hmr:false,forwardConsole:false}});await server.listen();
 const browser=await chromium.launch({headless:true});t.after(async()=>{await browser.close();await server.close();});
 const origin=server.resolvedUrls!.local[0].replace(/\/$/,''),page=await browser.newPage({viewport:{width:1440,height:1050}}),errors:string[]=[],external:string[]=[];let writes=0;
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async route=>{const request=route.request(),url=new URL(request.url());if(url.origin!==origin){external.push(url.origin);return route.abort();}if(request.isNavigationRequest())return route.fulfill({contentType:'text/html',body:await server.transformIndexHtml('/',`<!doctype html><html lang="zh-CN"><body style="margin:0;padding:24px"><div id="root"></div><script type="module" src="/${out}/entry.jsx"></script></body></html>`)});if(url.pathname.startsWith('/api/')){if(request.method()!=='GET')writes++;return route.fulfill(url.pathname.endsWith('/shape-price')?{json:current}:url.pathname.includes('/shape-price/revisions/')?{json:{revision:report,explanations:[]}}:{status:404,json:{}});}return route.continue();});
 await page.goto(`${origin}/?shapeRun=${shapeRunId}`);await page.getByRole('region',{name:'形态价格带版本报告'}).waitFor();await page.getByText('可比销量：1,040',{exact:true}).waitFor();
 await page.evaluate(()=>document.fonts.ready);
 const styles=await page.evaluate(()=>({loaded:[...document.querySelectorAll('style[data-vite-dev-id]')].map(el=>el.getAttribute('data-vite-dev-id')),tableFont:getComputedStyle(document.querySelector('.launch-table')!).fontSize,headerPadding:getComputedStyle(document.querySelector('.launch-table th')!).padding,bodyFont:getComputedStyle(document.body).fontFamily}));
 for(const file of ['globals.css','warm-theme.css','comparison-layout.css','market-research.css','market-shape-reference.css'])assert.ok(styles.loaded.some(path=>path?.endsWith(`/app/${file}`)),file);
 assert.ok(parseFloat(styles.tableFont)<=14);assert.notEqual(styles.headerPadding,'0px');assert.doesNotMatch(styles.bodyFont,/Times New Roman/);
 const observationsByViewport=[];
 for(const viewport of [{label:'desktop',width:1440,height:1050},{label:'mobile',width:390,height:844}]){
  await page.setViewportSize(viewport);await page.locator('.market-shape-table').first().evaluate(el=>{el.scrollLeft=0;});
  assert.equal(await page.locator('.market-shape-table tbody [data-column-id="product-1"]').first().evaluate(el=>getComputedStyle(el).position),viewport.width<=640?'static':'sticky');
  const layout=await page.evaluate(()=>({viewport:innerWidth,scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight}));assert.ok(layout.scrollWidth<=layout.viewport+1,JSON.stringify(layout));observationsByViewport.push({label:viewport.label,...layout});
  await page.screenshot({path:`${out}/${viewport.label}.png`,fullPage:true});
  await page.locator('.top-sales-section').screenshot({path:`${out}/products-${viewport.label}.png`});
  await page.getByRole('region',{name:'形态人工确认表'}).evaluate(el=>{el.scrollLeft=el.scrollWidth;});
  const metadataDetails=page.getByText('参考月字段来源',{exact:true}).first();await metadataDetails.click({timeout:2000});
  await page.getByRole('region',{name:'形态人工确认表'}).evaluate(el=>{el.scrollLeft=el.scrollWidth;});
  const expandedWidth=await page.evaluate(()=>document.documentElement.scrollWidth);assert.ok(expandedWidth<=viewport.width+1,`expanded metadata overflow: ${expandedWidth}`);
  await page.locator('.top-sales-section').screenshot({path:`${out}/source-metadata-${viewport.label}.png`});
  await metadataDetails.click({timeout:2000});
 }
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.equal(writes,0);
 await writeFile(`${out}/observations.json`,JSON.stringify({dataKind:'synthetic-only',styles,viewports:observationsByViewport,errors,external,writes},null,2));
});
