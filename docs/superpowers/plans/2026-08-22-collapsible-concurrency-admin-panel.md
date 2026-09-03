# Collapsible Concurrency Admin Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the unstyled concurrency/quota block with a compact-by-default status strip that expands into the approved management dashboard without changing queue, quota, permission, or provider behavior.

**Architecture:** Keep `ConcurrencyAdminPanel` as the only production component and add one local, non-persisted `expanded` state. The collapsed and expanded presentations share the same already-fetched safe snapshot; dedicated `concurrency-admin-*` classes isolate the layout from generic builder rules. Unit/source tests lock role and status semantics, while a Vite/Playwright harness locks the real toggle, computed layout, responsive behavior, and zero network mutations.

**Tech Stack:** React 19, TypeScript 5.9, Vinext/Vite, plain CSS, Node test runner, Playwright.

## Global Constraints

- Default to compact A after every page load; clicking “展开管理” reveals full B and clicking “收起” returns to A.
- Do not persist expanded state in localStorage, sessionStorage, cookies, PostgreSQL, or URL parameters.
- Do not modify PostgreSQL queueing, concurrency policy, quota calculation, connector circuit behavior, Agent/Web APIs, or role boundaries.
- Members render no panel; ordinary administrators can expand read-only details; only the primary administrator sees mutation controls.
- Do not display “正常” when SellerSprite is not configured, and do not expose the raw English configuration error as the primary UI message.
- Do not trigger real SellerSprite quota refresh, provider calls, Amazon sync, or paid model calls.
- Implement in the isolated `codex/stabilize-resumable-sync-pipeline` worktree; do not push, deploy, restart, or touch the current 31900/31901/58258 stack without a later user approval.
- Run one implementation-side targeted verification and one independent professional test-window verification; do not repeat broad hostile review loops.

---

## File Map

- `app/concurrency-admin-panel.tsx`: owns collapsed/expanded state, safe Chinese status projection, and role-specific rendering.
- `app/comparison-layout.css`: owns all `concurrency-admin-*` layout, metric, action, tone, and responsive rules.
- `tests/agent/concurrency-admin-page.test.tsx`: locks compact default, expanded role behavior, hidden controls, and safe status wording.
- `tests/agent/concurrency-admin-style.test.ts`: locks the existence and responsive boundaries of the dedicated CSS contract.
- `tests/agent/helpers/concurrency-admin-browser-harness.tsx`: renders the real component with a safe fixed snapshot and records attempted network calls.
- `tests/agent/helpers/concurrency-admin-browser-harness.html`: Vite entry page for the browser regression.
- `tests/agent/concurrency-admin-browser.test.ts`: verifies real expand/collapse, computed four/two/one-column layout, no overflow, no raw English message, and zero POST/PUT.

---

### Task 1: Compact/expanded component behavior and safe status semantics

**Files:**
- Modify: `tests/agent/concurrency-admin-page.test.tsx`
- Modify: `app/concurrency-admin-panel.tsx`

**Interfaces:**
- Consumes: existing `ConcurrencyAdminResponse`, `User`, `isPrimaryAdministrator`, and unchanged browser API helpers.
- Produces: `ConcurrencyAdminPanel({ user, initialSnapshot?, initialExpanded? })`; `initialExpanded` defaults to `false` and exists only to provide a deterministic render seam.

- [ ] **Step 1: Extend the render helper and write the failing compact/expanded tests**

Update the test renderer so hidden content is excluded and tests may explicitly render the expanded state:

```tsx
function render(
  account: User,
  data: ConcurrencyAdminResponse | null = snapshot(),
  initialExpanded = false,
) {
  return renderText(ConcurrencyAdminPanel({
    user: account,
    initialSnapshot: data,
    initialExpanded,
  }));
}

function renderText(node: unknown): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(renderText).join("");
  if (isValidElement(node)) {
    const element = node as { type: unknown; props: unknown };
    if (typeof element.type === "function") {
      const Component = element.type as (props: unknown) => unknown;
      return renderText(Component(element.props));
    }
    const props = element.props as {
      children?: unknown;
      hidden?: boolean;
      "aria-label"?: unknown;
      placeholder?: unknown;
    };
    if (props.hidden) return "";
    return [props["aria-label"], props.placeholder, renderText(props.children)]
      .filter(Boolean)
      .join("");
  }
  return "";
}
```

