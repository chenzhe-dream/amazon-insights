import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {chromium} from 'playwright';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {keywordPageRun,keywordRunId} from './helpers/market-keyword-page-fixture';

test('business page keeps editing/history behind an entry and restricts technical panels to admins',{timeout:60000},async t=>{
 const out='test-results/keyword-ui-entry-20260928';await mkdir(out,{recursive:true});
 const server=await createServer({configFile:false,cacheDir:out+'/vite',define:{'process.env':'{}'},plugins:[react()],server:{host:'127.0.0.1',port:0,hmr:false,forwardConsole:false}});await server.listen();
 const browser=await chromium.launch();t.after(async()=>{await browser.close();await server.close();});const origin=server.resolvedUrls!.local[0].replace(/\/$/,''),page=await browser.newPage({viewport:{width:1536,height:1050}});page.setDefaultTimeout(6000);
 const response=keywordPageRun(),errors:string[]=[],writes:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async route=>{const r=route.request(),u=new URL(r.url());if(u.origin!==origin)return route.abort();if(r.isNavigationRequest())return route.fulfill({contentType:'text/html',body:await server.transformIndexHtml('/',`<html><body><div id="root"></div><script type="module" src="/tests/agent/helpers/market-keyword-browser-harness.tsx"></script></body></html>`)});if(!u.pathname.startsWith('/api/'))return route.continue();if(r.method()!=='GET')writes.push(u.pathname);return route.fulfill({json:response});});
 await page.goto(origin+'/?keywordRun='+keywordRunId);await page.getByRole('region',{name:'关键词参考月指标'}).waitFor();
 assert.equal(await page.getByRole('heading',{name:'已保存的人工报告',exact:true}).count(),0);
 assert.equal(await page.getByRole('button',{name:'管理员核对',exact:true}).count(),0);
 assert.equal(await page.getByText('事实版本与来源截止时间',{exact:true}).count(),0);
 assert.equal(await page.locator('select[multiple]:visible').count(),0);
 await page.getByRole('button',{name:'人工校对与历史版本',exact:true}).click();await page.getByText('人工校对与分类编辑',{exact:true}).click();await page.getByLabel('修订备注').fill('draft survives closing');
 await page.getByRole('button',{name:'关闭人工工作区',exact:true}).click();assert.equal(await page.locator('select[multiple]:visible').count(),0);
 await page.getByRole('button',{name:'人工校对与历史版本',exact:true}).click();assert.equal(await page.getByLabel('修订备注').inputValue(),'draft survives closing');await page.getByRole('button',{name:'关闭人工工作区',exact:true}).click();
 await page.screenshot({path:out+'/member.png'});
 await page.goto(origin+'/?keywordRun='+keywordRunId+'&audit=1');await page.getByRole('button',{name:'管理员核对',exact:true}).click();await page.getByText('事实版本与来源截止时间',{exact:true}).waitFor();await page.screenshot({path:out+'/admin.png'});
 assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);
});
