import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import react from "@vitejs/plugin-react";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import { verifyExportEligibility } from "../../app/project-export/read-export-eligibility";
import { exportOrganizationId, exportProjectFixture, exportSessionIdentity } from "./helpers/project-export-fixture";

let server: ViteDevServer, browser: Browser, origin: string;
before(async () => {
  server = await createServer({configFile:false,cacheDir:"test-results/navigation-selection-vite",define:{"process.env":"{}"},plugins:[react()],server:{host:"127.0.0.1",port:0}});
  await server.listen(); const address=server.httpServer!.address(); assert.ok(address && typeof address!=="string");
  origin=`http://127.0.0.1:${address.port}`; browser=await chromium.launch({headless:true});
});
after(async () => { await browser?.close(); await server?.close(); });

test("page groups follow the catalog; parents select admitted leaves and expose partial state", async t => {
  const page=await browser.newPage({viewport:{width:1440,height:1400}}); t.after(()=>page.close());
  await page.goto(`${origin}/tests/agent/helpers/snapshot-navigation-selection-harness.html`);
  const dialog=page.getByRole("dialog");
  const groups=dialog.locator("fieldset[data-export-group]");
  assert.deepEqual(await groups.locator("legend").allTextContents(), ["竞品概览","VOC","关键词调研","新品定义","立项前确认清单","竞品流量分析"]);
  await dialog.screenshot({path:"test-results/navigation-selection-modal-desktop.png"});
  assert.equal(await dialog.getByRole("checkbox",{name:"竞品参数总览",exact:true}).isChecked(),true);
  assert.equal(await dialog.getByRole("checkbox",{name:"包含变体 / 订单"}).isChecked(),true);
  assert.equal(await groups.first().getByRole("checkbox",{name:"包含变体 / 订单"}).count(),1);
  const overview=dialog.getByRole("checkbox",{name:"竞品概览",exact:true});
  await overview.uncheck();
  assert.equal(await dialog.getByRole("checkbox",{name:"竞品参数总览",exact:true}).isChecked(),false);
  assert.equal(await dialog.getByRole("checkbox",{name:"主辅图",exact:true}).isChecked(),false);
  assert.equal(await dialog.getByRole("checkbox",{name:"包含变体 / 订单"}).isDisabled(),true);
  assert.equal(await dialog.getByRole("checkbox",{name:"包含变体 / 订单"}).isChecked(),false);
  await dialog.getByRole("checkbox",{name:"主辅图",exact:true}).check();
  assert.equal(await overview.evaluate((input:HTMLInputElement)=>input.indeterminate),true);
  await overview.check();
  assert.equal(await dialog.getByRole("checkbox",{name:"竞品参数总览",exact:true}).isChecked(),true);
});

test("empty and one-page choices are reflected in the preview; inaccessible leaves are hidden", async t => {
  const page=await browser.newPage(); t.after(()=>page.close());
  await page.goto(`${origin}/tests/agent/helpers/snapshot-navigation-selection-harness.html`);
  const dialog=page.getByRole("dialog");
  for(const checkbox of await dialog.locator('input[data-export-page]').all()) await checkbox.uncheck();
  assert.equal(await dialog.getByRole("button",{name:"确认并开始导出"}).isDisabled(),true);
  await dialog.getByText("请至少勾选一个页面。",{exact:true}).waitFor();
  await dialog.getByRole("checkbox",{name:"竞品 VOC 洞察",exact:true}).check();
  assert.match(await dialog.innerText(),/已选择 1 个页面/);
  assert.equal(await dialog.getByRole("heading",{name:"竞品 VOC 洞察",exact:true}).count(),1);
  await page.getByRole("button",{name:"限制权限"}).evaluate((button:HTMLButtonElement)=>button.click());
  assert.equal(await dialog.getByRole("checkbox",{name:"关键词洞察"}).count(),0);
  assert.equal(await dialog.getByRole("checkbox",{name:"新品定义"}).count(),0);
});

test("confirmation rejects prepared content from another page sharing the same source", async () => {
  const project=exportProjectFixture();
  let reads=0;
  await assert.rejects(verifyExportEligibility({
    libraryProjectId:project.id,moduleIds:["voc"],selection:{pageIds:["voc-insight"],includeVariants:false},
    sessionIdentity:exportSessionIdentity,organizationId:exportOrganizationId,signal:new AbortController().signal,
  },{sourceProjectId:project.sourceProjectId,project,
    selection:{pageIds:["voc-summary"],moduleIds:["voc"],includeVariants:false}},
  async () => {reads++;throw new Error("unexpected read");}),/快照页面选择已变化/);
  assert.equal(reads,0);
});