Add the exact behavior assertions:

```tsx
test("primary admin defaults to the compact safe summary", () => {
  const html = render(user(" ADMIN@EXAMPLE.COM ", "admin"));
  assert.match(html, /并发与额度/);
  assert.match(html, /保守档/);
  assert.match(html, /排队 4/);
  assert.match(html, /运行 2/);
  assert.match(html, /总额度未知/);
  assert.match(html, /展开管理/);
  assert.doesNotMatch(html, /手动刷新|切换策略|配置总额|解除熔断/);
});

test("primary admin expanded view exposes existing controls and a collapse action", () => {
  const html = render(user(" ADMIN@EXAMPLE.COM ", "admin"), snapshot(), true);
  assert.match(html, /收起/);
  assert.match(html, /手动刷新/);
  assert.match(html, /切换策略/);
  assert.match(html, /配置总额/);
  assert.match(html, /恢复卖家精灵/);
  assert.match(html, /解除熔断/);
  assert.doesNotMatch(html, /https?:|authorization|cookie|database|lease|owner/i);
});

test("ordinary admin expands read-only details without mutation controls", () => {
  const html = render(user("ops@example.com", "admin"), snapshot(), true);
  assert.match(html, /只读/);
  assert.match(html, /排队 4/);
  assert.doesNotMatch(html, /手动刷新|切换策略|配置总额|解除熔断/);
});

test("unconfigured SellerSprite uses one consistent Chinese warning", () => {
  const data = snapshot({
    connectors: {
      ...snapshot().connectors,
      sellerSprite: {
        configured: false,
        available: false,
        reason: "SellerSprite credential is not configured",
        checkedAt: now,
        circuit: {
          paused: false,
          manualHold: false,
          reason: null,
          updatedAt: null,
        },
      },
    },
  });
  const html = render(user("admin@example.com", "admin"), data, true);
  assert.match(html, /未配置/);
  assert.match(html, /尚未配置卖家精灵凭证/);
  assert.doesNotMatch(html, /credential is not configured|状态正常/);
});
```

- [ ] **Step 2: Run the component test and capture RED**

Run:

```powershell
npx tsx --conditions=react-server --test tests/agent/concurrency-admin-page.test.tsx
```

Expected: the new compact/expanded/status tests fail because the component always renders the full block, has no `initialExpanded`, and exposes the raw unconfigured reason.

- [ ] **Step 3: Add the local display state and safe status projection**

Add the optional deterministic initial state, leaving the production default `false`:

```tsx
export function ConcurrencyAdminPanel({
  user,
  initialSnapshot = null,
  initialExpanded = false,
}: {
  user: User;
  initialSnapshot?: ConcurrencyAdminResponse | null;
  initialExpanded?: boolean;
}) {
  const isAdmin = user.role === "admin";
  const isPrimary = isPrimaryAdministrator(user);
  const [expanded, setExpanded] = usePanelState(initialExpanded);
```

All existing `snapshot`, `pending`, `message`, `totalInput`, `selectedProfile`, fetch effect, `mutate`, and `submitTotal` declarations remain byte-for-byte unchanged after this inserted state.

Project the status without rendering the raw connector reason:

```tsx
function sellerSpritePresentation(
  connector: ConcurrencyAdminResponse["connectors"]["sellerSprite"] | undefined,
  quota: ConcurrencyAdminResponse["sellerSpriteQuota"] | undefined,
) {
  if (!connector?.configured) {
    return { label: "未配置", detail: "尚未配置卖家精灵凭证", tone: "warning" } as const;
  }
  if (connector.circuit.paused) {
    return {
      label: "已暂停",
      detail: quota?.warning ?? "卖家精灵调用已暂停",
      tone: "warning",
    } as const;
  }
  if (!connector.available) {
    return { label: "暂不可用", detail: "卖家精灵服务暂不可用", tone: "warning" } as const;
  }
  return { label: "正常", detail: "卖家精灵连接正常", tone: "success" } as const;
}
```

Use one stable toggle button so keyboard focus remains on the same element after both transitions:

```tsx
const presentation = sellerSpritePresentation(sellerSprite, quota);

return (
  <section
    className={`card concurrency-admin-panel ${expanded ? "is-expanded" : "is-collapsed"}`}
    aria-label="并发与额度"
  >
    <div className="concurrency-admin-heading">
      <div>
        <span className="status-chip">并发与额度</span>
        <h2>{expanded ? "队列、策略与卖家精灵额度" : "并发与额度"}</h2>
        <p>{isPrimary ? "最高管理员可调整策略" : "只读"}</p>
      </div>
      <div className="concurrency-admin-heading-actions">
        {snapshot ? <SourceBadgeText text={snapshot.policy.profile} /> : null}
        <button
          type="button"
          className="ghost-btn concurrency-admin-toggle"
          aria-expanded={expanded}
          aria-controls="concurrency-admin-details"
          onClick={() => setExpanded(value => !value)}
        >
          {expanded ? "收起" : "展开管理"}
        </button>
      </div>
    </div>

    {snapshot ? (
      <div className="concurrency-admin-summary" aria-label="并发与额度摘要">
        <Metric label="策略" value={profileLabel[snapshot.policy.profile]} detail={`SellerSprite ${snapshot.policy.limits.sellerSprite} · 任务 ${snapshot.policy.limits.wholeJob}`} />
        <Metric label="队列" value={`排队 ${snapshot.queue.queued}`} detail={`运行 ${snapshot.queue.running} · 暂停 ${snapshot.queue.paused}`} />
        <Metric label="卖家精灵额度" value={quota?.totalLabel ?? "总额度未知"} detail={`剩余 ${quota?.remaining ?? "未知"} · 本系统观察 ${quota?.localObservedAttempts ?? 0}`} />
        <Metric label="连接状态" value={presentation.label} detail={presentation.detail} tone={presentation.tone} />
      </div>
    ) : (
      <p className="traffic-data-note concurrency-admin-loading">{message ?? "正在读取并发与额度状态"}</p>
    )}

    <div
      id="concurrency-admin-details"
      className="concurrency-admin-details"
      hidden={!expanded}
    >
      {snapshot ? (
        <>
          <div className="concurrency-admin-notice">
            {quota?.checkedAt
              ? `额度更新时间 ${new Date(quota.checkedAt).toLocaleString("zh-CN")}`
              : presentation.detail}
          </div>
          {isPrimary ? (
            <div className="concurrency-admin-actions">
              <button
                type="button"
                className="ghost-btn"
                disabled={pending !== null}
                onClick={() => void mutate("refresh", refreshSellerSpriteQuota)}
              >
                {pending === "refresh" ? "刷新中…" : "手动刷新"}
              </button>
              <label className="concurrency-admin-control-group">
                <select
                  aria-label="切换策略"
                  value={selectedProfile}
                  disabled={pending !== null}
                  onChange={event => setSelectedProfile(event.target.value as keyof typeof profileLabel)}
                >
                  <option value="conservative">保守档</option>
                  <option value="standard">标准档</option>
                  <option value="fast">高速档</option>
                </select>
                <button
                  type="button"
                  className="ghost-btn"
                  disabled={pending !== null}
                  onClick={() => void mutate("policy", () => updateConcurrencyPolicy(selectedProfile))}
                >
                  切换策略
                </button>
              </label>
              <button
                type="button"
                className="ghost-btn"
                disabled={pending !== null}
                onClick={() => void mutate("pause", () => setSellerSpritePause(!Boolean(sellerSprite?.circuit.paused)))}
              >
                {sellerSprite?.circuit.paused ? "恢复卖家精灵" : "暂停卖家精灵"}
              </button>
              <button
                type="button"
                className="ghost-btn"
                disabled={pending !== null}
                onClick={() => void mutate("reset", resetSellerSpriteCircuit)}
              >
                解除熔断
              </button>
              <form className="concurrency-admin-control-group" onSubmit={submitTotal}>
                <input
                  aria-label="配置总额"
                  value={totalInput}
                  inputMode="numeric"
                  placeholder="配置总额"
                  onChange={event => setTotalInput(event.target.value)}
                />
                <button type="submit" className="primary-btn" disabled={pending !== null}>
                  保存
                </button>
              </form>
            </div>
          ) : (
            <p className="traffic-data-note concurrency-admin-notice">
              只读账户可查看状态，不能修改策略、额度或熔断。
            </p>
          )}
        </>
      ) : null}
    </div>
    {message ? <p className="auth-login-status" role="status">{message}</p> : null}
  </section>
);
```

