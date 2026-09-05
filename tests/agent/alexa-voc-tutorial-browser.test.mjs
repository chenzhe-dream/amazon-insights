import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readdirSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { chromium } from "playwright";

const user = {
  id: "018f1f5c-60f0-4b7a-8000-000000000001",
  organizationId: "018f1f5c-60f0-4b7a-8000-000000000002",
  email: "admin@example.com",
  displayName: "Admin",
  role: "admin",
  status: "active",
  createdAt: "2026-09-04T00:00:00.000Z",
  updatedAt: "2026-09-04T00:00:00.000Z",
};
const sessionIdentity = "A".repeat(43);
const expectedTemplate = "这个产品的顾客关注点是什么、好评点是什么、差评点是什么、未被满足的需求是什么、使用人群是谁、使用场景是什么、购买动机是什么。";

let browser;
let serverProcess;
let baseUrl;
let serverOutput = "";

function browserExecutablePath() {
  const defaultPath = chromium.executablePath();
  if (existsSync(defaultPath)) return defaultPath;
  const browsersPath = join(process.env.LOCALAPPDATA ?? "", "ms-playwright");
  if (existsSync(browsersPath)) {
    const chromiumDirectory = readdirSync(browsersPath, { withFileTypes: true })
      .find(entry => entry.isDirectory() && entry.name.startsWith("chromium-"));
    if (chromiumDirectory) {
      const fallbackPath = join(browsersPath, chromiumDirectory.name, "chrome-win64", "chrome.exe");
      if (existsSync(fallbackPath)) return fallbackPath;
    }
  }
  const systemChrome = join(process.env.ProgramFiles ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe");
  assert.ok(existsSync(systemChrome), "Playwright Chromium or system Chrome is required");
  return systemChrome;
}

async function reservePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  const closed = once(server, "close");
  server.close();
  await closed;
  return port;
}

async function waitForServer(url) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Built Web server did not start:\n${serverOutput}`);
}

before(async () => {
  const port = await reservePort();
  baseUrl = `http://127.0.0.1:${port}`;
  serverProcess = spawn(process.execPath, ["scripts/team-prod-server.mjs"], {
    cwd: process.cwd(),
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  serverProcess.stdout.on("data", chunk => { serverOutput += chunk; });
  serverProcess.stderr.on("data", chunk => { serverOutput += chunk; });
  await waitForServer(baseUrl);
  browser = await chromium.launch({ headless: true, executablePath: browserExecutablePath() });
});

after(async () => {
  await browser?.close();
  if (serverProcess && serverProcess.exitCode === null) {
    serverProcess.kill("SIGTERM");
    await Promise.race([once(serverProcess, "exit"), new Promise(resolve => setTimeout(resolve, 5_000))]);
  }
});

async function openVocPage({ copyMode = "clipboard" } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(5_000);
  await page.addInitScript(({ copyMode }) => {
    window.__copiedAlexaVocTemplate = "";
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async text => {
          if (copyMode === "deferred") {
            return new Promise((resolve, reject) => {
              window.__finishTemplateCopy = resolve;
              window.__failTemplateCopy = reject;
            });
          }
          if (copyMode !== "clipboard") throw new Error("clipboard unavailable");
          window.__copiedAlexaVocTemplate = text;
        },
      },
    });
    document.execCommand = command => {
      if (copyMode !== "fallback" || command !== "copy") return false;
      const active = document.activeElement;
      if (!(active instanceof HTMLTextAreaElement)) return false;
      window.__copiedAlexaVocTemplate = active.value.slice(active.selectionStart, active.selectionEnd);
      return true;
    };
  }, { copyMode });
  await page.route("**/api/catalog", route => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ items: [] }),
  }));
  await page.route("**/api/agent/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/v1/auth/session")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ authenticated: true, user, sessionIdentity }),
      });
    }
    if (path.includes("/v1/local-data/projects")) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ projects: [] }) });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  await page.goto(`${baseUrl}/?tab=voc`, { waitUntil: "networkidle" });
  return { context, page };
}

