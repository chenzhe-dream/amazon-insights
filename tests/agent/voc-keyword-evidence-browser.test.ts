import { persistedResult } from "./helpers/persisted-product-result";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { before, after, test } from "node:test";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
let server: ViteDevServer, browser: Browser, origin: string;
before(async()=>{
 server=await createServer({configFile:false,cacheDir:".runtime/evidence-vite",plugins:[react()],optimizeDeps:{entries:["tests/agent/helpers/voc-evidence-browser-harness.html"]},server:{host:"127.0.0.1",port:0}}); await server.listen();
 const addr=server.httpServer!.address(); assert.ok(addr && typeof addr!=="string"); origin=`http://127.0.0.1:${addr.port}`;
 browser=await chromium.launch({headless:true,executablePath:existsSync(chromium.executablePath())?chromium.executablePath():"C:/Program Files/Google/Chrome/Application/chrome.exe"});
});
after(async()=>{await browser?.close();await server?.close();});
const projectId="10000000-0000-4000-8000-000000000002", baseSyncRunId="10000000-0000-4000-8000-000000000003", organizationId="10000000-0000-4000-8000-000000000001";
const now="2026-09-10T00:00:00.000Z", asin="B08L7DD8L9";
function inventory() {
 const manual={schemaVersion:"voc-evidence/v1",organizationId,projectId,baseSyncRunId,marketplace:"US",selectedAsins:[asin],sourcePolicy:"manual-only",fingerprint:"a".repeat(64),sourceMode:"manual",coverage:[{asin,primary:"missing",manualDimensions:[],reviewDimensions:[],missingDimensions:["attention","positives","negatives","unmet","audiences","scenarios","motives"],manual:null,review:null}],keywords:{state:"missing",source:null}};
 return {manual,fallback:{...manual,sourcePolicy:"manual-with-review-fallback",fingerprint:"b".repeat(64),sourceMode:"review-fallback",coverage:[{...manual.coverage[0],primary:"review",reviewDimensions:["positives"],review:{id:"fixture",version:"1",contentHash:"c".repeat(64),capturedAt:now}}]}};
}
test("production panel only reads until explicit fallback, double click creates once and logout clears",async t=>{
 const page=await browser.newPage();t.after(()=>page.close()); let posts=0, gets=0;
 await page.route("**/*",async route=>{
  const req=route.request(); if(!req.url().startsWith(origin)) return route.abort();
  if(!req.url().includes("/api/agent/"))return route.continue();if(req.url().includes("voc-automation"))return route.fulfill({json:{projectId,baseSyncRunId,selectedAsins:[asin],state:"waiting-voc",runId:null,message:"等待 VOC",updatedAt:now,startedAt:null}});
  if(req.method()==="POST") { posts++; const body=req.postDataJSON();assert.equal(body.evidenceSelection.sourcePolicy,"manual-with-review-fallback"); await new Promise(r=>setTimeout(r,100));return route.fulfill({status:409,json:{error:{code:"CONFLICT",message:"fixture input changed"}}}); }
  gets++;return route.fulfill({json:inventory()});
 });
 await page.goto(`${origin}/tests/agent/helpers/voc-evidence-browser-harness.html`);await page.locator(".voc-coverage summary").click();
 const button=page.getByRole("button",{name:"使用评论兜底分析"});await button.waitFor();await page.getByTestId("evidence-source").filter({hasText:"尚未启用评论兜底"}).waitFor();
 assert.equal(posts,0);assert.ok(gets>0);
 assert.match((await page.getByTestId("evidence-source").textContent() ?? ""),/尚未启用评论兜底/);
 await page.reload();await page.locator(".voc-coverage summary").click(); await button.waitFor();await page.waitForTimeout(200);assert.equal(posts,0);
 await button.evaluate((element:HTMLButtonElement)=>{element.click();element.click();});await page.getByRole("alert").waitFor();assert.equal(posts,1);
 await page.getByRole("button",{name:"Logout",exact:true}).click();assert.match((await page.getByTestId("evidence-source").textContent() ?? ""),/等待可信输入/);
});

