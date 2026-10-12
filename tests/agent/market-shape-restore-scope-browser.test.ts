import assert from 'node:assert/strict';
import test from 'node:test';
import {chromium, type Page} from 'playwright';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {shapePageRun, shapeRunId,shapeRevision} from './helpers/market-shape-page-fixture';
import {openShapeTaskRecovery} from './helpers/open-market-admin-tools';

test('shape restoration binds saved scope without overwriting newer drafts or other modules', {timeout:90_000}, async t => {
  const server=await createServer({configFile:false,cacheDir:'test-results/shape-restore-vite',define:{'process.env':'{}'},plugins:[react()],server:{host:'127.0.0.1',port:0,hmr:false,forwardConsole:false}});
  await server.listen();
  const browser=await chromium.launch();
  t.after(async()=>{await browser.close();await server.close()});
  const origin=server.resolvedUrls!.local[0].replace(/\/$/,''), current=shapePageRun();
  current.run.status='succeeded';
  current.run.scope={...current.run.scope,marketplace:'UK',currency:'GBP',fromMonth:'2026-06',toMonth:'2026-07'};
  const newer=shapePageRun();newer.run.id='71000000-0000-4000-8000-000000000005';newer.run.status='succeeded';newer.run.scope.nodeIdPath='4:5:6';
  let writes=0, reads=0, release:(()=>void)|undefined,newerRelease:(()=>void)|undefined,newerReads=0,writeRelease:(()=>void)|undefined;
  const base='?themeView=shapes&marketShapeNode=&marketNode=999999&marketSite=US&marketMonth=2026-08&marketFrom=2026-08&marketKeywordNode=888888&marketKeywordSite=US&marketKeywordFrom=2026-08&marketKeywordMonth=2026-08';
  const page=await browser.newPage();page.setDefaultTimeout(5000);
  await page.route('**/*',async route=>{
    const request=route.request(), url=new URL(request.url());
    if(url.origin!==origin)return route.abort();
    if(request.isNavigationRequest())return route.fulfill({contentType:'text/html',body:await server.transformIndexHtml('/',`<html><body><div id="root"></div><script type="module">import React from 'react';import {createRoot} from 'react-dom/client';import {MarketResearchSection} from '/app/market-research-section.tsx';createRoot(document.getElementById('root')).render(React.createElement(MarketResearchSection,{sessionIdentity:'shape-restore-test',showAuditDetails:true}));</script></body></html>`)});
    if(!url.pathname.startsWith('/api/'))return route.continue();
    if(request.method()!=='GET'){writes++;if(writeRelease)await new Promise<void>(resolve=>{writeRelease=resolve});return route.fulfill({status:500,json:{error:'Synthetic save unavailable'}})}
    if(url.pathname.includes('/shape-price/revisions/'))return route.fulfill({json:{revision:shapeRevision()}});
    if(url.pathname.endsWith(`/runs/${shapeRunId}/shape-price`)){
      reads++;
      if(release)await new Promise<void>(resolve=>{release=resolve});
      return route.fulfill({json:current});
    }
    if(url.pathname.endsWith(`/runs/${newer.run.id}/shape-price`)){newerReads++;if(newerRelease)await new Promise<void>(resolve=>{newerRelease=resolve});return route.fulfill({json:newer});}
    if(url.pathname.endsWith('/market-research/jobs'))return route.fulfill({json:{jobs:[]}});
    return route.fulfill({status:404,json:{error:'no saved fixture'}});
  });
  const node=page.getByLabel('类目节点',{exact:true});
  async function restore(){await openShapeTaskRecovery(page);await page.getByLabel('形态任务编号').fill(shapeRunId);await page.getByRole('button',{name:'读取任务',exact:true}).click()}
  async function restored(){await page.waitForFunction(()=>document.querySelector<HTMLInputElement>('input[aria-label="类目节点"]')?.value==='1:2:3')}
  async function reportLoaded(p:Page){await p.getByText('Shelf lamp',{exact:true}).waitFor()}

  await t.test('explicit restore fills an empty query and enables the recollection confirmation',async()=>{
    await page.goto(origin+base);await node.waitFor();await restore();await restored();
    assert.equal(await page.getByRole('button',{name:'英国站',exact:true}).getAttribute('aria-pressed'),'true');
    assert.equal(await page.getByLabel('起始月').inputValue(),'2026-06');
    assert.equal(await page.getByLabel('结束月').inputValue(),'2026-07');
    const params=new URL(page.url()).searchParams;
    assert.equal(params.get('marketShapeNode'),'1:2:3');assert.equal(params.get('marketShapeSite'),'UK');
    assert.equal(params.get('marketShapeFrom'),'2026-06');assert.equal(params.get('marketShapeMonth'),'2026-07');
    assert.equal(params.get('marketNode'),'999999');assert.equal(params.get('marketKeywordNode'),'888888');
    await page.getByRole('button',{name:'重新采集',exact:true}).click();
    await page.getByRole('button',{name:'确认重新采集 100 件',exact:true}).waitFor();
    await page.getByRole('button',{name:'取消',exact:true}).click();assert.equal(writes,0);
  });
  await t.test('explicit restore adopts a different saved scope; state refresh and page refresh preserve edited conditions',async()=>{
    await page.goto(origin+base.replace('marketShapeNode=','marketShapeNode=777777'));await node.waitFor();
    await restore();await restored();await node.fill('666666');
    await Promise.all([page.waitForResponse(response=>response.url().endsWith(`/runs/${shapeRunId}/shape-price`)),page.getByRole('button',{name:'刷新形态状态',exact:true}).click()]);await reportLoaded(page);
    assert.equal(await node.inputValue(),'666666');
    await page.reload();await reportLoaded(page);assert.equal(await node.inputValue(),'666666');
    const nav=page.getByRole('navigation',{name:'市场调研模块'});
    await nav.getByRole('button',{name:'市场总览',exact:true}).click();
    assert.equal(await page.getByRole('region',{name:'市场总览查询条件'}).getByLabel('类目节点或路径').inputValue(),'999999');
    await nav.getByRole('button',{name:'商品形态及价格带',exact:true}).click();await reportLoaded(page);
    assert.equal(await node.inputValue(),'666666');assert.equal(writes,0);
  });
  await t.test('a saved task deep link with missing conditions backfills scope and survives refresh',async()=>{
    await page.goto(origin+base+'&shapeRun='+shapeRunId);await restored();await reportLoaded(page);
    await page.reload();await restored();await reportLoaded(page);
    assert.equal(await page.getByLabel('起始月').inputValue(),'2026-06');assert.equal(writes,0);
  });
  await t.test('late reads never replace a query edited while task restoration was pending',async()=>{
    for(const explicit of [true,false]){
      await page.goto(origin+base);await node.waitFor();
      release=()=>{};const before=reads;
      if(explicit)await restore();else await page.goto(origin+base+'&shapeRun='+shapeRunId);
      await page.waitForFunction(()=>document.body.textContent?.includes('正在读取形态任务'));
      while(reads===before)await page.waitForTimeout(10);
      await node.fill('555555');release!();release=undefined;await reportLoaded(page);
      assert.equal(await node.inputValue(),'555555');assert.equal(new URL(page.url()).searchParams.get('marketShapeNode'),'555555');
    }
    assert.equal(writes,0);
  });
  await t.test('failed target retains report, URL and manual draft',async()=>{
    await page.goto(origin+base+'&shapeRun='+shapeRunId);await reportLoaded(page);
    await page.getByLabel('修订说明').fill('keep my manual draft');await openShapeTaskRecovery(page);
    await page.getByLabel('形态任务编号').fill('00000000-0000-4000-8000-000000000999');
    await page.getByRole('button',{name:'读取任务',exact:true}).click();
    await page.getByText(/目标任务读取失败/).waitFor();await reportLoaded(page);
    assert.equal(new URL(page.url()).searchParams.get('shapeRun'),shapeRunId);
    assert.equal(await page.getByLabel('修订说明').inputValue(),'keep my manual draft');assert.equal(writes,0);
  });
  await t.test('successful target requires discard confirmation and cancellation keeps edits',async()=>{
    await page.goto(origin+base+'&shapeRun='+shapeRunId);await reportLoaded(page);
    await page.getByLabel('修订说明').fill('keep until approved');await openShapeTaskRecovery(page);
    await page.getByLabel('形态任务编号').fill(newer.run.id);await page.getByRole('button',{name:'读取任务',exact:true}).click();
    await page.getByRole('button',{name:'保留修改',exact:true}).click();
    assert.equal(new URL(page.url()).searchParams.get('shapeRun'),shapeRunId);
    assert.equal(await page.getByLabel('修订说明').inputValue(),'keep until approved');
    await page.getByRole('button',{name:'读取任务',exact:true}).click();
    await page.getByRole('button',{name:'放弃修改并切换',exact:true}).click();
    await page.waitForFunction(()=>new URL(location.href).searchParams.get('shapeRun')==='71000000-0000-4000-8000-000000000005');
    assert.equal(await page.getByLabel('修订说明').inputValue(),'');assert.equal(writes,0);
  });
  await t.test('target cancellation and unmount invalidate delayed responses',async()=>{
    for(const unmount of [false,true]){
      await page.goto(origin+base+'&shapeRun='+shapeRunId);await reportLoaded(page);await openShapeTaskRecovery(page);
      newerRelease=()=>{};const before=newerReads;
      await page.getByLabel('形态任务编号').fill(newer.run.id);await page.getByRole('button',{name:'读取任务',exact:true}).click();
      while(newerReads===before)await page.waitForTimeout(10);
      if(unmount)await page.getByRole('navigation',{name:'市场调研模块'}).getByRole('button',{name:'市场总览',exact:true}).click();
      else await page.getByRole('button',{name:'取消读取',exact:true}).click();
      newerRelease!();newerRelease=undefined;await page.waitForTimeout(100);
      assert.equal(new URL(page.url()).searchParams.get('shapeRun'),shapeRunId);
      if(!unmount)await reportLoaded(page);
    }
    assert.equal(writes,0);
  });
  await t.test('new edits while awaiting GET or discard are rechecked and same-task refresh preserves them',async()=>{
    await page.goto(origin+base+'&shapeRun='+shapeRunId);await reportLoaded(page);await openShapeTaskRecovery(page);
    newerRelease=()=>{};const before=newerReads;
    await page.getByLabel('形态任务编号').fill(newer.run.id);await page.getByRole('button',{name:'读取任务',exact:true}).click();
    while(newerReads===before)await page.waitForTimeout(10);
    await node.fill('333333');await page.getByLabel('修订说明').fill('edited during GET');
    newerRelease!();newerRelease=undefined;
    await page.getByRole('button',{name:'放弃修改并切换',exact:true}).waitFor();
    await page.getByLabel('修订说明').fill('edited during confirmation');
    await page.getByRole('button',{name:'放弃修改并切换',exact:true}).click();
    assert.equal(new URL(page.url()).searchParams.get('shapeRun'),shapeRunId);
    await page.getByRole('button',{name:'放弃修改并切换',exact:true}).click();
    await page.waitForFunction(()=>new URL(location.href).searchParams.get('shapeRun')==='71000000-0000-4000-8000-000000000005');
    assert.equal(await node.inputValue(),'333333');
    await page.getByLabel('修订说明').fill('same-task draft');
    await page.getByLabel('形态任务编号').fill(newer.run.id);await page.getByRole('button',{name:'读取任务',exact:true}).click();
    await page.getByRole('status').filter({hasText:'正在读取目标任务'}).waitFor({state:'hidden'});
    assert.equal(await page.getByLabel('修订说明').inputValue(),'same-task draft');assert.equal(await node.inputValue(),'333333');assert.equal(writes,0);
  });
  await t.test('an older pending task cannot overwrite a newly restored task',async()=>{
    await page.goto(origin+base);await node.waitFor();release=()=>{};const before=reads;await restore();
    while(reads===before)await page.waitForTimeout(10);
    await page.getByLabel('形态任务编号').fill(newer.run.id);await page.getByRole('button',{name:'读取任务',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector<HTMLInputElement>('input[aria-label="类目节点"]')?.value==='4:5:6');
    release!();release=undefined;
    await page.getByRole('button',{name:'刷新形态状态',exact:true}).click();await reportLoaded(page);
    assert.equal(await node.inputValue(),'4:5:6');assert.equal(new URL(page.url()).searchParams.get('shapeRun'),newer.run.id);
    assert.equal(writes,0);
  });
  await t.test('failed target and same-task refresh retain historical version selection',async()=>{
    const revision=shapeRevision();current.run.latestRevision=revision;current.run.history=[{revisionId:revision.revisionId,ordinal:1,createdAt:revision.createdAt}];
    await page.goto(origin+base+'&shapeRun='+shapeRunId);await reportLoaded(page);
    await page.getByLabel('形态报告版本').selectOption(revision.revisionId);
    await page.getByText('正在读取此版本…',{exact:true}).waitFor({state:'hidden'});
    await openShapeTaskRecovery(page);await page.getByLabel('形态任务编号').fill('00000000-0000-4000-8000-000000000999');
    await page.getByRole('button',{name:'读取任务',exact:true}).click();await page.getByText(/目标任务读取失败/).waitFor();
    assert.equal(await page.getByLabel('形态报告版本').inputValue(),revision.revisionId);
    await restore();await page.getByRole('status').filter({hasText:'正在读取目标任务'}).waitFor({state:'hidden'});
    assert.equal(await page.getByLabel('形态报告版本').inputValue(),revision.revisionId);assert.equal(writes,0);
  });
  await t.test('saving blocks target restores until write settles',async()=>{
    await page.goto(origin+base+'&shapeRun='+shapeRunId);await reportLoaded(page);await openShapeTaskRecovery(page);
    writeRelease=()=>{};await page.getByLabel('修订说明').fill('save in progress');
    await page.getByRole('button',{name:'确认并重新计算',exact:true}).click();
    assert.equal(await page.getByRole('button',{name:'读取任务',exact:true}).isDisabled(),true);
    assert.equal(await page.getByLabel('形态任务编号').isDisabled(),true);assert.equal(new URL(page.url()).searchParams.get('shapeRun'),shapeRunId);
    while(writes===0)await page.waitForTimeout(10);writeRelease!();writeRelease=undefined;
    await page.getByText('Synthetic save unavailable',{exact:true}).waitFor();assert.equal(writes,1);
  });
});
