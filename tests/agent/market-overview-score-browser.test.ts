import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdir} from 'node:fs/promises';
import {chromium} from 'playwright';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {buildCheckedOverviewSynthesis} from '../../server/domain/market-research/overview-score-readiness';
import {buildItemCheckedOverviewSynthesis} from '../../server/domain/market-research/overview-item-scoring';
import {projectMarketOverviewOriginalSynthesis} from '../../server/domain/market-research/overview-original-synthesis';
import {completeScoreFixture} from './helpers/overview-score-complete-fixture';
test('complete, partial and unavailable scores retain cards and render without misleading plots',{timeout:60000},async t=>{
 const server=await createServer({configFile:false,cacheDir:'test-results/overview-score-vite',define:{'process.env':'{}'},plugins:[react()],server:{host:'127.0.0.1',port:0,hmr:false,forwardConsole:false}});await server.listen();
 const browser=await chromium.launch();t.after(async()=>{await browser.close();await server.close();});
 const origin=server.resolvedUrls!.local[0].replace(/\/$/,''),page=await browser.newPage({viewport:{width:1500,height:1000}}),errors:string[]=[];
 page.on('pageerror',e=>errors.push(e.message));
 const wrap=(v:ReturnType<typeof buildCheckedOverviewSynthesis>)=>({version:6 as const,...v,inputGaps:[],sourceRefs:[],originalAssumptions:[]});
 const {niche,report}=completeScoreFixture(),full=wrap(buildCheckedOverviewSynthesis(niche,report)),items=wrap(buildItemCheckedOverviewSynthesis(niche,report));niche.brandCrn=null;const partial=wrap(buildCheckedOverviewSynthesis(niche,report));
 const empty=projectMarketOverviewOriginalSynthesis({scope:{organizationId:'11111111-1111-4111-8111-111111111111',researchId:'22222222-2222-4222-8222-222222222222',marketplace:'US',nodeIdPath:'1:2',fromMonth:'2026-08',toMonth:'2026-08',currency:'USD'},parameters:{headTopN:10,newProductMonths:6},sources:[]});
 const cases={full,partial,empty,items};
 await page.route('**/*',async route=>{const request=route.request(),url=new URL(request.url());if(url.origin!==origin)return route.abort();if(!request.isNavigationRequest())return route.continue();const result=cases[url.searchParams.get('case') as keyof typeof cases]??empty;
  return route.fulfill({contentType:'text/html',body:await server.transformIndexHtml('/',`<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:20px"><div id="root"></div><script>window.scoreResult=${JSON.stringify(result).replaceAll('<','\\u003c')}</script><script type="module" src="/tests/agent/helpers/overview-score-browser-harness.tsx"></script></body></html>`)});
 });
 await mkdir('test-results/overview-score-browser',{recursive:true});
 for(const [name,points] of [['full',6],['partial',5],['empty',0]] as const){await page.goto(`${origin}/?case=${name}`);const region=page.getByRole('region',{name:'原版市场概览总结'});await region.waitFor();assert.equal(await region.locator('[data-score-point]').count(),points);assert.equal(await region.locator('[data-score-polygon]').count(),name==='full'?1:0);assert.equal(await region.locator('.ss-market-synthesis-sections > li').count(),6);assert.doesNotMatch(await region.innerText(),/è¡|æœ|å¸/);assert.ok(await region.evaluate(e=>e.scrollWidth<=e.clientWidth+1));if(name!=='full')assert.match(await region.innerText(),/暂不评级/);await page.screenshot({path:`test-results/overview-score-browser/${name}.png`,fullPage:true});}
 for(const role of ['member','admin']){
  await page.goto(`${origin}/?case=items&role=${role}`);const region=page.getByRole('region',{name:'原版市场概览总结'});await region.waitFor();
  assert.equal(await region.getByText(/评分项明细/).count(),0,'score audit does not interrupt the six conclusions');
  const sections=region.locator('.ss-market-synthesis-sections');
  const priceDetails=sections.getByText('查看价格带依据',{exact:true});await priceDetails.waitFor();
  const before=await sections.boundingBox();assert.ok(before&&before.height<650,'six conclusions fit a compact desktop section');
  assert.equal(await sections.getByText(/高毛利验证带/).isVisible(),false);
  await priceDetails.click();assert.equal(await sections.getByText(/高毛利验证带/).isVisible(),true);
  assert.equal(await sections.getByText('广告前毛利为模型估算，不等同于商品实际毛利。',{exact:true}).count(),1);
  assert.doesNotMatch(await sections.innerText(),/模型估算广告前毛利（非实际毛利）/);await priceDetails.click();
  const panel=page.getByRole('group',{name:'管理员工具',exact:true});
  if(role==='member')assert.equal(await panel.count(),0);
  else{await panel.locator(':scope > summary').click();await panel.getByText('总览评分项明细',{exact:true}).click();assert.equal(await panel.locator('h5').count(),6);assert.match(await panel.innerText(),/分组折算前/);}
  assert.equal(await region.locator('[data-score-polygon]').count(),1);assert.ok((await region.innerText()).includes(items.summary.gradeLabel!));
  await page.screenshot({path:`test-results/overview-score-browser/items-${role}.png`,fullPage:true});
 }
 assert.deepEqual(errors,[]);
});
