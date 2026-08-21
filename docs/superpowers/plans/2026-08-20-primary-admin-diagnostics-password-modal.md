# Primary-Admin Diagnostics And Password Modal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the root-path builder diagnostic only to the validated `admin@example.com` administrator while preserving every business message, and render the existing password-change form as a hydration-safe viewport modal.

**Architecture:** A pure presentation-policy module combines the exact primary-administrator predicate with an explicit `path-diagnostic | business` notice provenance; `app/page.tsx` keeps its existing `setMessage(text)` call surface and conditionally omits only the initial diagnostic at its three builder sites. `PasswordChangeControl` keeps its current request/state ownership but portals the open dialog to `document.body`, with client-mount/document guards, labelled dialog semantics, Escape teardown, and no feedback-modal changes.

**Tech Stack:** Node.js 22.13+, TypeScript 5.9, React 19.2 (`createPortal`), vinext, Node test runner through `tsx`, Playwright 1.62, existing built-stack launcher.

## Global Constraints

- Base commit is exactly `6c4b595eb4711071c095d63609d886517f2360c8`; work only in `C:\Users\EDY\Amazon-Product-Opportunity-Insights\.worktrees\openspec-4-3-auth`.
- The primary administrator is exactly a validated session user with `role === "admin"` and `email.trim().toLowerCase() === "admin@example.com"`; `test-admin@amazon-insights.local`, every other administrator, and every member fail the predicate.
- This is presentation policy only. Do not add or change roles, capabilities, authorization, database records, migrations, routes, password policy/API/session semantics, or account-management UI.
- Suppress only the initial root-path diagnostic. `/p/<slug>` opening status and every validation, synchronization, marketplace, project, save/load, progress, success, and failure message remain business feedback visible to every authenticated user.
- Do not search Chinese text, CSS color, or `.builder-message.error` to decide privilege. Use explicit `path-diagnostic | business` provenance.
- Do not hide, disable, move, or permission-gate project, save, refresh, analysis, keyword, traffic, or other business controls.
- Portal only the password-change backdrop/form to `document.body`. Do not portal, refactor, or visually change `FeedbackButton` or `.feedback-modal`.
- Preserve the exact `POST /v1/auth/password` three-field contract, duplicate-submit protection, current-session retention, other-session revocation, generic inline failure copy, and global handling of only `401 AUTHENTICATION_REQUIRED`.
- Add no dependency and do not modify `package.json`, lockfiles, generated data, server code, shared role schema, database files, migrations, environment files, or OpenSpec checkboxes.
- Existing `.auth-modal-backdrop`/`.auth-modal` CSS already supplies fixed viewport layout and responsive width; verify `app/globals.css` but do not edit it in this change.
- The worktree already contains unrelated modified data-source/runbook files and untracked SQLite/project data. Treat all of them as protected user WIP: never use `git add .`, `git add -A`, `reset`, `checkout`, `restore`, `stash`, `clean`, `rebase`, or `push`.
- Before each task commit, require an empty pre-existing index, stage only that task's explicit paths, inspect `git diff --cached --name-only` and `git diff --cached`, and create a normal new commit without amend.
- Task 1 and Task 2 are independent reviewer gates and each produces one commit.

---

## Exact File Map

**Create:**

- `app/lib/primary-admin.ts` — pure primary-administrator and builder-notice visibility policy; no authorization logic.
- `tests/agent/primary-admin.test.ts` — identity matrix and diagnostic/business provenance tests.
- `tests/agent/password-change-modal-browser.test.mjs` — built-page portal, accessibility, viewport, inline-error, and close/reopen smoke.

**Modify:**

