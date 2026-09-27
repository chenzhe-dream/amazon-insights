import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import react from "@vitejs/plugin-react";
import { chromium, type Browser, type Page } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import { exportProjectFixture, exportRuntimeFixture, exportSessionFixture, exportSessionIdentity, exportSourceProjectFixture, exportTranslationFixture, exportVersionFixture } from "./helpers/project-export-fixture";

let server: ViteDevServer, browser: Browser, origin: string;
before(async () => {
  server = await createServer({configFile:false,cacheDir:"test-results/export-lifecycle-vite",define:{"process.env":"{}"},plugins:[react()],server:{host:"127.0.0.1",port:0}});
  await server.listen(); const address=server.httpServer!.address(); assert.ok(address && typeof address!=="string");
  origin=`http://127.0.0.1:${address.port}`; browser=await chromium.launch({headless:true});
});
after(async () => { await browser?.close(); await server?.close(); });

function heldRoute() {
  let arrived!: () => void, release!: () => void;
  return {arrived:new Promise<void>(resolve=>{arrived=resolve;}),wait:()=>{arrived();return new Promise<void>(resolve=>{release=resolve;});},release:()=>release()};
}
async function fixture(t: test.TestContext, voc = false) {
  const page=await browser.newPage({acceptDownloads:true}); t.after(()=>page.close()); page.setDefaultTimeout(15_000);
  await page.route("https://m.media-amazon.com/**",route=>route.abort());
  const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));t.after(()=>assert.deepEqual(errors,[]));
  const first=exportProjectFixture(); const second={...first,id:"10000000-0000-4000-8000-000000000002",name:"第二个灯具项目"};
  const state={sessionIdentity:exportSessionIdentity,price:25.99,visibleModules: voc ? ["overview","voc"] : ["overview"],versionGate:null as ReturnType<typeof heldRoute>|null,
    favoriteGate:null as ReturnType<typeof heldRoute>|null,versionReads:0,writes:[] as string[]};
  await page.route("**/api/**",async route=>{
    const path=new URL(route.request().url()).pathname.replace("/api/agent","");
    if(route.request().method()!=="GET")state.writes.push(path);
    const reply=async (body:unknown,status=200)=>{try{await route.fulfill({status,contentType:"application/json",body:JSON.stringify(body)});}catch(error){
      if(!route.request().failure())throw error; // A canceled browser fetch may close while its held response is released.
    }};
    if(path==="/v1/auth/session")return reply({...exportSessionFixture(),sessionIdentity:state.sessionIdentity,visibleModules:state.visibleModules});
    if(path==="/api/runtime-analysis-data")return reply(exportRuntimeFixture());
    if(path==="/api/alexa-voc")return reply({records:[]});
    if(path==="/api/local-rule-reports")return reply({reports:[]});
    if(path.endsWith("/project-favorites")){
      const hold=state.favoriteGate;if(hold){state.favoriteGate=null;await hold.wait();}
      return reply({projectIds:[first.id,second.id]});
    }
    if(path===`/v1/local-data/projects/${first.id}`)return reply({project:first});
    if(path===`/v1/local-data/projects/${second.id}`)return reply({project:second});
    if(path===`/v1/projects/${first.sourceProjectId}`)return reply({project:{...exportSourceProjectFixture(),currentRunId:null}});
    if(path.endsWith("/current-display-version")){
      state.versionReads++;const hold=state.versionGate;if(hold){state.versionGate=null;await hold.wait();}
      const version=exportVersionFixture();version.catalog[0].price=state.price;
      return reply(version);
    }
    if(path.includes("/selling-point-translations/"))return reply(exportTranslationFixture(path.split("/").at(-1)!.split("?")[0]));
    return reply({error:"Unexpected endpoint"},404);
  });
  await page.goto(`${origin}/tests/agent/helpers/snapshot-lifecycle-harness.html${voc ? "?voc" : ""}`);
  return {page,state};
}
const frame=(page:Page)=>page.locator('iframe[title="HTML 快照预览"]');

test('closing during the selection delay never starts the scheduled read',async t=>{
  const {page,state}=await fixture(t);await readyHtml(page);const before=state.versionReads;
  await page.clock.install();await page.clock.pauseAt(new Date());
  await page.getByRole('checkbox',{name:'包含变体 / 订单',exact:true}).uncheck();
  await page.getByRole('button',{name:'取消',exact:true}).click();
  await page.clock.runFor(1000);
  assert.equal(state.versionReads,before);assert.equal(await page.getByRole('dialog').count(),0);
});

