import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdir} from 'node:fs/promises';
import {chromium} from 'playwright';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {shapePageRun} from './helpers/market-shape-page-fixture';

test('month picker switches year directly, respects month bounds and preserves query scope',{timeout:90000},async t=>{
 const server=await createServer({configFile:false,cacheDir:'test-results/shape-month-vite',define:{'process.env':'{}'},plugins:[react()],server:{host:'127.0.0.1',port:0,hmr:false,forwardConsole:false}});await server.listen();
 const browser=await chromium.launch();t.after(async()=>{await browser.close();await server.close()});
 const origin=server.resolvedUrls!.local[0].replace(/\/$/,''),page=await browser.newPage({viewport:{width:1280,height:900}}),commands:any[]=[],errors:string[]=[];
 page.setDefaultTimeout(8000);page.on('pageerror',error=>errors.push(error.stack??error.message));
 await page.clock.setFixedTime(new Date('2026-09-27T00:00:00Z'));
 await page.route('**/*',async route=>{const request=route.request(),url=new URL(request.url());if(url.origin!==origin)return route.abort();
  if(request.isNavigationRequest())return route.fulfill({contentType:'text/html',body:await server.transformIndexHtml('/',`<html><body><div id="root"></div><script type="module" src="/tests/agent/helpers/market-shape-browser-harness.tsx"></script></body></html>`)});
  if(!url.pathname.startsWith('/api/'))return route.continue();
  if(url.pathname.endsWith('/shape-price/query')){const body=request.postDataJSON();commands.push(body);const response=shapePageRun();response.run.scope={...response.run.scope,...body.scope};return route.fulfill({json:response});}
  return route.fulfill({status:404,json:{error:'fixture'}});
 });
 await page.goto(origin);
 const from=page.getByRole('textbox',{name:'起始月',exact:true}),to=page.getByRole('textbox',{name:'结束月',exact:true});
 await from.click();await page.getByRole('combobox',{name:'选择年份'}).selectOption('2025');
 await page.getByRole('option',{name:/^选择 一月 2025$/,exact:false}).click();
 assert.equal(await from.inputValue(),'2025-01');assert.equal(commands.length,0,'changing month must not collect');
 await to.click();assert.equal(await page.getByRole('option',{name:/九月 2026$/}).getAttribute('aria-disabled'),'true');
 await page.keyboard.press('Escape');
 await from.fill('2027-01');assert.equal(await from.evaluate((el:HTMLInputElement)=>el.checkValidity()),false,'typed out-of-range month must block submission');
 await from.fill('');assert.equal(await from.evaluate((el:HTMLInputElement)=>el.checkValidity()),false);
 await from.fill('2025-03');await from.press('Tab');assert.equal(await from.inputValue(),'2025-03');
 await page.getByRole('button',{name:'筛选市场',exact:true}).click();await page.waitForTimeout(500);assert.equal(commands.length,1,await page.locator('body').innerText());
 assert.equal(commands[0].scope.fromMonth,'2025-03');assert.equal(commands[0].scope.toMonth,'2026-08');assert.equal(commands[0].scope.nodeIdPath,'1:2:3');
 await page.setViewportSize({width:390,height:844});await to.click();
 const popup=page.locator('.shape-month-calendar');const box=await popup.boundingBox();assert.ok(box&&box.x>=0&&box.x+box.width<=390);
 await mkdir('test-results/shape-month-picker',{recursive:true});await page.screenshot({path:'test-results/shape-month-picker/mobile.png'});
 await page.keyboard.press('Escape');assert.equal(await popup.count(),0);
 await to.focus();await to.press('ArrowDown');await popup.waitFor();await page.keyboard.press('Escape');assert.deepEqual(errors,[]);
});
