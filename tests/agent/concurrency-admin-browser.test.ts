import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";

import {
  listConnectorCredentials,
  probeConnector,
  revokeConnectorCredential,
  saveConnectorCredential,
} from "../../app/lib/concurrency-admin-browser";

let server: ViteDevServer;
let browser: Browser;
let baseUrl = "";

function browserExecutablePath() {
  const defaultPath = chromium.executablePath();
  if (existsSync(defaultPath)) return defaultPath;

  const browsersPath = join(process.env.LOCALAPPDATA ?? "", "ms-playwright");
  if (existsSync(browsersPath)) {
    const chromiumDirectory = readdirSync(browsersPath, { withFileTypes: true })
      .find((entry) => entry.isDirectory() && entry.name.startsWith("chromium-"));
    if (chromiumDirectory) {
      const fallbackPath = join(browsersPath, chromiumDirectory.name, "chrome-win64", "chrome.exe");
      if (existsSync(fallbackPath)) return fallbackPath;
    }
  }

  const systemChrome = join(process.env.ProgramFiles ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe");
  assert.ok(existsSync(systemChrome), "Playwright Chromium or system Chrome is required for this browser test");
  return systemChrome;
}

before(async () => {
  server = await createServer({
    configFile: false,
    server: {
      host: "127.0.0.1",
      port: 0,
    },
  });
  await server.listen();
  const address = server.httpServer?.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true, executablePath: browserExecutablePath() });
});

after(async () => {
  await browser?.close();
  await server?.close();
});

test("connector credential browser helpers use exact secret-safe requests", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string; body?: BodyInit | null }> = [];
  const credential = {
    connectorId: "sif",
    configured: true,
    managed: true,
    source: "managed",
    version: 1,
    updatedAt: "2026-08-23T08:00:00.000Z",
  };
  globalThis.fetch = (async (input, init) => {
    calls.push({
      url: String(input),
      method: (init?.method ?? "GET").toUpperCase(),
      body: init?.body,
    });
    const url = String(input);
    if (url.endsWith("/v1/connectors")) {
      return Response.json({ connectors: [
        credential,
        { ...credential, connectorId: "sorftime" },
        { ...credential, connectorId: "sellerSprite" },
      ] });
    }
    if (url.endsWith("/probe")) {
      return Response.json({
        connectorId: "sif",
        configured: true,
        available: true,
        reason: null,
        checkedAt: "2026-08-23T08:00:00.000Z",
      });
    }
    return Response.json(credential);
  }) as typeof fetch;
  try {
    await listConnectorCredentials();
    await saveConnectorCredential("sif", "one-use-secret");
    await revokeConnectorCredential("sif");
    await probeConnector("sif");
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(calls, [
    { url: "/api/agent/v1/connectors", method: "GET", body: undefined },
    { url: "/api/agent/v1/connectors/sif/credential", method: "PUT", body: JSON.stringify({ secret: "one-use-secret" }) },
    { url: "/api/agent/v1/connectors/sif/credential", method: "DELETE", body: undefined },
    { url: "/api/agent/v1/connectors/sif/probe", method: "POST", body: undefined },
  ]);
});