test("fixed fallback source survives missing keywords and refresh; a new click after success uses a new key",async t=>{
 const page=await browser.newPage();t.after(()=>page.close());const keys:string[]=[];let reads=0;
 const runId="10000000-0000-4000-8000-000000000009";
 const run={id:runId,projectId,mode:"existing-data",status:"waiting-input",createdBy:organizationId,dataCutoffAt:now,createdAt:now,updatedAt:now};
 const state={run,stages:[],evidenceSelection:inventory().fallback};
 await page.route("**/*",async route=>{
  const req=route.request();if(!req.url().startsWith(origin))return route.abort();if(!req.url().includes("/api/agent/"))return route.continue();if(req.url().includes("voc-automation"))return route.fulfill({json:{projectId,baseSyncRunId,selectedAsins:[asin],state:"waiting-voc",runId:null,message:"等待 VOC",updatedAt:now,startedAt:null}});
  if(req.method()==="POST"){keys.push(req.postDataJSON().idempotencyKey);return route.fulfill({json:state});}
  reads++; return route.fulfill({json:req.url().includes("voc-inputs")?inventory():req.url().endsWith("reports")?{reports:[]}:state});
 });
 await page.goto(`${origin}/tests/agent/helpers/voc-evidence-browser-harness.html`);await page.locator(".voc-coverage summary").click();
 const start=page.getByRole("button",{name:"使用评论兜底分析"});await start.click();
 await page.getByTestId("evidence-source").filter({hasText:"本次固定输入"}).waitFor();assert.match((await page.getByTestId("evidence-source").textContent() ?? ""),/评论兜底版.*待手工 VOC 验证/);
 await page.reload();await page.locator(".voc-coverage summary").click();await page.getByTestId("evidence-source").filter({hasText:"本次固定输入"}).waitFor();assert.equal(keys.length,1);
 await start.click();await page.waitForTimeout(150);assert.equal(keys.length,2);assert.notEqual(keys[0],keys[1]);assert.ok(reads>1);
});

test("real saved output becomes history on edit and disappears on logout",async t=>{
 const page=await browser.newPage();t.after(()=>page.close());let posts=0, changed=false;
 const readyInventory=()=>{const value=inventory();value.manual.keywords.state="ready";value.fallback.keywords.state="ready";return value;};
 const runId="10000000-0000-4000-8000-000000000009", reportId="10000000-0000-4000-8000-000000000008";
 const stage={id:reportId,runId,stage:"product-definition",status:"succeeded",progress:100,attemptCount:1,startedAt:now,completedAt:now,lastError:null,createdAt:now,updatedAt:now};
 const run={id:runId,projectId,mode:"existing-data",status:"succeeded",createdBy:organizationId,dataCutoffAt:now,createdAt:now,updatedAt:now};
 const report={schemaVersion:"1.0.0",id:reportId,runId,agentRunId:reportId,version:1,stage:"product-definition",status:"complete",skill:{id:"define-amazon-product-from-voc-keywords",version:"1.0.0",contentHash:"d".repeat(64)},snapshotIds:[reportId],model:{model:"fixture",provider:"fixture"},dataCutoffAt:now,evidence:[{id:"voc-1",type:"theme",sourceId:"fixture",capturedAt:now}],result:{...persistedResult,evidenceSelection:readyInventory().fallback,identity:{...persistedResult.identity,inputFingerprint:readyInventory().fallback.fingerprint}},createdAt:now};
 await page.route("**/*",async route=>{
  const req=route.request();if(!req.url().startsWith(origin))return route.abort();if(!req.url().includes("/api/agent/"))return route.continue();if(req.url().includes("voc-automation"))return route.fulfill({json:{projectId,baseSyncRunId,selectedAsins:[asin],state:"waiting-voc",runId:null,message:"等待 VOC",updatedAt:now,startedAt:null}});
  if(req.method()==="POST")posts++;
  const inputs=readyInventory();if(changed)inputs.fallback.fingerprint="f".repeat(64);
  return route.fulfill({json:req.url().includes("voc-inputs")?inputs:req.url().endsWith("reports")?{reports:[report]}:{run,stages:[stage],evidenceSelection:readyInventory().fallback}});
 });
 await page.goto(`${origin}/tests/agent/helpers/voc-evidence-browser-harness.html?vocRun=${runId}&vocAsins=${asin}`);
 await page.getByText("PERSISTED_RESULT_MARKER",{exact:true}).waitFor();
 assert.equal(posts,0);assert.equal(await page.getByText("历史报告待更新",{exact:false}).count(),0);
 changed=true;await page.getByRole("button",{name:"Edit manual"}).click();await page.getByText("输入已变化或旧报告缺少来源版本：历史报告待更新。",{exact:true}).waitFor();assert.equal(posts,0);
 await page.screenshot({path:".superpowers/sdd/evidence-history-browser.png",fullPage:true});
 await page.getByRole("button",{name:"Logout",exact:true}).click();assert.equal(await page.getByText("PERSISTED_RESULT_MARKER",{exact:true}).count(),0);
});

