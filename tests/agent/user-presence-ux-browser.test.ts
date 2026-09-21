import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdir} from 'node:fs/promises';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {chromium} from 'playwright';

test('presence UI supports pagination, global search, filters, history, refresh recovery and mobile layout',async t=>{
 const server=await createServer({configFile:false,define:{'process.env':'{}'},plugins:[react()],server:{host:'127.0.0.1',port:0}});
 await server.listen();t.after(()=>server.close());
 const address=server.httpServer!.address();assert.ok(address&&typeof address!=='string');const origin='http://127.0.0.1:'+address.port;
 const browser=await chromium.launch({headless:true});t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:1440,height:1100}});
 const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
 let fail=false;
 const users=Array.from({length:24},(_,i)=>({account:`fixture-${String(i).padStart(2,'0')}@example.com`,displayName:['陈晨','林晓','李明','王悦','张蕾'][i%5]+' '+String(i).padStart(2,'0'),
   source:i===23?'local':'dingtalk',role:i===0?'admin':'member',accountStatus:'active',presenceStatus:i%3===0?'recently-online':'session-expired',
   loginCount:i+1,lastLoginAt:'2026-09-14T02:05:00.000Z',lastActivityAt:'2026-09-14T03:10:00.000Z',validSessionExpiresAt:null,
   recentLogins:[{loggedInAt:'2026-09-14T02:05:00.000Z',lastActivityAt:'2026-09-14T03:10:00.000Z',expiresAt:'2026-09-15T02:05:00.000Z',invalidationReason:'expired'}]}));
 await page.route('**/api/agent/v1/admin/users?**',async route=>{
   if(fail)return route.fulfill({status:503,body:'{}'});
   const q=new URL(route.request().url()).searchParams;
   const scoped=users.filter(u=>(q.get('source')==='all'||u.source===q.get('source'))&&(u.account+' '+u.displayName).includes(q.get('q')??''));
   const filtered=scoped.filter(u=>q.get('status')==='all'||u.presenceStatus===q.get('status')),pageSize=Number(q.get('pageSize')),selected=Math.min(Number(q.get('page')),Math.max(1,Math.ceil(filtered.length/pageSize)));
   return route.fulfill({contentType:'application/json',body:JSON.stringify({asOf:'2026-09-14T03:20:00.000Z',recentActivityWindowSeconds:900,users:filtered.slice((selected-1)*pageSize,selected*pageSize),pagination:{page:selected,pageSize,total:filtered.length},summary:{total:scoped.length,recentlyOnline:scoped.filter(u=>u.presenceStatus==='recently-online').length,neverLoggedIn:0}})});
 });
 await page.goto(origin+'/tests/agent/helpers/user-presence-ux-harness.html');
 await page.getByRole('cell',{name:'陈晨 00 钉钉账号'}).waitFor();
 assert.equal(await page.getByRole('button',{name:'登录记录',exact:true}).count(),10);
 await page.getByRole('button',{name:'下一页'}).click();await page.getByRole('cell',{name:'陈晨 10 钉钉账号'}).waitFor();
 await page.getByRole('searchbox',{name:'搜索人员'}).fill('22');
 await page.getByRole('cell',{name:'李明 22 钉钉账号'}).waitFor();
 assert.equal(await page.getByRole('button',{name:'登录记录',exact:true}).count(),1);
 assert.equal(await page.getByRole('button',{name:'上一页'}).isDisabled(),true);
 await page.getByRole('button',{name:'登录记录',exact:true}).click();await page.getByRole('table',{name:'李明 22 最近登录记录'}).waitFor();
 await page.getByRole('searchbox',{name:'搜索人员'}).fill('不存在');await page.getByText('没有找到符合条件的人员').waitFor();
 await page.getByRole('button',{name:'重置筛选'}).click();await page.getByRole('cell',{name:'陈晨 00 钉钉账号'}).waitFor();
 await page.getByLabel('每页人数').selectOption('20');await page.getByRole('cell',{name:'张蕾 19 钉钉账号'}).waitFor();
 assert.equal(await page.getByRole('button',{name:'登录记录',exact:true}).count(),20);
 await page.getByLabel('账号来源').selectOption('local');await page.getByRole('cell',{name:'王悦 23 fixture-23@example.com'}).waitFor();
 await page.getByLabel('账号来源').selectOption('dingtalk');await page.getByRole('cell',{name:'陈晨 00 钉钉账号'}).waitFor();
 fail=true;await page.getByRole('button',{name:'刷新',exact:true}).click();await page.getByRole('alert').waitFor();
 assert.equal(await page.getByRole('button',{name:'登录记录',exact:true}).count(),20);
 fail=false;await page.getByRole('button',{name:'重试',exact:true}).click();await page.getByRole('alert').waitFor({state:'hidden'});
 await page.getByLabel('每页人数').selectOption('10');await page.getByRole('cell',{name:'张蕾 19 钉钉账号'}).waitFor({state:'hidden'});
 await mkdir('.superpowers/sdd',{recursive:true});
 await page.screenshot({path:'.superpowers/sdd/presence-desktop.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'mobile page has no horizontal overflow');
 await page.screenshot({path:'.superpowers/sdd/presence-mobile.png',fullPage:true});
 assert.deepEqual(errors,[]);
});
