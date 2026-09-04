# Alexa VOC Copyable Seven-Question Template Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the approved seven-question prompt and a resilient “复制模板” action to the existing Alexa VOC tutorial dialog.

**Architecture:** Keep the prompt constant, copy state, textarea reference, and clipboard fallback inside `AlexaVocTutorialDialog`. Extend the existing browser test so the new behavior is proven without changing VOC import state, APIs, authentication, or OpenSpec worktrees.

**Tech Stack:** React 19, TypeScript, CSS Modules, Playwright, Node test runner.

## Global Constraints

- Use the exact template: `这个产品的顾客关注点是什么、好评点是什么、差评点是什么、未被满足的需求是什么、使用人群是谁、使用场景是什么、购买动机是什么。`
- Render the template in a read-only, selectable text area below the existing blue reminder in the dialog's left column.
- Provide a “复制模板” button, “已复制” success state, and “复制失败，请手动选择” failure feedback.
- Try `navigator.clipboard.writeText` first, then fall back to selecting the text and calling `document.execCommand("copy")` for LAN HTTP browsers.
- Do not replace the current 338 × 719 screenshot in this change.
- Do not modify VOC import logic, server APIs, authentication, runtime data, `app/page.tsx`, or any OpenSpec file.
- Re-check the active OpenSpec worktrees before local deployment.

---

### Task 1: Specify the copyable template in the browser test

**Files:**
- Modify: `tests/agent/alexa-voc-tutorial-browser.test.mjs`

**Interfaces:**
- Consumes: the existing `openVocPage()` Playwright harness and tutorial dialog
- Produces: regression assertions for the exact template, read-only state, clipboard payload, and success feedback

- [ ] **Step 1: Add clipboard capture to the page harness**

Change the harness signature to `async function openVocPage({ copyMode = "clipboard" } = {})`. Immediately after `const page = await context.newPage();`, install this script before navigation:

```js
await page.addInitScript(({ copyMode }) => {
  window.__copiedAlexaVocTemplate = "";
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async text => {
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
```

- [ ] **Step 2: Add the failing template assertions**

After the existing reminder assertion, add:

```js
const expectedTemplate = "这个产品的顾客关注点是什么、好评点是什么、差评点是什么、未被满足的需求是什么、使用人群是谁、使用场景是什么、购买动机是什么。";
const template = dialog.getByRole("textbox", { name: "七问模板" });
assert.equal(await template.inputValue(), expectedTemplate);
assert.equal(await template.getAttribute("readonly"), "");

const copyButton = dialog.getByRole("button", { name: "复制模板", exact: true });
await copyButton.click();
assert.equal(await page.evaluate(() => window.__copiedAlexaVocTemplate), expectedTemplate);
await dialog.getByRole("button", { name: "已复制", exact: true }).waitFor();
```

- [ ] **Step 3: Add the failing clipboard-error test**

Add a separate browser test:

```js
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
```

- [ ] **Step 4: Add the failing LAN HTTP fallback test**

Add a separate browser test:

```js
test("Alexa VOC tutorial copies through the selectable-text fallback", async () => {
  const { context, page } = await openVocPage({ copyMode: "fallback" });
  try {
    await page.getByRole("button", { name: "查看录入教程", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Alexa VOC 录入教程" });
    await dialog.getByRole("button", { name: "复制模板", exact: true }).click();
    assert.equal(
      await page.evaluate(() => window.__copiedAlexaVocTemplate),
      "这个产品的顾客关注点是什么、好评点是什么、差评点是什么、未被满足的需求是什么、使用人群是谁、使用场景是什么、购买动机是什么。",
    );
    await dialog.getByRole("button", { name: "已复制", exact: true }).waitFor();
  } finally {
    await context.close();
  }
});
```

- [ ] **Step 5: Build the unchanged application and verify RED**

Run: `npm run build`

Run: `node --test tests/agent/alexa-voc-tutorial-browser.test.mjs`

Expected: FAIL because the dialog has no textbox named “七问模板”.