- `app/page.tsx` — initialize explicit notice provenance, retain the `setMessage(text)` business wrapper, and conditionally render exactly three builder-message spans.
- `app/auth-session-gate.tsx` — body portal, hydration guard, dialog semantics, Escape listener, and stale-feedback teardown.
- `tests/agent/helpers/render-auth-session-gate.tsx` — retain SSR evidence that a closed/client-only password dialog emits no modal subtree.
- `tests/agent/web-auth-session.test.ts` — assert the identity control exposes the trigger but no password form during SSR.
- `tests/rendered-html.test.mjs` — assert the unauthenticated server body contains neither password-dialog markup nor protected navigation.

**Verify only:**

- `app/globals.css` — `.topbar` has `backdrop-filter`; existing fixed backdrop and responsive dialog rules should need no edit after portaling.
- `tests/agent/local-agent-browser.test.ts` — `INVALID_CREDENTIALS` remains inline while only `AUTHENTICATION_REQUIRED` expires the gate.
- `tests/agent/password-change.test.ts` — backend current-session retention and other-session revocation remain unchanged.

## Stable Interfaces

```ts
export const PRIMARY_ADMIN_EMAIL = "admin@example.com";

export type BuilderNotice = Readonly<{
  kind: "path-diagnostic" | "business";
  text: string;
}>;

export function isPrimaryAdministrator(user: User): boolean;
export function shouldShowBuilderNotice(notice: BuilderNotice, user: User): boolean;
```

`app/page.tsx` owns the one path-diagnostic initializer. Its local `setMessage(text: string): void` wrapper always writes `{ kind: "business", text }`, so existing handlers do not need a broad rewrite and can never accidentally inherit diagnostic visibility.

---

### Task 1: Primary-Administrator Builder Diagnostic Visibility

**Files:**
- Create: `app/lib/primary-admin.ts`
- Create: `tests/agent/primary-admin.test.ts`
- Modify: `app/page.tsx:1-7, 1770-1800, 1960-1990, 2790-2810, 3100-3125, 3260-3285`

**Interfaces:**
- Consumes: validated `User` from `AuthenticatedWebSession.user`.
- Produces: `PRIMARY_ADMIN_EMAIL`, `BuilderNotice`, `isPrimaryAdministrator(user: User): boolean`, and `shouldShowBuilderNotice(notice: BuilderNotice, user: User): boolean`.

- [ ] **Step 1: Confirm the protected WIP boundary before editing.**

```powershell
git rev-parse HEAD
git status --short
git diff --cached --name-only
```

Expected: HEAD prints `6c4b595eb4711071c095d63609d886517f2360c8`; the previously observed data-source/runbook/SQLite/project WIP may remain; the cached-name command prints nothing. If the index is not empty, stop and ask the owner rather than changing it.

- [ ] **Step 2: Write the focused policy RED tests.** Create `tests/agent/primary-admin.test.ts` with the complete matrix below.

```ts
import assert from "node:assert/strict";
import test from "node:test";

import type { User } from "../../shared/agent-contracts";
import {
  isPrimaryAdministrator,
  shouldShowBuilderNotice,
  type BuilderNotice,
} from "../../app/lib/primary-admin";

function user(email: string, role: User["role"]): User {
  return {
    id: "018f1f5c-60f0-4b7a-8000-000000000001",
    organizationId: "018f1f5c-60f0-4b7a-8000-000000000002",
    email,
    displayName: "Fixture",
    role,
    status: "active",
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
  };
}

test("primary administrator requires the admin role and normalized approved email", () => {
  assert.equal(isPrimaryAdministrator(user("admin@example.com", "admin")), true);
  assert.equal(isPrimaryAdministrator(user("  ADMIN@EXAMPLE.COM  ", "admin")), true);
  assert.equal(isPrimaryAdministrator(user("test-admin@amazon-insights.local", "admin")), false);
  assert.equal(isPrimaryAdministrator(user("other-admin@example.com", "admin")), false);
  assert.equal(isPrimaryAdministrator(user("admin@example.com", "member")), false);
});

test("only path diagnostics are suppressed for non-primary users", () => {
  const diagnostic: BuilderNotice = {
    kind: "path-diagnostic",
    text: "根路径诊断",
  };
  const businessMessages: BuilderNotice[] = [
    { kind: "business", text: "请至少输入 3 个竞品 ASIN" },
    { kind: "business", text: "同步失败，请重试" },
    { kind: "business", text: "已切换至美国站" },
    { kind: "business", text: "已保存到收藏夹" },
  ];
  const primary = user("admin@example.com", "admin");
  const ordinaryAdmin = user("test-admin@amazon-insights.local", "admin");
  const member = user("member@example.com", "member");

  assert.equal(shouldShowBuilderNotice(diagnostic, primary), true);
  assert.equal(shouldShowBuilderNotice(diagnostic, ordinaryAdmin), false);
  assert.equal(shouldShowBuilderNotice(diagnostic, member), false);
  for (const notice of businessMessages) {
    assert.equal(shouldShowBuilderNotice(notice, primary), true);
    assert.equal(shouldShowBuilderNotice(notice, ordinaryAdmin), true);
    assert.equal(shouldShowBuilderNotice(notice, member), true);
  }
});
```

