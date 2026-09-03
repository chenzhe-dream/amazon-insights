# Sync Readiness and VOC Import Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Display truthful per-ASIN automatic-module readiness and a clear Chinese error when Manual Alexa VOC import is rejected.

**Architecture:** Keep both calculations in pure client-safe helpers. `sync-job-display.ts` owns the readiness matrix calculation; a new Manual VOC feedback helper converts bounded HTTP error categories into safe UI copy. React components only render helper outputs.

**Tech Stack:** TypeScript 5.9, React 19, Node test runner through `tsx`, ESLint, production build.

## Global Constraints

- Only `SYNC_STAGE_TEMPLATE` entries with `kind === "auto"` enter readiness scoring.
- One `ASIN × automatic module` is one scoring unit.
- Manual Alexa VOC stays outside the automatic denominator and remains a separate pending count.
- HTTP 422 displays `导入失败：请确认报告包含当前 ASIN，并至少包含 3 个标准维度标题。`.
- Unknown errors do not expose response bodies, stacks, credentials, or internal fields.
- Do not change Provider calls, sync lifecycle, database contracts, or Manual VOC completion gates.
- Preserve all generated business-data WIP and do not stage it.

---

### Task 1: Per-ASIN Automatic Module Readiness

**Files:**
- Modify: `app/lib/sync-job-display.ts:9-133`
- Modify: `app/asin-sync-funnel.tsx:11-21,262-305`
- Test: `tests/agent/asin-sync-readiness.test.ts`

**Interfaces:**
- Consumes: `SYNC_STAGE_TEMPLATE`, `idleStageStatus(stageId, items)` and `AsinDataStatusItem[]`.
- Produces: `calculateAutoModuleReadiness(items): { ready: number; total: number; percent: number }`.

- [ ] **Step 1: Write the failing matrix test**

Add three status rows whose eleven automatic modules contain exactly twenty-one ready cells, then assert:

```ts
assert.deepEqual(calculateAutoModuleReadiness(items), {
  ready: 21,
  total: 33,
  percent: 64,
});
assert.deepEqual(calculateAutoModuleReadiness([]), { ready: 0, total: 0, percent: 0 });
```

- [ ] **Step 2: Verify RED**

Run:

```powershell
npx tsx --conditions=react-server --test tests/agent/asin-sync-readiness.test.ts
```

Expected: FAIL because `calculateAutoModuleReadiness` is not exported.

- [ ] **Step 3: Implement the minimal pure calculation**

Add:

```ts
export function calculateAutoModuleReadiness(items: readonly AsinDataStatusItem[]) {
  const stages = SYNC_STAGE_TEMPLATE.filter(stage => stage.kind === "auto");
  const total = items.length * stages.length;
  const ready = items.reduce(
    (count, item) => count + stages.filter(stage => idleStageStatus(stage.id, [item]) === "done").length,
    0,
  );
  return { ready, total, percent: total === 0 ? 0 : Math.round((ready / total) * 100) };
}
```

Import it in `asin-sync-funnel.tsx`, replace the old whole-column count, render `自动模块就绪 {ready}/{total}（{percent}%）`, and use `percent` for the bar width.

- [ ] **Step 4: Verify GREEN**

Run the focused command from Step 2. Expected: PASS, including the 21/33/64 and empty-state assertions.

- [ ] **Step 5: Commit**

```powershell
git add app/lib/sync-job-display.ts app/asin-sync-funnel.tsx tests/agent/asin-sync-readiness.test.ts
git commit -m "fix(web): calculate readiness per ASIN module"
```

### Task 2: Safe Manual VOC Import Error Copy

**Files:**
- Create: `app/lib/manual-alexa-voc-import-feedback.ts`
- Modify: `app/alexa-voc-import-panel.tsx:1-60`
- Create: `tests/agent/manual-alexa-voc-import-feedback.test.ts`

**Interfaces:**
- Consumes: HTTP status and parsed unknown JSON payload.
- Produces: `manualAlexaVocImportErrorMessage(status: number, payload: unknown): string`.

