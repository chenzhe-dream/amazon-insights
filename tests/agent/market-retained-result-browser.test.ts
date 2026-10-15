import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {chromium} from 'playwright';

test('four module result retention survives refresh and fails closed across scope and authorization', {timeout:90000}, async t => {
  const server=await createServer({configFile:false,plugins:[react()],server:{host:'127.0.0.1',port:0,hmr:false,forwardConsole:false}});await server.listen();
  const browser=await chromium.launch({headless:true});t.after(async()=>{await browser.close();await server.close();});
  const origin=server.resolvedUrls!.local[0].replace(/\/$/,'');
  for(const runKey of ['overviewRun','shapeRun','keywordRun','themeRun']) await t.test(runKey,async()=>{
    const page=await browser.newPage();page.setDefaultTimeout(6000);page.on('pageerror',error=>console.error('retained browser error',error.message));
    const oldId=randomUUID(),newId=randomUUID(),scope={organizationId:'org-a',researchId:randomUUID(),marketplace:'US',nodeIdPath:'12:34',currency:'USD',fromMonth:'2026-09',toMonth:'2026-09'};
    const saved={id:oldId,scope,params:{poolSize:100},steps:[],usable:true};
    let current={...saved,id:newId,usable:false,steps:[{current:true,status:'failed',errorCode:'quota-exhausted'}]};let reads=0,writes=0,forbidden=false;
    await page.route('**/*',async route=>{
      const request=route.request(),url=new URL(request.url());if(url.origin!==origin)return route.abort();
      if(request.method()!=='GET'){writes++;return route.abort();}
      if(request.isNavigationRequest())return route.fulfill({contentType:'text/html',body:await server.transformIndexHtml('/'+runKey,`<div id="root"></div><script type="module">
        import React from 'react';import {createRoot} from 'react-dom/client';
        import {MarketRetainedResult} from '/app/market-retained-result.tsx';
        import {rememberPreviousMarketRun} from '/app/lib/market-retained-result.ts';
        const initial=${JSON.stringify(current)};
        window.remember=(next,prior)=>rememberPreviousMarketRun('${runKey}',next,prior);
        window.remember(initial.id,'${oldId}');
        const read=async(id,signal)=>{const response=await fetch('/saved/'+id,{signal});if(!response.ok)throw Error('forbidden');return response.json();};
        function App(){const [run,setRun]=React.useState(initial);window.update=setRun;return React.createElement(MarketRetainedResult,{current:run,runKey:'${runKey}',read,usable:row=>row.usable},row=>React.createElement('p',null,'原报告 '+row.id+' 商品100'));}
        createRoot(document.getElementById('root')).render(React.createElement(App));
      </script>`)});
      if(url.pathname.startsWith('/saved/')){reads++;return forbidden?route.fulfill({status:403,json:{error:'forbidden'}}):route.fulfill({json:saved});}
      return route.continue();
    });
    await page.goto(origin+'/'+runKey);await page.getByRole('region',{name:'保留的上次报告'}).waitFor();
    assert.match(await page.locator('body').innerText(),/数据源额度已耗尽/);assert.match(await page.locator('body').innerText(),/商品100/);assert.equal(reads,1);
    await page.reload();await page.getByRole('region',{name:'保留的上次报告'}).waitFor();assert.equal(reads,2);assert.equal(writes,0);
    // A quota failure can still produce a partial report (for example overview's
    // freshly collected basic metrics). It must not hide the previous full report.
    current={...current,usable:true};
    await page.evaluate(value=>(window as any).update(value),current);
    await page.waitForTimeout(80);
    assert.equal(await page.getByRole('region',{name:'保留的上次报告'}).count(),1,'partial quota result keeps the historical report');
    await page.reload();await page.getByRole('region',{name:'保留的上次报告'}).waitFor();
    await page.evaluate(value=>(window as any).update({...value,steps:[]}),current);await page.getByRole('region',{name:'保留的上次报告'}).waitFor({state:'detached'});
    current={...current,usable:false};
    current={...current,id:randomUUID(),scope:{...scope,marketplace:'DE',currency:'EUR'}};
    await page.evaluate(({current,oldId})=>{(window as any).remember(current.id,oldId);(window as any).update(current);},{current,oldId});
    await page.waitForResponse(response=>response.url().includes('/saved/'));await page.waitForTimeout(60);
    assert.equal(await page.getByRole('region',{name:'保留的上次报告'}).count(),0);
    forbidden=true;current={...current,id:randomUUID(),scope};
    await page.evaluate(({current,oldId})=>{(window as any).remember(current.id,oldId);(window as any).update(current);},{current,oldId});
    await page.getByRole('alert').waitFor();assert.equal(await page.getByText(/商品100/).count(),0);assert.equal(writes,0);
    await page.close();
  });
});