- [ ] **Step 3: Run the focused test and capture RED.**

Run: `npx tsx --conditions=react-server --test tests/agent/primary-admin.test.ts`

Expected: FAIL because `app/lib/primary-admin.ts` does not exist. A missing-module failure is the required RED; syntax/environment failures must be corrected before production edits.

- [ ] **Step 4: Implement the pure presentation policy.** Create `app/lib/primary-admin.ts` exactly as follows.

```ts
import type { User } from "../../shared/agent-contracts";

export const PRIMARY_ADMIN_EMAIL = "admin@example.com";

export type BuilderNotice = Readonly<{
  kind: "path-diagnostic" | "business";
  text: string;
}>;

export function isPrimaryAdministrator(user: User): boolean {
  return user.role === "admin"
    && user.email.trim().toLowerCase() === PRIMARY_ADMIN_EMAIL;
}

export function shouldShowBuilderNotice(
  notice: BuilderNotice,
  user: User,
): boolean {
  return notice.kind !== "path-diagnostic" || isPrimaryAdministrator(user);
}
```

This module must not import API clients, session controllers, server authorization, or role schemas beyond the existing `User` type.

- [ ] **Step 5: Convert the shared string state to explicit provenance without rewriting handlers.** In `app/page.tsx`, import the stable interfaces and replace only the current message initializer with this exact shape.

```tsx
import {
  shouldShowBuilderNotice,
  type BuilderNotice,
} from "./lib/primary-admin";

const ROOT_PATH_DIAGNOSTIC =
  "根路径不再混合展示全部底库。请输入一批同类 ASIN，或点下方工作区进入 /p/floor-lamps、/p/kick-scooters";

// Inside AuthenticatedAmazonOpportunityApp, after slugParam is known:
const [builderNotice, setBuilderNotice] = useState<BuilderNotice>(() =>
  slugParam
    ? { kind: "business", text: `正在打开工作区 /p/${slugParam}` }
    : { kind: "path-diagnostic", text: ROOT_PATH_DIAGNOSTIC },
);
const setMessage = useCallback((text: string) => {
  setBuilderNotice({ kind: "business", text });
}, []);
const message = builderNotice.text;
const showBuilderNotice = shouldShowBuilderNotice(builderNotice, authSession.user);
```

Add `setMessage` to the dependency lists of `startSyncIfNeeded` and the project/slug loading effect that reports “找不到工作区”; do not change the text or calling shape of any existing `setMessage(...)`. The slug opening status is deliberately `business`, not privileged diagnostic content.

- [ ] **Step 6: Gate exactly the three builder spans and nothing else.** At overview, replace its current span with:

```tsx
{showBuilderNotice ? (
  <span
    className={
      message.includes("请") || message.includes("不正确") || message.includes("重复")
        ? "builder-message error"
        : "builder-message"
    }
  >
    {message}
  </span>
) : null}
```

