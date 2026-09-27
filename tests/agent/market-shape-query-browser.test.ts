import assert from 'node:assert/strict';
import test from 'node:test';
import {chromium} from 'playwright';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {shapePageRun,shapeRevision,shapeRunId} from './helpers/market-shape-page-fixture';
test('query entry uses reuse API and polling recovers, stops after five failures and stops on denied access',{timeout:60000},async t=>{
 const server=await createServer({configFile:false,cacheDir:'test-results/shape-query-vite',define:{'process.env':'{}'},plugins:[react()],server:{host:'127.0.0.1',port:0,hmr:false,forwardConsole:false}});await server.listen();
 const browser=await chromium.launch();t.after(async()=>{await browser.close();await server.close()});
 const origin=server.resolvedUrls!.local[0].replace(/\/$/,''),page=await browser.newPage(),current=shapePageRun(),commands:unknown[]=[];let reads=0,mode=503;
 current.run.status='succeeded';current.run.steps=current.run.steps.map(s=>({...s,status:'succeeded' as const}));
 await page.clock.install();
 await page.route('**/*',async route=>{const request=route.request(),url=new URL(request.url());if(url.origin!==origin)return route.abort();
  if(request.isNavigationRequest())return route.fulfill({contentType:'text/html',body:await server.transformIndexHtml('/',`<html><body><div id="root"></div><script type="module" src="/tests/agent/helpers/market-shape-browser-harness.tsx"></script></body></html>`)});
  if(!url.pathname.startsWith('/api/'))return route.continue();
  if(url.pathname.endsWith('/shape-price/query')){const body=request.postDataJSON();commands.push(body);current.run.scope={...current.run.scope,...body.scope};current.run.params=body.params;return route.fulfill({json:current});}
  if(url.pathname.endsWith(`/runs/${shapeRunId}/shape-price`)){reads++;return mode===200?route.fulfill({json:current}):route.fulfill({status:mode,json:{error:'测试连接失败'}});}
  return route.fulfill({status:404,json:{error:'unexpected route'}});
 });
 await page.goto(origin);await page.getByRole('button',{name:'筛选市场',exact:true}).click();await page.getByText(/4秒后自动重试/).waitFor();assert.equal(reads,1);
 mode=200;await page.clock.fastForward(4000);await page.waitForFunction(()=>!document.body.textContent?.includes('4秒后自动重试'));assert.equal(reads,2);
 await page.getByRole('button',{name:'筛选市场',exact:true}).click();await page.waitForFunction(()=>document.body.textContent?.includes('保存'));assert.equal((commands[0] as any).forceRefresh,false);assert.equal((commands[1] as any).forceRefresh,false);
 await page.getByRole('button',{name:'重新采集',exact:true}).click();await page.waitForTimeout(50);assert.equal((commands[2] as any).forceRefresh,true);
 mode=503;await page.getByRole('button',{name:'刷新形态状态',exact:true}).click();await page.getByText(/4秒后自动重试/).waitFor();const before=reads;
 for(const delay of [4000,8000,16000,30000]){await page.clock.fastForward(delay);await page.waitForTimeout(50);}
 await page.getByText(/自动重试已停止/).waitFor();assert.equal(reads-before,4);await page.clock.fastForward(120000);assert.equal(reads-before,4);
 mode=403;await page.getByRole('button',{name:'刷新形态状态',exact:true}).click();await page.waitForTimeout(50);const denied=reads;await page.clock.fastForward(120000);assert.equal(reads,denied);assert.equal(commands.length,3);
});

test('English category resolves before shape query; failed lookups retain the report and numeric input bypasses lookup',{timeout:60000},async t=>{
 const server=await createServer({configFile:false,cacheDir:'test-results/shape-category-name-vite',define:{'process.env':'{}'},plugins:[react()],server:{host:'127.0.0.1',port:0,hmr:false,forwardConsole:false}});await server.listen();
 const browser=await chromium.launch();t.after(async()=>{await browser.close();await server.close()});
 const origin=server.resolvedUrls!.local[0].replace(/\/$/,''),page=await browser.newPage(),lookups:string[]=[],queries:string[]=[];
 let current=shapePageRun();current.run.status='succeeded';current.run.latestRevision=shapeRevision();current.run.history=[{revisionId:current.run.latestRevision.revisionId,ordinal:1,createdAt:current.run.latestRevision.createdAt}];
 await page.route('**/*',async route=>{const request=route.request(),url=new URL(request.url());if(url.origin!==origin)return route.abort();
  if(request.isNavigationRequest())return route.fulfill({contentType:'text/html',body:await server.transformIndexHtml('/',`<html><body><div id="root"></div><script type="module" src="/tests/agent/helpers/market-shape-browser-harness.tsx"></script></body></html>`)});
  if(!url.pathname.startsWith('/api/'))return route.continue();
  if(url.pathname.endsWith('/shape-price/resolve-category')){const body=request.postDataJSON();lookups.push(body.name);assert.equal(body.marketplace,'US');
   if(body.name==='Unknown')return route.fulfill({status:400,json:{error:'Sorftime 未找到完全匹配的类目英文名'}});
   if(body.name==='Ambiguous')return route.fulfill({status:400,json:{error:'类目英文名对应多个节点'}});
   return route.fulfill({json:{nodeId:'13280971'}});
  }
  if(url.pathname.endsWith('/shape-price/query')){const body=request.postDataJSON();queries.push(body.scope.nodeIdPath);if(body.scope.nodeIdPath!=='1:2:3'){current=shapePageRun();current.run.status='succeeded';current.run.scope={...current.run.scope,...body.scope};current.run.latestRevision=null;current.run.history=[];}current.run.params=body.params;return route.fulfill({json:current});}
  if(url.pathname.endsWith(`/runs/${shapeRunId}/shape-price`))return route.fulfill({json:current});
  return route.fulfill({status:404,json:{error:'unexpected route'}});
 });
 await page.goto(origin);const field=page.getByLabel('类目节点',{exact:true}),search=page.getByRole('button',{name:'筛选市场',exact:true});
 await search.click();await page.getByRole('region',{name:'形态价格带版本报告'}).waitFor();assert.deepEqual(queries,['1:2:3']);assert.deepEqual(lookups,[]);
 for(const [name,message] of [['Unknown','未找到完全匹配'],['Ambiguous','对应多个节点']] as const){await field.fill(name);await search.click();await page.getByRole('alert').filter({hasText:message}).waitFor();assert.equal(await field.inputValue(),name);assert.equal(await page.getByRole('region',{name:'形态价格带版本报告'}).count(),1);assert.deepEqual(queries,['1:2:3']);}
 await field.fill('Floor Lamps');await search.click();await page.waitForFunction(()=>document.querySelector('input[aria-label="类目节点"]')?.getAttribute('value')==='13280971');assert.deepEqual(lookups,['Unknown','Ambiguous','Floor Lamps']);assert.deepEqual(queries,['1:2:3','13280971']);
 await field.fill(' 13280971 ');await search.click();await page.waitForTimeout(100);assert.deepEqual(lookups,['Unknown','Ambiguous','Floor Lamps']);assert.deepEqual(queries,['1:2:3','13280971','13280971']);assert.equal(await field.inputValue(),'13280971');
});