test("connector helpers reject unknown response fields without echoing submitted secrets", async () => {
  const originalFetch = globalThis.fetch;
  const sentinel = "credential-sentinel-never-echo";
  globalThis.fetch = (async () => Response.json({
    error: { message: sentinel },
  }, { status: 400 })) as typeof fetch;
  try {
    await assert.rejects(
      saveConnectorCredential("sif", sentinel),
      (error: unknown) => {
        assert.doesNotMatch(String(error), new RegExp(sentinel));
        return true;
      },
    );
    globalThis.fetch = (async () => Response.json({
      connectorId: "sif",
      configured: true,
      managed: true,
      source: "managed",
      version: 1,
      updatedAt: "2026-08-23T08:00:00.000Z",
      credential: sentinel,
    })) as typeof fetch;
    await assert.rejects(saveConnectorCredential("sif", sentinel));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("panel toggles A to B without network mutation and remains responsive", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.goto(`${baseUrl}/tests/agent/helpers/concurrency-admin-browser-harness.html`, {
      waitUntil: "domcontentloaded",
    });

    const region = page.getByRole("region", { name: "并发与额度" });
    const toggle = region.locator(".concurrency-admin-toggle");
    await toggle.waitFor();
    assert.equal(await toggle.textContent(), "展开管理");
    assert.equal(await toggle.getAttribute("aria-expanded"), "false");
    assert.equal(await region.getByRole("button", { name: "手动刷新" }).count(), 0);

    await toggle.click();
    assert.equal(await toggle.textContent(), "收起");
    assert.equal(await toggle.getAttribute("aria-expanded"), "true");
    assert.equal(await region.locator(".concurrency-admin-metric").count(), 4);
    assert.equal(await region.getByRole("button", { name: "手动刷新" }).count(), 1);
    assert.doesNotMatch(await region.textContent() ?? "", /credential is not configured/);

    const columns = await region.locator(".concurrency-admin-summary").evaluate((element) =>
      getComputedStyle(element).gridTemplateColumns.split(" ").length,
    );
    assert.equal(columns, 4);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    assert.deepEqual(await page.evaluate(() => window.__networkMethods), []);

    await toggle.click();
    assert.equal(await toggle.textContent(), "展开管理");
    assert.equal(await toggle.getAttribute("aria-expanded"), "false");

    await page.setViewportSize({ width: 900, height: 900 });
    await toggle.click();
    const mediumColumns = await region.locator(".concurrency-admin-summary").evaluate((element) =>
      getComputedStyle(element).gridTemplateColumns.split(" ").length,
    );
    assert.equal(mediumColumns, 2);
    await toggle.click();

    await page.setViewportSize({ width: 740, height: 900 });
    await toggle.click();
    const mobileColumns = await region.locator(".concurrency-admin-summary").evaluate((element) =>
      getComputedStyle(element).gridTemplateColumns.split(" ").length,
    );
    assert.equal(mobileColumns, 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    assert.deepEqual(await page.evaluate(() => window.__networkMethods), []);
  } finally {
    await page.close();
  }
});

test("credential save and probe double-clicks make one request and clear transient input", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.goto(`${baseUrl}/tests/agent/helpers/concurrency-admin-browser-harness.html`, {
      waitUntil: "domcontentloaded",
    });
    const region = page.getByRole("region", { name: "并发与额度" });
    await region.locator(".concurrency-admin-toggle").click();
    const sellerSpriteCard = region.locator(".connector-credential-card").filter({ hasText: "SellerSprite" });
    const input = sellerSpriteCard.getByLabel("凭证输入");
    await input.fill("credential-sentinel-one-use");
    await sellerSpriteCard.getByRole("button", { name: "保存凭证" }).evaluate((button) => {
      (button as HTMLButtonElement).click();
      (button as HTMLButtonElement).click();
    });
    await page.getByRole("status").filter({ hasText: "已更新" }).waitFor();
    assert.equal(await input.inputValue(), "");

    const sifCard = region.locator(".connector-credential-card").filter({ hasText: "SIF" });
    await page.evaluate(() => {
      const originalFetch = window.fetch;
      window.fetch = async (input, init) => {
        if (String(input).endsWith("/probe")) {
          await new Promise((resolve) => window.setTimeout(resolve, 200));
        }
        return originalFetch(input, init);
      };
    });
    const probeButton = sifCard.locator(".connector-credential-actions button").last();
    await probeButton.evaluate((button) => {
      (button as HTMLButtonElement).click();
      (button as HTMLButtonElement).click();
    });
    await page.waitForFunction(() => Array.from(document.querySelectorAll(".connector-credential-card")).some((card) =>
      card.textContent?.includes("SIF")
        && Array.from(card.querySelectorAll("button")).some((button) => button.disabled)
    ));
    assert.equal(await probeButton.isDisabled(), true);
    assert.equal(await probeButton.textContent(), "测试中…");
    const probeStatus = page.getByRole("status");
    await probeStatus.waitFor();
    assert.match(await probeStatus.textContent() ?? "", /SIF · 连接正常/);
    const successTime = await page.evaluate(() => new Date("2026-08-23T08:00:00.000Z").toLocaleString("zh-CN"));
    assert.match(await sifCard.textContent() ?? "", new RegExp(escapeRegExp(successTime)));
    const calls = await page.evaluate(() => window.__networkCalls);
    assert.equal(calls.filter((call) => call.method === "PUT").length, 1);
    assert.equal(calls.filter((call) => call.url.endsWith("/probe")).length, 1);
    assert.equal(calls.some((call) => call.url.includes("sync-asins")), false);
  } finally {
    await page.close();
  }

  const remount = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await remount.goto(`${baseUrl}/tests/agent/helpers/concurrency-admin-browser-harness.html`, {
      waitUntil: "domcontentloaded",
    });
    await remount.getByRole("region", { name: "并发与额度" }).locator(".concurrency-admin-toggle").click();
    assert.equal(await remount.getByLabel("凭证输入").first().inputValue(), "");
  } finally {
    await remount.close();
  }
});