test("an old inventory response after logout cannot restore another scope", async t=>{
 const page=await browser.newPage();t.after(()=>page.close());let release!:()=>void,entered!:()=>void;
 const gate=new Promise<void>(resolve=>{release=resolve;}), requested=new Promise<void>(resolve=>{entered=resolve;});
 await page.route("**/*",async route=>{const req=route.request();if(!req.url().startsWith(origin))return route.abort();if(!req.url().includes("/api/agent/"))return route.continue();if(req.url().includes("voc-automation"))return route.fulfill({json:{projectId,baseSyncRunId,selectedAsins:[asin],state:"waiting-voc",runId:null,message:"等待 VOC",updatedAt:now,startedAt:null}});assert.equal(req.method(),"GET");entered();await gate;await route.fulfill({json:inventory()}).catch(()=>{});});
 await page.goto(`${origin}/tests/agent/helpers/voc-evidence-browser-harness.html`);await page.locator(".voc-coverage summary").click();await requested;
 await page.getByRole("button",{name:"Logout",exact:true}).click();release();await page.waitForTimeout(150);
 assert.equal((await page.getByTestId("evidence-source").textContent() ?? ""),"等待可信输入");assert.equal(await page.getByRole("button",{name:"使用评论兜底分析"}).isDisabled(),true);
});

test("a late POST after scope deselection cannot attach a run", async t=>{
 const page=await browser.newPage();t.after(()=>page.close());let release!:()=>void,entered!:()=>void,posts=0;
 const gate=new Promise<void>(resolve=>{release=resolve;}),requested=new Promise<void>(resolve=>{entered=resolve;});
 await page.route("**/*",async route=>{const req=route.request();if(!req.url().startsWith(origin))return route.abort();if(!req.url().includes("/api/agent/"))return route.continue();if(req.url().includes("voc-automation"))return route.fulfill({json:{projectId,baseSyncRunId,selectedAsins:[asin],state:"waiting-voc",runId:null,message:"等待 VOC",updatedAt:now,startedAt:null}});
  if(req.method()!=="POST")return route.fulfill({json:inventory()});posts++;entered();await gate;
  await route.fulfill({json:{run:{id:"10000000-0000-4000-8000-000000000009",projectId,mode:"existing-data",status:"queued",createdBy:organizationId,dataCutoffAt:now,createdAt:now,updatedAt:now},stages:[]}}).catch(()=>{});
 });
 await page.goto(`${origin}/tests/agent/helpers/voc-evidence-browser-harness.html`);await page.locator(".voc-coverage summary").click();await page.getByRole("button",{name:"使用评论兜底分析"}).click();await requested;
 await page.getByRole("checkbox").uncheck();release();await page.waitForTimeout(150);assert.equal(posts,1);assert.equal(new URL(page.url()).searchParams.get("vocRun"),null);assert.equal((await page.getByTestId("evidence-source").textContent() ?? ""),"等待可信输入");
});

for(const action of ["Switch project","Switch session"]) test(`late input from old ${action} is ignored`,async t=>{
 const page=await browser.newPage();t.after(()=>page.close());let release!:()=>void, entered!:()=>void,reads=0;
 const gate=new Promise<void>(resolve=>{release=resolve;}),requested=new Promise<void>(resolve=>{entered=resolve;});
 await page.route("**/*",async route=>{const req=route.request();if(!req.url().startsWith(origin))return route.abort();if(!req.url().includes("/api/agent/"))return route.continue();if(req.url().includes("voc-automation"))return route.fulfill({json:{projectId,baseSyncRunId,selectedAsins:[asin],state:"waiting-voc",runId:null,message:"等待 VOC",updatedAt:now,startedAt:null}});assert.equal(req.method(),"GET");reads++;if(reads===1){entered();await gate;await route.fulfill({json:inventory()}).catch(()=>{});}else await route.fulfill({status:403,json:{error:{message:"Fixture scope denied"}}});});
 await page.goto(`${origin}/tests/agent/helpers/voc-evidence-browser-harness.html`);await page.locator(".voc-coverage summary").click();await requested;await page.getByRole("button",{name:action,exact:true}).click();release();await page.getByRole("alert").waitFor();assert.equal((await page.getByTestId("evidence-source").textContent() ?? ""),"等待可信输入");
});


