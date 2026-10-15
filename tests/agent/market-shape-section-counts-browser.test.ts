import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdir,writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';

test('local section filters count included products through edits, exclusion and restoration',{timeout:60000},async t=>{
 const out='test-results/shape-section-counts';await mkdir(out,{recursive:true});
 const product=(asin:string)=>({rank:1,asin,title:'Fixture lamp',brand:asin==='B000000001'?'Brand A':'Brand B',imageUrl:'',monthlySalesVolume:10,monthlySalesAmount:200,sales:{last3Months:30,last6Months:60,y2024:120,y2025:120,monthsAvailable:24},monthlyTrend:{volume:[],amount:[]},price:20,categoryRank:'',productCategory:'',productShape:'未分类',productShapeHint:null,bsrRank:null,deliveryType:'',reviewCount:1,starRating:4,seller:'',sellerOrigin:null,onlineDate:'2024-01',grossProfitMargin:65,priceBand:'$20-30'});
 const report={marketplace:'US',sorftimeSite:'US',nodeId:'123',categoryName:'Fixture',fetchedAt:'2026-09-27T00:00:00Z',note:'',stats:{},history:{volume:[],amount:[],avgPrice:[],listingMonopoly:[],brandMonopoly:[],sellerMonopoly:[]},products:[product('B000000001'),product('B000000002')],productSalesTotals:{},topLinkCount:2};
 await writeFile(out+'/entry.jsx',`import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{MarketShapeReferenceView}from'/app/market-shape-reference/view';import'/app/globals.css';import'/app/warm-theme.css';import'/app/comparison-layout.css';import'/app/market-research.css';import'/app/market-shape-reference.css';function App(){const[a,setA]=useState({B000000002:'其他'});const[s,setS]=useState(['B000000001','B000000002']);const[locked,setLocked]=useState(false);return <><button onClick={()=>setLocked(true)}>测试只读版本</button><MarketShapeReferenceView disabled={locked} report={${JSON.stringify(report)}} assignments={a} selectedAsins={s} onAssignment={(asin,label)=>setA(old=>({...old,[asin]:label}))} onSelected={setS}/></>};createRoot(document.getElementById('root')).render(<App/>);`);
 const server=await createServer({configFile:false,cacheDir:out+'/vite',define:{'process.env':'{}'},plugins:[react()],server:{host:'127.0.0.1',port:0,hmr:false,forwardConsole:false}});await server.listen();t.after(()=>server.close());
 const browser=await chromium.launch({headless:true});t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),origin=server.resolvedUrls!.local[0];const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async route=>{if(!route.request().url().startsWith(origin))return route.abort();if(route.request().isNavigationRequest())return route.fulfill({contentType:'text/html',body:await server.transformIndexHtml('/',`<html><body><div id="root"></div><script type="module" src="/${out}/entry.jsx"></script></body></html>`)});return route.continue()});
 await page.goto(origin);

 const inspect=async(name:string,expected:Record<string,number>)=>{
  await page.getByRole('button',{name:name+'局部筛选',exact:true}).click();
  const panel=page.getByRole('listbox');await panel.waitFor();
  for(const [label,count] of Object.entries(expected)){
   const option=panel.locator('li').filter({has:page.getByRole('checkbox',{name:label,exact:true})});
   assert.equal((await option.locator('.top-sales-multi-select-option-count').innerText()).trim(),`${count} 链接`,`${name}/${label}`);
  }
  await page.getByRole('button',{name:name+'局部筛选',exact:true}).click();
 };
 await page.getByLabel('B000000001 人工形态',{exact:true}).waitFor();
 const final=page.locator('#market-structure-synthesis-conclusion');
 assert.equal(await final.locator('.market-structure-dimension-head h5').count(),5);
 assert.match(await final.innerText(),/新品准入机会/);assert.match(await final.innerText(),/机会方向/);
 assert.match(await final.innerText(),/本维缺失项/);assert.doesNotMatch(await final.innerText(),/阶段总结/);
 await final.getByText('本维缺失项（1 条商品）',{exact:true}).first().click();
 assert.match(await final.locator('details[open]').innerText(),/B000000001：商品形态待标注/);

 for(const name of ['形态销量','形态价格带'])await inspect(name,{'未分类':1,'其他':1});
 await inspect('品牌价格带',{'Brand A':1,'Brand B':1});
 // Selecting a local group must not erase the count of another available group.
 await page.getByRole('button',{name:'形态价格带局部筛选',exact:true}).click();
 await page.getByRole('listbox').getByRole('checkbox',{name:'未分类',exact:true}).click();
 await page.getByRole('button',{name:'形态价格带局部筛选',exact:true}).click();
 await inspect('形态价格带',{'未分类':1,'其他':1});
 // Label edits and included/excluded state change the counts without changing source data.
 await page.getByLabel('B000000001 人工形态',{exact:true}).fill('其他');
 await page.getByLabel('搜索商品',{exact:true}).click();
 await inspect('形态销量',{'其他':2});
 const row=page.locator('table.top-sales-table tbody tr').first();
 page.once('dialog',dialog=>dialog.accept());await row.getByRole('button',{name:'移除',exact:true}).click();
 await inspect('形态销量',{'其他':1});await inspect('品牌价格带',{'Brand A':0,'Brand B':1});
 await row.getByRole('button',{name:'恢复',exact:true}).click();
 await inspect('形态销量',{'其他':2});await inspect('品牌价格带',{'Brand A':1,'Brand B':1});
 assert.deepEqual(errors,[]);
});

