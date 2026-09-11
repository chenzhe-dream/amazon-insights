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
function manualInventory(fingerprint = "d".repeat(64)) {
 const value=inventory();
 value.manual.fingerprint=fingerprint;
 value.manual.keywords.state="ready";
 Object.assign(value.manual.coverage[0], {primary:"manual", missingDimensions:[], manual:{id:"manual-fixture",version:"1",contentHash:fingerprint,capturedAt:now}});
 return value;
}

test("automation registers missing inputs without claiming execution",async t=>{
 const page=await browser.newPage();t.after(()=>page.close());let posts=0,reads=0;
 await page.route("**/api/agent/**",async route=>{const req=route.request();if(req.url().includes("voc-automation")){if(req.method()==="POST"){posts++;assert.deepEqual(req.postDataJSON(),{baseSyncRunId,selectedAsins:[asin]});}else reads++;return route.fulfill({json:{projectId,baseSyncRunId,selectedAsins:[asin],state:"waiting-voc",runId:null,message:"等待手工 VOC",updatedAt:now,startedAt:null}});}return route.fulfill({json:inventory()});});
 await page.goto(`${origin}/tests/agent/helpers/voc-evidence-browser-harness.html`);await page.getByTestId("automation-status").waitFor({timeout:5000});await page.waitForTimeout(1250);assert.equal(posts,1);assert.ok(reads>=1);assert.equal(await page.getByText("当前执行中",{exact:true}).count(),0);
 assert.equal(await page.locator(".voc-evidence-panel").evaluate(el=>getComputedStyle(el).borderRadius),"16px");
 await page.getByRole("button",{name:"Edit manual"}).click();await page.waitForTimeout(250);assert.equal(posts,1);
 await page.reload();await page.getByTestId("automation-status").waitFor();assert.equal(posts,2);
});

function automation(state = "waiting-voc", runId: string | null = null) { return {projectId,baseSyncRunId,selectedAsins:[asin],state,runId,message:state,updatedAt:now,startedAt:null}; }
test("failed automation uses a fresh retry key and preserves it after ambiguous failure",async t=>{
 const page=await browser.newPage();t.after(()=>page.close());const keys:(string|undefined)[]=[];
 await page.route("**/api/agent/**",async route=>{const req=route.request();if(req.url().includes("voc-automation")){if(req.method()==="POST"){keys.push(req.postDataJSON().retryKey);if(keys.length===2)return route.fulfill({status:503,json:{error:{message:"retry unavailable"}}});}return route.fulfill({json:automation("failed")});}return route.fulfill({json:manualInventory()});});
 await page.goto(`${origin}/tests/agent/helpers/voc-evidence-browser-harness.html`);await page.getByRole("button",{name:"重试手工 VOC 分析"}).click();await page.getByRole("alert").filter({hasText:"retry unavailable"}).waitFor();await page.getByRole("button",{name:"重试手工 VOC 分析"}).click();await page.waitForTimeout(250);assert.equal(keys.length,3);assert.equal(keys[0],undefined);assert.ok(keys[1]);assert.equal(keys[1],keys[2]);
});
test("automation GET failure retries reads without another POST",async t=>{
 const page=await browser.newPage();t.after(()=>page.close());let posts=0,fail=true;
 await page.route("**/api/agent/**",async route=>{const req=route.request();if(req.url().includes("voc-automation")){if(req.method()==="POST")posts++;else if(fail){fail=false;return route.fulfill({status:503,json:{error:{message:"status unavailable"}}});}return route.fulfill({json:automation("waiting-keywords")});}return route.fulfill({json:manualInventory()});});
 await page.goto(`${origin}/tests/agent/helpers/voc-evidence-browser-harness.html`);await page.getByRole("alert").filter({hasText:"status unavailable"}).waitFor({timeout:5000});await page.getByRole("button",{name:"重试读取分析状态"}).click();await page.waitForTimeout(1250);assert.equal(posts,1);
});
test("stale automation scope cannot attach a run or overwrite selection",async t=>{
 const page=await browser.newPage();t.after(()=>page.close());
 await page.route("**/api/agent/**",async route=>route.fulfill({json:route.request().url().includes("voc-automation")?{...automation("queued","10000000-0000-4000-8000-000000000009"),selectedAsins:["B000000000"]}:inventory()}));
 await page.goto(`${origin}/tests/agent/helpers/voc-evidence-browser-harness.html`);await page.getByRole("alert").filter({hasText:"自动分析范围不匹配"}).waitFor({timeout:5000});assert.ok(!page.url().includes("vocRun="));assert.equal(await page.getByRole("checkbox").isChecked(),true);
});

