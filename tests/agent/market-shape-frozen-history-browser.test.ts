import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {shapeSorftimePageRevision,shapeSorftimePageRun} from './helpers/market-shape-sorftime-page-fixture';

test('freeze A, edit working B, view A then return B without provider calls or writes on reads',{timeout:120000},async t=>{
 const revision=shapeSorftimePageRevision();revision.note='FROZEN A';
 const run=shapeSorftimePageRun().run;
 const harness=`import React,{useState}from'react';import{createRoot}from'react-dom/client';import{MarketShapeFrozenHistory}from'/app/market-shape-frozen-history';function App(){const [label,set]=useState('A');return <MarketShapeFrozenHistory run={${JSON.stringify(run)}} selectedAsins={${JSON.stringify(revision.selectedAsins)}} assignments={{B000000001:label}} disabled={false} onRefresh={()=>{}}><input aria-label="working-label" value={label} onChange={e=>set(e.target.value)}/><p>LIVE WORKING {label}</p></MarketShapeFrozenHistory>};createRoot(document.getElementById('root')).render(<App/>);`;
 const server=await createServer({configFile:false,cacheDir:'test-results/frozen-shape-vite',define:{'process.env':'{}'},plugins:[{name:'harness',resolveId(id){if(id==='/harness.tsx')return id;},load(id){if(id==='/harness.tsx')return harness;}},react()],server:{host:'127.0.0.1',port:0,hmr:false,forwardConsole:false}});
 await server.listen();t.after(()=>server.close());
 const browser=await chromium.launch();t.after(()=>browser.close());const page=await browser.newPage();page.setDefaultTimeout(10000);
 const origin=server.resolvedUrls!.local[0].replace(/\/$/,'');let writes=0,reads=0;
 await page.route('**/*',async route=>{const request=route.request(),u=new URL(request.url());if(u.origin!==origin)return route.abort();if(request.isNavigationRequest())return route.fulfill({contentType:'text/html',body:'<div id="root"></div><script type="module" src="/harness.tsx"></script>'});if(!u.pathname.startsWith('/api/'))return route.continue();
  assert.ok(u.pathname.includes('/shape-price/revisions'),'Only snapshot API is allowed');
  if(request.method()==='POST'){writes++;const body=request.postDataJSON();assert.equal(body.assignments[0].label,'A');revision.assignments=body.assignments;}
  else reads++;
  return route.fulfill({json:{revision}});
 });
 await page.goto(origin);await page.getByRole('button',{name:'保存冻结报告'}).click();await page.getByText(/FROZEN A/).waitFor();assert.equal(writes,1);
 await page.getByLabel('形态报告版本').selectOption('working');await page.getByLabel('working-label').fill('B');
 await page.getByLabel('形态报告版本').selectOption(revision.revisionId);await page.getByText(/FROZEN A/).waitFor();
 assert.equal(await page.getByLabel('working-label').count(),0);assert.ok((await page.locator('body').innerText()).includes('只读冻结版本'));assert.equal(writes,1);assert.ok(reads>=2);
 await page.getByLabel('形态报告版本').selectOption('working');assert.equal(await page.getByLabel('working-label').inputValue(),'B');assert.equal(writes,1);
});
