import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdir} from 'node:fs/promises';
import {chromium} from 'playwright';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {buildCheckedOverviewSynthesis} from '../../server/domain/market-research/overview-score-readiness';
import {projectMarketOverviewOriginalSynthesis} from '../../server/domain/market-research/overview-original-synthesis';
import {completeScoreFixture} from './helpers/overview-score-complete-fixture';
test('complete, partial and unavailable scores retain cards and render without misleading plots',{timeout:60000},async t=>{
 const server=await createServer({configFile:false,cacheDir:'test-results/overview-score-vite',define:{'process.env':'{}'},plugins:[react()],server:{host:'127.0.0.1',port:0,hmr:false,forwardConsole:false}});await server.listen();
 const browser=await chromium.launch();t.after(async()=>{await browser.close();await server.close();});
 const origin=server.resolvedUrls!.local[0].replace(/\/$/,''),page=await browser.newPage({viewport:{width:1500,height:1000}}),errors:string[]=[];
 page.on('pageerror',e=>errors.push(e.message));
 const wrap=(v:ReturnType<typeof buildCheckedOverviewSynthesis>)=>({version:6 as const,...v,inputGaps:[],sourceRefs:[],originalAssumptions:[]});
 const {niche,report}=completeScoreFixture(),full=wrap(buildCheckedOverviewSynthesis(niche,report));niche.brandCrn=null;const partial=wrap(buildCheckedOverviewSynthesis(niche,report));
 const empty=projectMarketOverviewOriginalSynthesis({scope:{organizationId:'11111111-1111-4111-8111-111111111111',researchId:'22222222-2222-4222-8222-222222222222',marketplace:'US',nodeIdPath:'1:2',fromMonth:'2026-08',toMonth:'2026-08',currency:'USD'},parameters:{headTopN:10,newProductMonths:6},sources:[]});
 const cases={full,partial,empty};
 await page.route('**/*',async route=>{const request=route.request(),url=new URL(request.url());if(url.origin!==origin)return route.abort();if(!request.isNavigationRequest())return route.continue();const result=cases[url.searchParams.get('case') as keyof typeof cases]??empty;
  return route.fulfill({contentType:'text/html',body:await server.transformIndexHtml('/',`<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:20px"><div id="root"></div><script>window.scoreResult=${JSON.stringify(result).replaceAll('<','\\u003c')}</script><script type="module" src="/tests/agent/helpers/overview-score-browser-harness.tsx"></script></body></html>`)});
 });
 await mkdir('test-results/overview-score-browser',{recursive:true});
 for(const [name,points] of [['full',6],['partial',5],['empty',0]] as const){await page.goto(`${origin}/?case=${name}`);const region=page.getByRole('region',{name:'原版市场概览总结'});await region.waitFor();assert.equal(await region.locator('[data-score-point]').count(),points);assert.equal(await region.locator('[data-score-polygon]').count(),name==='full'?1:0);assert.equal(await region.locator('.ss-market-synthesis-sections > li').count(),6);assert.doesNotMatch(await region.innerText(),/è¡|æœ|å¸/);assert.ok(await region.evaluate(e=>e.scrollWidth<=e.clientWidth+1));if(name!=='full')assert.match(await region.innerText(),/暂不评级/);await page.screenshot({path:`test-results/overview-score-browser/${name}.png`,fullPage:true});}
 assert.deepEqual(errors,[]);
});
