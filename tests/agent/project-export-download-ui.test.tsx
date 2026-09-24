import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { before, after, test } from "node:test";
import react from "@vitejs/plugin-react";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import { exportProjectFixture, exportSessionFixture, exportSourceProjectFixture, exportTranslationFixture, exportVersionFixture, exportRuntimeFixture } from "./helpers/project-export-fixture";

let server: ViteDevServer, browser: Browser, origin: string;
before(async () => {
  server = await createServer({ configFile:false,cacheDir:"test-results/export-ui-vite",define:{"process.env":"{}"},plugins:[react()],server:{host:"127.0.0.1",port:0} });
  await server.listen(); const address=server.httpServer!.address(); assert.ok(address && typeof address!=="string");
  origin=`http://127.0.0.1:${address.port}`; browser=await chromium.launch({headless:true});
});
after(async () => { await browser?.close();await server?.close(); });
async function fixture(t: test.TestContext, modules = "overview") {
  const page=await browser.newPage(); t.after(()=>page.close()); page.setDefaultTimeout(30000);
  await page.route("https://m.media-amazon.com/**", route => route.abort());
  const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));t.after(()=>assert.deepEqual(errors,[]));
  const state={favorite:true,fail:false,denied:false,delay:0,version:exportVersionFixture(),calls:[] as string[],writes:[] as string[]};
  const project=exportProjectFixture();
  await page.route("**/api/**",async route=>{
    const path=new URL(route.request().url()).pathname.replace("/api/agent","");
    const method=route.request().method(); state.calls.push(path); if(method!=="GET")state.writes.push(path);
    const reply=(body:unknown,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(body)});
    if(path==="/v1/auth/session")return reply({...exportSessionFixture(),visibleModules:state.denied?[]:modules.split(",")});
    if(path==="/api/runtime-analysis-data")return reply(exportRuntimeFixture());
    if(path==="/api/alexa-voc")return reply({records:[]});
    if(path==="/api/local-rule-reports")return reply({reports:[]});
    if(path.endsWith("/project-favorites"))return reply({projectIds:state.favorite?[project.id]:[]});
    if(path==="/v1/local-data/projects")return reply({projects:[project],pagination:{
      page:1,pageSize:10,total:1,totalPages:1,historyTotal:1,favoritesTotal:1,categories:[],
    }});
    if(path===`/v1/local-data/projects/${project.id}`)return reply({project});
    if(path===`/v1/projects/${project.sourceProjectId}`)return reply({project:{...exportSourceProjectFixture(),currentRunId:null}});
    if(path.endsWith("/current-display-version")) {
      if (state.delay) await new Promise(resolve => setTimeout(resolve, state.delay));
      return state.fail?reply({error:"报告读取失败"},500):reply(state.version);
    }
    if(path.includes("/selling-point-translations/"))return reply(exportTranslationFixture(path.split("/").at(-1)!));
    return reply({error:"Unexpected endpoint"},404);
  });
  await page.goto(`${origin}/tests/agent/helpers/analysis-favorites-harness.html?export=true&modules=${modules}`);
  await page.getByRole("button",{name:"导出",exact:true}).click();
  return {page,state};
}
test("download is the exact preview even after online edits; recipient needs no app session",async t=>{
  const {page,state}=await fixture(t);
  const iframe=page.locator('iframe[title="HTML 快照预览"]');
  await iframe.waitFor();
  const confirm=page.getByRole("button",{name:"确认并开始导出"});
  await page.waitForFunction(()=>![...document.querySelectorAll("button")].find(x=>x.textContent==="确认并开始导出")?.disabled);
  const html=await iframe.getAttribute("srcdoc");assert.ok(html);
  assert.match(html,/25\.99/);
  assert.equal(await page.getByRole("checkbox",{name:"变体 / 订单",exact:true}).isDisabled(),false);
  state.version.catalog[0].price=98765;
  const before=state.calls.length;
  const downloadPromise=page.waitForEvent("download");await confirm.click();const download=await downloadPromise;
  assert.match(download.suggestedFilename(),/^历史灯具项目_US_快照_\d{8}-\d{6}\.html$/);
  const path=resolve("test-results",download.suggestedFilename());await download.saveAs(path);
  assert.equal(await readFile(path,"utf8"),html);
  assert.ok(!state.calls.slice(before).some(path=>path.endsWith("current-display-version")));
  assert.deepEqual(state.writes,[]);
  const context=await browser.newContext();t.after(()=>context.close());const recipient=await context.newPage();
  await recipient.route("https://m.media-amazon.com/**", route => route.abort());
  const apiRequests:string[]=[];recipient.on("request",req=>{if(req.url().includes("/api/"))apiRequests.push(req.url());});
  await recipient.goto(pathToFileURL(path).href);
  await recipient.getByRole("heading",{name:"历史灯具项目",exact:true}).waitFor();
  assert.match(await recipient.locator("body").innerText(),/25\.99/);
  assert.doesNotMatch(await recipient.locator("body").innerText(),/98765/);
  assert.deepEqual(apiRequests,[]);
  await page.screenshot({path:"test-results/favorite-export-overview-preview.png",fullPage:true});
});
test("failed reads retry without analysis, and changed eligibility blocks confirmation",async t=>{
  const {page,state}=await fixture(t);
  await page.locator('iframe[title="HTML 快照预览"]').waitFor();
  const checkbox=page.getByRole("checkbox",{name:"竞品参数总览",exact:true});
  await page.getByRole("checkbox",{name:"变体 / 订单",exact:true}).uncheck();
  await page.getByRole("checkbox",{name:"主副图分析",exact:true}).uncheck();
  await checkbox.uncheck();await page.getByText("请至少勾选一个模块。",{exact:true}).waitFor();
  state.fail=true;state.delay=700;await checkbox.check();
  assert.equal(await page.locator('iframe[title="HTML 快照预览"]').count(),0);
  assert.equal(await page.getByRole("button",{name:"确认并开始导出"}).isDisabled(),true);
  await page.getByRole("button",{name:"重试读取"}).waitFor();
  assert.equal(await page.getByRole("button",{name:"确认并开始导出"}).isDisabled(),true);
  state.fail=false;await page.getByRole("button",{name:"重试读取"}).click();
  await page.locator('iframe[title="HTML 快照预览"]').waitFor();
  state.favorite=false;
  await page.getByRole("button",{name:"确认并开始导出"}).click();
  await page.getByText(/项目已取消收藏/).waitFor();
  assert.equal(await page.locator('iframe[title="HTML 快照预览"]').count(),0);
  assert.deepEqual(state.writes,[]);
});

