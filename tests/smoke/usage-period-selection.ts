import assert from "node:assert/strict";
import {fileURLToPath} from "node:url";
import {createServer} from "vite";
import react from "@vitejs/plugin-react";
import {chromium} from "playwright";
import {UsageQuerySchema, type UsageQuery} from "../../shared/usage-analytics-contracts";
import {usageRange} from "../../server/services/usage-analytics-service";
import {beijingToday} from "../../app/lib/usage-analytics-query";

// Real component and browser, fixture responses only; no production database or usage writes.
const root=fileURLToPath(new URL("../../",import.meta.url));
const vite=await createServer({root,configFile:false,define:{"process.env":"{}"},plugins:[react()],server:{host:"127.0.0.1",port:0}});
const browser=await chromium.launch({headless:true});
try{
  await vite.listen();
  const address=vite.httpServer!.address();assert.ok(address&&typeof address!=="string");
  const page=await browser.newPage({viewport:{width:1440,height:1000}});
  page.setDefaultTimeout(10000);
  const errors:string[]=[],requests:UsageQuery[]=[];
  page.on("pageerror",e=>errors.push(e.message));
  let failNext=false;
  await page.route("**/api/agent/**",async route=>{
    const url=new URL(route.request().url());
    if(url.pathname.endsWith("/auth/session"))return route.fulfill({json:{authenticated:true,user:{id:"00000000-0000-4000-8000-000000000001",organizationId:"00000000-0000-4000-8000-000000000002",email:"period@example.test",displayName:"测试人员",role:"admin",status:"active",createdAt:"2026-01-01T00:00:00.000Z",updatedAt:"2026-01-01T00:00:00.000Z"},sessionIdentity:"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",canViewUserPresence:true,visibleModules:["admin-users"],canManageModuleVisibility:true}});
    if(url.pathname.endsWith("/auth/activity"))return route.fulfill({json:{ok:true}});
    if(url.pathname.endsWith("/admin/users"))return route.fulfill({json:{asOf:new Date().toISOString(),recentActivityWindowSeconds:900,users:[]}});
    if(url.pathname.endsWith("/usage/people"))return route.fulfill({json:{people:[],hasMore:false}});
    assert.ok(url.pathname.endsWith("/usage"),"Unexpected request: "+url.pathname);
    const query=UsageQuerySchema.parse(Object.fromEntries(url.searchParams));requests.push(query);
    if(failNext){failNext=false;return route.fulfill({status:503,json:{error:{message:"统计暂时不可用"}}});}
    const metrics={visits:12,clicks:7,visibleMs:120000,activeMs:60000};
    return route.fulfill({json:{
      range:usageRange(query),asOf:new Date().toISOString(),timeZone:"Asia/Shanghai",collectionStartedAt:"2020-01-01T00:00:00Z",
      totals:{...metrics,userCount:1},
      users:[{...metrics,userId:"period-user",displayName:"测试人员",personLabel:"period-user",bindingStatus:"dingtalk",lastActivityAt:null,lastPageKey:null}],
      pages:[{...metrics,pageKey:"overview",userCount:1}],
    }});
  });
  const responseFor=(period:string,date:string,userId?:string)=>page.waitForResponse(r=>{
    const url=new URL(r.url());
    return url.pathname.endsWith("/usage")&&url.searchParams.get("period")===period&&url.searchParams.get("date")===date&&url.searchParams.get("userId")===(userId??null);
  });
  async function change(period:string,date:string,action:()=>Promise<unknown>,userId?:string){
    const response=responseFor(period,date,userId);await action();assert.equal((await response).status(),200);
    await page.getByRole("heading",{name:"人员使用明细",exact:true}).waitFor();
  }
  const today=beijingToday();
  await page.goto("http://127.0.0.1:"+address.port+"/tests/fixtures/usage-analytics/index.html");
  await page.waitForTimeout(500);
  await page.getByRole("button",{name:"使用统计",exact:true}).click();
  await page.getByRole("region",{name:"使用统计"}).waitFor();
  await page.getByRole("heading",{name:"人员使用明细",exact:true}).waitFor();
  await change("day","2025-08-12",()=>page.getByLabel("选择统计年月日").fill("2025-08-12"));
  await change("week",today,()=>page.getByRole("button",{name:"周",exact:true}).click());
  const week=page.getByLabel("选择统计周内日期");
  await week.waitFor();
  await change("week","2025-01-01",()=>week.fill("2025-01-01"));
  await page.getByText(/2024\/12\/30.*2025\/1\/5/).waitFor();
  await change("week","2025-01-05",()=>week.fill("2025-01-05"));
  await page.getByText(/2024\/12\/30.*2025\/1\/5/).waitFor();
  await change("week","2025-01-05",()=>page.getByRole("button",{name:"刷新",exact:true}).click());
  assert.equal(await week.getAttribute("max"),today);
  await week.fill("");assert.equal(await week.inputValue(),"2025-01-05");
  await week.fill("2099-01-01");assert.equal(await week.inputValue(),"2025-01-05");

  await change("month",today.slice(0,7)+"-01",()=>page.getByRole("button",{name:"月",exact:true}).click());
  const month=page.getByLabel("选择统计年月");
  await change("month","2024-02-01",()=>month.fill("2024-02"));
  await page.getByText(/2024\/2\/1.*2024\/2\/29/).waitFor();
  assert.equal(await month.getAttribute("max"),today.slice(0,7));
  await month.fill("");assert.equal(await month.inputValue(),"2024-02");
  await month.fill("2099-01");assert.equal(await month.inputValue(),"2024-02");
  await change("month","2024-02-01",()=>page.getByRole("button",{name:"测试人员",exact:true}).click(),"period-user");
  await page.getByRole("heading",{name:"测试人员 · 页面明细"}).waitFor();
  const detail=responseFor("month","2025-08-01","period-user");
  await change("month","2025-08-01",()=>month.fill("2025-08"));assert.equal((await detail).status(),200);
  await page.getByRole("button",{name:"收起明细"}).click();
  await change("month","2025-08-01",()=>page.getByLabel("筛选页面").selectOption("overview"));
  assert.equal(requests.at(-1)?.pageKey,"overview");
  await change("week","2025-01-05",()=>page.getByRole("button",{name:"周",exact:true}).click());
  await change("day","2025-08-12",()=>page.getByRole("button",{name:"日",exact:true}).click());
  await change("month","2025-08-01",()=>page.getByRole("button",{name:"月",exact:true}).click());
  failNext=true;
  await page.getByRole("button",{name:"刷新",exact:true}).click();
  await page.getByRole("alert").filter({hasText:"统计暂时不可用"}).waitFor();
  await change("month","2025-08-01",()=>page.getByRole("button",{name:"刷新",exact:true}).click());
  await page.setViewportSize({width:390,height:850});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),"390px layout overflows");
  assert.deepEqual(errors,[]);
  console.log("PASS: week/month selection, Beijing cross-year week and leap month, defaults, refresh, details, filters, retained dates, invalid/future input, error recovery, 390px layout.");
}finally{await browser.close();await vite.close();}