- [ ] **Step 1: Write failing feedback tests**

```ts
assert.equal(
  manualAlexaVocImportErrorMessage(422, { error: { code: "VALIDATION_ERROR", message: "Alexa report is incomplete or invalid" } }),
  "导入失败：请确认报告包含当前 ASIN，并至少包含 3 个标准维度标题。",
);
assert.equal(manualAlexaVocImportErrorMessage(500, { error: { secret: "must-not-render" } }), "导入失败");
assert.doesNotMatch(manualAlexaVocImportErrorMessage(500, { error: {} }), /\[object Object\]/);
```

- [ ] **Step 2: Verify RED**

Run:

```powershell
npx tsx --conditions=react-server --test tests/agent/manual-alexa-voc-import-feedback.test.ts
```

Expected: FAIL because the helper module does not exist.

- [ ] **Step 3: Implement bounded status mapping and wire the panel**

Create:

```ts
const COPY: Readonly<Record<number, string>> = Object.freeze({
  400: "导入失败：请求格式无效，请重新选择 ASIN 后再试。",
  413: "导入失败：报告内容过长，请粘贴完整七问正文并删除无关内容。",
  422: "导入失败：请确认报告包含当前 ASIN，并至少包含 3 个标准维度标题。",
  503: "导入失败：Manual Alexa VOC 录入服务暂不可用。",
});

export function manualAlexaVocImportErrorMessage(status: number, payload: unknown) {
  if (COPY[status]) return COPY[status];
  if (payload && typeof payload === "object") {
    const error = (payload as { error?: unknown }).error;
    if (typeof error === "string" && error.trim()) return error.trim();
  }
  return "导入失败";
}
```

Replace the panel's `String(payload.error)` branch with `manualAlexaVocImportErrorMessage(response.status, payload)`.

- [ ] **Step 4: Verify GREEN**

Run the focused command from Step 2. Expected: PASS and no test output contains `[object Object]` or the sentinel secret.

- [ ] **Step 5: Commit**

```powershell
git add app/lib/manual-alexa-voc-import-feedback.ts app/alexa-voc-import-panel.tsx tests/agent/manual-alexa-voc-import-feedback.test.ts
git commit -m "fix(voc): show bounded import errors"
```

### Task 3: Retrospective Regression Gate

**Files:**
- Verify only: all Task 1 and Task 2 files
- Protect: existing generated `app/*-data.ts`, project JSON, and runtime data

**Interfaces:**
- Consumes: both committed fixes.
- Produces: evidence that focused behavior, affected contracts, lint, build, and WIP boundaries remain valid.

- [ ] **Step 1: Run combined focused regression**

```powershell
npx tsx --conditions=react-server --test tests/agent/asin-sync-readiness.test.ts tests/agent/manual-alexa-voc-import-feedback.test.ts tests/alexa-voc-import-validation.test.ts tests/agent/alexa-voc-mutation-routes.test.ts
```

Expected: all tests PASS.

- [ ] **Step 2: Run changed-file lint**

```powershell
npx eslint app/lib/sync-job-display.ts app/asin-sync-funnel.tsx app/lib/manual-alexa-voc-import-feedback.ts app/alexa-voc-import-panel.tsx tests/agent/asin-sync-readiness.test.ts tests/agent/manual-alexa-voc-import-feedback.test.ts
```

Expected: exit code 0 with no errors.

- [ ] **Step 3: Run production build**

```powershell
npm run build
```

Expected: exit code 0.

- [ ] **Step 4: Review diff and WIP boundary**

```powershell
git diff --check HEAD~2..HEAD
git diff --name-only HEAD~2..HEAD
git status --short
```

Expected: only the planned source/tests plus design/plan commits are in committed history; existing generated business-data WIP remains unstaged and unchanged by these fixes.

- [ ] **Step 5: Record the retrospective result**

Report the observed test counts, lint/build results, exact commits, computed sample `21/33（64%）`, and confirm that no Provider, browser POST, database write, or deployment occurred.