test("HTTP-200 unavailable probe shows failure reason and checked time", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const failedAt = "2026-08-23T08:30:00.000Z";
  try {
    await page.goto(`${baseUrl}/tests/agent/helpers/concurrency-admin-browser-harness.html`, {
      waitUntil: "domcontentloaded",
    });
    await page.evaluate((checkedAt) => {
      const originalFetch = window.fetch;
      window.fetch = async (input, init) => {
        if (!String(input).endsWith("/probe")) return originalFetch(input, init);
        await new Promise((resolve) => window.setTimeout(resolve, 200));
        await originalFetch(input, init);
        return Response.json({
          connectorId: "sif",
          configured: true,
          available: false,
          reason: "Connector upstream is temporarily unavailable",
          checkedAt,
        });
      };
    }, failedAt);

    const region = page.getByRole("region", { name: "并发与额度" });
    await region.locator(".concurrency-admin-toggle").click();
    const sifCard = region.locator(".connector-credential-card").filter({ hasText: "SIF" });
    const probeButton = sifCard.locator(".connector-credential-actions button").last();
    await probeButton.evaluate((button) => {
      (button as HTMLButtonElement).click();
      (button as HTMLButtonElement).click();
    });
    await page.waitForFunction(() => Array.from(document.querySelectorAll(".connector-credential-card")).some((card) =>
      card.textContent?.includes("SIF")
        && Array.from(card.querySelectorAll("button")).some((button) => button.disabled)
    ));
    assert.equal(await probeButton.isDisabled(), true);
    assert.equal(await probeButton.textContent(), "测试中…");
    const probeStatus = page.getByRole("status");
    await probeStatus.waitFor();
    assert.match(await probeStatus.textContent() ?? "", /SIF · 连接失败/);

    const failureTime = await page.evaluate((checkedAt) => new Date(checkedAt).toLocaleString("zh-CN"), failedAt);
    const cardText = await sifCard.textContent() ?? "";
    assert.match(cardText, /连接失败/);
    assert.match(cardText, /Connector upstream is temporarily unavailable/);
    assert.match(cardText, new RegExp(escapeRegExp(failureTime)));
    assert.equal(await page.getByRole("status").filter({ hasText: "已更新" }).count(), 0);
    const calls = await page.evaluate(() => window.__networkCalls);
    assert.equal(calls.filter((call) => call.url.endsWith("/v1/connectors/sif/probe") && call.method === "POST").length, 1);
    assert.equal(calls.some((call) => call.url.includes("sync-asins")), false);
  } finally {
    await page.close();
  }
});

test("legacy repair confirmation double-click applies once and refreshes with GET only", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.goto(`${baseUrl}/tests/agent/helpers/concurrency-admin-browser-harness.html`, {
      waitUntil: "domcontentloaded",
    });
    const region = page.getByRole("region", { name: "并发与额度" });
    await region.locator(".concurrency-admin-toggle").click();
    await region.getByRole("button", { name: "确认应用" }).evaluate((button) => {
      (button as HTMLButtonElement).click();
      (button as HTMLButtonElement).click();
    });
    await page.getByRole("status").filter({ hasText: "已更新" }).waitFor();
    const calls = await page.evaluate(() => window.__networkCalls);
    assert.equal(calls.filter((call) => call.url.endsWith("/legacy-repair/apply")).length, 1);
    assert.equal(calls.filter((call) => call.url.endsWith("/v1/local-data/sync-asins/legacy-job") && call.method === "GET").length, 1);
    assert.equal(calls.some((call) => call.url.endsWith("/resume")), false);
    assert.equal(calls.some((call) => call.url.endsWith("/v1/local-data/sync-asins") && call.method === "POST"), false);
  } finally {
    await page.close();
  }
});

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
