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
  createdAt: "2026-08-20T00:00:00.000Z",
  updatedAt: "2026-08-20T00:00:00.000Z",
};
const sessionIdentity = "A".repeat(43);

let browser;
let serverProcess;
let baseUrl;
let serverOutput = "";
let passwordResponse = route => route.fulfill({
  status: 401,
  contentType: "application/json",
  body: JSON.stringify({ error: { code: "INVALID_CREDENTIALS", message: "safe", requestId: "wrong-current" } }),
});

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
  assert.ok(existsSync(systemChrome), "Playwright Chromium or system Chrome is required for this browser test");
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
    await Promise.race([
      once(serverProcess, "exit"),
      new Promise(resolve => setTimeout(resolve, 5_000)),
    ]);
  }
});

async function openAuthenticatedPage() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.route("**/api/catalog", route => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ items: [] }),
  }));
  await page.route("**/api/agent/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/v1/auth/session")) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ authenticated: true, user, sessionIdentity }) });
    }
    if (path.endsWith("/v1/auth/password")) {
      return passwordResponse(route);
    }
    if (path.includes("/v1/local-data/projects")) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ projects: [] }) });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "修改密码", exact: true }).waitFor();
  return { context, page };
}

test("password dialog portals to body, stays inline on wrong password, and tears down cleanly", async () => {
  const { context, page } = await openAuthenticatedPage();
  try {
    const trigger = page.getByRole("button", { name: "修改密码", exact: true });
    assert.equal(await page.locator("body > .auth-modal-backdrop").count(), 0);
    await trigger.click();

    const backdrop = page.locator("body > .auth-modal-backdrop");
    const dialog = page.getByRole("dialog", { name: "修改密码" });
    assert.equal(await backdrop.count(), 1);
    assert.equal(await dialog.locator('input[name="currentPassword"]').evaluate(element => document.activeElement === element), true);
    assert.equal(await dialog.getAttribute("aria-modal"), "true");
    assert.equal(await page.evaluate(() => document.body.style.overflow), "hidden");
    await dialog.getByRole("button", { name: "关闭", exact: true }).focus();
    await page.keyboard.press("Shift+Tab");
    assert.equal(await dialog.getByRole("button", { name: "更新密码" }).evaluate(node => node === document.activeElement), true);
    assert.equal(await dialog.locator('input[name="currentPassword"]').getAttribute("autocomplete"), "current-password");
    assert.equal(await dialog.locator('input[name="newPassword"]').getAttribute("autocomplete"), "new-password");
    assert.equal(await dialog.locator('input[name="confirmation"]').getAttribute("autocomplete"), "new-password");
    for (const name of ["currentPassword", "newPassword", "confirmation"]) {
      const input = dialog.locator(`input[name="${name}"]`);
      assert.equal(await input.getAttribute("minlength"), "8");
      assert.equal(await input.getAttribute("maxlength"), "1024");
    }

    const desktopBox = await backdrop.boundingBox();
    assert.ok(desktopBox);
    assert.ok(desktopBox.x <= 1 && desktopBox.y <= 1);
    assert.ok(desktopBox.width >= 1279 && desktopBox.height >= 799);

    await dialog.getByLabel("当前密码").fill("wrong-pass");
    await dialog.getByLabel("新密码", { exact: true }).fill("new-pass-1");
    await dialog.getByLabel("确认新密码").fill("new-pass-1");
    await dialog.getByRole("button", { name: "更新密码" }).click();
    await page.getByText("密码更新失败，请检查当前密码和新密码").waitFor();
    await page.locator(".auth-identity-control").waitFor();

    await page.keyboard.press("Escape");
    assert.equal(await backdrop.count(), 0);
    assert.equal(await page.evaluate(() => document.body.style.overflow), "");
    assert.equal(await trigger.evaluate(element => document.activeElement === element), true);
    await trigger.click();
    assert.equal(await page.getByText("密码更新失败，请检查当前密码和新密码").count(), 0);
    assert.equal(await dialog.locator('input[name="currentPassword"]').evaluate(element => document.activeElement === element), true);
    await dialog.getByRole("button", { name: "关闭" }).click();
    assert.equal(await backdrop.count(), 0);
    assert.equal(await trigger.evaluate(element => document.activeElement === element), true);
    await trigger.click();
    assert.equal(await dialog.locator('input[name="currentPassword"]').evaluate(element => document.activeElement === element), true);

    await page.setViewportSize({ width: 390, height: 844 });
    const narrowBox = await backdrop.boundingBox();
    const formBox = await dialog.boundingBox();
    assert.ok(narrowBox && formBox);
    assert.ok(narrowBox.x <= 1 && narrowBox.y <= 1);
    assert.ok(narrowBox.width >= 389 && narrowBox.height >= 843);
    assert.ok(formBox.x >= 0 && formBox.y >= 0);
    assert.ok(formBox.x + formBox.width <= 390 && formBox.y + formBox.height <= 844);
    assert.equal(await dialog.locator('input[name="currentPassword"]').evaluate(element => document.activeElement === element), true);

    await page.keyboard.press("Escape");
    assert.equal(await page.locator("body > .auth-modal-backdrop").count(), 0);
    assert.equal(await page.locator(".feedback-modal").count(), 0);
  } finally {
    await context.close();
  }
});

