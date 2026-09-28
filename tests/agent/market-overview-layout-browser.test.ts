import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdir,writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {overviewDistributionDetails} from './helpers/market-overview-page-fixture';
import {normalizeMarketOverviewDistribution} from '../../server/domain/market-research/overview-distributions';

test('overview concentration charts remain readable and product details collapse independently',{timeout:60000},async t=>{
 const out='test-results/overview-layout';await mkdir(out,{recursive:true});
 const detail=overviewDistributionDetails();
 const distribution=normalizeMarketOverviewDistribution('market_product_concentration',{data:Array.from({length:100},(_,i)=>({asin:`B${String(i).padStart(9,'0')}`,totalUnits:100-i,totalRevenue:(100-i)*20}))});
 const entry={...detail.numbers.distributions![0],operation:'market_product_concentration' as const,distribution};
 detail.numbers.distributions!.push(entry);
 for(const month of ['2026-06','2026-07','2026-08'])detail.numbers.distributions!.push({...entry,month,operation:'market_seller_type_concentration',status:month==='2026-07'?'failed':'partial',distribution:month==='2026-07'?null:normalizeMarketOverviewDistribution('market_seller_type_concentration',{data:[{label:'FBA',asinNum:month==='2026-06'?80:96,units:90},{label:'FBM',asinNum:month==='2026-06'?20:4,units:10}]})});
 const content=normalizeMarketOverviewDistribution('market_ebc_distribution',{data:['有A+有视频','有A+无视频','无A+有视频','无A+无视频'].flatMap((label,i)=>[{label,products:1,units:(i+1)*10},{label:`新品${label}`,products:1,units:5}])});
 detail.numbers.distributions!.push({...entry,operation:'market_ebc_distribution',distribution:content});
 await writeFile(out+'/entry.jsx',`import React from 'react';import{createRoot}from'react-dom/client';import{MarketOverviewReferenceSections}from'/app/market-overview-reference-sections';import{MarketOverviewConcentrationChart}from'/app/market-overview-concentration-chart';import'/app/globals.css';import'/app/market-ui-reference.css';import'/app/market-research.css';const d=${JSON.stringify(detail)},rows=${JSON.stringify(distribution.rows)};createRoot(document.getElementById('root')).render(<main className="market-ui-reference" style={{padding:30}}><MarketOverviewReferenceSections entry={d.entry} detail={d} overview={null}/>{['brand','seller'].map(kind=><section data-kind={kind} key={kind}><MarketOverviewConcentrationChart rows={rows} kind={kind} headTopN={10} currency="USD"/></section>)}</main>);`);
 const server=await createServer({configFile:false,cacheDir:out+'/vite',define:{'process.env':'{}'},plugins:[react()],server:{host:'127.0.0.1',port:0,hmr:false,forwardConsole:false}});await server.listen();t.after(()=>server.close());
 const browser=await chromium.launch();t.after(()=>browser.close());const page=await browser.newPage({viewport:{width:1500,height:1000}}),origin=server.resolvedUrls!.local[0],errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async route=>{if(!route.request().url().startsWith(origin))return route.abort();if(route.request().isNavigationRequest())return route.fulfill({contentType:'text/html',body:await server.transformIndexHtml('/',`<html><body><div id="root"></div><script type="module" src="/${out}/entry.jsx"></script></body></html>`)});return route.continue();});
 await page.goto(origin);const section=page.locator('[data-report-section="product-crn"]');await section.locator('svg').waitFor();
 for(const selector of ['[data-report-section="product-crn"]','[data-kind="brand"]','[data-kind="seller"]']){
  const chart=page.locator(selector+' svg'),box=await chart.boundingBox();assert.ok(box&&box.height>=200&&box.height<=300,`${selector}: ${JSON.stringify(box)}`);
  assert.equal(await chart.locator('rect[fill="#c4b5fd"]').count(),100);
 }
 const table=section.getByRole('region',{name:'商品集中度明细'});assert.equal(await table.locator('tbody').isVisible(),false);
 const expand=table.getByRole('button',{name:'展开商品明细'});await expand.click();assert.equal(await table.locator('tbody tr').count(),10);assert.equal(await expand.count(),0);
 const firstRow=await table.locator('tbody tr').first().boundingBox();assert.ok(firstRow&&firstRow.height<=36);
 await table.getByRole('button',{name:'收起商品明细'}).click();assert.equal(await table.locator('tbody').isVisible(),false);
 await section.getByRole('button',{name:'返回前10商品',exact:true}).click();assert.equal(await section.locator('rect[fill="#c4b5fd"]').count(),10);
 await section.getByRole('button',{name:'全部(100)',exact:true}).click();assert.equal(await section.locator('rect[fill="#c4b5fd"]').count(),100);
 await section.scrollIntoViewIfNeeded();await page.screenshot({path:out+'/concentration-collapsed.png'});
 await table.getByRole('button',{name:'展开商品明细'}).click();await page.screenshot({path:out+'/concentration-expanded.png'});
 const sellers=page.locator('[data-report-section="seller-type"]');
 assert.equal(await sellers.locator('svg').count(),1,'only the selected month is drawn');
 const month=sellers.getByRole('button',{name:'2026-08',exact:true});assert.equal(await month.getAttribute('aria-pressed'),'true');
 const distBox=await sellers.locator('svg').boundingBox();assert.ok(distBox&&distBox.height<=240);
 await sellers.getByRole('button',{name:'查看分组 FBA',exact:true}).focus();await page.keyboard.press('Enter');assert.match(await sellers.getByRole('status').innerText(),/商品 96/);
 await sellers.getByRole('button',{name:'2026-07',exact:true}).click();assert.equal(await sellers.locator('svg').count(),0);assert.match(await sellers.innerText(),/采集失败/);
 await sellers.getByRole('button',{name:'2026-06',exact:true}).click();await sellers.getByRole('button',{name:'查看分组 FBA',exact:true}).click();assert.match(await sellers.getByRole('status').innerText(),/商品 80/);
 await sellers.scrollIntoViewIfNeeded();await page.screenshot({path:out+'/distribution-months.png'});
 const pies=page.locator('[data-report-section="ebc"]');assert.equal(await pies.locator('svg.overview-content-pie').count(),2);
 const left=await pies.locator('svg').first().boundingBox(),right=await pies.locator('svg').last().boundingBox();assert.ok(left&&right&&left.height===260&&Math.abs(left.y-right.y)<1&&right.x>left.x+left.width);
 await pies.getByRole('button',{name:/有A\+有视频\s*10%/}).click();assert.match(await pies.getByRole('status').innerText(),/销量 10/);
 await pies.scrollIntoViewIfNeeded();await page.screenshot({path:out+'/content-pies.png'});
 assert.deepEqual(errors,[]);
});
