import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {chromium} from 'playwright';
import {buildProjectPreviewContext} from '../../shared/market-project-preview';
import {overviewRun,overviewRunId,overviewDistributionDetails} from './helpers/market-overview-page-fixture';
import {shapePageRun,shapeRunId} from './helpers/market-shape-page-fixture';
import {keywordPageRun,keywordRunId} from './helpers/market-keyword-page-fixture';
import {themeRun,themeRunId,themeDetails} from './helpers/market-theme-page-fixture';

test('favorite preview opens four saved module reports for two categories with zero collection writes',{timeout:90000},async t=>{
 const server=await createServer({configFile:false,cacheDir:'test-results/project-preview-vite',define:{'process.env':'{}'},plugins:[react()],server:{host:'127.0.0.1',port:0,hmr:false,forwardConsole:false}});
 await server.listen();const browser=await chromium.launch();t.after(async()=>{await browser.close();await server.close()});
 const origin=server.resolvedUrls!.local[0].replace(/\/$/,''),page=await browser.newPage();page.setDefaultTimeout(8000);
 let node='1:456',writes=0;const errors:string[]=[],readIds=new Set<string>();page.on('pageerror',e=>errors.push(e.message));
 const ids={overview:overviewRunId,shapes:shapeRunId,keywords:keywordRunId,themes:themeRunId};
 const idFor=(id:string)=>node==='2:987'?id.slice(0,-1)+((parseInt(id.at(-1)!,16)+4)%16).toString(16):id;
 const adapt=(data:unknown)=>JSON.parse(JSON.stringify(data),(key,value)=>key==='nodeIdPath'?node:typeof value==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value)?idFor(value):value);
 await page.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());if(url.origin!==origin)return route.abort();
  if(request.isNavigationRequest()){
   const scope={marketplace:'US' as const,nodeIdPath:node,fromMonth:'2026-07',toMonth:'2026-08'};
   const context={overview:{...scope,runId:idFor(overviewRunId)}};
   const preview=buildProjectPreviewContext(context,'overview',node==='3:111'?[]:(['shapes','keywords','themes'] as const).map(module=>({context:{[module]:{...scope,runId:idFor(ids[module])}},status:'ready',createdAt:'2026-09-12T00:00:00Z'})));
   const row={favoriteId:'90000000-0000-4000-8000-000000000001',title:'Synthetic',creatorName:'Test',updatedAt:'2026-09-12T00:00:00Z',status:'ready',context,previewContext:preview};
   return route.fulfill({contentType:'text/html',body:await server.transformIndexHtml('/preview-'+node.replaceAll(':','-')+'.html',`<div id="root"></div><script type="module">
    import React from 'react';import {createRoot} from 'react-dom/client';import {CategoryHistoryRows} from '/app/market-project-catalog.tsx';import {MarketResearchSection} from '/app/market-research-section.tsx';
    import '/app/globals.css';import '/app/market-research.css';
    const library=location.pathname==='/library';createRoot(document.getElementById('root')).render(library?React.createElement(CategoryHistoryRows,{items:[${JSON.stringify(row)}],module:'overview',onDetail:()=>{}}):React.createElement(MarketResearchSection,{sessionIdentity:'preview-fixture'}));
   </script>`)});
  }
  if(!url.pathname.startsWith('/api/'))return route.continue();
  if(request.method()!=='GET'){writes++;return route.fulfill({status:500,json:{error:{message:'No writes permitted'}}});}
  if(url.pathname.endsWith('/market-research/jobs'))return route.fulfill({json:{jobs:[]}});
  if(url.pathname.includes('/reports/')&&url.pathname.endsWith('/details')){
   return route.fulfill({json:adapt(url.pathname.includes(idFor(themeRunId))?themeDetails(url):overviewDistributionDetails())});
  }
  for(const [id,fixture] of [[overviewRunId,overviewRun],[shapeRunId,shapePageRun],[keywordRunId,keywordPageRun],[themeRunId,themeRun]] as const){
   if(url.pathname.includes('/runs/'+idFor(id))){readIds.add(node+':'+id);return route.fulfill({json:adapt(fixture())});}
  }
  return route.fulfill({status:404,json:{error:{message:'No saved fixture'}}});
 });
 for(const category of ['1:456','2:987']){
  node=category;await page.goto(origin+'/library');await page.getByRole('link',{name:'预览报告 ↗'}).click();
  try{await page.getByRole('region',{name:'已保存总览报告'}).waitFor();}catch(e){console.log('preview-failure',node,page.url(),errors,(await page.locator('body').innerText()).slice(-6000));throw e;}
  const nav=page.getByRole('navigation',{name:'市场调研模块'});
  assert.equal(await page.getByLabel('类目节点或路径',{exact:true}).inputValue(),node);
  await nav.getByRole('button',{name:'商品形态及价格带',exact:true}).click();
  await page.getByText('Shelf lamp',{exact:true}).first().waitFor();assert.equal(await page.getByLabel('类目节点',{exact:true}).inputValue(),node);
  await nav.getByRole('button',{name:'类目关键词洞察',exact:true}).click();
  await page.getByRole('region',{name:'关键词参考月指标',exact:true}).getByText('shelf lamp',{exact:true}).waitFor();assert.equal(await page.getByLabel('类目节点或路径',{exact:true}).inputValue(),node);
  await nav.getByRole('button',{name:'类目买家评论见解',exact:true}).click();
  await page.locator('.category-cs-table').getByText('新版装配主题',{exact:true}).waitFor();assert.equal(await page.getByLabel('类目路径',{exact:true}).inputValue(),node);
  for(const id of Object.values(ids))assert.ok(readIds.has(node+':'+id));
  assert.equal(writes,0);await page.reload();await page.getByLabel('类目路径',{exact:true}).waitFor();assert.equal(await page.getByLabel('类目路径',{exact:true}).inputValue(),node);
 }
 node='3:111';await page.goto(origin+'/library');await page.getByRole('link',{name:'预览报告 ↗'}).click();
 const nav=page.getByRole('navigation',{name:'市场调研模块'});await nav.waitFor();
 for(const [label,input,key] of [['商品形态及价格带','类目节点','shapeRun'],['类目关键词洞察','类目节点或路径','keywordRun'],['类目买家评论见解','类目路径','themeRun']]){
  await nav.getByRole('button',{name:label,exact:true}).click();await page.getByLabel(input,{exact:true}).waitFor();
  assert.equal(await page.getByLabel(input,{exact:true}).inputValue(),node);assert.equal(new URL(page.url()).searchParams.get(key),null);
 }
 assert.equal(await page.locator('.category-cs-table').count(),0,'missing report does not retain previous category data');
 assert.deepEqual(errors,[]);assert.equal(writes,0);
});