async function waitUntilClosed(page, dialog) {
  await dialog.waitFor({ state: "detached" });
  await page.waitForFunction(() => document.body.style.overflow === "");
}

test("discarding pending feedback cannot erase the next draft", async () => {
  const { context, page } = await openVocPage();
  try {
    const entry = page.locator(".help-feedback-entry");
    await entry.click();
    await page.getByRole("tab", { name: "提交反馈", exact: true }).click();
    await page.getByLabel("标题").fill("正在提交的旧草稿");
    await page.getByLabel("详细描述").fill("延迟返回时已经重新打开抽屉。");
    let releaseSubmit;
    const held = new Promise(resolve => { releaseSubmit = resolve; });
    let requestArrived;
    const arrived = new Promise(resolve => { requestArrived = resolve; });
    await page.route("**/api/agent/v1/feedback", async route => {
      requestArrived();
      await held;
      await route.fulfill({ json: { feedbackId: "delayed-test-only", createdAt: new Date().toISOString() } });
    });
    await page.getByRole("button", { name: "提交反馈", exact: true }).click();
    await arrived;
    page.once("dialog", dialog => dialog.accept());
    await page.getByRole("button", { name: "关闭帮助与反馈", exact: true }).click();
    await entry.click();
    await page.getByLabel("标题").fill("必须保留的新草稿");
    const response = page.waitForResponse(response => response.url().endsWith("/api/agent/v1/feedback"));
    releaseSubmit();
    await response;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.getByLabel("标题").inputValue(), "必须保留的新草稿");
    assert.equal(await page.getByRole("button", { name: "提交反馈", exact: true }).isEnabled(), true);
  } finally {
    await context.close();
  }
});

test("Alexa VOC tutorial opens with the approved image and closes accessibly", async () => {
  const { context, page } = await openVocPage();
  try {
    const trigger = page.getByRole("button", { name: "查看录入教程", exact: true });
    await trigger.waitFor({ timeout: 5_000 });
    const dialog = page.getByRole("dialog", { name: "Alexa VOC 录入教程" });
    assert.equal(await dialog.count(), 0);

    await trigger.click();
    await dialog.waitFor();
    assert.equal(await dialog.getAttribute("aria-modal"), "true");
    const close = dialog.getByRole("button", { name: "关闭录入教程" });
    assert.equal(await close.evaluate(element => document.activeElement === element), true);
    for (const text of [
      "打开 Amazon 商品详情页与 Alexa for Shopping。",
      "将七问模板一次性粘贴到对话框。",
      "复制 Alexa 完整回复，返回系统选择对应 ASIN 并导入。",
    ]) await dialog.getByText(text).waitFor();
    await dialog.getByText("请复制完整回复，不要只复制摘要。").waitFor();
    const template = dialog.getByRole("textbox", { name: "七问模板" });
    assert.equal(await template.inputValue(), expectedTemplate);
    assert.equal(await template.getAttribute("readonly"), "");
    const screenshot = dialog.getByRole("img", { name: "Alexa for Shopping 中粘贴七问模板的操作示例" });
    const screenshotUrl = new URL(await screenshot.getAttribute("src"), page.url());
    assert.equal(screenshotUrl.searchParams.get("url") ?? screenshotUrl.pathname, "/tutorials/alexa-voc-entry.png");
    assert.equal(await page.evaluate(() => document.body.style.overflow), "hidden");

    await dialog.click({ position: { x: 40, y: 40 } });
    assert.equal(await dialog.count(), 1);

    await page.keyboard.press("Escape");
    await waitUntilClosed(page, dialog);
    assert.equal(await trigger.evaluate(element => document.activeElement === element), true);

    await trigger.click();
    await page.locator('[data-testid="alexa-voc-tutorial-backdrop"]').click({ position: { x: 4, y: 4 } });
    await waitUntilClosed(page, dialog);

    await trigger.click();
    await close.click();
    await waitUntilClosed(page, dialog);

    await page.setViewportSize({ width: 390, height: 844 });
    await trigger.click();
    await dialog.waitFor();
    const narrowBox = await dialog.boundingBox();
    assert.ok(narrowBox);
    assert.ok(narrowBox.x >= 0 && narrowBox.x + narrowBox.width <= 390);
  } finally {
    await context.close();
  }
});