At both keywords and traffic, replace their current spans with:

```tsx
{showBuilderNotice ? (
  <span
    className={
      message.includes("请") || message.includes("不正确") || message.includes("重复") || message.includes("失败")
        ? "builder-message error"
        : "builder-message"
    }
  >
    {message}
  </span>
) : null}
```

Do not wrap `.builder-actions`, project chips, links, save buttons, or analysis buttons. Rendering `null` must remove the span entirely so there is no empty flex item.

- [ ] **Step 7: Verify Task 1 GREEN and inspect the narrow diff.**

```powershell
npx tsx --conditions=react-server --test tests/agent/primary-admin.test.ts
npx eslint app/lib/primary-admin.ts app/page.tsx tests/agent/primary-admin.test.ts
git diff --check -- app/lib/primary-admin.ts app/page.tsx tests/agent/primary-admin.test.ts
git diff -- app/lib/primary-admin.ts app/page.tsx tests/agent/primary-admin.test.ts
```

Expected: 2 focused tests PASS; ESLint and diff check exit `0`; the diff shows one pure module, one state wrapper, one callback dependency addition, and exactly three conditional span renderings. No existing business `setMessage(...)` call, button, route, or unrelated file changes.

- [ ] **Step 8: Commit only Task 1.**

```powershell
git add -- app/lib/primary-admin.ts app/page.tsx tests/agent/primary-admin.test.ts
git diff --cached --name-only
git diff --cached --check
git diff --cached
git commit -m "fix(ui): restrict builder diagnostics to primary admin"
git status --short
```

Expected cached paths before commit: exactly the three paths above. After commit, unrelated protected WIP remains unstaged and the Task 1 paths are clean. Do not push.

---

### Task 2: Body-Level Password Portal And Fresh-Build Acceptance

**Files:**
- Create: `tests/agent/password-change-modal-browser.test.mjs`
- Modify: `app/auth-session-gate.tsx:1-55`
- Modify: `tests/agent/helpers/render-auth-session-gate.tsx`
- Modify: `tests/agent/web-auth-session.test.ts`
- Modify: `tests/rendered-html.test.mjs`
- Verify only: `app/globals.css:3,154-184`, `tests/agent/local-agent-browser.test.ts`, `tests/agent/password-change.test.ts`

**Interfaces:**
- Consumes: existing `changeWebPassword(input)`, `subscribeToAuthenticationRequired`, `.auth-modal-backdrop`, and `.auth-modal`.
- Produces: one client-only portal directly under `document.body`; no API, role, CSS, or feedback-modal interface.

- [ ] **Step 1: Reconfirm index/WIP safety after Task 1.**

```powershell
git status --short
git diff --cached --name-only
```

Expected: protected unrelated WIP may remain; cached-name output is empty. Stop if another worker has staged files.

- [ ] **Step 2: Add SSR guards and the focused browser RED.** Update `tests/agent/helpers/render-auth-session-gate.tsx` to keep rendering `AuthIdentityControl`. In the existing rendered-view test add:

```ts
assert.match(rendered.identity, /修改密码/);
assert.doesNotMatch(rendered.identity, /auth-modal-backdrop|role="dialog"|name="currentPassword"/);
```

In `tests/rendered-html.test.mjs`, add these assertions to the authentication-shell test:

```js
assert.doesNotMatch(body, /auth-modal-backdrop|role=["']dialog["']|name=["']currentPassword["']/);
```

Create `tests/agent/password-change-modal-browser.test.mjs` with this complete built-page smoke. It uses the installed `playwright` dependency, intercepts only browser requests, and never requires a real password or Agent Service.

