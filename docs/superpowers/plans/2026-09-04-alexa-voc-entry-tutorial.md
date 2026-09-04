# Alexa VOC Entry Tutorial Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an accessible “查看录入教程” modal beside the Alexa VOC quick-entry heading, using the user-provided Alexa screenshot and three fixed instructions.

**Architecture:** Keep the tutorial in a focused client component with its own CSS module and portal lifecycle. Integrate it with one import and one render point in the existing Alexa VOC panel; do not change the large page shell, VOC data flow, server APIs, or OpenSpec worktrees.

**Tech Stack:** React 19, TypeScript, Next/Vinext, CSS Modules, Playwright, Node test runner.

## Global Constraints

- Work on a new `codex/voc-entry-tutorial-20260904` branch in a separate worktree based on commit `15af238`.
- Copy the supplied screenshot without modifying its bytes; expected SHA-256 is `4A148C24E74F22E0F8B79C4691115C99FB4931A6D226ED04A5916E2E847C5AD0`.
- Do not modify `app/page.tsx`, VOC parsing, import APIs, database code, permissions, OpenSpec files, or generated runtime data.
- Do not overwrite or stage files from another worktree.
- Use the exact user-facing copy and image alternative text specified below.
- Preserve the existing Alexa VOC import behavior when the tutorial is closed or open.

---

### Task 1: Preserve the supplied tutorial screenshot

**Files:**
- Create: `public/tutorials/alexa-voc-entry.png`
- Test: `tests/agent/alexa-voc-tutorial-assets.test.ts`

**Interfaces:**
- Consumes: supplied image `C:\Users\EDY\AppData\Local\Temp\@lQLPJxZ5T704TXfNA2zNAZywytPHjYljUDoKbCbtSBABAA.png`
- Produces: immutable browser asset `/tutorials/alexa-voc-entry.png`

- [x] **Step 1: Write the failing asset integrity test**

```ts
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const EXPECTED_SHA256 = "4a148c24e74f22e0f8b79c4691115c99fb4931a6d226ed04a5916e2e847c5ad0";

test("Alexa VOC tutorial keeps the approved source screenshot unchanged", async () => {
  const image = await readFile(new URL("../../public/tutorials/alexa-voc-entry.png", import.meta.url));
  assert.equal(createHash("sha256").update(image).digest("hex"), EXPECTED_SHA256);
});
```

- [x] **Step 2: Run the test and confirm the asset is missing**

Run: `npx tsx --test tests/agent/alexa-voc-tutorial-assets.test.ts`

Expected: FAIL with `ENOENT` for `public/tutorials/alexa-voc-entry.png`.

- [x] **Step 3: Copy the exact approved screenshot**

Run:

```powershell
New-Item -ItemType Directory -Force public\tutorials | Out-Null
Copy-Item -LiteralPath 'C:\Users\EDY\AppData\Local\Temp\@lQLPJxZ5T704TXfNA2zNAZywytPHjYljUDoKbCbtSBABAA.png' -Destination 'public\tutorials\alexa-voc-entry.png'
```

- [x] **Step 4: Run the integrity test and confirm it passes**

Run: `npx tsx --test tests/agent/alexa-voc-tutorial-assets.test.ts`

Expected: 1 test, 1 pass, 0 failures.

- [x] **Step 5: Commit the immutable asset slice**

```powershell
git add public/tutorials/alexa-voc-entry.png tests/agent/alexa-voc-tutorial-assets.test.ts
git commit -m "test(voc): preserve tutorial screenshot"
```

### Task 2: Build and integrate the accessible tutorial dialog

**Files:**
- Create: `app/alexa-voc-tutorial-dialog.tsx`
- Create: `app/alexa-voc-tutorial-dialog.module.css`
- Modify: `app/alexa-voc-import-panel.tsx:3-35,305-322`
- Test: `tests/agent/alexa-voc-tutorial-browser.test.mjs`

**Interfaces:**
- Consumes: `/tutorials/alexa-voc-entry.png`
- Produces: `AlexaVocTutorialDialog(): JSX.Element`, rendering the trigger and a body portal only while open

- [x] **Step 1: Write a failing browser interaction test**

Create `tests/agent/alexa-voc-tutorial-browser.test.mjs` with the complete production-server harness and interaction assertions:

```js
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

async function openVocPage() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
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

test("Alexa VOC tutorial opens with the approved image and closes accessibly", async () => {
  const { context, page } = await openVocPage();
  try {
    const trigger = page.getByRole("button", { name: "查看录入教程", exact: true });
    await trigger.waitFor();
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
    const screenshot = dialog.getByRole("img", { name: "Alexa for Shopping 中粘贴七问模板的操作示例" });
    assert.match(await screenshot.getAttribute("src"), /\/tutorials\/alexa-voc-entry\.png/);
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
```

- [x] **Step 2: Build the unchanged application and verify the browser test fails at the missing trigger**