test("a stale password response cannot update a second pending dialog", async () => {
  let requestCount = 0;
  let resolveA;
  let resolveB;
  let acknowledgeARequest;
  let acknowledgeBRequest;
  const aRequestHeld = new Promise(resolve => { acknowledgeARequest = resolve; });
  const bRequestHeld = new Promise(resolve => { acknowledgeBRequest = resolve; });
  passwordResponse = route => new Promise(resolve => {
    requestCount += 1;
    if (requestCount === 1) {
      resolveA = () => resolve(route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) }));
      acknowledgeARequest();
      return;
    }
    if (requestCount === 2) {
      resolveB = () => resolve(route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "INVALID_CREDENTIALS", message: "safe", requestId: "b-wrong-current" } }),
      }));
      acknowledgeBRequest();
      return;
    }
    throw new Error("Unexpected password request");
  });
  const { context, page } = await openAuthenticatedPage();
  try {
    const trigger = page.getByRole("button", { name: "修改密码", exact: true });
    const backdrop = page.locator("body > .auth-modal-backdrop");
    const dialog = page.getByRole("dialog", { name: "修改密码" });
    await trigger.click();
    await dialog.locator('input[name="currentPassword"]').fill("a-current-password");
    await dialog.locator('input[name="newPassword"]').fill("a-new-password");
    await dialog.locator('input[name="confirmation"]').fill("a-new-password");
    await dialog.getByRole("button", { name: "更新密码" }).click();
    await dialog.getByRole("button", { name: "更新中…" }).waitFor();
    await aRequestHeld;

    await dialog.getByRole("button", { name: "关闭" }).click();
    await trigger.click();
    await dialog.locator('input[name="currentPassword"]').fill("b-current-password");
    await dialog.locator('input[name="newPassword"]').fill("b-new-password");
    await dialog.locator('input[name="confirmation"]').fill("b-new-password");
    const aResponseSeen = page.waitForResponse(response => response.url().includes("/v1/auth/password") && response.status() === 200);
    await dialog.getByRole("button", { name: "更新密码" }).click();
    await dialog.getByRole("button", { name: "更新中…" }).waitFor();
    await bRequestHeld;
    resolveA();
    await aResponseSeen;
    await page.evaluate(() => Promise.resolve());
    assert.equal(await dialog.locator('input[name="currentPassword"]').inputValue(), "b-current-password");
    assert.equal(await dialog.locator('input[name="newPassword"]').inputValue(), "b-new-password");
    assert.equal(await dialog.locator('input[name="confirmation"]').inputValue(), "b-new-password");
    assert.equal(await dialog.getByRole("button", { name: "更新中…" }).isDisabled(), true);
    assert.equal(await page.getByText("密码已更新，其他登录会话已退出").count(), 0);
    assert.equal(await page.getByText("密码更新失败，请检查当前密码和新密码").count(), 0);
    resolveB();
    await page.getByText("密码更新失败，请检查当前密码和新密码").waitFor();
    assert.equal(await dialog.getByRole("button", { name: "更新密码" }).isDisabled(), false);
    assert.equal(await page.getByText("密码已更新，其他登录会话已退出").count(), 0);
    await page.keyboard.press("Escape");
    assert.equal(await backdrop.count(), 0);
  } finally {
    passwordResponse = route => route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "INVALID_CREDENTIALS", message: "safe", requestId: "wrong-current" } }),
    });
    await context.close();
  }
});