```js
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { after, before, test } from "node:test";
import { once } from "node:events";
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

let browser;
let serverProcess;
let baseUrl;
let serverOutput = "";

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
  browser = await chromium.launch({ headless: true });
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
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ authenticated: true, user }) });
    }
    if (path.endsWith("/v1/auth/password")) {
      return route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "INVALID_CREDENTIALS", message: "safe", requestId: "wrong-current" } }),
      });
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
    assert.equal(await page.locator("body > .auth-modal-backdrop").count(), 0);
    await page.getByRole("button", { name: "修改密码", exact: true }).click();

    const backdrop = page.locator("body > .auth-modal-backdrop");
    const dialog = page.getByRole("dialog", { name: "修改密码" });
    assert.equal(await backdrop.count(), 1);
    assert.equal(await dialog.getAttribute("aria-modal"), "true");
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
    await dialog.getByLabel("新密码").fill("new-pass-1");
    await dialog.getByLabel("确认新密码").fill("new-pass-1");
    await dialog.getByRole("button", { name: "更新密码" }).click();
    await page.getByText("密码更新失败，请检查当前密码和新密码").waitFor();
    await page.locator(".auth-identity-control").waitFor();

    await dialog.getByRole("button", { name: "关闭" }).click();
    assert.equal(await backdrop.count(), 0);
    await page.getByRole("button", { name: "修改密码", exact: true }).click();
    assert.equal(await page.getByText("密码更新失败，请检查当前密码和新密码").count(), 0);

    await page.setViewportSize({ width: 390, height: 844 });
    const narrowBox = await backdrop.boundingBox();
    const formBox = await dialog.boundingBox();
    assert.ok(narrowBox && formBox);
    assert.ok(narrowBox.x <= 1 && narrowBox.y <= 1);
    assert.ok(narrowBox.width >= 389 && narrowBox.height >= 843);
    assert.ok(formBox.x >= 0 && formBox.y >= 0);
    assert.ok(formBox.x + formBox.width <= 390 && formBox.y + formBox.height <= 844);

    await page.keyboard.press("Escape");
    assert.equal(await page.locator("body > .auth-modal-backdrop").count(), 0);
    assert.equal(await page.locator(".feedback-modal").count(), 0);
  } finally {
    await context.close();
  }
});
```

- [ ] **Step 3: Capture the portal RED against the current implementation.**

```powershell
npm run build
node --test tests/agent/password-change-modal-browser.test.mjs
```

Expected: build exits `0`; browser test FAILS because the backdrop is nested under `.topbar .auth-identity-control` rather than matching `body > .auth-modal-backdrop` (and its viewport bounds are clipped). If Chromium is missing, run `npx playwright install chromium` once; this installs the existing dependency's browser binary and must not change package or lock files, then rerun until the behavioral RED is observed.

- [ ] **Step 4: Implement the hydration-safe body portal and teardown.** In `app/auth-session-gate.tsx`, add `useRef`, import `createPortal` from `react-dom`, and change only `PasswordChangeControl` to the following structure. Keep the three field definitions and `changeWebPassword` payload exactly as they are now.