Run: `npm run build`

Run: `node --test tests/agent/alexa-voc-tutorial-browser.test.mjs`

Expected: FAIL because the “查看录入教程” button does not exist.

- [x] **Step 3: Implement the minimal client component**

Create `app/alexa-voc-tutorial-dialog.tsx` with:

```tsx
"use client";

import Image from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import styles from "./alexa-voc-tutorial-dialog.module.css";

export function AlexaVocTutorialDialog() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    queueMicrotask(() => triggerRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [close, open]);

  const dialog = open && typeof document !== "undefined"
    ? createPortal(
        <div
          className={styles.backdrop}
          data-testid="alexa-voc-tutorial-backdrop"
          onMouseDown={event => {
            if (event.target === event.currentTarget) close();
          }}
        >
          <section className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="alexa-voc-tutorial-title">
            <header className={styles.header}>
              <h2 id="alexa-voc-tutorial-title">Alexa VOC 录入教程</h2>
              <button ref={closeRef} type="button" className={styles.close} aria-label="关闭录入教程" onClick={close}>×</button>
            </header>
            <div className={styles.content}>
              <div className={styles.instructions}>
                <ol>
                  <li>打开 Amazon 商品详情页与 Alexa for Shopping。</li>
                  <li>将七问模板一次性粘贴到对话框。</li>
                  <li>复制 Alexa 完整回复，返回系统选择对应 ASIN 并导入。</li>
                </ol>
                <p className={styles.note}>请复制完整回复，不要只复制摘要。</p>
              </div>
              <div className={styles.screenshotFrame}>
                <Image className={styles.screenshot} src="/tutorials/alexa-voc-entry.png" width={338} height={719} alt="Alexa for Shopping 中粘贴七问模板的操作示例" priority />
              </div>
            </div>
          </section>
        </div>,
        document.body,
      )
    : null;

  return <>
    <button ref={triggerRef} type="button" className={styles.trigger} onClick={() => setOpen(true)}>
      <span aria-hidden="true">ⓘ</span> 查看录入教程
    </button>
    {dialog}
  </>;
}
```

Create `app/alexa-voc-tutorial-dialog.module.css` with:

```css
.trigger{display:inline-flex;align-items:center;gap:5px;margin-top:8px;padding:5px 9px;border:1px solid #d6e5fb;border-radius:999px;background:#f7faff;color:#2f6fae;font-size:9px;font-weight:700;line-height:1.2;cursor:pointer}
.trigger:hover{border-color:#9fc5ef;background:#eef6ff}
.trigger:focus-visible,.close:focus-visible{outline:2px solid #2f80ed;outline-offset:2px}
.backdrop{position:fixed;inset:0;z-index:1000;display:grid;place-items:center;padding:24px;overflow:auto;background:rgba(25,39,58,.48);backdrop-filter:blur(2px)}
.dialog{width:min(920px,100%);max-height:calc(100vh - 48px);overflow:auto;border:1px solid #dce5ef;border-radius:14px;background:#fff;box-shadow:0 24px 80px rgba(19,37,61,.28)}
.header{position:sticky;top:0;z-index:1;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:16px 20px;border-bottom:1px solid #e7edf4;background:rgba(255,255,255,.96)}
.header h2{margin:0;color:#233a59;font-size:17px;line-height:1.3}
.close{display:grid;place-items:center;width:32px;height:32px;border:1px solid transparent;border-radius:8px;background:transparent;color:#60748c;font-size:24px;line-height:1;cursor:pointer}
.close:hover{border-color:#dbe5ef;background:#f6f9fc;color:#233a59}
.content{display:grid;grid-template-columns:minmax(240px,.82fr) minmax(300px,1.18fr);gap:24px;padding:20px}
.instructions{align-self:start;padding:10px 4px}
.instructions ol{display:flex;flex-direction:column;gap:24px;margin:0;padding:0;list-style:none;counter-reset:tutorial-step}
.instructions li{position:relative;min-height:28px;padding-left:42px;color:#344b67;font-size:13px;line-height:1.65;counter-increment:tutorial-step}
.instructions li::before{content:counter(tutorial-step);position:absolute;top:0;left:0;display:grid;place-items:center;width:26px;height:26px;border-radius:50%;background:#2f80ed;color:#fff;font-size:11px;font-weight:800}
.note{margin:24px 0 0;padding:11px 12px;border:1px solid #d7e8fb;border-radius:9px;background:#f1f7ff;color:#2f6fae;font-size:11px;font-weight:700;line-height:1.5}
.screenshotFrame{display:grid;place-items:center;min-width:0;padding:14px;border:1px solid #dfe7f0;border-radius:10px;background:#f8fafc}
.screenshot{display:block;width:auto;max-width:100%;height:auto;max-height:min(68vh,719px);object-fit:contain}
@media(max-width:720px){.backdrop{place-items:start center;padding:12px}.dialog{max-height:calc(100vh - 24px)}.header{padding:14px 16px}.header h2{font-size:15px}.content{grid-template-columns:1fr;gap:16px;padding:16px}.instructions{padding:0}.instructions ol{gap:14px}.screenshotFrame{padding:10px}.screenshot{width:min(338px,100%);max-height:none}}
```

