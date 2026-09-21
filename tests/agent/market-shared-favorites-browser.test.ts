import assert from "node:assert/strict";
import test from "node:test";
import {createServer} from "vite";
import react from "@vitejs/plugin-react";
import {chromium,type Page} from "playwright";
import {MarketFavoriteCreateSchema,type MarketFavorite} from "../../shared/market-favorites-contracts";
for (const withoutRandomUUID of [false, true]) test(`shared favorites persist across viewers and restore keyword inputs without starting collection (randomUUID unavailable: ${withoutRandomUUID})`,{timeout:90000},async t=>{
 const server=await createServer({configFile:false,define:{"process.env":"{}"},plugins:[react()],server:{host:"127.0.0.1",port:0,hmr:false}});await server.listen();
 const origin=server.resolvedUrls!.local[0],browser=await chromium.launch();t.after(async()=>{await browser.close();await server.close()});
 const entries:MarketFavorite[]=[],writes:string[]=[],ids:string[]=[];let failSave=true;
 async function open(){
  const page=await browser.newPage({viewport:{width:1366,height:1000}});page.setDefaultTimeout(10000);
  if (withoutRandomUUID) await page.addInitScript(() => Object.defineProperty(crypto, "randomUUID", { value: undefined }));
  await page.route("**/*",async route=>{
   const request=route.request(),url=new URL(request.url());if(url.origin!==new URL(origin).origin)return route.abort();
   if(request.isNavigationRequest())return route.fulfill({contentType:"text/html",body:await server.transformIndexHtml("/",'<html><body><div id="root"></div><script type="module">import React from "react";import {createRoot} from "react-dom/client";import {MarketResearchSection} from "/app/market-research-section.tsx";import "/app/globals.css";createRoot(document.getElementById("root")).render(React.createElement(MarketResearchSection,{sessionIdentity:"favorite-viewer"}));</script></body></html>')});
   if(!url.pathname.startsWith("/api/"))return route.continue();
   if(request.method()!=="GET")writes.push(url.pathname);
   if(url.pathname==="/api/agent/v1/market-research/favorites"){
    if(request.method()==="POST"){
     const body=MarketFavoriteCreateSchema.parse(request.postDataJSON());ids.push(body.id);
     if(failSave){failSave=false;return route.fulfill({status:503,json:{error:{message:"暂时无法保存"}}})}
     const item={...body,createdBy:"10000000-0000-4000-8000-000000000001",creatorName:"测试同事",createdAt:"2026-09-15T00:00:00.000Z",canDelete:true};entries.push(item);
     return route.fulfill({status:201,json:{favorite:item}});
    }
    const all=entries.filter(item=>item.module===url.searchParams.get("module")&&item.title.includes(url.searchParams.get("q")??"")),pageNumber=Number(url.searchParams.get("page")??1);
    return route.fulfill({json:{items:all.slice((pageNumber-1)*10,pageNumber*10),total:all.length,page:pageNumber,pageSize:10}});
   }
   if(request.method()!=="GET")throw Error("Opening a favorite must not start a task: "+url.pathname);
   if(url.pathname.endsWith("/market-research/jobs"))return route.fulfill({json:{jobs:[]}});
   return route.fulfill({status:404,json:{error:{message:"fixture has no existing task"}}});
  });
  await page.goto(origin);await page.getByRole("navigation",{name:"市场调研模块"}).waitFor();return page;
 }
 const one=await open();
 await one.getByRole("navigation",{name:"市场调研模块"}).getByRole("button",{name:"类目关键词洞察",exact:true}).click();
 await one.getByLabel("产品核心名",{exact:true}).fill("desk lamp");
 await one.getByLabel("类目说明",{exact:true}).fill("学习用台灯");
 await one.getByText("类目范围与采集设置",{exact:true}).click();
 await one.getByLabel("类目节点或路径",{exact:true}).fill("123:456");
 await one.getByRole("button",{name:"☆ 收藏",exact:true}).click();
 const favorites=one.getByRole("region",{name:"团队共享收藏"});await favorites.getByLabel("收藏名称").fill("团队台灯研究");
 await favorites.getByRole("button",{name:"保存到团队",exact:true}).click();await favorites.getByRole("alert").waitFor();
 await favorites.getByRole("button",{name:"保存到团队",exact:true}).click();await favorites.getByText("已保存到团队共享收藏",{exact:true}).waitFor();
 assert.equal(ids[0],ids[1],"save retry keeps the same id");
 assert.equal(entries[0].keywordInput?.seeds,"desk lamp");assert.equal(entries[0].keywordInput?.categoryContext,"学习用台灯");
 await one.close();
 const two=await open();await two.getByRole("navigation",{name:"市场调研模块"}).getByRole("button",{name:"类目关键词洞察",exact:true}).click();
 await two.getByRole("button",{name:"☆ 团队共享收藏",exact:true}).click();
 await two.getByRole("button",{name:"团队台灯研究",exact:true}).click();
 try{await two.getByLabel("类目说明",{exact:true}).waitFor()}catch(error){console.log("restore-debug",two.url(),await two.locator("body").innerText());throw error}
 assert.equal(await two.getByLabel("产品核心名",{exact:true}).inputValue(),"desk lamp");
 assert.equal(await two.getByLabel("类目说明",{exact:true}).inputValue(),"学习用台灯");
 await two.getByText("类目范围与采集设置",{exact:true}).click();assert.equal(await two.getByLabel("类目节点或路径",{exact:true}).inputValue(),"123:456");
 assert.deepEqual(writes,["/api/agent/v1/market-research/favorites","/api/agent/v1/market-research/favorites"]);
 await two.setViewportSize({width:390,height:844});assert.ok(await two.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 await two.close();
});
