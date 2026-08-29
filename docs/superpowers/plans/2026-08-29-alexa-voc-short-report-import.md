# Alexa VOC Short Report Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow users to submit any non-empty Alexa VOC report through the manual paste panel without changing automatic capture safeguards.

**Architecture:** Add one pure shared predicate for manual-report presence and consume it from both the client panel and API route. Keep structural validity in the existing Alexa VOC parsing pipeline, so report length is not treated as a proxy for report quality.

**Tech Stack:** TypeScript, React, Vinext, Node test runner, tsx

## Global Constraints

- Modify only `C:/Users/EDY/Amazon-Product-Opportunity-Insights/.worktrees/stabilize-resumable-sync-pipeline`.
- Manual paste rejects only blank content; there is no fixed character threshold.
- Automatic capture scripts and their completeness thresholds remain unchanged.
- Existing unrelated working-tree changes must remain untouched.

---

### Task 1: Shared manual import validation

**Files:**
- Create: `app/alexa-voc-import-validation.ts`
- Create: `tests/alexa-voc-import-validation.test.ts`

**Interfaces:**
- Consumes: an unknown report value supplied by a UI or API payload.
- Produces: `hasManualAlexaVocText(value: unknown): boolean`.

- [ ] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { hasManualAlexaVocText } from "../app/alexa-voc-import-validation";

test("accepts a non-empty manual report shorter than 600 characters", () => {
  assert.equal(hasManualAlexaVocText("1️⃣ 顾客关注点\n安装简单"), true);
});

test("rejects an empty manual report", () => {
  assert.equal(hasManualAlexaVocText("   \n\t"), false);
  assert.equal(hasManualAlexaVocText(undefined), false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test tests/alexa-voc-import-validation.test.ts`

Expected: FAIL because `app/alexa-voc-import-validation.ts` does not exist.

- [ ] **Step 3: Write the minimal implementation**

```ts
export function hasManualAlexaVocText(value: unknown) {
  return String(value ?? "").trim().length > 0;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test tests/alexa-voc-import-validation.test.ts`

Expected: two tests PASS.

- [ ] **Step 5: Commit**

```powershell
git add app/alexa-voc-import-validation.ts tests/alexa-voc-import-validation.test.ts
git commit -m "test: define manual Alexa VOC text validation"
```

### Task 2: Wire the shared rule into the manual UI and API

**Files:**
- Modify: `app/alexa-voc-import-panel.tsx:3,96`
- Modify: `app/api/alexa-voc/import/route.ts:1-2,42-43`
- Test: `tests/alexa-voc-import-validation.test.ts`

**Interfaces:**
- Consumes: `hasManualAlexaVocText(value: unknown): boolean` from Task 1.
- Produces: a manual submit button enabled for every non-empty report and an API that rejects only blank reports before parsing.

- [ ] **Step 1: Add a failing wiring assertion**

Extend `tests/alexa-voc-import-validation.test.ts` with source-level integration checks that protect both consumers:

```ts
import fs from "node:fs";

test("manual import consumers use presence validation instead of a length threshold", () => {
  const panel = fs.readFileSync(new URL("../app/alexa-voc-import-panel.tsx", import.meta.url), "utf8");
  const route = fs.readFileSync(new URL("../app/api/alexa-voc/import/route.ts", import.meta.url), "utf8");

  assert.match(panel, /!hasManualAlexaVocText\(text\)/);
  assert.match(route, /!hasManualAlexaVocText\(text\)/);
  assert.doesNotMatch(panel, /length\s*<\s*600/);
  assert.doesNotMatch(route, /length\s*<\s*600/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test tests/alexa-voc-import-validation.test.ts`

Expected: FAIL because the panel and route still contain the 600-character checks.

- [ ] **Step 3: Wire the validator into the client and route**

In `app/alexa-voc-import-panel.tsx`, import the predicate and replace the button condition:

```ts
import { hasManualAlexaVocText } from "./alexa-voc-import-validation";
```

```tsx
disabled={status === "loading" || !hasManualAlexaVocText(text)}
```

In `app/api/alexa-voc/import/route.ts`, import the same predicate and replace the length check:

```ts
import { hasManualAlexaVocText } from "../../../alexa-voc-import-validation";
```

```ts
if (!hasManualAlexaVocText(text)) {
  return Response.json({ error: "Alexa 报告内容不能为空" }, { status: 400, headers });
}
```

- [ ] **Step 4: Run focused and project verification**

Run: `npx tsx --test tests/alexa-voc-import-validation.test.ts`

Expected: three tests PASS.

Run: `npm run build`

Expected: Vinext build completes successfully.

- [ ] **Step 5: Commit**

```powershell
git add app/alexa-voc-import-panel.tsx app/api/alexa-voc/import/route.ts tests/alexa-voc-import-validation.test.ts
git commit -m "fix: allow short manual Alexa VOC reports"
```

