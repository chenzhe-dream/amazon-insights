import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdir} from 'node:fs/promises';
import {chromium} from 'playwright';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {overviewRun,overviewDistributionDetails} from './helpers/market-overview-page-fixture';
import {shapeSorftimePageRun} from './helpers/market-shape-sorftime-page-fixture';

test('both market modules consolidate admin tools and omit them for members without losing reports or draft editing',{timeout:90000},async t=>{
 const out='test-results/market-admin-tools';await mkdir(out,{recursive:true});
 const server=await createServer({configFile:false,cacheDir:out+'/vite',define:{'process.env':'{}'},plugins:[react()],server:{host:'127.0.0.1',port:0,hmr:false,forwardConsole:false}});await server.listen();
 const browser=await chromium.launch();t.after(async()=>{await browser.close();await server.close()});
 const origin=server.resolvedUrls!.local[0],overview=overviewRun(),detail=overviewDistributionDetails(),shape=shapeSorftimePageRun(2,2),errors:string[]=[],writes:string[]=[];
 let draft={version:0,items:[] as Array<{asin:string;included:boolean;label:string|null}>,catalogLabels:[] as string[],updatedAt:null as string|null};
 for(const role of ['member','admin'] as const){
  const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(6000);page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',async route=>{const req=route.request(),url=new URL(req.url());if(url.origin!==new URL(origin).origin)return route.abort();
   if(req.isNavigationRequest())return route.fulfill({contentType:'text/html',body:await server.transformIndexHtml('/', '<html><body style="margin:24px"><div id="root"></div><script type="module" src="/tests/agent/helpers/market-admin-tools-harness.tsx"></script></body></html>')});
   if(!url.pathname.startsWith('/api/'))return route.continue();
   if(url.pathname.endsWith('/auth/session'))return route.fulfill({json:{authenticated:true,user:{id:'66666666-6666-4666-8666-666666666666',organizationId:shape.run.scope.organizationId,email:'fixture@example.com',displayName:'Fixture',role,status:'active',createdAt:'2026-09-01T00:00:00.000Z',updatedAt:'2026-09-01T00:00:00.000Z'},sessionIdentity:'a'.repeat(43),canViewUserPresence:false}});
   if(req.method()!=='GET'){writes.push(url.pathname);if(url.pathname.endsWith('/shape-price/draft')){const body=req.postDataJSON();draft={items:body.items,catalogLabels:body.catalogLabels,version:draft.version+1,updatedAt:new Date().toISOString()};return route.fulfill({json:{draft}})}return route.fulfill({json:{}});}
   if(url.pathname.endsWith('/shape-price/draft'))return route.fulfill({json:{draft}});
   if(url.pathname.endsWith('/shape-price'))return route.fulfill({json:shape});
   if(url.pathname.includes('/reports/'))return route.fulfill({json:detail});
   if(url.pathname.endsWith('/overview'))return route.fulfill({json:overview});
   if(url.pathname.endsWith('/market-research/jobs'))return route.fulfill({json:{jobs:[]}});
   if(url.pathname.endsWith('/favorites'))return route.fulfill({json:{favorites:[]}});
   return route.fulfill({status:404,json:{error:'no fixture'}});
  });
  for(const view of ['overview','shapes']){
   await page.goto(origin+`?fixtureRole=${role}&themeView=${view}&${view==='overview'?'overviewRun='+overview.run.id:'shapeRun='+shape.run.id}`);
   if(view==='overview')await page.getByRole('region',{name:'已保存总览报告'}).waitFor();
   else{await page.getByLabel('B000000001 人工形态',{exact:true}).waitFor();await page.getByText('草稿：已保存',{exact:true}).waitFor();}
   const panel=page.getByRole('group',{name:'管理员工具',exact:true});
   if(role==='member'){
    assert.equal(await panel.count(),0);
    for(const text of ['分析设置与任务管理','本报告的分析规则','采集历史与状态','恢复已有形态任务','来源步骤详情','数据完整度与缺失说明'])assert.equal(await page.getByText(text,{exact:true}).count(),0,`${view}: member must not mount ${text}`);
    if(view==='shapes'){await page.getByLabel('B000000001 人工形态',{exact:true}).fill('落地灯');await page.getByText('草稿：已保存',{exact:true}).waitFor();assert.equal(draft.items.find(item=>item.asin==='B000000001')?.label,'落地灯');}
   }else{
    assert.equal(await panel.count(),1);assert.equal(await panel.getAttribute('open'),null);
    await panel.locator(':scope > summary').click();
    const label=view==='overview'?'分析设置与任务管理':'来源步骤详情';assert.equal(await panel.getByText(label,{exact:true}).isVisible(),true);
    await panel.getByText(label,{exact:true}).click();
    if(view==='shapes')await panel.getByText('恢复已有形态任务',{exact:true}).click();
    assert.equal(await panel.getByRole('button',{name:view==='overview'?'刷新总览状态':'刷新形态状态',exact:true}).count(),1);
    if(view==='overview')for(const title of ['已保存指标与原始来源','分析维度覆盖与缺口','本报告的分析规则','报告版本与来源身份'])assert.equal(await panel.getByText(title,{exact:true}).isVisible(),true);
    await panel.evaluate(el=>el.scrollIntoView({block:'start'}));await page.screenshot({path:out+`/${view}-admin.png`});
    if(view==='shapes'){
     await page.getByRole('button',{name:'切换为普通账号',exact:true}).click();
     assert.equal(await panel.count(),0);assert.equal(await page.getByText('恢复已有形态任务',{exact:true}).count(),0);
     assert.equal(await page.getByLabel('B000000001 人工形态',{exact:true}).inputValue(),'落地灯','permission change preserves the business draft');
    }
   }
  }
  await page.close();
 }
 assert.deepEqual(errors,[]);assert.ok(writes.length>0);assert.ok(writes.every(path=>path.endsWith('/shape-price/draft')),'viewing admin panels never creates tasks');
});