```tsx
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

function PasswordChangeControl() {
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const dialogOpen = useRef(false);

  useEffect(() => {
    setMounted(true);
    return () => { dialogOpen.current = false; };
  }, []);

  const openDialog = useCallback(() => {
    dialogOpen.current = true;
    setMessage(null);
    setOpen(true);
  }, []);

  const closeDialog = useCallback(() => {
    dialogOpen.current = false;
    setMessage(null);
    setOpen(false);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeDialog();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeDialog, open]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setPending(true);
    setMessage(null);
    try {
      await changeWebPassword({
        currentPassword: String(data.get("currentPassword") ?? ""),
        newPassword: String(data.get("newPassword") ?? ""),
        confirmation: String(data.get("confirmation") ?? ""),
      });
      form.reset();
      if (dialogOpen.current) setMessage("密码已更新，其他登录会话已退出");
    } catch {
      if (dialogOpen.current) setMessage("密码更新失败，请检查当前密码和新密码");
    } finally {
      setPending(false);
    }
  }

  const dialog = (
    <div className="auth-modal-backdrop" role="presentation">
      <form
        className="auth-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="password-change-title"
        onSubmit={(event) => void submit(event)}
      >
        <div className="section-head">
          <h2 id="password-change-title">修改密码</h2>
          <button type="button" className="ghost-btn" onClick={closeDialog}>关闭</button>
        </div>
        <label>当前密码<input name="currentPassword" type="password" minLength={8} maxLength={1024} autoComplete="current-password" required /></label>
        <label>新密码<input name="newPassword" type="password" minLength={8} maxLength={1024} autoComplete="new-password" required /></label>
        <label>确认新密码<input name="confirmation" type="password" minLength={8} maxLength={1024} autoComplete="new-password" required /></label>
        <button className="auth-login-submit" type="submit" disabled={pending}>{pending ? "更新中…" : "更新密码"}</button>
        {message ? <p className="auth-login-status" role="status">{message}</p> : null}
      </form>
    </div>
  );

  return <>
    <button type="button" className="ghost-btn" onClick={openDialog}>修改密码</button>
    {open && mounted && typeof document !== "undefined"
      ? createPortal(dialog, document.body)
      : null}
  </>;
}
```

Do not move `PasswordChangeControl` out of `AuthIdentityControl`. Do not add backdrop-click closing, focus-trap packages, animations, or any edit to `FeedbackButton`.

- [ ] **Step 5: Run focused GREEN, auth regressions, lint, and the fresh build once after implementation.**

```powershell
npx tsx --conditions=react-server --test tests/agent/primary-admin.test.ts tests/agent/web-auth-session.test.ts tests/agent/local-agent-browser.test.ts tests/agent/password-change.test.ts
npx eslint app/auth-session-gate.tsx app/page.tsx app/lib/primary-admin.ts tests/agent/primary-admin.test.ts tests/agent/web-auth-session.test.ts tests/agent/password-change-modal-browser.test.mjs tests/rendered-html.test.mjs
npm run build
node --test tests/rendered-html.test.mjs
node --test tests/agent/password-change-modal-browser.test.mjs
git diff --check -- app/auth-session-gate.tsx tests/agent/helpers/render-auth-session-gate.tsx tests/agent/web-auth-session.test.ts tests/agent/password-change-modal-browser.test.mjs tests/rendered-html.test.mjs
```

Expected: all focused tests PASS; `INVALID_CREDENTIALS` leaves the authenticated gate mounted; the backend session-revocation regression passes; lint exits `0`; the fresh build exits `0`; SSR contains only the checking shell and no password dialog; the browser smoke sees one direct-body viewport portal, complete fields at desktop/narrow widths, labelled dialog semantics, inline wrong-password feedback, and complete close/Escape teardown. Do not run another build if code has not changed.

- [ ] **Step 6: Run the live authenticated acceptance on that same fresh build.** Use ports `31900/31901` and an isolated temporary SQLite database so existing WIP databases are untouched. The password for `admin:init` is entered only at its hidden prompt.

```powershell
$acceptanceDir = New-Item -ItemType Directory -Path (Join-Path ([IO.Path]::GetTempPath()) ("primary-admin-modal-" + [guid]::NewGuid()))
$env:NODE_ENV = "development"
$env:AGENT_DATABASE_URL = " "
$env:AGENT_SQLITE_PATH = Join-Path $acceptanceDir.FullName "acceptance.sqlite"
$env:AGENT_AUTH_ALLOW_ANONYMOUS_LOOPBACK = "0"
$env:AGENT_AUTH_ALLOW_INSECURE_LOOPBACK_COOKIE = "1"
$env:AGENT_SERVICE_HOST = "127.0.0.1"
$env:AGENT_SERVICE_PORT = "31901"
$env:AGENT_SERVICE_INTERNAL_URL = "http://127.0.0.1:31901"
$env:WEB_HOST = "127.0.0.1"
$env:WEB_PORT = "31900"
$env:AGENT_SERVICE_TRUSTED_ORIGINS = "http://127.0.0.1:31900,http://localhost:31900"
$env:AGENT_SERVICE_PROXY_TOKEN = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
npm run admin:init -- --email admin@example.com --display-name Admin --organization-id 10000000-0000-4000-8000-000000000001
npm run auth:seed-test-users -- --organization-id 10000000-0000-4000-8000-000000000001
npm run stack:start
```