test("all eight modules prepare and download together; deselected module is absent from the HTML",async t=>{
  const {page,state}=await fixture(t,"overview,voc,keywords,definition,checklist,traffic");
  const iframe=page.locator('iframe[title="HTML 快照预览"]');
  await iframe.waitFor();
  assert.equal(await page.getByRole("checkbox",{checked:true}).count(),8);
  const html=await iframe.getAttribute("srcdoc");assert.ok(html);
  for(const title of ["竞品参数总览","变体 / 订单","主副图分析","VOC 分析","关键词调研","新品定义","立项前确认清单","竞品流量分析"])assert.ok(html.includes(title),title);
  await page.screenshot({path:"test-results/favorite-export-all-modules-preview.png",fullPage:true});
  await page.getByRole("checkbox",{name:"VOC 分析",exact:true}).uncheck();
  await page.waitForFunction(()=>document.querySelector('iframe[title="HTML 快照预览"]')?.getAttribute("srcdoc")?.includes('id="voc"')===false);
  const reduced=await iframe.getAttribute("srcdoc");assert.ok(reduced);
  assert.doesNotMatch(reduced,/<h2[^>]*>VOC 分析<\/h2>/);
  const downloaded=page.waitForEvent("download");await page.getByRole("button",{name:"确认并开始导出"}).click();
  const file=await downloaded;const path=resolve("test-results","all-modules-snapshot.html");await file.saveAs(path);
  assert.equal(await readFile(path,"utf8"),reduced);assert.deepEqual(state.writes,[]);
});
