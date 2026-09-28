import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {chromium} from 'playwright';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {keywordPageRun} from './helpers/market-keyword-page-fixture';

test('query entry recovers temporary read failures, retains edits, and uses year-month selection',{timeout:60000},async t=>{
 const payload=keywordPageRun(),out='test-results/keyword-recovery-20260928';await mkdir(out,{recursive:true});
 const server=await createServer({configFile:false,cacheDir:out+'/vite',define:{'process.env':'{}'},plugins:[react()],server:{host:'127.0.0.1',port:0,hmr:false,forwardConsole:false}});await server.listen();
 const browser=await chromium.launch();t.after(async()=>{await browser.close();await server.close();});
 const origin=server.resolvedUrls!.local[0].replace(/\/$/,''),page=await browser.newPage({viewport:{width:1536,height:1050}});
 let failures=0,reads=0,mode:'ok'|'transient'|'denied'='transient';const writes:string[]=[],errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(12000);
 await page.route('**/*',async route=>{const req=route.request(),url=new URL(req.url());if(url.origin!==origin)return route.abort();
  if(req.isNavigationRequest())return route.fulfill({contentType:'text/html',body:await server.transformIndexHtml('/',`<!doctype html><html><body><div id="root"></div><script type="module" src="/tests/agent/helpers/market-keyword-browser-harness.tsx"></script></body></html>`)});
  if(!url.pathname.startsWith('/api/'))return route.continue();if(req.method()!=='GET')writes.push(url.pathname);
  if(req.method()==='GET'&&url.pathname.endsWith('/keywords')){reads++;if(mode==='denied')return route.fulfill({status:403,json:{error:{message:'没有访问权限'}}});if(mode==='transient'&&failures++===0)return route.fulfill({status:503,json:{error:{message:'服务暂时不可用'}}});return route.fulfill({json:payload});}
  return route.fulfill({status:404,json:{}});
 });
 await page.goto(`${origin}/?keywordRun=${payload.run.id}`);
 await page.getByRole('region',{name:'关键词参考月指标'}).waitFor();assert.equal(reads,2,'initial read recovers without manual refresh');
 await page.getByText('类目范围与采集设置',{exact:true}).click();await page.getByLabel('起始月',{exact:true}).click();await page.getByLabel('选择年份',{exact:true}).selectOption('2024');await page.screenshot({path:out+'/month-picker.png'});await page.getByText('一月',{exact:true}).click();assert.equal(await page.getByLabel('起始月',{exact:true}).inputValue(),'2024-01');await page.screenshot({path:out+'/query.png'});
 await page.getByLabel('结束月',{exact:true}).click();await page.getByLabel('选择年份',{exact:true}).selectOption('2023');assert.equal(await page.getByText('一月',{exact:true}).getAttribute('aria-disabled'),'true','end month cannot precede start month');await page.keyboard.press('Escape');
 await page.getByText('任务进度、重试与取消',{exact:true}).click();await page.getByLabel('类目说明',{exact:true}).fill('保留人工输入');failures=0;
 await page.getByRole('button',{name:'刷新关键词状态',exact:true}).click();await page.getByRole('alert').filter({hasText:'自动重试'}).waitFor();
 assert.ok(await page.getByRole('region',{name:'关键词参考月指标'}).isVisible());
 await page.getByRole('alert').filter({hasText:'自动重试'}).waitFor({state:'hidden'});assert.equal(await page.getByLabel('类目说明',{exact:true}).inputValue(),'保留人工输入');
 mode='denied';await page.getByRole('button',{name:'刷新关键词状态',exact:true}).click();await page.getByRole('alert').filter({hasText:'没有访问权限'}).waitFor();const stopped=reads;await page.waitForTimeout(2400);assert.equal(reads,stopped);
 assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);
});