test("backend readiness advances into a saved run without browser resubmission",async t=>{
 const page=await browser.newPage();t.after(()=>page.close());let posts=0,ready=false;
 const runId="10000000-0000-4000-8000-000000000009";
 const run={run:{id:runId,projectId,mode:"existing-data",status:"running",createdBy:organizationId,dataCutoffAt:now,createdAt:now,updatedAt:now},stages:[],evidenceSelection:manualInventory().manual};
 await page.route("**/api/agent/**",async route=>{const req=route.request();if(req.url().includes("voc-automation")){if(req.method()==="POST")posts++;return route.fulfill({json:automation(ready?"voc-running":"waiting-keywords",ready?runId:null)});}return route.fulfill({json:req.url().includes("voc-inputs")?manualInventory():req.url().endsWith("reports")?{reports:[]}:run});});
 await page.goto(`${origin}/tests/agent/helpers/voc-evidence-browser-harness.html`);await page.getByTestId("automation-status").filter({hasText:"等待关键词"}).waitFor();ready=true;
 await page.waitForURL(/vocRun=/,{timeout:5000});await page.getByTestId("automation-status").filter({hasText:"VOC 分析中"}).waitFor();await page.waitForTimeout(1200);assert.equal(posts,1);
});

test("late automation POST after logout cannot restore a run",async t=>{
 const page=await browser.newPage();t.after(()=>page.close());let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);t.after(()=>release());let submitted=false;
 await page.route("**/api/agent/**",async route=>{if(route.request().url().includes("voc-automation")){submitted=true;await gate;return route.fulfill({json:automation("queued","10000000-0000-4000-8000-000000000009")}).catch(()=>{});}return route.fulfill({json:inventory()});});
 await page.goto(`${origin}/tests/agent/helpers/voc-evidence-browser-harness.html`);await page.waitForTimeout(200);assert.equal(submitted,true);await page.getByRole("button",{name:"Logout"}).click();release();await page.waitForTimeout(300);assert.ok(!page.url().includes("vocRun="));assert.equal(await page.getByText("当前执行中",{exact:true}).count(),0);
});

test("three ASIN panel screenshot shows compact waiting state",async t=>{
 const page=await browser.newPage({viewport:{width:1280,height:950}});t.after(()=>page.close());
 const asins=[asin,"B000000001","B000000002"];
 const value=inventory();value.manual.selectedAsins=asins;value.fallback.selectedAsins=asins;
 value.manual.coverage=asins.map(asin=>({...value.manual.coverage[0],asin}));value.fallback.coverage=asins.map(asin=>({...value.fallback.coverage[0],asin}));
 await page.route("**/api/agent/**",async route=>route.fulfill({json:route.request().url().includes("voc-automation")?{...automation(),selectedAsins:asins,message:"等待 3 个 ASIN 的手工 VOC 输入；齐全后后台自动分析。"}:value}));
 await page.goto(`${origin}/tests/agent/helpers/voc-evidence-browser-harness.html?catalogAsins=${asins.join(",")}`);await page.getByTestId("automation-status").filter({hasText:"等待手工 VOC"}).waitFor();await page.locator(".voc-evidence-panel").screenshot({path:"test-results/voc-automation-ui.png"});
 assert.equal(await page.getByRole("checkbox").count(),3);
});

test("explicit fallback run survives automation baseline and fallback failure retries fallback",async t=>{
 const page=await browser.newPage();t.after(()=>page.close());
 const fallbackId="10000000-0000-4000-8000-000000000008", manualId="10000000-0000-4000-8000-000000000009", nextId="10000000-0000-4000-8000-000000000010";
 let automationId=manualId, fallbackPosts=0;const retryKeys:unknown[]=[];
 const state=(id:string)=>({run:{id,projectId,mode:"existing-data",status:id===fallbackId?"failed":"succeeded",createdBy:organizationId,dataCutoffAt:now,createdAt:now,updatedAt:now},stages:[],evidenceSelection:id===fallbackId?inventory().fallback:manualInventory().manual});
 await page.route("**/api/agent/**",async route=>{const req=route.request();if(req.url().includes("voc-automation")){if(req.method()==="POST")retryKeys.push(req.postDataJSON().retryKey);return route.fulfill({json:automation("succeeded",automationId)});}if(req.method()==="POST"){fallbackPosts++;assert.equal(req.postDataJSON().evidenceSelection.sourcePolicy,"manual-with-review-fallback");return route.fulfill({json:state(fallbackId)});}return route.fulfill({json:req.url().includes("voc-inputs")?inventory():req.url().endsWith("reports")?{reports:[]}:state(req.url().includes(fallbackId)?fallbackId:automationId)});});
 await page.goto(`${origin}/tests/agent/helpers/voc-evidence-browser-harness.html?vocRun=${fallbackId}`);await page.locator(".voc-coverage summary").click();await page.getByTestId("evidence-source").filter({hasText:"评论兜底版"}).waitFor();await page.waitForTimeout(1300);assert.equal(new URL(page.url()).searchParams.get("vocRun"),fallbackId);assert.equal(await page.getByRole("button",{name:"重试手工 VOC 分析"}).count(),0);
 await page.getByRole("button",{name:"重试评论兜底分析"}).click();await page.waitForTimeout(250);assert.equal(fallbackPosts,1);assert.deepEqual(retryKeys,[undefined]);
 automationId=nextId;await page.waitForURL(new RegExp(`vocRun=${nextId}`),{timeout:5000});
});