Update `Metric` to emit dedicated classes and a semantic tone:

```tsx
function Metric({
  label,
  value,
  detail,
  tone = "neutral",
}: {
  label: string;
  value: string;
  detail: string;
  tone?: "neutral" | "success" | "warning";
}) {
  return (
    <div className={`concurrency-admin-metric tone-${tone}`}>
      <small>{label}</small>
      <strong>{value}</strong>
      <span>{detail}</span>
    </div>
  );
}
```

- [ ] **Step 4: Run the component tests and targeted lint for GREEN**

Run:

```powershell
npx tsx --conditions=react-server --test tests/agent/concurrency-admin-page.test.tsx
npx eslint app/concurrency-admin-panel.tsx tests/agent/concurrency-admin-page.test.tsx
```

Expected: all component tests pass and ESLint exits 0.

- [ ] **Step 5: Commit Task 1**

```powershell
git add -- app/concurrency-admin-panel.tsx tests/agent/concurrency-admin-page.test.tsx
git diff --cached --check
git commit -m "fix: make concurrency panel safely collapsible"
```

Expected: one normal commit containing only the component and its focused unit test.

---

### Task 2: Dedicated dashboard styles and real-browser regression

**Files:**
- Create: `tests/agent/concurrency-admin-style.test.ts`
- Create: `tests/agent/concurrency-admin-browser.test.ts`
- Create: `tests/agent/helpers/concurrency-admin-browser-harness.tsx`
- Create: `tests/agent/helpers/concurrency-admin-browser-harness.html`
- Modify: `app/comparison-layout.css`
- Modify: `app/concurrency-admin-panel.tsx` only if Task 1 left class-name integration incomplete.

**Interfaces:**
- Consumes: Task 1 classes `concurrency-admin-panel`, `concurrency-admin-heading`, `concurrency-admin-summary`, `concurrency-admin-metric`, `concurrency-admin-actions`, and `concurrency-admin-control-group`.
- Produces: desktop four-column, medium two-column, mobile one-column dashboard with no generic `.builder-actions` dependency.

- [ ] **Step 1: Write the failing CSS contract test**

Create `tests/agent/concurrency-admin-style.test.ts`:

```ts
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const cssUrl = new URL("../../app/comparison-layout.css", import.meta.url);

test("concurrency panel owns its dashboard and control layout", async () => {
  const css = await readFile(cssUrl, "utf8");
  for (const selector of [
    ".concurrency-admin-panel",
    ".concurrency-admin-heading",
    ".concurrency-admin-summary",
    ".concurrency-admin-metric",
    ".concurrency-admin-actions",
    ".concurrency-admin-control-group",
  ]) {
    assert.match(css, new RegExp(selector.replace(".", "\\.")));
  }
  assert.match(css, /grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(css, /@media\(max-width:1100px\)[\s\S]*?repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(css, /@media\(max-width:760px\)[\s\S]*?grid-template-columns:\s*1fr/);
});
```

- [ ] **Step 2: Write the failing real-browser regression and harness**

The harness imports the real component and real CSS, supplies a fixed primary-admin snapshot, and replaces `window.fetch` with a recorder that throws if called:

```tsx
import { createElement } from "react";
import { createRoot } from "react-dom/client";

import "../../../app/globals.css";
import "../../../app/comparison-layout.css";
import { ConcurrencyAdminPanel } from "../../../app/concurrency-admin-panel";

window.__networkMethods = [];
window.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
  window.__networkMethods.push((init?.method ?? "GET").toUpperCase());
  throw new Error("network is disabled in the concurrency panel harness");
}) as typeof window.fetch;

createRoot(document.getElementById("root")!).render(
  createElement(ConcurrencyAdminPanel, {
    user: {
      id: "10000000-0000-4000-8000-000000000001",
      organizationId: "20000000-0000-4000-8000-000000000001",
      email: "admin@example.com",
      displayName: "Admin",
      role: "admin",
      status: "active",
      createdAt: "2026-08-22T08:00:00.000Z",
      updatedAt: "2026-08-22T08:00:00.000Z",
    },
    initialSnapshot: {
      schemaVersion: "1.0.0",
      organizationId: "20000000-0000-4000-8000-000000000001",
      queue: { queued: 0, running: 0, paused: 0, terminal: 12 },
      policy: {
        version: "standard-v1",
        profile: "standard",
        limits: {
          wholeJob: 4,
          sellerSprite: 2,
          sif: 1,
          sorftime: 1,
          model: 2,
          image: 2,
        },
        sellerSpriteRolling: { maxAttempts: 30, windowMs: 60_000 },
      },
      connectors: {
        sellerSprite: {
          configured: false,
          available: false,
          reason: "SellerSprite credential is not configured",
          checkedAt: "2026-08-22T08:00:00.000Z",
          circuit: {
            paused: false,
            manualHold: false,
            reason: null,
            updatedAt: null,
          },
        },
        sif: {
          configured: true,
          available: true,
          reason: null,
          checkedAt: "2026-08-22T08:00:00.000Z",
          circuit: {
            paused: false,
            manualHold: false,
            reason: null,
            updatedAt: null,
          },
        },
        sorftime: {
          configured: true,
          available: true,
          reason: null,
          checkedAt: "2026-08-22T08:00:00.000Z",
          circuit: {
            paused: false,
            manualHold: false,
            reason: null,
            updatedAt: null,
          },
        },
      },
      sellerSpriteQuota: {
        total: null,
        totalLabel: "总额度未知",
        remaining: null,
        used: null,
        localObservedAttempts: 0,
        source: "local-observed",
        status: "unknown",
        checkedAt: null,
        ageSeconds: null,
        warning: null,
      },
    },
  }),
);
```

Declare the recorder in the harness file:

```ts
declare global {
  interface Window {
    __networkMethods: string[];
  }
}
```

The HTML entry is exact and minimal:

```html
<!doctype html>
<html lang="zh-CN">
  <body>
    <main class="page-content"><div id="root"></div></main>
    <script type="module" src="/tests/agent/helpers/concurrency-admin-browser-harness.tsx"></script>
  </body>
</html>
```

Use the existing Vite/Playwright lifecycle and `browserExecutablePath()` pattern from `tests/agent/primary-admin-browser.test.ts`. Add these assertions:

```ts
test("panel toggles A to B without network mutation and remains responsive", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
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

  const columns = await region.locator(".concurrency-admin-summary").evaluate(element =>
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
  const mediumColumns = await region.locator(".concurrency-admin-summary").evaluate(element =>
    getComputedStyle(element).gridTemplateColumns.split(" ").length,
  );
  assert.equal(mediumColumns, 2);
  await toggle.click();

  await page.setViewportSize({ width: 740, height: 900 });
  await toggle.click();
  const mobileColumns = await region.locator(".concurrency-admin-summary").evaluate(element =>
    getComputedStyle(element).gridTemplateColumns.split(" ").length,
  );
  assert.equal(mobileColumns, 1);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  assert.deepEqual(await page.evaluate(() => window.__networkMethods), []);
  await page.close();
});
```

- [ ] **Step 3: Run both new tests and capture RED**

Run:

```powershell
npx tsx --conditions=react-server --test tests/agent/concurrency-admin-style.test.ts tests/agent/concurrency-admin-browser.test.ts
```

Expected: the CSS contract fails because the selectors do not exist; the browser test fails on missing layout and/or toggle behavior.

- [ ] **Step 4: Add the dedicated CSS and remove all generic builder-action dependencies from the panel**

Append one contiguous section to `app/comparison-layout.css`:

```css
.concurrency-admin-panel{overflow:hidden;padding:0}
.concurrency-admin-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:18px 20px 14px;border-bottom:1px solid var(--line)}
.concurrency-admin-heading h2{margin:7px 0 0;font-size:16px;line-height:1.35}
.concurrency-admin-heading p{margin:5px 0 0;font-size:10px;color:var(--muted)}
.concurrency-admin-heading-actions{display:flex;align-items:center;gap:8px;flex:none}
.concurrency-admin-toggle{white-space:nowrap}
.concurrency-admin-summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;padding:16px 20px}
.concurrency-admin-metric{min-width:0;border:1px solid #e5eaf1;border-radius:9px;background:#fbfcfd;padding:13px 14px}
.concurrency-admin-metric small,.concurrency-admin-metric strong,.concurrency-admin-metric span{display:block}
.concurrency-admin-metric small{font-size:9px;color:var(--muted)}
.concurrency-admin-metric strong{margin:7px 0 5px;font-size:17px;line-height:1.25;color:#26384d}
.concurrency-admin-metric span{font-size:9px;line-height:1.5;color:#708094;overflow-wrap:anywhere}
.concurrency-admin-metric.tone-success strong{color:var(--green)}
.concurrency-admin-metric.tone-warning{border-color:#f0d9ad;background:#fffaf0}
.concurrency-admin-metric.tone-warning strong{color:#b27620}
.concurrency-admin-details{border-top:1px solid #edf1f5}
.concurrency-admin-notice{margin:0 20px 14px;padding:9px 11px;border-radius:8px;background:#f0faf4;color:#397359;font-size:9px;line-height:1.5}
.concurrency-admin-actions{display:flex;align-items:center;flex-wrap:wrap;gap:9px;padding:14px 20px 18px;border-top:1px solid #edf1f5;background:#fafcfd}
.concurrency-admin-control-group{display:flex;align-items:center;gap:7px;margin:0}
.concurrency-admin-control-group select,.concurrency-admin-control-group input{height:34px;border:1px solid #dbe3ed;background:#fff;border-radius:7px;padding:0 10px;color:#34465d;outline:none;font-size:10px}
.concurrency-admin-control-group input{width:118px}
.concurrency-admin-control-group select:focus,.concurrency-admin-control-group input:focus{border-color:#72adf8;box-shadow:0 0 0 3px #e9f3ff}
.concurrency-admin-loading{margin:0;padding:16px 20px}
.concurrency-admin-panel.is-collapsed .concurrency-admin-heading{border-bottom:0;padding-bottom:10px}
.concurrency-admin-panel.is-collapsed .concurrency-admin-summary{padding-top:0}
@media(max-width:1100px){.concurrency-admin-summary{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:760px){.concurrency-admin-heading{display:block;padding:15px 16px 12px}.concurrency-admin-heading-actions{justify-content:space-between;margin-top:10px}.concurrency-admin-summary{grid-template-columns:1fr;padding:12px 16px}.concurrency-admin-actions{align-items:stretch;padding:12px 16px 16px}.concurrency-admin-control-group{width:100%}.concurrency-admin-control-group select,.concurrency-admin-control-group input{flex:1;min-width:0}.concurrency-admin-actions>.ghost-btn{flex:1}}
```

In the component, use `className="concurrency-admin-details"`, `className="concurrency-admin-notice"`, `className="concurrency-admin-actions"`, and `className="concurrency-admin-control-group"`. Do not leave `builder-actions` anywhere inside `ConcurrencyAdminPanel`.

- [ ] **Step 5: Run Task 1 and Task 2 verification for GREEN**

Run:

```powershell
npx tsx --conditions=react-server --test tests/agent/concurrency-admin-page.test.tsx tests/agent/concurrency-admin-style.test.ts tests/agent/concurrency-admin-browser.test.ts tests/agent/concurrency-admin-routes.test.ts
npx eslint app/concurrency-admin-panel.tsx app/comparison-layout.css tests/agent/concurrency-admin-page.test.tsx tests/agent/concurrency-admin-style.test.ts tests/agent/concurrency-admin-browser.test.ts tests/agent/helpers/concurrency-admin-browser-harness.tsx
```

Expected: all listed tests pass; ESLint exits 0. If ESLint does not accept CSS in this repository configuration, rerun the same command without the CSS path and record that exact scoped exception.

- [ ] **Step 6: Build once and commit Task 2**

Run:

```powershell
npm run build
git diff --check
git status --short
```

Expected: production build exits 0; no diff whitespace errors; only Task 2 paths plus the Task 1 commit are present.

Commit:

```powershell
git add -- app/comparison-layout.css app/concurrency-admin-panel.tsx tests/agent/concurrency-admin-style.test.ts tests/agent/concurrency-admin-browser.test.ts tests/agent/helpers/concurrency-admin-browser-harness.tsx tests/agent/helpers/concurrency-admin-browser-harness.html
git diff --cached --check
git commit -m "fix: polish concurrency administration dashboard"
```

Expected: one normal Task 2 commit; worktree clean after commit.

---

### Task 3: Independent professional test-window business acceptance

**Files:**
- Read only: Task 1 and Task 2 commits, approved design, and this plan.
- Write only: ignored `.superpowers/sdd/concurrency-panel-test-report.md`.