test("Alexa VOC tutorial copies the exact template with the Clipboard API", async () => {
  const { context, page } = await openVocPage();
  try {
    await page.getByRole("button", { name: "查看录入教程", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Alexa VOC 录入教程" });
    await dialog.getByRole("button", { name: "复制模板", exact: true }).click();
    assert.equal(await page.evaluate(() => window.__copiedAlexaVocTemplate), expectedTemplate);
    await dialog.getByRole("button", { name: "已复制", exact: true }).waitFor();
  } finally {
    await context.close();
  }
});

test("Alexa VOC tutorial copies through the selectable-text fallback", async () => {
  const { context, page } = await openVocPage({ copyMode: "fallback" });
  try {
    await page.getByRole("button", { name: "查看录入教程", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Alexa VOC 录入教程" });
    await dialog.getByRole("button", { name: "复制模板", exact: true }).click();
    assert.equal(await page.evaluate(() => window.__copiedAlexaVocTemplate), expectedTemplate);
    await dialog.getByRole("button", { name: "已复制", exact: true }).waitFor();
  } finally {
    await context.close();
  }
});

test("Alexa VOC tutorial keeps the template selectable when copying fails", async () => {
  const { context, page } = await openVocPage({ copyMode: "failure" });
  try {
    await page.getByRole("button", { name: "查看录入教程", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Alexa VOC 录入教程" });
    const template = dialog.getByRole("textbox", { name: "七问模板" });
    await dialog.getByRole("button", { name: "复制模板", exact: true }).click();
    await dialog.getByText("复制失败，请手动选择", { exact: true }).waitFor();
    const selection = await template.evaluate(element => ({
      start: element.selectionStart,
      end: element.selectionEnd,
      length: element.value.length,
    }));
    assert.deepEqual(selection, { start: 0, end: selection.length, length: selection.length });
  } finally {
    await context.close();
  }
});

test("tutorial keyboard navigation stays inside the open dialog", async () => {
  const { context, page } = await openVocPage();
  try {
    await page.getByRole("button", { name: "查看录入教程", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Alexa VOC 录入教程" });
    await page.keyboard.press("Shift+Tab");
    assert.equal(await dialog.evaluate(node => node.contains(document.activeElement)), true);
    await dialog.getByRole("textbox", { name: "七问模板" }).focus();
    await page.keyboard.press("Tab");
    assert.equal(await dialog.getByRole("button", { name: "关闭录入教程" }).evaluate(node => node === document.activeElement), true);
  } finally {
    await context.close();
  }
});

test("a delayed clipboard result cannot update a reopened tutorial", async () => {
  const { context, page } = await openVocPage({ copyMode: "deferred" });
  try {
    const trigger = page.getByRole("button", { name: "查看录入教程", exact: true });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "Alexa VOC 录入教程" });
    await dialog.getByRole("button", { name: "复制模板", exact: true }).click();
    await page.waitForFunction(() => typeof window.__finishTemplateCopy === "function");
    await page.keyboard.press("Escape");
    await trigger.click();
    await page.evaluate(async () => {
      window.__finishTemplateCopy();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    assert.equal(await dialog.getByRole("button", { name: "已复制", exact: true }).count(), 0);
    assert.equal(await dialog.getByRole("button", { name: "复制模板", exact: true }).count(), 1);
  } finally {
    await context.close();
  }
});
