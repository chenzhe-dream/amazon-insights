import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdir,writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';

test('manual shape editing retains focus under an active shape filter and supports batch edits',{timeout:60000},async t=>{
 const out='test-results/shape-reference-editing';await mkdir(out,{recursive:true});
 const product=(asin:string)=>({rank:1,asin,title:'Fixture lamp',brand:'Fixture',imageUrl:'',monthlySalesVolume:10,monthlySalesAmount:200,sales:{last3Months:30,last6Months:60,y2024:120,y2025:120,monthsAvailable:24},monthlyTrend:{volume:[],amount:[]},price:20,categoryRank:'',productCategory:'',productShape:'未分类',productShapeHint:null,bsrRank:null,deliveryType:'',reviewCount:1,starRating:4,seller:'',sellerOrigin:null,onlineDate:'2024-01',grossProfitMargin:65,priceBand:'$20-30'});
 const report={marketplace:'US',sorftimeSite:'US',nodeId:'123',categoryName:'Fixture',fetchedAt:'2026-09-27T00:00:00Z',note:'',stats:{},history:{volume:[],amount:[],avgPrice:[],listingMonopoly:[],brandMonopoly:[],sellerMonopoly:[]},products:[product('B000000001'),product('B000000002')],productSalesTotals:{},topLinkCount:2};
 await writeFile(out+'/entry.jsx',`import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{MarketShapeReferenceView}from'/app/market-shape-reference/view';import'/app/globals.css';import'/app/warm-theme.css';import'/app/comparison-layout.css';import'/app/market-research.css';import'/app/market-shape-reference.css';function App(){const[a,setA]=useState({B000000002:'其他'});const[s,setS]=useState(['B000000001','B000000002']);const[locked,setLocked]=useState(false);return <><button onClick={()=>setLocked(true)}>测试只读版本</button><MarketShapeReferenceView disabled={locked} report={${JSON.stringify(report)}} assignments={a} selectedAsins={s} onAssignment={(asin,label)=>setA(old=>({...old,[asin]:label}))} onSelected={setS}/></>};createRoot(document.getElementById('root')).render(<App/>);`);
 const server=await createServer({configFile:false,cacheDir:out+'/vite',define:{'process.env':'{}'},plugins:[react()],server:{host:'127.0.0.1',port:0,hmr:false,forwardConsole:false}});await server.listen();t.after(()=>server.close());
 const browser=await chromium.launch({headless:true});t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),origin=server.resolvedUrls!.local[0];const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async route=>{if(!route.request().url().startsWith(origin))return route.abort();if(route.request().isNavigationRequest())return route.fulfill({contentType:'text/html',body:await server.transformIndexHtml('/',`<html><body><div id="root"></div><script type="module" src="/${out}/entry.jsx"></script></body></html>`)});return route.continue()});
 await page.goto(origin);
 const input=page.getByLabel('B000000001 人工形态',{exact:true});await input.waitFor();
 // The unfiltered controlled input must actually accept text, not merely focus.
 await input.fill('层架式');assert.equal(await input.inputValue(),'层架式');await input.fill('');
 await page.getByRole('button',{name:'筛选商品形态',exact:true}).click();await page.getByRole('checkbox',{name:'未分类',exact:true}).click();
 await input.click();await page.keyboard.type('shelf');
 assert.equal(await input.count(),1,'typing must not remove the focused row from a filtered table');
 assert.equal(await input.inputValue(),'shelf');
 await input.dispatchEvent('compositionstart');await input.fill('层架落地灯');await input.dispatchEvent('compositionend',{data:'层架落地灯'});assert.equal(await input.inputValue(),'层架落地灯');await page.keyboard.press('Tab');assert.equal(await input.count(),0,'after editing, the active filter must apply again');
 await page.getByRole('button',{name:'筛选商品形态',exact:true}).click();await page.getByRole('button',{name:'显示全部',exact:true}).click();await page.getByRole('button',{name:'筛选商品形态',exact:true}).click();
 await page.getByLabel('批量选择 B000000001',{exact:true}).check();await page.getByLabel('批量选择 B000000002',{exact:true}).check();await page.getByLabel('批量形态',{exact:true}).fill('弧形灯');await page.getByRole('button',{name:'批量设为此形态',exact:true}).click();
 assert.equal(await input.inputValue(),'弧形灯');assert.equal(await page.getByLabel('B000000002 人工形态',{exact:true}).inputValue(),'弧形灯');
 // Original distinct actions: clearing shape leaves the batch selection in place.
 await page.getByLabel('批量选择 B000000001',{exact:true}).check();await page.getByRole('button',{name:'批量清除形态',exact:true}).click();assert.equal(await input.inputValue(),'');assert.ok(await page.getByLabel('批量选择 B000000001',{exact:true}).isChecked());
 await input.fill('层架 · 灯');await page.keyboard.press('Tab');
 const shapeSection=page.locator('section').filter({has:page.getByRole('heading',{name:'商品形态 · 销量占比分析',exact:true})});
 await shapeSection.getByRole('button',{name:'形态销量局部筛选',exact:true}).click();await page.getByRole('checkbox',{name:'层架 · 灯',exact:true}).click();
 assert.equal(await page.getByLabel('选择 B000000001',{exact:true}).isChecked(),true);assert.equal(await page.getByLabel('选择 B000000002',{exact:true}).isChecked(),true);
 assert.equal(await shapeSection.locator('tbody tr:not(.shape-price-total-row)').count(),1);
 await page.getByText('管理形态名称',{exact:true}).click();await page.getByLabel('管理形态',{exact:true}).selectOption('弧形灯');await page.getByRole('button',{name:'删除形态',exact:true}).click();await page.getByText(/将把 1 件商品恢复为未分类/).waitFor();await page.getByRole('button',{name:'确认删除形态',exact:true}).click();assert.equal(await page.getByLabel('B000000002 人工形态',{exact:true}).inputValue(),'');
 const rect=await input.boundingBox();assert.ok(rect&&rect.height>=32&&rect.width>=110,JSON.stringify(rect));
 await page.getByLabel('搜索商品',{exact:true}).scrollIntoViewIfNeeded();
 await page.screenshot({path:out+'/annotation-desktop.png'});
 await page.setViewportSize({width:390,height:844});await input.scrollIntoViewIfNeeded();await page.screenshot({path:out+'/annotation-mobile.png'});await page.setViewportSize({width:1440,height:1000});
 await page.getByRole('button',{name:'测试只读版本',exact:true}).click();assert.ok(await input.isDisabled());assert.ok(await page.getByLabel('批量形态',{exact:true}).isDisabled());assert.ok(await page.getByLabel('批量选择可见商品',{exact:true}).isDisabled());assert.deepEqual(errors,[]);
});