**Interfaces:**
- Consumes: clean candidate worktree after Task 2 and its implementation report.
- Produces: one independent pass/fail report with exact commands, counts, business tracer evidence, and any reproducible direct blockers.

- [ ] **Step 1: Recheck worktree boundaries before starting anything**

Run:

```powershell
git status --short
git rev-parse --short HEAD
git -C C:\Users\EDY\Amazon-Product-Opportunity-Insights\.worktrees\feat-voc-positioning-skill-execution status --short
```

Expected: candidate worktree is clean; the shared worktree remains untouched with its pre-existing user changes only. Stop immediately if the candidate contains unexplained changes.

- [ ] **Step 2: Run the panel acceptance suite once**

```powershell
npx tsx --conditions=react-server --test tests/agent/concurrency-admin-page.test.tsx tests/agent/concurrency-admin-style.test.ts tests/agent/concurrency-admin-browser.test.ts tests/agent/concurrency-admin-routes.test.ts
```

Expected: all tests pass with zero skips. Required evidence: default A, expand B, collapse A, ordinary-admin read-only, primary-admin controls, Chinese unconfigured warning, four-column desktop, one-column mobile, no overflow, zero POST/PUT during toggle.

- [ ] **Step 3: Run the direct business-blocker tracer suite once**

```powershell
npx tsx --conditions=react-server --test tests/agent/asin-sync-session.test.ts tests/agent/sync-terminal-owner.test.ts tests/agent/sync-job-dedupe.test.ts tests/agent/sync-job-dispatcher.test.ts tests/agent/sync-dynamic-traffic-start.test.ts tests/agent/feedback.test.ts tests/agent/feedback-proxy-integration.test.ts
node --test tests/scripts/sync-pipeline-ordering.test.mjs tests/scripts/image-remarks-concurrency.test.mjs tests/scripts/asin-sync-job-postconditions.test.mjs
```

Expected: all listed tests pass. Required business evidence: refresh recovery is GET-only, explicit restart is exactly one POST, same scope has one worker, traffic completes before images, image concurrency never exceeds two, one image failure is isolated into a gap, and feedback attachment submit/read remains byte-safe.

- [ ] **Step 4: Run one production build and isolated PostgreSQL/fake-provider smokes**

```powershell
npm run build
npm run smoke:stack:postgres
npm run smoke:concurrency:fake
```

Expected:

- Build exits 0.
- PostgreSQL dual-process smoke reports the same run after Web restart, Agent lease recovery, one final report, and no duplicate report.
- Twenty-user fake smoke accepts 20 submissions, keeps whole-job concurrency at or below 4, SellerSprite at or below 2, image at or below 2, rolling SellerSprite attempts at or below 30 per 60 seconds, PostgreSQL connections at or below 10, and zero active permits at exit.
- The smoke uses isolated schemas, random ports, fake provider/model behavior, and cleans up all started processes. It must not connect to current 31900/31901/58258 or real providers.

- [ ] **Step 5: Report one final acceptance verdict**

Write `.superpowers/sdd/concurrency-panel-test-report.md` with the title `Concurrency Panel Professional Test Report`. Record the literal tested commit from `git rev-parse --short HEAD`; literal passed and total counts for the panel and business tracer suites with skipped counts; a PASS/FAIL line for the build, PostgreSQL restart smoke, and twenty-user fake-provider smoke; `Live services touched: no`; `Real provider requests: 0`; exact Critical and direct-blocker lists or the literal value `0`; deferred non-blocking observations; and one final verdict of `APPROVED FOR CONTROLLED DEPLOYMENT` or `BLOCKED`.

Acceptance requires `Critical=0`, direct business blockers `=0`, every specified tracer green, build green, both isolated smokes green, and no unexplained worktree changes. Minor styling suggestions and non-blocking engineering recommendations are deferred and do not trigger another whole-branch review cycle.

---

## Execution Order

1. One implementation window completes Task 1 and Task 2 with TDD, one build, two normal commits, and a clean candidate worktree.
2. One independent professional test window performs Task 3 exactly once and does not edit production code.
3. Only reproducible Critical or direct business blockers may return to the implementation window for one bounded repair and one affected-test rerun.
4. After the professional tester approves, the main review window reports evidence and asks for a separate controlled deployment approval; it does not deploy automatically.