test("rapid selection changes wait for the final choice without reviving earlier HTML",async t=>{
  const {page,state}=await fixture(t);await readyHtml(page);
  const before=state.versionReads;
  await page.clock.install();await page.clock.pauseAt(new Date());
  const variants=page.getByRole('checkbox',{name:'包含变体 / 订单',exact:true});
  await variants.uncheck();await page.clock.runFor(100);
  await variants.check();await page.clock.runFor(100);
  await variants.uncheck();await page.clock.runFor(100);
  await unavailable(page);
  assert.equal(state.versionReads,before,'intermediate selections must not read a report');
  state.price=92.75;await page.clock.resume();
  const html=await readyHtml(page);
  assert.equal(state.versionReads,before+1);
  assert.match(html,/92\.75/);assert.equal(state.writes.length,0);
});
async function readyHtml(page:Page) {
  await frame(page).waitFor();
  await page.getByRole("button",{name:"确认并开始导出"}).waitFor({state:"visible"});
  await page.waitForFunction(()=>{const button=[...document.querySelectorAll("button")].find(x=>x.textContent==="确认并开始导出");return button && !button.disabled;});
  const html=await frame(page).getAttribute("srcdoc");assert.ok(html);return html;
}
async function unavailable(page:Page) {
  assert.equal(await frame(page).count(),0);
  assert.equal(await page.getByRole("button",{name:"确认并开始导出"}).isDisabled(),true);
}
async function changeUnderlyingContext(page:Page, buttonName:string) {
  // The modal backdrop intentionally blocks pointer clicks on the surrounding app.
  // Dispatch its host control directly to simulate external project/session state changing.
  await page.getByRole("button",{name:buttonName}).evaluate((button:HTMLButtonElement)=>button.click());
}

test("closing during preparation cancels its result; reopening prepares a fresh visible snapshot",async t=>{
  const {page,state}=await fixture(t);const hold=heldRoute();state.versionGate=hold;
  await hold.arrived;
  await page.getByRole("button",{name:"取消",exact:true}).click();
  assert.equal(await page.getByRole("dialog").count(),0);
  state.price=41.25;await page.getByRole("button",{name:"打开导出"}).click();
  assert.match(await readyHtml(page),/41\.25/);
  hold.release();await page.waitForTimeout(100);
  assert.match((await frame(page).getAttribute("srcdoc"))!,/41\.25/);
  assert.equal(state.writes.length,0);
});

test("a project change discards a late prior read and shows only the newly chosen project",async t=>{
  const {page,state}=await fixture(t);const hold=heldRoute();state.versionGate=hold;
  await hold.arrived;
  await changeUnderlyingContext(page,"切换项目");
  await unavailable(page);state.price=53.75;
  const html=await readyHtml(page);assert.match(html,/第二个灯具项目/);assert.match(html,/53\.75/);
  hold.release();await page.waitForTimeout(100);
  assert.match((await frame(page).getAttribute("srcdoc"))!,/第二个灯具项目/);
  assert.equal(state.writes.length,0);
});

test("a session change discards a late prior read and regenerates the preview",async t=>{
  const {page,state}=await fixture(t);const hold=heldRoute();state.versionGate=hold;
  await hold.arrived;state.sessionIdentity="t".repeat(43);
  await changeUnderlyingContext(page,"切换会话");
  await unavailable(page);state.price=68.5;
  assert.match(await readyHtml(page),/68\.5/);
  hold.release();await page.waitForTimeout(100);
  assert.match((await frame(page).getAttribute("srcdoc"))!,/68\.5/);
  assert.equal(state.writes.length,0);
});

test("selection A to B to A never revives A's earlier HTML",async t=>{
  const {page,state}=await fixture(t);
  const initial=await readyHtml(page);assert.match(initial,/25\.99/);
  const variants=page.getByRole("checkbox",{name:"包含变体 / 订单",exact:true});
  const hold=heldRoute();state.versionGate=hold;
  await variants.uncheck();await unavailable(page);await hold.arrived;
  state.price=76.4;await variants.check();await unavailable(page);
  const renewed=await readyHtml(page);assert.match(renewed,/76\.4/);assert.notEqual(renewed,initial);
  hold.release();await page.waitForTimeout(100);
  assert.equal(await frame(page).getAttribute("srcdoc"),renewed);
  assert.equal(state.writes.length,0);
});

test("a stalled preparation times out at 60 seconds and offers retry",async t=>{
  const {page,state}=await fixture(t);await readyHtml(page);
  await page.clock.install();const hold=heldRoute();state.versionGate=hold;
  await page.getByRole("checkbox",{name:"包含变体 / 订单",exact:true}).uncheck();
  await hold.arrived;await unavailable(page);
  await page.clock.fastForward(60_001);
  await page.getByRole("alert").getByText("读取超时，请重试").waitFor();
  assert.equal(await page.getByRole("button",{name:"确认并开始导出"}).isDisabled(),true);
  hold.release();state.price=84.3;
  await page.getByRole("button",{name:"重试读取"}).click();
  assert.match(await readyHtml(page),/84\.3/);
});

test("changing selection while confirmation waits prevents the old download",async t=>{
  const {page,state}=await fixture(t);await readyHtml(page);
  const hold=heldRoute();state.favoriteGate=hold;let downloads=0;page.on("download",()=>downloads++);
  await page.getByRole("button",{name:"确认并开始导出"}).click();await hold.arrived;
  await page.getByRole("checkbox",{name:"包含变体 / 订单",exact:true}).uncheck();
  await unavailable(page);hold.release();await readyHtml(page);
  await page.waitForTimeout(100);assert.equal(downloads,0);assert.equal(state.writes.length,0);
});