### Task 2: Implement the template panel and copy behavior

**Files:**
- Modify: `app/alexa-voc-tutorial-dialog.tsx`
- Modify: `app/alexa-voc-tutorial-dialog.module.css`
- Test: `tests/agent/alexa-voc-tutorial-browser.test.mjs`

**Interfaces:**
- Consumes: browser clipboard API and the existing dialog's left-column layout
- Produces: `ALEXA_VOC_SEVEN_QUESTION_TEMPLATE`, a read-only textarea, and copy feedback local to the dialog

- [ ] **Step 1: Add the exact template constant and local copy state**

Add above the component:

```tsx
const ALEXA_VOC_SEVEN_QUESTION_TEMPLATE =
  "这个产品的顾客关注点是什么、好评点是什么、差评点是什么、未被满足的需求是什么、使用人群是谁、使用场景是什么、购买动机是什么。";

type CopyStatus = "idle" | "copied" | "failed";
```

Inside the component add:

```tsx
const [copyStatus, setCopyStatus] = useState<CopyStatus>("idle");
const templateRef = useRef<HTMLTextAreaElement>(null);
const copyResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
```

- [ ] **Step 2: Add clipboard-first copying with an HTTP fallback**

Add this callback inside the component:

```tsx
const copyTemplate = useCallback(async () => {
  let copied = false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(ALEXA_VOC_SEVEN_QUESTION_TEMPLATE);
      copied = true;
    }
  } catch {
    copied = false;
  }

  if (!copied && templateRef.current) {
    templateRef.current.focus();
    templateRef.current.select();
    try {
      copied = document.execCommand("copy");
    } catch {
      copied = false;
    }
  }

  if (!copied) {
    setCopyStatus("failed");
    return;
  }

  setCopyStatus("copied");
  if (copyResetTimerRef.current) clearTimeout(copyResetTimerRef.current);
  copyResetTimerRef.current = setTimeout(() => setCopyStatus("idle"), 1800);
}, []);
```

Add timer cleanup:

```tsx
useEffect(() => () => {
  if (copyResetTimerRef.current) clearTimeout(copyResetTimerRef.current);
}, []);
```

- [ ] **Step 3: Render the approved template panel below the reminder**

Immediately after the existing reminder paragraph, add:

```tsx
<div className={styles.templatePanel}>
  <div className={styles.templateHeader}>
    <label htmlFor="alexa-voc-seven-question-template">七问模板</label>
    <button type="button" className={styles.copyButton} onClick={copyTemplate}>
      {copyStatus === "copied" ? "已复制" : "复制模板"}
    </button>
  </div>
  <textarea
    ref={templateRef}
    id="alexa-voc-seven-question-template"
    className={styles.templateText}
    value={ALEXA_VOC_SEVEN_QUESTION_TEMPLATE}
    readOnly
    rows={5}
  />
  {copyStatus === "failed" ? (
    <p className={styles.copyError} role="status">复制失败，请手动选择</p>
  ) : null}
</div>
```

When opening the dialog, reset stale copy feedback:

```tsx
onClick={() => {
  setCopyStatus("idle");
  setOpen(true);
}}
```

- [ ] **Step 4: Style the template panel without enlarging the screenshot**

Add these focused CSS classes:

```css
.templatePanel { margin-top: 16px; padding: 12px; border: 1px solid #dfe7f0; border-radius: 9px; background: #fbfcfe; }
.templateHeader { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
.templateHeader label { color: #344b67; font-size: 12px; font-weight: 800; }
.copyButton { padding: 5px 9px; border: 1px solid #bcd7f5; border-radius: 7px; background: #fff; color: #2f6fae; font-size: 10px; font-weight: 700; cursor: pointer; }
.copyButton:hover { background: #eef6ff; }
.copyButton:focus-visible, .templateText:focus-visible { outline: 2px solid #2f80ed; outline-offset: 2px; }
.templateText { display: block; width: 100%; resize: vertical; box-sizing: border-box; padding: 9px 10px; border: 1px solid #dfe7f0; border-radius: 7px; background: #fff; color: #344b67; font: inherit; font-size: 11px; line-height: 1.65; }
.copyError { margin: 8px 0 0; color: #b42318; font-size: 10px; line-height: 1.5; }
```

