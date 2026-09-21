import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { chromium } from "playwright";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const proxyToken = "task6-feedback-browser-proxy-token";
const organizationId = "20000000-0000-4000-8000-000000000006";
const identities = Object.freeze({
  member: Object.freeze({
    token: "M".repeat(43),
    user: Object.freeze({
      id: "10000000-0000-4000-8000-000000000061",
      organizationId,
      email: "member@example.com",
      displayName: "Acceptance Member",
      role: "member",
    }),
  }),
  ordinaryAdmin: Object.freeze({
    token: "O".repeat(43),
    user: Object.freeze({
      id: "10000000-0000-4000-8000-000000000062",
      organizationId,
      email: "ordinary-admin@example.com",
      displayName: "Acceptance Admin",
      role: "admin",
    }),
  }),
  primaryAdmin: Object.freeze({
    token: "P".repeat(43),
    user: Object.freeze({
      id: "10000000-0000-4000-8000-000000000063",
      organizationId,
      email: "admin@example.com",
      displayName: "Primary Admin",
      role: "admin",
    }),
  }),
});
const pngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const png = Buffer.from(pngBase64, "base64");
const reservedPorts = new Set([3_000, 31_900, 31_901, 58_258]);

function browserExecutablePath() {
  const defaultPath = chromium.executablePath();
  if (existsSync(defaultPath)) return defaultPath;

  const browsersPath = join(process.env.LOCALAPPDATA ?? "", "ms-playwright");
  if (existsSync(browsersPath)) {
    const chromiumDirectory = readdirSync(browsersPath, { withFileTypes: true })
      .find((entry) => entry.isDirectory() && entry.name.startsWith("chromium-"));
    if (chromiumDirectory) {
      const fallbackPath = join(
        browsersPath,
        chromiumDirectory.name,
        "chrome-win64",
        "chrome.exe",
      );
      if (existsSync(fallbackPath)) return fallbackPath;
    }
  }

  const systemChrome = join(
    process.env.ProgramFiles ?? "C:\\Program Files",
    "Google",
    "Chrome",
    "Application",
    "chrome.exe",
  );
  assert.ok(
    existsSync(systemChrome),
    "Playwright Chromium or system Chrome is required for this browser test",
  );
  return systemChrome;
}

async function reservePort() {
  const server = createNetServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  const closed = once(server, "close");
  server.close();
  await closed;
  assert.equal(reservedPorts.has(port), false, `test port ${port} is reserved`);
  return port;
}

function isolatedChildEnv(extra) {
  const env = {};
  for (const key of [
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "Path",
    "PATH",
    "PATHEXT",
    "TEMP",
    "TMP",
    "LOCALAPPDATA",
    "ProgramFiles",
    "PROGRAMFILES",
  ]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return { ...env, NODE_ENV: "development", ...extra };
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32" && child.pid) {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    await once(killer, "exit");
  } else {
    child.kill("SIGTERM");
  }
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    once(child, "exit"),
    new Promise((resolveDelay) => setTimeout(resolveDelay, 5_000)),
  ]);
}

async function waitForWeb(url, child, output) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Test Web process exited before readiness:\n${output()}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(`Test Web server did not become ready:\n${output()}`);
}

async function createUser(repository, identity, createdAt, initial = false) {
  const input = {
    ...identity.user,
    status: "active",
    createdAt,
    updatedAt: createdAt,
    passwordHash: "test-only-password-record",
  };
  if (initial) {
    const created = await repository.createInitialAdmin(input);
    assert.ok(created);
    return;
  }
  const created = await repository.createLocalUser(input);
  assert.equal(created.created, true);
}