Open `http://127.0.0.1:31900` in a real browser. Use the hidden-prompt primary-admin password and the ACL-protected credential-file path returned by the seed command; never print, copy into notes, stage, or commit password/token/cookie values.

Verify this exact checklist without starting a paid provider run:

- `admin@example.com`/`admin`: on `/`, `/?tab=keywords`, and `/?tab=traffic`, the red root diagnostic exists; project/library links and action buttons remain present.
- `test-admin@amazon-insights.local`/`admin` and `test-member-1@amazon-insights.local`/`member`: on all three tabs, no diagnostic span or blank placeholder exists. Change marketplace once and submit fewer than three ASINs; both the marketplace success message and validation error appear normally.
- For any authenticated user, open “修改密码”: DevTools Elements shows exactly one `body > .auth-modal-backdrop`, outside `.topbar`; the overlay covers the viewport and all three fields are visible at desktop and a narrow resized viewport.
- Submit one incorrect current password: the generic inline failure appears, the identity/application remains mounted, and no login screen replaces it. Close and reopen: feedback is cleared and only one portal exists. Escape removes the portal completely.
- Confirm the floating feedback button still opens/closes its existing modal and has not been portaled or visually changed.

Stop the stack with `Ctrl+C`. Keep the isolated acceptance directory until evidence is complete; its path is outside the repository and must never be staged. Removing it later is a separate explicit cleanup decision, not part of this implementation plan.

- [ ] **Step 7: Commit only Task 2 after acceptance.**

```powershell
git add -- app/auth-session-gate.tsx tests/agent/helpers/render-auth-session-gate.tsx tests/agent/web-auth-session.test.ts tests/agent/password-change-modal-browser.test.mjs tests/rendered-html.test.mjs
git diff --cached --name-only
git diff --cached --check
git diff --cached
git commit -m "fix(auth): portal password dialog to viewport"
git status --short
git log -2 --oneline
```

Expected cached paths before commit: exactly the five paths above. Final log shows the Task 2 commit above the Task 1 commit; protected pre-existing WIP remains unstaged; no CSS, feedback modal, server, database, environment, generated data, package, lockfile, role, route, or migration file is committed. Do not push.

---

## Plan Self-Review

- [x] **Spec coverage:** Task 1 covers the exact role-plus-normalized-email matrix, explicit path/business provenance, all three builder sites, absent diagnostic DOM for non-primary users, and continued visibility of representative business feedback and controls. Task 2 covers the body portal, mount/document guard, containing-block escape, exact fields/API semantics, labelled dialog, close/Escape teardown, stale-feedback clearing, wrong-password versus expired-session regression, SSR, fresh build, desktop/narrow viewport, feedback-modal isolation, and real primary/test-admin/member acceptance.
- [x] **Scope and WIP safety:** No server/DB/role/route/API/button/feedback-modal/package change is planned; the dirty worktree is protected through explicit paths and forbidden broad/destructive Git operations.
- [x] **Placeholder scan:** Every production edit, test body, expected result, interface, and command is explicit. Conditional Chromium installation is exact and does not modify dependency manifests.
- [x] **Type consistency:** `BuilderNotice`, `isPrimaryAdministrator`, `shouldShowBuilderNotice`, `setMessage(text)`, and the password field names match in interfaces, tests, implementation, and acceptance checks.
- [x] **Command and commit boundaries:** Every RED/GREEN/build/render/browser command has an expected result; Task 1 and Task 2 have separate explicit-path commits; no push occurs.