- [x] **Step 4: Add the single integration point**

Add this import to `app/alexa-voc-import-panel.tsx`:

```tsx
import { AlexaVocTutorialDialog } from "./alexa-voc-tutorial-dialog";
```

Render the trigger directly below the existing explanatory paragraph inside the heading copy:

```tsx
<p>
  可直接粘贴 Alexa 完整回复；支持无序号标题、ASCII/全角括号与复制表格。
</p>
<AlexaVocTutorialDialog />
```

Do not change any import state, submission handler, or API call.

- [x] **Step 5: Build and run the browser test**

Run: `npm run build`

Run: `node --test tests/agent/alexa-voc-tutorial-browser.test.mjs`

Expected: browser test passes with trigger, modal, image, focus, all three close paths, scroll restoration, and narrow viewport containment.

- [x] **Step 6: Run focused regression checks**

```powershell
npx eslint app/alexa-voc-tutorial-dialog.tsx app/alexa-voc-import-panel.tsx tests/agent/alexa-voc-tutorial-assets.test.ts tests/agent/alexa-voc-tutorial-browser.test.mjs
npx tsx --conditions=react-server --test tests/agent/alexa-voc-page-scope.test.ts tests/agent/alexa-voc-mutation-routes.test.ts tests/agent/alexa-voc-tutorial-assets.test.ts
```

Expected: ESLint exits 0 and all focused tests pass.

- [x] **Step 7: Commit the dialog slice**

```powershell
git add app/alexa-voc-tutorial-dialog.tsx app/alexa-voc-tutorial-dialog.module.css app/alexa-voc-import-panel.tsx tests/agent/alexa-voc-tutorial-browser.test.mjs
git commit -m "feat(voc): add entry tutorial dialog"
```

### Task 3: Verify parallel isolation and publish locally

**Files:**
- Modify only plan checkboxes if verification succeeds.

**Interfaces:**
- Consumes: completed tutorial branch and local formal-stack manager
- Produces: verified local build on Web port 31900 without touching OpenSpec worktrees

- [x] **Step 1: Re-check parallel worktrees**

Run `git worktree list --porcelain`, then run `git -C` with `status --short` for every exact active OpenSpec worktree listed below:

```text
C:\Users\EDY\Amazon-Product-Opportunity-Insights\.worktrees\openspec-12-5-future-changes
C:\Users\EDY\Amazon-Product-Opportunity-Insights\.worktrees\openspec-4-3-auth
C:\Users\EDY\Amazon-Product-Opportunity-Insights\.worktrees\openspec-9-1-eval-fixtures
C:\Users\EDY\Amazon-Product-Opportunity-Insights\.worktrees\openspec-9-2-auto-evaluator
C:\Users\EDY\Amazon-Product-Opportunity-Insights\.worktrees\openspec-9-3-human-rating-switch
C:\Users\EDY\Amazon-Product-Opportunity-Insights\.worktrees\openspec-9-4-release-gate
```

Confirm none of their dirty paths is `app/alexa-voc-import-panel.tsx`, `app/alexa-voc-tutorial-dialog.tsx`, `app/alexa-voc-tutorial-dialog.module.css`, `public/tutorials/alexa-voc-entry.png`, or either new tutorial test.

- [x] **Step 2: Run final verification**

```powershell
npm test
node --test tests/agent/alexa-voc-tutorial-browser.test.mjs
npx tsx --conditions=react-server --test tests/agent/alexa-voc-page-scope.test.ts tests/agent/alexa-voc-mutation-routes.test.ts tests/agent/alexa-voc-tutorial-assets.test.ts
npx eslint app/alexa-voc-tutorial-dialog.tsx app/alexa-voc-import-panel.tsx tests/agent/alexa-voc-tutorial-assets.test.ts tests/agent/alexa-voc-tutorial-browser.test.mjs
git diff --check
```

Expected: every command exits 0 with no test failures or lint errors.

- [x] **Step 3: Start the local formal stack from the tutorial worktree**

Run: `powershell -ExecutionPolicy Bypass -File .\scripts\manage-formal-stack.ps1`

If the manager reports an active analysis job, do not terminate it; leave the verified branch intact and report that deployment is waiting. Otherwise confirm Web 31900, Agent 31901, PostgreSQL 58258, and the deployed commit.

- [x] **Step 4: Verify the live page and ask for visual acceptance**

Verify `GET http://127.0.0.1:31900/api/health` returns HTTP 200. Open `http://127.0.0.1:31900/?tab=voc`, click “查看录入教程”, and verify the real image and responsive dialog. Ask the user to confirm the layout before any merge into another development branch.