async function openIdentity(browser, baseUrl, identity) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  if (identity) {
    await context.addCookies([{
      name: "agent_session",
      value: identity.token,
      url: baseUrl,
      sameSite: "Lax",
    }]);
  }
  const page = await context.newPage();
  const browserErrors = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  const response = await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  assert.equal(response?.status(), 200);
  try {
    if (identity) {
      await page.locator(".help-feedback-entry").waitFor({ timeout: 60_000 });
    } else {
      await page.getByRole("heading", { name: "登录您的账户" }).waitFor({ timeout: 60_000 });
    }
  } catch (error) {
    const body = await page.locator("body").innerText().catch(() => "<unavailable>");
    throw new Error(
      `${error instanceof Error ? error.message : "Browser identity gate failed"}\n` +
      `body=${body}\nclientErrors=${browserErrors.join(" | ")}`,
    );
  }
  return { context, page };
}

async function dispatchFile(page, eventName, fileName, mediaType, contents, lastModified) {
  await page.locator(".feedback-image-input").evaluate(
    (target, input) => {
      const bytes = input.base64
        ? Uint8Array.from(atob(input.base64), (character) => character.charCodeAt(0))
        : new TextEncoder().encode(input.text);
      const file = new File([bytes], input.fileName, {
        type: input.mediaType,
        lastModified: input.lastModified,
      });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      const event = new Event(input.eventName, { bubbles: true, cancelable: true });
      Object.defineProperty(
        event,
        input.eventName === "paste" ? "clipboardData" : "dataTransfer",
        { value: transfer },
      );
      target.dispatchEvent(event);
    },
    {
      eventName,
      fileName,
      mediaType,
      base64: mediaType.startsWith("image/") ? contents.toString("base64") : null,
      text: mediaType.startsWith("image/") ? null : contents.toString("utf8"),
      lastModified,
    },
  );
}

async function assertDrawerTabs(page, includeAdmin) {
  await page.locator(".help-feedback-entry").click();
  await page.getByRole("dialog", { name: "帮助与反馈中心" }).waitFor();
  for (const label of ["使用手册", "提交反馈", "我的反馈"]) {
    assert.equal(await page.getByRole("tab", { name: label, exact: true }).count(), 1);
  }
  assert.equal(
    await page.getByRole("tab", { name: /反馈管理/ }).count(),
    includeAdmin ? 1 : 0,
  );
}

async function assertDirtyClose(page, action) {
  await page.getByRole("tab", { name: "提交反馈", exact: true }).click();
  await page.getByLabel("标题").fill("未提交草稿");

  const dismissed = new Promise((resolveDialog) => {
    page.once("dialog", async (dialog) => {
      assert.equal(dialog.type(), "confirm");
      assert.equal(dialog.message(), "放弃尚未提交的反馈草稿？");
      await dialog.dismiss();
      resolveDialog();
    });
  });
  await Promise.all([dismissed, action()]);
  assert.equal(await page.locator(".help-feedback-layer").getAttribute("hidden"), null);
  assert.equal(await page.getByLabel("标题").inputValue(), "未提交草稿");

  const accepted = new Promise((resolveDialog) => {
    page.once("dialog", async (dialog) => {
      assert.equal(dialog.message(), "放弃尚未提交的反馈草稿？");
      await dialog.accept();
      resolveDialog();
    });
  });
  await Promise.all([accepted, action()]);
  await page.waitForFunction(
    () => document.querySelector(".help-feedback-layer")?.hasAttribute("hidden") === true,
  );
}

const webServerArgument = process.argv.indexOf("--task6-web-server");