test("failed replacement preserves saved history across reload without creating another run",async t=>{
 const page=await browser.newPage();t.after(()=>page.close());let posts=0;
 const readyInventory=()=>{const value=inventory();value.manual.keywords.state="ready";value.fallback.keywords.state="ready";return value;};
 const runId="10000000-0000-4000-8000-000000000009", reportId="10000000-0000-4000-8000-000000000008";
 const stage={id:reportId,runId,stage:"product-definition",status:"succeeded",progress:100,attemptCount:1,startedAt:now,completedAt:now,lastError:null,createdAt:now,updatedAt:now};
 const run={id:runId,projectId,mode:"existing-data",status:"succeeded",createdBy:organizationId,dataCutoffAt:now,createdAt:now,updatedAt:now};
 const report={schemaVersion:"1.0.0",id:reportId,runId,agentRunId:reportId,version:1,stage:"product-definition",status:"complete",skill:{id:"define-amazon-product-from-voc-keywords",version:"1.0.0",contentHash:"d".repeat(64)},snapshotIds:[reportId],model:{model:"fixture",provider:"fixture"},dataCutoffAt:now,evidence:[{id:"voc-1",type:"theme",sourceId:"fixture",capturedAt:now}],result:{...persistedResult,evidenceSelection:readyInventory().fallback,identity:{...persistedResult.identity,inputFingerprint:readyInventory().fallback.fingerprint}},createdAt:now};

 const failedId="10000000-0000-4000-8000-000000000007";
 const failedState={run:{...run,id:failedId,status:"failed"},stages:[{...stage,runId:failedId,status:"failed"}],evidenceSelection:readyInventory().fallback};
 await page.route("**/*",async route=>{
  const req=route.request();if(!req.url().startsWith(origin))return route.abort();if(!req.url().includes("/api/agent/"))return route.continue();if(req.url().includes("voc-automation"))return route.fulfill({json:{projectId,baseSyncRunId,selectedAsins:[asin],state:"waiting-voc",runId:null,message:"等待 VOC",updatedAt:now,startedAt:null}});
  if(req.method()==="POST"){posts++;return route.fulfill({json:failedState});}
  if(req.url().includes("voc-inputs"))return route.fulfill({json:readyInventory()});
  const failed=req.url().includes(failedId);
  return route.fulfill({json:req.url().endsWith("reports")?{reports:failed?[]:[report]}:failed?failedState:{run,stages:[stage],evidenceSelection:readyInventory().fallback}});
 });
 await page.goto(`${origin}/tests/agent/helpers/voc-evidence-browser-harness.html?vocRun=${runId}&vocAsins=${asin}`);
 await page.getByText("PERSISTED_RESULT_MARKER",{exact:true}).waitFor();
 assert.equal(await page.getByText("输入已变化或旧报告缺少来源版本：历史报告待更新。",{exact:true}).count(),0);
 await page.getByRole("button",{name:"使用评论兜底分析"}).click();
 const historyNotice=page.getByText("输入已变化或旧报告缺少来源版本：历史报告待更新。",{exact:true});
 await historyNotice.waitFor();
 // The busy state marks the old report as history before the POST response updates the URL.
 await page.waitForURL(url => url.searchParams.get("vocRun") === failedId);
 assert.equal(posts,1);
 assert.equal(new URL(page.url()).searchParams.get("vocRun"),failedId);
 assert.equal(new URL(page.url()).searchParams.get("vocHistory"),runId);
 await page.getByText("PERSISTED_RESULT_MARKER",{exact:true}).waitFor();
 await page.reload();await page.locator(".voc-coverage summary").click();await historyNotice.waitFor();await page.getByText("PERSISTED_RESULT_MARKER",{exact:true}).waitFor();
 assert.equal(posts,1);
});

for (const marketplace of ["DE", "CA"]) test(`${marketplace} panel uses scoped fallback without manual automation`, async t => {
 const page=await browser.newPage();t.after(()=>page.close());let automationCalls=0,posts=0;
 const scoped=inventory();scoped.manual.marketplace=marketplace;scoped.fallback.marketplace=marketplace;
 await page.route("**/*", async route => {
  const req=route.request();if(!req.url().startsWith(origin))return route.abort();if(!req.url().includes("/api/agent/"))return route.continue();
  if(req.url().includes("voc-automation")){automationCalls++;return route.fulfill({status:500,json:{}});}
  if(req.method()==="POST"){posts++;assert.equal(req.postDataJSON().evidenceSelection.sourcePolicy,"manual-with-review-fallback");return route.fulfill({status:409,json:{error:{message:"fixture input changed"}}});}
  return route.fulfill({json:scoped});
 });
 await page.goto(`${origin}/tests/agent/helpers/voc-evidence-browser-harness.html?marketplace=${marketplace}`);
 await page.getByText("本站评论已就绪",{exact:true}).waitFor();
 assert.equal(automationCalls,0);assert.equal(posts,0);
 await page.getByRole("button",{name:"使用评论兜底分析"}).click();await page.getByRole("alert").waitFor();assert.equal(posts,1);assert.equal(automationCalls,0);
});
