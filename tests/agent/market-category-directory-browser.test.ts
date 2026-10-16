import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {chromium} from 'playwright';

test('custom directory name is plain text and only category digits open Amazon',async t=>{
 const server=await createServer({configFile:false,cacheDir:'test-results/category-directory-vite',plugins:[react()],server:{host:'127.0.0.1',port:0,hmr:false,forwardConsole:false}});
 await server.listen();const browser=await chromium.launch({headless:true});t.after(async()=>{await browser.close();await server.close()});
 const page=await browser.newPage(),origin=server.resolvedUrls!.local[0].replace(/\/$/,'');page.setDefaultTimeout(7000);
 await page.route('**/*',async route=>{
  if(new URL(route.request().url()).origin!==origin)return route.abort();
  if(!route.request().isNavigationRequest())return route.continue();
  return route.fulfill({contentType:'text/html',body:await server.transformIndexHtml('/',`<div id="root"></div><script type="module">
   import React from 'react';import {createRoot} from 'react-dom/client';
   import {CategoryDirectoryEntry} from '/app/market-project-catalog.tsx';import '/app/market-project-favorites.css';
   const stats={reports:0,conditions:0,ready:0,running:0};
   const category={categoryId:'1063294',displayName:'可调光落地灯',sites:['US'],reports:40,conditions:0,complete:false,updatedAt:'2026-10-16T00:00:00Z',modules:{overview:stats,shapes:stats,keywords:stats,themes:stats}};
   function App(){const [selected,setSelected]=React.useState(0);return React.createElement('div',{className:'mpf-library mpf-category-workspace',style:{width:220}},React.createElement('aside',{className:'mpf-groups'},React.createElement(CategoryDirectoryEntry,{category,selected:false,onSelect:()=>setSelected(v=>v+1)})),React.createElement('output',null,String(selected)));}
   document.addEventListener('click',e=>{if(e.target.closest('a')){e.preventDefault();document.body.dataset.opened='yes';}});
   createRoot(document.getElementById('root')).render(React.createElement(App));
  </script>`)});
 });
 await page.goto(origin+'/');const name=page.getByText('可调光落地灯',{exact:true});await name.waitFor();
 const link=page.getByRole('link',{name:'1063294 ↗'});
 assert.equal(await link.getAttribute('href'),'https://www.amazon.com/b?node=1063294');
 const entry=await page.locator('.mpf-category-entry').boundingBox(),box=await link.boundingBox();assert.ok(entry&&box);
 assert.ok(box.width<entry.width-50,'external link must not stretch across the row');
 await page.mouse.click(entry.x+entry.width-10,box.y+box.height/2);
 await page.getByText('1',{exact:true}).waitFor();assert.equal(await page.locator('body').getAttribute('data-opened'),null);
 // Name and report count also fall through to internal selection, not the link.
 for(const target of [name,page.getByText('US · 40 份报告',{exact:true})]){const b=await target.boundingBox();assert.ok(b);await page.mouse.click(b.x+5,b.y+b.height/2);}
 await page.getByText('3',{exact:true}).waitFor();assert.equal(await page.locator('body').getAttribute('data-opened'),null);
 await link.click();assert.equal(await page.locator('body').getAttribute('data-opened'),'yes');assert.equal(await page.locator('output').textContent(),'3');
});
