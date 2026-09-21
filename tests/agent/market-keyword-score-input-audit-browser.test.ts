import assert from 'node:assert/strict';
import test from 'node:test';
import {chromium} from 'playwright';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {keywordRuleFixture} from './helpers/market-keyword-rule-fixture';
import {buildMarketKeywordScoreInputAudit} from '../../server/domain/market-research/keyword-score-input-audit';
import {canonicalJsonSha256 as digest} from '../../server/runtime/model-request-accounting';

test('operators inspect versioned source gaps from existing details without starting analysis',{timeout:60000},async t=>{
 const {response}=keywordRuleFixture({aba:true});
 response.run.scoreInputAudit=buildMarketKeywordScoreInputAudit({facts:response.run.facts!,report:response.run.ruleReport!});
 const before=digest(response),server=await createServer({configFile:false,cacheDir:'test-results/keyword-score-audit-vite',define:{'process.env':'{}'},plugins:[react()],server:{host:'127.0.0.1',port:0,hmr:false,forwardConsole:false}});
 await server.listen();const browser=await chromium.launch({headless:true});t.after(async()=>{await browser.close();await server.close();});
 const origin=server.resolvedUrls!.local[0].replace(/\/$/,''),page=await browser.newPage({viewport:{width:1440,height:1050}}),unexpected:string[]=[],errors:string[]=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/*',async route=>{const request=route.request(),url=new URL(request.url());
  if(url.origin!==origin||request.method()!=='GET'){unexpected.push(`${request.method()} ${url.href}`);return route.abort();}
  if(request.isNavigationRequest())return route.fulfill({contentType:'text/html',body:await server.transformIndexHtml('/',`<!doctype html><html><body style="margin:24px"><div id="root"></div><script type="module" src="/tests/agent/helpers/market-keyword-browser-harness.tsx"></script></body></html>`)});
  if(url.pathname.startsWith('/api/')){if(url.pathname.endsWith('/keywords'))return route.fulfill({json:response});unexpected.push(url.pathname);return route.abort();}
  return route.continue();
 });
 await page.goto(`${origin}/?keywordRun=${response.run.id}`);
 const report=page.getByLabel('关键词 W5 与 PVS 规则报告',{exact:true});await report.waitFor();
 await report.getByText('评分依据',{exact:true}).click();
 const audit=report.getByLabel('评分输入核对',{exact:true});await audit.waitFor();
 assert.match(await audit.innerText(),/成员级 ABA 点击份额已保存/);
 assert.match(await audit.innerText(),/来源窗口未注明/);assert.match(await audit.innerText(),/趋势推荐竞价币种未确认/);
 await audit.getByText('查看本簇原词竞价与 ABA 来源',{exact:true}).click();
 assert.match(await audit.innerText(),/ABA 前三点击份额：0.0%/);assert.match(await audit.innerText(),/采集失败/);
 assert.match(await audit.innerText(),/top3_click_shares/);
 await report.getByText('规则与报告版本',{exact:true}).click();
 assert.match(await report.innerText(),/0.28 × S1/);assert.match(await report.innerText(),/market-keyword-score-input-audit\/v1/);
 assert.match(await report.getByRole('region',{name:'PVS 需求簇评分表',exact:true}).locator('tbody').innerText(),/待验证/);
 await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);assert.equal(digest(response),before);
});