test("changing session while confirmation waits prevents the old download",async t=>{
  const {page,state}=await fixture(t);await readyHtml(page);
  const hold=heldRoute();state.favoriteGate=hold;let downloads=0;page.on("download",()=>downloads++);
  await page.getByRole("button",{name:"确认并开始导出"}).click();await hold.arrived;
  state.sessionIdentity="t".repeat(43);await changeUnderlyingContext(page,"切换会话");
  await unavailable(page);hold.release();await readyHtml(page);
  await page.waitForTimeout(100);assert.equal(downloads,0);assert.equal(state.writes.length,0);
});

test("VOC summary to insight to summary discards the held same-source preparation",async t=>{
  const {page,state}=await fixture(t,true);
  await page.getByRole("checkbox",{name:"竞品概览",exact:true}).uncheck();
  await page.getByRole("checkbox",{name:"竞品 VOC 洞察",exact:true}).uncheck();
  await page.getByRole("checkbox",{name:"产品定义结论",exact:true}).uncheck();
  const first=await readyHtml(page); assert.match(first,/data-snapshot-page="voc-summary"/);
  const hold=heldRoute();state.versionGate=hold;
  await page.getByRole("checkbox",{name:"竞品 VOC 洞察",exact:true}).check();
  await page.getByRole("checkbox",{name:"竞品VOC 汇总",exact:true}).uncheck();
  await unavailable(page);await hold.arrived;
  await page.getByRole("checkbox",{name:"竞品VOC 汇总",exact:true}).check();
  await page.getByRole("checkbox",{name:"竞品 VOC 洞察",exact:true}).uncheck();
  await unavailable(page);
  const renewed=await readyHtml(page);
  assert.match(renewed,/data-snapshot-page="voc-summary"/);
  assert.doesNotMatch(renewed,/data-snapshot-page="voc-insight"/);
  assert.notEqual(renewed,first);
  hold.release();await page.waitForTimeout(100);
  assert.equal(await frame(page).getAttribute("srcdoc"),renewed);
  assert.equal(state.writes.length,0);
});

test("switching between VOC leaves during confirmation prevents the prior download",async t=>{
  const {page,state}=await fixture(t,true);
  await readyHtml(page);
  const hold=heldRoute();state.favoriteGate=hold;let downloads=0;page.on("download",()=>downloads++);
  await page.getByRole("button",{name:"确认并开始导出"}).click();await hold.arrived;
  await page.getByRole("checkbox",{name:"竞品 VOC 洞察",exact:true}).uncheck();
  await unavailable(page);hold.release();await readyHtml(page);
  await page.waitForTimeout(100);
  assert.equal(downloads,0);assert.equal(state.writes.length,0);
});

test("revoking a page permission clears its prepared preview",async t=>{
  const {page,state}=await fixture(t,true);
  await readyHtml(page);
  state.visibleModules=["overview"];
  await changeUnderlyingContext(page,"撤销 VOC 权限");
  await unavailable(page);
  const html=await readyHtml(page);
  assert.doesNotMatch(html,/data-snapshot-page="voc-/);
  assert.equal(await page.getByRole("checkbox",{name:"VOC",exact:true}).count(),0);
});

test("iframe page navigation does not change export selection or reread sources",async t=>{
  const {page,state}=await fixture(t);
  const html=await readyHtml(page);
  const reads=state.versionReads;
  const report=page.frameLocator('iframe[title="HTML 快照预览"]');
  await report.getByText("主辅图",{exact:true}).first().click();
  assert.equal(state.versionReads,reads);
  assert.equal(await frame(page).getAttribute("srcdoc"),html);
  assert.equal(await page.getByRole("checkbox",{name:"竞品参数总览",exact:true}).isChecked(),true);
  assert.equal(await page.getByRole("checkbox",{name:"主辅图",exact:true}).isChecked(),true);
});

test("deselecting the current page prepares the first remaining page as default",async t=>{
  const {page}=await fixture(t);
  await readyHtml(page);
  await page.getByRole("checkbox",{name:"竞品参数总览",exact:true}).uncheck();
  await unavailable(page);
  const html=await readyHtml(page);
  assert.doesNotMatch(html,/data-snapshot-page="overview"/);
  assert.match(html,/data-snapshot-page="images"/);
  const report=page.frameLocator('iframe[title="HTML 快照预览"]');
  assert.equal(await report.locator('input[type="radio"]:checked').count(),1);
});

test("revoking VOC permission during confirmation prevents the download",async t=>{
  const {page,state}=await fixture(t,true);await readyHtml(page);
  const hold=heldRoute();state.favoriteGate=hold;let downloads=0;page.on("download",()=>downloads++);
  await page.getByRole("button",{name:"确认并开始导出"}).click();await hold.arrived;
  state.visibleModules=["overview"];await changeUnderlyingContext(page,"撤销 VOC 权限");
  await unavailable(page);hold.release();await readyHtml(page);
  await page.waitForTimeout(100);assert.equal(downloads,0);
});