- [ ] **Step 5: Build and verify GREEN**

Run: `npm run build`

Run: `node --test tests/agent/alexa-voc-tutorial-browser.test.mjs`

Expected: 1 test, 1 pass, 0 failures.

- [ ] **Step 6: Run focused regression checks**

```powershell
npx eslint app/alexa-voc-tutorial-dialog.tsx app/alexa-voc-import-panel.tsx tests/agent/alexa-voc-tutorial-browser.test.mjs
npx tsx --conditions=react-server --test tests/agent/alexa-voc-page-scope.test.ts tests/agent/alexa-voc-mutation-routes.test.ts tests/agent/alexa-voc-tutorial-assets.test.ts
git diff --check
```

Expected: every command exits 0 with no test failures or lint errors.

- [ ] **Step 7: Commit the implementation slice**

```powershell
git add app/alexa-voc-tutorial-dialog.tsx app/alexa-voc-tutorial-dialog.module.css tests/agent/alexa-voc-tutorial-browser.test.mjs
git commit -m "feat(voc): add copyable seven-question template"
```

### Task 3: Re-check isolation and deploy locally

**Files:**
- Modify only this plan's checkboxes after verification.

**Interfaces:**
- Consumes: verified tutorial branch and local formal-stack manager
- Produces: the updated tutorial on Web port 31900

- [ ] **Step 1: Re-check all active OpenSpec worktrees**

Run `git worktree list --porcelain`, then run `git -C` with `status --short` for these exact active OpenSpec paths:

```text
C:\Users\EDY\Amazon-Product-Opportunity-Insights\.worktrees\openspec-12-5-future-changes
C:\Users\EDY\Amazon-Product-Opportunity-Insights\.worktrees\openspec-4-3-auth
C:\Users\EDY\Amazon-Product-Opportunity-Insights\.worktrees\openspec-9-1-eval-fixtures
C:\Users\EDY\Amazon-Product-Opportunity-Insights\.worktrees\openspec-9-2-auto-evaluator
C:\Users\EDY\Amazon-Product-Opportunity-Insights\.worktrees\openspec-9-3-human-rating-switch
C:\Users\EDY\Amazon-Product-Opportunity-Insights\.worktrees\openspec-9-4-release-gate
```

Confirm none has dirty changes to either tutorial component, the Alexa VOC import panel, the tutorial image, or the tutorial browser test.

- [ ] **Step 2: Run final verification**

```powershell
npm test
node --test tests/agent/alexa-voc-tutorial-browser.test.mjs
npx tsx --conditions=react-server --test tests/agent/alexa-voc-page-scope.test.ts tests/agent/alexa-voc-mutation-routes.test.ts tests/agent/alexa-voc-tutorial-assets.test.ts
npx eslint app/alexa-voc-tutorial-dialog.tsx app/alexa-voc-import-panel.tsx tests/agent/alexa-voc-tutorial-assets.test.ts tests/agent/alexa-voc-tutorial-browser.test.mjs
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 3: Deploy the verified branch to the local formal stack**

Run: `powershell -ExecutionPolicy Bypass -File .\scripts\manage-formal-stack.ps1`

If an analysis task is active, do not terminate it. Otherwise expect Web 31900, Agent 31901, PostgreSQL 58258, and the new implementation commit.

- [ ] **Step 4: Verify live health and preserve the branch for user acceptance**

Verify `GET http://127.0.0.1:31900/api/health` and `GET http://127.0.0.1:31900/tutorials/alexa-voc-entry.png` both return HTTP 200. Ask the user to refresh `http://127.0.0.1:31900/?tab=voc` and visually confirm the template layout before merging or pushing.