if (webServerArgument >= 0) {
  const port = Number(process.argv[webServerArgument + 1]);
  assert.ok(Number.isSafeInteger(port) && port > 0 && port <= 65_535);
  const [{ default: vinext }, { createServer }] = await Promise.all([
    import("vinext"),
    import("vite"),
  ]);
  const server = await createServer({
    root: repoRoot,
    configFile: false,
    logLevel: "error",
    plugins: [vinext()],
    server: { host: "127.0.0.1", port, strictPort: true },
  });
  await server.listen();
  const close = async () => {
    await server.close();
    process.exit(0);
  };
  process.once("SIGINT", () => { void close(); });
  process.once("SIGTERM", () => { void close(); });
  await new Promise(() => {});
} else test("help and feedback center works end-to-end through the real same-origin proxy", { timeout: 180_000 }, async (t) => {
  const [{ buildAgentApp }, { openSqliteAgentRepository }] = await Promise.all([
    import("../../server/app.ts"),
    import("../../server/db/sqlite-repository.ts"),
  ]);
  const directory = mkdtempSync(join(tmpdir(), "help-feedback-browser-"));
  const repository = openSqliteAgentRepository({
    path: join(directory, "agent.sqlite"),
    busyTimeoutMs: 5_000,
  });
  let agent = null;
  let webProcess = null;
  let browser = null;
  t.after(async () => {
    await browser?.close();
    await stopChild(webProcess);
    await agent?.close();
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const createdAt = "2026-08-22T00:00:00.000Z";
  await createUser(repository, identities.primaryAdmin, createdAt, true);
  await createUser(repository, identities.ordinaryAdmin, createdAt);
  await createUser(repository, identities.member, createdAt);

  const webPort = await reservePort();
  const webOrigin = `http://127.0.0.1:${webPort}`;
  const principalByToken = new Map(Object.values(identities).map((identity, index) => [
    identity.token,
    Object.freeze({
      kind: "user",
      userId: identity.user.id,
      organizationId,
      email: identity.user.email,
      role: identity.user.role,
      sessionId: `30000000-0000-4000-8000-00000000006${index + 1}`,
    }),
  ]));
  // Authentication and the presence heartbeat must agree on a live session.
  for (const [token, principal] of principalByToken) {
    await repository.createSession({
      id: principal.sessionId, userId: principal.userId,
      tokenHash: createHash("sha256").update(token).digest("hex"),
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      revokedAt: null, lastSeenAt: null,
    });
  }
  const authService = {
    async authenticate(rawToken) {
      return principalByToken.get(rawToken) ?? null;
    },
    async findPublicUser(userId) {
      return repository.findUserById(userId);
    },
    async login() {
      return { status: "invalid-credentials" };
    },
    async logout() {},
    async changePassword() {
      return { status: "invalid-credentials" };
    },
  };
  const authConfig = {
    mode: "authenticated",
    cookie: { name: "agent_session", secure: false, maxAgeSeconds: 3_600 },
    sessionTtlMs: 3_600_000,
    loginLimiter: { windowMs: 60_000, maxFailures: 5, maxEntries: 100 },
  };
  agent = buildAgentApp({
    env: {
      AGENT_SERVICE_PROXY_TOKEN: proxyToken,
      AGENT_SERVICE_TRUSTED_ORIGINS: webOrigin,
      npm_package_version: "0.1.0-test",
    },
    authConfig,
    authService,
    repository,
    storageAvailable: true,
    concurrencyAdminService: null,
  });
  await agent.listen({ host: "127.0.0.1", port: 0 });
  const agentAddress = agent.server.address();
  assert.ok(agentAddress && typeof agentAddress === "object");
  assert.equal(reservedPorts.has(agentAddress.port), false);
  const agentOrigin = `http://127.0.0.1:${agentAddress.port}`;
  const proxyEnv = {
    AGENT_SERVICE_INTERNAL_URL: agentOrigin,
    AGENT_SERVICE_PROXY_TOKEN: proxyToken,
  };
  let webOutput = "";
  webProcess = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), "--task6-web-server", String(webPort)],
    {
      cwd: repoRoot,
      env: isolatedChildEnv(proxyEnv),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  webProcess.stdout.on("data", (chunk) => { webOutput += chunk; });
  webProcess.stderr.on("data", (chunk) => { webOutput += chunk; });
  await waitForWeb(webOrigin, webProcess, () => webOutput);
  const unauthenticatedSessionProbe = await fetch(`${webOrigin}/api/agent/v1/auth/session`);
  const unauthenticatedSessionBody = await unauthenticatedSessionProbe.json();
  assert.equal(
    unauthenticatedSessionProbe.status,
    200,
    JSON.stringify(unauthenticatedSessionBody),
  );
  assert.deepEqual(unauthenticatedSessionBody, {
    authenticated: false,
    user: null,
    sessionIdentity: null,
  });

  browser = await chromium.launch({
    headless: true,
    executablePath: browserExecutablePath(),
  });

  const unauthenticated = await openIdentity(browser, webOrigin, null);
  try {
    assert.equal(await unauthenticated.page.locator(".help-feedback-entry").count(), 0);
    assert.equal(
      await unauthenticated.page.evaluate(async () => (await fetch("/api/agent/v1/feedback/mine")).status),
      401,
    );
  } finally {
    await unauthenticated.context.close();
  }

  const ordinaryAdmin = await openIdentity(browser, webOrigin, identities.ordinaryAdmin);
  try {
    await assertDrawerTabs(ordinaryAdmin.page, false);
    assert.equal(
      await ordinaryAdmin.page.evaluate(async () => (await fetch("/api/agent/v1/feedback/admin")).status),
      403,
    );
    await ordinaryAdmin.page.getByRole("tab", { name: "我的反馈", exact: true }).click();
    await ordinaryAdmin.page.getByText("暂无反馈", { exact: true }).waitFor();
  } finally {
    await ordinaryAdmin.context.close();
  }

  const member = await openIdentity(browser, webOrigin, identities.member);
  const feedbackTitle = "浏览器验收反馈";
  try {
    const entry = member.page.locator(".help-feedback-entry");
    const sourceStatus = member.page.locator(".sync-status");
    assert.equal(await entry.evaluate((left, right) => Boolean(left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING), await sourceStatus.elementHandle()), true);
    assert.equal(await member.page.getByRole("button", { name: "反馈", exact: true }).count(), 0);
    assert.equal(await member.page.getByRole("button", { name: "返回顶部", exact: true }).count(), 1);
    await member.page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await member.page.locator(".back-to-top-btn.visible").waitFor();
    await member.page.getByRole("button", { name: "返回顶部", exact: true }).click();
    await member.page.waitForFunction(() => window.scrollY === 0);

    await assertDrawerTabs(member.page, false);
    assert.equal(
      await member.page.evaluate(async () => (await fetch("/api/agent/v1/feedback/admin")).status),
      403,
    );
    await member.page.getByRole("tab", { name: "提交反馈", exact: true }).click();
    const input = member.page.locator('.feedback-image-input input[type="file"]');
    await input.setInputFiles({ name: "picker.png", mimeType: "image/png", buffer: png });
    await dispatchFile(member.page, "drop", "drop.png", "image/png", png, 2);
    await dispatchFile(member.page, "paste", "paste.png", "image/png", png, 3);
    assert.equal(await member.page.locator(".feedback-image-previews li").count(), 3);
    await member.page.waitForFunction(() => Array.from(
      document.querySelectorAll(".feedback-image-previews img"),
    ).every((image) => image.complete && image.naturalWidth === 1 && image.naturalHeight === 1));

    await dispatchFile(member.page, "paste", "fourth.png", "image/png", png, 4);
    await member.page.getByText("fourth.png：最多只能添加 3 张图片", { exact: true }).waitFor();
    await dispatchFile(member.page, "drop", "notes.txt", "text/plain", Buffer.from("not an image"), 5);
    await member.page.getByText("notes.txt：仅支持 PNG、JPEG 或 WebP", { exact: true }).waitFor();
    await member.page.locator(".feedback-image-previews li").filter({ hasText: "drop.png" })
      .getByRole("button", { name: "删除", exact: true }).click();
    assert.equal(await member.page.locator(".feedback-image-previews li").count(), 2);
    await dispatchFile(member.page, "drop", "replacement.png", "image/png", png, 6);
    assert.equal(await member.page.locator(".feedback-image-previews li").count(), 3);

    await member.page.getByLabel("类型").selectOption("bug");
    await member.page.getByLabel("标题").fill(feedbackTitle);
    await member.page.getByLabel("详细描述").fill("选择、拖放和粘贴的截图必须通过真实同源代理提交。");
    const submitRequestPromise = member.page.waitForRequest((request) =>
      request.method() === "POST" && new URL(request.url()).pathname === "/api/agent/v1/feedback");
    const submitResponsePromise = member.page.waitForResponse((response) =>
      response.request().method() === "POST" && new URL(response.url()).pathname === "/api/agent/v1/feedback");
    await member.page.getByRole("button", { name: "提交反馈", exact: true }).click();
    const submitRequest = await submitRequestPromise;
    const submitResponse = await submitResponsePromise;
    assert.equal(submitResponse.status(), 200);
    assert.equal(submitRequest.headers()["content-type"], "application/json");
    assert.equal(submitRequest.headers()["x-feedback-transfer"], "1");
    assert.equal(submitRequest.postDataJSON().images.length, 3);
    await member.page.getByText(/提交成功 · /).waitFor();
    assert.equal(await member.page.locator(".feedback-image-previews li").count(), 0);

    await member.page.getByRole("tab", { name: "我的反馈", exact: true }).click();
    const ownItem = member.page.locator(".feedback-list-item").filter({ hasText: feedbackTitle });
    await ownItem.waitFor();
    assert.match(await ownItem.textContent() ?? "", /3 张图片/);
    const thumbnailResponsePromise = member.page.waitForResponse((response) =>
      response.request().method() === "GET" && response.url().includes("/attachments/"));
    await ownItem.click();
    await member.page.locator(".feedback-detail h3").filter({ hasText: feedbackTitle }).waitFor();
    assert.equal(await member.page.locator(".feedback-attachments button").count(), 3);
    assert.equal(await member.page.locator(".feedback-history li").count(), 1);

    const attachmentResponse = await thumbnailResponsePromise;
    assert.equal(attachmentResponse.status(), 200);
    assert.equal(attachmentResponse.headers()["content-type"], "image/png");
    await member.page.waitForFunction(() => {
      const images = [...document.querySelectorAll(".feedback-attachments img")];
      return images.length === 3 && images.every(image => image instanceof HTMLImageElement
        && image.complete
        && image.naturalWidth === 1
        && image.naturalHeight === 1);
    });
    const pagesBefore = member.context.pages().length;
    const thumbnail = member.page.locator(".feedback-attachments button").first();
    await thumbnail.click();
    await member.page.getByRole("dialog", {name:/图片预览/}).waitFor();
    assert.equal(member.context.pages().length,pagesBefore);
    await member.page.keyboard.press("Escape");
    await member.page.getByRole("dialog", {name:/图片预览/}).waitFor({state:"hidden"});
    assert.equal(await member.page.locator(".feedback-detail").isVisible(),true);
    assert.equal(await thumbnail.evaluate(el=>el===document.activeElement),true);
    await member.page.setViewportSize({width:390,height:844});
    await thumbnail.click();
    await member.page.getByRole("dialog", {name:/图片预览/}).waitFor();
    assert.ok(await member.page.getByRole("dialog", {name:/图片预览/}).evaluate(el=>el.getBoundingClientRect().width<=window.innerWidth));
    await member.page.getByRole("button",{name:"关闭图片预览",exact:true}).click();
    await member.page.setViewportSize({width:1280,height:800});

    await member.page.getByRole("button", { name: "关闭帮助与反馈", exact: true }).click();
    for (const action of [
      () => member.page.getByRole("button", { name: "关闭帮助与反馈", exact: true }).click(),
      () => member.page.locator(".help-feedback-layer").click({ position: { x: 5, y: 5 }, force: true }),
      () => member.page.keyboard.press("Escape"),
    ]) {
      await member.page.locator(".help-feedback-entry").click();
      await assertDirtyClose(member.page, action);
    }
  } finally {
    await member.context.close();
  }

  const primaryAdmin = await openIdentity(browser, webOrigin, identities.primaryAdmin);
  try {
    await primaryAdmin.page.locator('.help-feedback-entry .feedback-unread-badge[aria-label="1 条未读反馈"]').waitFor();
    assert.equal(
      await primaryAdmin.page.evaluate(async () => (await fetch("/api/agent/v1/feedback/admin")).status),
      200,
    );
    await assertDrawerTabs(primaryAdmin.page, true);
    await primaryAdmin.page.getByRole("tab", { name: /反馈管理/ }).click();
    const filter = primaryAdmin.page.getByLabel("管理筛选");
    const processingResponse = primaryAdmin.page.waitForResponse((response) =>
      response.url().endsWith("/api/agent/v1/feedback/admin?status=processing"));
    await filter.selectOption("processing");
    assert.equal((await processingResponse).status(), 200);
    await primaryAdmin.page.getByText("暂无反馈", { exact: true }).waitFor();

    const newResponse = primaryAdmin.page.waitForResponse((response) =>
      response.url().endsWith("/api/agent/v1/feedback/admin?status=new"));
    await filter.selectOption("new");
    assert.equal((await newResponse).status(), 200);
    const adminItem = primaryAdmin.page.locator(".feedback-list-item").filter({ hasText: feedbackTitle });
    await adminItem.waitFor();

    const markSeenRequestPromise = primaryAdmin.page.waitForRequest((request) =>
      request.method() === "POST" && request.url().endsWith("/mark-seen"));
    const markSeenResponsePromise = primaryAdmin.page.waitForResponse((response) =>
      response.request().method() === "POST" && response.url().endsWith("/mark-seen"));
    await adminItem.click();
    const markSeenRequest = await markSeenRequestPromise;
    const markSeenResponse = await markSeenResponsePromise;
    assert.equal(markSeenRequest.method(), "POST");
    assert.equal(markSeenResponse.status(), 200);
    assert.deepEqual(await markSeenResponse.json(), { seen: true });
    await primaryAdmin.page.waitForFunction(() =>
      document.querySelector('.help-feedback-entry .feedback-unread-badge[aria-label="1 条未读反馈"]') === null);
    assert.equal(await primaryAdmin.page.locator(".feedback-history li").count(), 1);
    assert.match(await primaryAdmin.page.locator(".feedback-history li").first().textContent() ?? "", /新反馈/);

    await primaryAdmin.page.getByLabel("反馈状态").selectOption("processing");
    const statusRequestPromise = primaryAdmin.page.waitForRequest((request) =>
      request.method() === "POST" && request.url().endsWith("/status"));
    const statusResponsePromise = primaryAdmin.page.waitForResponse((response) =>
      response.request().method() === "POST" && response.url().endsWith("/status"));
    await primaryAdmin.page.getByRole("button", { name: "更新状态", exact: true }).click();
    const statusRequest = await statusRequestPromise;
    const statusResponse = await statusResponsePromise;
    assert.equal(statusResponse.status(), 200);
    assert.deepEqual(statusRequest.postDataJSON(), { status: "processing", expectedVersion: 1 });
    await primaryAdmin.page.waitForFunction(() => document.querySelectorAll(".feedback-history li").length === 2);
    assert.match(await primaryAdmin.page.locator(".feedback-history li").last().textContent() ?? "", /处理中/);

    await primaryAdmin.page.getByRole("button", { name: "返回列表", exact: true }).click();
    await filter.selectOption("processing");
    await primaryAdmin.page.locator(".feedback-list-item").filter({ hasText: feedbackTitle }).waitFor();
  } finally {
    await primaryAdmin.context.close();
  }
});
