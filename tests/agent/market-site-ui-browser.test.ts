import assert from "node:assert/strict";
import test from "node:test";
import {createServer} from "vite";
import react from "@vitejs/plugin-react";
import {chromium} from "playwright";
test("all four module queries preserve UK scope and send GBP without calling a provider",{timeout:90000},async t=>{
 const server=await createServer({configFile:false,define:{"process.env":"{}"},plugins:[react()],server:{host:"127.0.0.1",port:0,hmr:false}});await server.listen();const browser=await chromium.launch();t.after(async()=>{await browser.close();await server.close()});
 const origin=server.resolvedUrls!.local[0],writes:Array<{path:string;body:Record<string,unknown>}>=[];
 for(const view of ["overview","shapes","keywords","themes"]){
  const page=await browser.newPage();page.setDefaultTimeout(10000);
  await page.route("**/*",async route=>{
   const request=route.request(),url=new URL(request.url());if(url.origin!==new URL(origin).origin)return route.abort();
   if(request.isNavigationRequest())return route.fulfill({contentType:"text/html",body:await server.transformIndexHtml("/",'<html><body><div id="root"></div><script type="module">import React from "react";import {createRoot} from "react-dom/client";import {MarketResearchSection} from "/app/market-research-section.tsx";import "/app/globals.css";createRoot(document.getElementById("root")).render(React.createElement(MarketResearchSection,{sessionIdentity:"country-test"}));</script></body></html>')});
   if(!url.pathname.startsWith("/api/"))return route.continue();
   if(request.method()==="POST"){writes.push({path:url.pathname,body:request.postDataJSON()});return route.fulfill({status:400,json:{error:{message:"Captured scope; do not start provider tasks in this test"}}})}
   return route.fulfill({status:404,json:{error:{message:"No saved fixtures"}}});
  });
  await page.goto(origin+"?themeView="+view+"&marketSite=UK&marketNode=123:456&marketMonth=2026-08&marketFrom=2026-08");
  await page.getByRole("button",{name:"英国站",exact:true}).waitFor();
  await page.waitForFunction(()=>document.querySelector('[aria-label="选择市场站点"] button[aria-pressed="true"]')?.textContent==="英国站");
  const before=writes.length;const submitted=page.waitForResponse(response=>response.request().method()==="POST");
  if(view==="overview")await page.getByRole("button",{name:"筛选市场",exact:true}).click();
  if(view==="shapes")await page.getByRole("button",{name:"筛选市场",exact:true}).click();
  if(view==="keywords"){await page.getByLabel("产品核心名",{exact:true}).fill("desk lamp");await page.getByLabel("类目说明",{exact:true}).fill("桌面台灯");await page.getByRole("button",{name:"采集关键词并分析",exact:true}).click()}
  if(view==="themes")await page.getByRole("button",{name:"拉取见解",exact:true}).click();
  await submitted;
  assert.equal(writes.length,before+1,view+" submits exactly one scope request");
  assert.equal(writes.at(-1)!.body.marketplace,"UK",view);
  if(view!=="overview")assert.equal(writes.at(-1)!.body.currency,"GBP",view);
  assert.equal(writes.at(-1)!.body.nodeIdPath??writes.at(-1)!.body.nodeQuery,"123:456");
  await page.close();
 }
});