test("new automation run replaces old manual URL after its source is known",async t=>{
 const page=await browser.newPage();t.after(()=>page.close());const oldId="10000000-0000-4000-8000-000000000008",newId="10000000-0000-4000-8000-000000000009";
 const state=(id:string)=>({run:{id,projectId,mode:"existing-data",status:id===oldId?"failed":"running",createdBy:organizationId,dataCutoffAt:now,createdAt:now,updatedAt:now},stages:[],evidenceSelection:manualInventory().manual});
 await page.route("**/api/agent/**",async route=>{const url=route.request().url();return route.fulfill({json:url.includes("voc-automation")?automation("voc-running",newId):url.includes("voc-inputs")?manualInventory():url.endsWith("reports")?{reports:[]}:state(url.includes(oldId)?oldId:newId)});});
 await page.goto(`${origin}/tests/agent/helpers/voc-evidence-browser-harness.html?vocRun=${oldId}`);await page.waitForURL(new RegExp(`vocRun=${newId}`),{timeout:5000});
});

test("legacy URL run without evidence manifest can advance to new automation run",async t=>{
 const page=await browser.newPage();t.after(()=>page.close());const oldId="10000000-0000-4000-8000-000000000008",newId="10000000-0000-4000-8000-000000000009";
 const state=(id:string)=>({run:{id,projectId,mode:"existing-data",status:id===oldId?"failed":"running",createdBy:organizationId,dataCutoffAt:now,createdAt:now,updatedAt:now},stages:[]});
 await page.route("**/api/agent/**",async route=>{const url=route.request().url();return route.fulfill({json:url.includes("voc-automation")?automation("voc-running",newId):url.includes("voc-inputs")?manualInventory():url.endsWith("reports")?{reports:[]}:state(url.includes(oldId)?oldId:newId)});});
 await page.goto(`${origin}/tests/agent/helpers/voc-evidence-browser-harness.html?vocRun=${oldId}`);await page.waitForURL(new RegExp(`vocRun=${newId}`),{timeout:5000});
});

test("failed automation overrides waiting definition and shows only readable stage error",async t=>{
 const page=await browser.newPage();t.after(()=>page.close());const runId="10000000-0000-4000-8000-000000000009";
 const stage=(name:string,status:string)=>({id:runId,runId,stage:name,status,progress:0,attemptCount:1,startedAt:now,completedAt:now,lastError:status==="failed"?{code:"AGENT_SERVICE_UNAVAILABLE",message:"分析服务暂不可用",requestId:"fixture-request",retryable:true}:null,createdAt:now,updatedAt:now});
 const run={run:{id:runId,projectId,mode:"existing-data",status:"failed",createdBy:organizationId,dataCutoffAt:now,createdAt:now,updatedAt:now},stages:[stage("voc-positioning","failed"),stage("product-definition","waiting-input")],evidenceSelection:manualInventory().manual};
 await page.route("**/api/agent/**",async route=>{const url=route.request().url();return route.fulfill({json:url.includes("voc-automation")?automation("failed",runId):url.includes("voc-inputs")?manualInventory():url.endsWith("reports")?{reports:[]}:run});});
 await page.goto(`${origin}/tests/agent/helpers/voc-evidence-browser-harness.html`);await page.getByRole("alert").filter({hasText:"分析服务暂不可用"}).waitFor();assert.ok(await page.getByText("当前执行失败",{exact:true}).count()>0);assert.equal(await page.getByRole("alert").first().textContent(),"VOC 分析失败：分析服务暂不可用");assert.equal(await page.getByRole("button",{name:"重试手工 VOC 分析"}).isEnabled(),true);
});
test("registration settles after disable and returning to same owner",async t=>{
 const page=await browser.newPage();t.after(()=>page.close());let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);t.after(()=>release());let posts=0;
 await page.route("**/api/agent/**",async route=>{const req=route.request();if(req.url().includes("voc-automation")){if(req.method()==="POST" && ++posts===1)await gate;return route.fulfill({json:automation("failed")}).catch(()=>{});}return route.fulfill({json:inventory()});});
 await page.goto(`${origin}/tests/agent/helpers/voc-evidence-browser-harness.html`);await page.getByText("正在登记分析范围…",{exact:true}).waitFor();await page.getByRole("button",{name:"Logout"}).click();release();await page.waitForTimeout(100);await page.getByRole("button",{name:"Resume"}).click();await page.getByTestId("automation-status").filter({hasText:"分析失败"}).waitFor();await page.waitForTimeout(1200);assert.equal(await page.getByRole("button",{name:"重试手工 VOC 分析"}).isEnabled(),true);assert.equal(await page.getByText("正在登记分析范围…",{exact:true}).count(),0);
});
