import assert from 'node:assert/strict';
import test from 'node:test';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {chromium} from 'playwright';

test('legacy collection explicitly binds its authorized source before opening image processing', {timeout:60000}, async t=>{
 const server=await createServer({configFile:false,plugins:[react()],define:{'process.env':'{}'},server:{host:'127.0.0.1',port:0,hmr:false}});await server.listen();
 const browser=await chromium.launch();t.after(async()=>{await browser.close();await server.close()});
 const page=await browser.newPage();page.setDefaultTimeout(8000);
 const origin=server.resolvedUrls!.local[0];let sourceProjectId:string|null=null;let fail=true;const writes:string[]=[];
 const base={marketplace:'US',asins:['B01M119PTN','B00P8J6AQG','B0FV2T2SP4'],majorCategory:null,categoryLabel:null,note:null,createdBy:null,createdAt:'2026-09-15T00:00:00.000Z',updatedAt:'2026-09-15T00:00:00.000Z'};
 const source={...base,id:'30000000-0000-4000-8000-000000000001',kind:'analysis',slug:'source',name:'儿童雪撬板'};
 const collection={...base,id:'30000000-0000-4000-8000-000000000002',kind:'keyword-compare',slug:'saved',name:'流量词收藏'};
 await page.route('**/*',async route=>{
  const r=route.request(),url=new URL(r.url());if(url.origin!==new URL(origin).origin)return route.abort();
  if(r.isNavigationRequest())return route.fulfill({contentType:'text/html',body:await server.transformIndexHtml('/',`<div id="root"></div><script type="module">import React from 'react';import {createRoot} from 'react-dom/client';import {ListingImageSourceProject} from '/app/listing-image-source-project.tsx';createRoot(document.getElementById('root')).render(React.createElement(ListingImageSourceProject,{projectId:'${collection.id}',asins:${JSON.stringify(base.asins)},marketplace:'US',onOpen:p=>{window.openedSource=p.id},onContext:()=>{}}));</script>`)});
  if(!url.pathname.startsWith('/api/'))return route.continue();
  if(r.method()==='PATCH'){
   writes.push(url.pathname);assert.equal(r.postDataJSON().sourceProjectId,source.id);
   if(fail){fail=false;return route.fulfill({status:503,json:{error:{message:'稍后重试'}}})}
   sourceProjectId=source.id;return route.fulfill({json:{project:{...collection,sourceProjectId}}});
  }
  assert.equal(r.method(),'GET','opening must not collect or analyze');
  if(url.pathname==='/api/agent/v1/projects')return route.fulfill({json:{projects:[{...source,currentRunId:'run'}]}});
  if(url.pathname.endsWith('/projects/'+collection.id))return route.fulfill({json:{project:{...collection,sourceProjectId}}});
  if(url.pathname.endsWith('/local-data/projects'))return route.fulfill({json:{projects:[source]}});
  return route.fulfill({status:404,json:{}});
 });
 await page.goto(origin);
 const choose=page.getByRole('button',{name:'关联并打开：儿童雪撬板'});await choose.waitFor();
 assert.equal(await page.evaluate(()=>(window as any).openedSource),undefined);assert.deepEqual(writes,[]);
 await choose.click();await page.getByRole('alert').filter({hasText:'503'}).waitFor();
 assert.equal(await page.evaluate(()=>(window as any).openedSource),undefined);
 await choose.click();await page.waitForFunction(()=>(window as any).openedSource);
 assert.equal(await page.evaluate(()=>(window as any).openedSource),source.id);assert.equal(sourceProjectId,source.id);
 await page.reload();await page.getByRole('button',{name:'打开来源：儿童雪撬板'}).click();
 assert.equal(writes.length,2,'saved provenance is reused without another binding or analysis');
});
