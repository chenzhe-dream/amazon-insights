import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdir} from 'node:fs/promises';
import {chromium} from 'playwright';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {keywordRuleFixture} from './helpers/market-keyword-rule-fixture';
import {keywordRunId} from './helpers/market-keyword-page-fixture';

test('saved result shows W5 and real cluster labels in reference sections without starting analysis',{timeout:60000},async t=>{
 const {response}=keywordRuleFixture(),server=await createServer({configFile:false,cacheDir:'test-results/keyword-result-view-vite',define:{'process.env':'{}'},plugins:[react()],server:{host:'127.0.0.1',port:0,hmr:false,forwardConsole:false}});
 await server.listen();const browser=await chromium.launch({headless:true});t.after(async()=>{await browser.close();await server.close();});
 const origin=server.resolvedUrls!.local[0].replace(/\/$/,''),page=await browser.newPage({viewport:{width:1440,height:1050}}),unexpected:string[]=[],errors:string[]=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/*',async route=>{const request=route.request(),url=new URL(request.url());
  if(url.origin!==origin||request.method()!=='GET'){unexpected.push(`${request.method()} ${url.href}`);return route.abort();}
  if(request.isNavigationRequest())return route.fulfill({contentType:'text/html',body:await server.transformIndexHtml('/',`<!doctype html><html><body style="margin:24px"><div id="root"></div><script type="module" src="/tests/agent/helpers/market-keyword-browser-harness.tsx"></script></body></html>`)});
  if(url.pathname.startsWith('/api/')){if(url.pathname.endsWith('/keywords'))return route.fulfill({json:response});unexpected.push(url.pathname);return route.abort();}
  return route.continue();
 });
 await page.goto(`${origin}/?keywordRun=${keywordRunId}`);
 const w5=page.getByLabel('W5 需求变化明细',{exact:true});await w5.waitFor();
 assert.equal(await w5.locator('tbody tr').count(),2);
 assert.match(await w5.locator('tbody tr').first().innerText(),/200\s+80.0%\s+300.0%\s+100.0%\s+100.0%/);
 assert.match(await w5.locator('tbody tr').last().innerText(),/50\s+20.0%\s+-50.0%\s+0.0%\s+未知/);
 assert.ok(await w5.getByRole('button',{name:'W5 需求变化下一页'}).isDisabled());
 const clusters=page.locator('.launch-block').filter({has:page.getByRole('heading',{name:'需求簇合成',exact:true})});
 assert.match(await clusters.innerText(),/W1（灯具） \+ W2（未知） \+ W3（未知） \+ W4（未知）/);
 const taxonomy=page.locator('.launch-block').filter({has:page.getByRole('heading',{name:'关键词含义分类标准',exact:true})});
 await taxonomy.getByRole('button',{name:'收起',exact:true}).click();assert.equal(await taxonomy.locator('table').count(),0);
 await taxonomy.getByRole('button',{name:'展开词表',exact:true}).click();assert.match(await taxonomy.locator('table').innerText(),/灯具/);
 const out='test-results/market-ui-parity/keyword-saved-results';await mkdir(out,{recursive:true});
 await w5.evaluate(el=>el.closest('.launch-block')!.scrollIntoView({block:'start'}));await page.screenshot({path:`${out}/candidate-desktop-w5-clusters.png`});
 await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 await w5.evaluate(el=>el.closest('.launch-block')!.scrollIntoView({block:'start'}));await page.screenshot({path:`${out}/candidate-mobile-w5-clusters.png`});
 assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);
});
