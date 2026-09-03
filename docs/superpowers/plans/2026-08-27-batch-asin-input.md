# Batch ASIN Input Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the ten fixed overview inputs with one paste-friendly ASIN editor that validates an ordered set of 3–10 ASINs without changing backend submission contracts.

**Architecture:** A pure parser returns valid ASINs and explicit invalid, duplicate, and overflow diagnostics. `app/page.tsx` owns the raw text so invalid tokens remain visible until the operator fixes them; a presentation component renders the controlled textarea and diagnostics. The page keeps its existing ordered `string[]` submission identity and blocks submission whenever diagnostics are non-empty.

**Tech Stack:** React 19, TypeScript, node:test, Playwright component harness, ESLint.

## Global Constraints

- Current stable version is frozen; work in an independent worktree and branch.
- Preserve the existing ordered `string[]` project registration and sync contracts.
- Do not silently truncate invalid or more-than-10 input; do not create a project or POST when validation fails.
- Keep project identity, URL ownership, double-click deduplication, tenant checks, and sync lifecycle unchanged.
- Run one focused implementation verification and one independent limited review; only Critical or direct business blockers permit rework.
- Preserve protected business WIP and keep the index limited to this task.

---

### Task 1: Pure ASIN parser and batch editor

**Files:**
- Create: `app/lib/asin-batch-input.ts`
- Create: `app/batch-asin-input.tsx`
- Modify: `app/page.tsx:436-465,1860-1900,2440-2520,3038-3065`
- Modify: `app/warm-theme.css:606-690`
- Test: `tests/agent/asin-batch-input.test.tsx`
- Test: `tests/agent/asin-sync-session.test.ts`

**Interfaces:**
- Produces: `parseBatchAsinInput(raw: string, max?: number): BatchAsinParseResult`.
- Produces: `BatchAsinInput({ raw, result, onRawChange })` with no hidden input state.
- Preserves: `runAnalysis()` submits `result.asins` using the existing project registration and `/v1/local-data/sync-asins` routes.

- [ ] **Step 1: Write parser RED tests**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { parseBatchAsinInput } from "../../app/lib/asin-batch-input";

test("parses mixed delimiters, uppercases, preserves order, and reports duplicates", () => {
  const result = parseBatchAsinInput("b0aaaa0001\nB0BBBB0002，B0AAAA0001;B0CCCC0003");
  assert.deepEqual(result.asins, ["B0AAAA0001", "B0BBBB0002", "B0CCCC0003"]);
  assert.deepEqual(result.duplicates, ["B0AAAA0001"]);
  assert.deepEqual(result.invalid, []);
  assert.deepEqual(result.overflow, []);
  assert.equal(result.canSubmit, false);
});

test("reports invalid and overflow tokens without truncating silently", () => {
  const raw = [...Array.from({ length: 11 }, (_, i) => `B${String(i).padStart(9, "0")}`), "bad"].join(" ");
  const result = parseBatchAsinInput(raw);
  assert.equal(result.asins.length, 10);
  assert.equal(result.overflow.length, 1);
  assert.deepEqual(result.invalid, ["BAD"]);
  assert.equal(result.canSubmit, false);
});
```

- [ ] **Step 2: Run parser RED**

Run: `npm exec -- tsx --conditions=react-server --test tests/agent/asin-batch-input.test.tsx`

Expected: FAIL because the parser module does not exist.

- [ ] **Step 3: Implement the bounded parser**

```ts
export type BatchAsinParseResult = {
  asins: string[]; invalid: string[]; duplicates: string[]; overflow: string[]; canSubmit: boolean;
};

export function parseBatchAsinInput(raw: string, max = 10): BatchAsinParseResult {
  const tokens = raw.toUpperCase().split(/[\s,，、;；|]+/).map(value => value.trim()).filter(Boolean);
  const invalid: string[] = [], duplicates: string[] = [], unique: string[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    if (!/^[A-Z0-9]{10}$/.test(token)) { invalid.push(token); continue; }
    if (seen.has(token)) { if (!duplicates.includes(token)) duplicates.push(token); continue; }
    seen.add(token); unique.push(token);
  }
  const asins = unique.slice(0, max), overflow = unique.slice(max);
  return { asins, invalid, duplicates, overflow,
    canSubmit: asins.length >= 3 && asins.length <= max && !invalid.length && !duplicates.length && !overflow.length };
}
```

- [ ] **Step 4: Implement the controlled editor and explicit diagnostics**

```tsx
"use client";
import type { BatchAsinParseResult } from "./lib/asin-batch-input";

export function BatchAsinInput({ raw, result, onRawChange }: {
  raw: string; result: BatchAsinParseResult; onRawChange: (raw: string) => void;
}) {
  return <div className="asin-batch-input">
    <textarea aria-label="批量输入 ASIN" value={raw} onChange={event => onRawChange(event.target.value)}
      placeholder={'每行一个 ASIN，也可用空格或逗号分隔\n例如：B0XXXXXXXX B0YYYYYYYY B0ZZZZZZZZ'} />
    <div className="asin-batch-summary">已识别 {result.asins.length}/10 个</div>
    {result.invalid.length ? <p role="alert">格式错误：{result.invalid.join("、")}</p> : null}
    {result.duplicates.length ? <p role="alert">重复 ASIN：{result.duplicates.join("、")}</p> : null}
    {result.overflow.length ? <p role="alert">最多 10 个，超出：{result.overflow.join("、")}</p> : null}
  </div>;
}
```

- [ ] **Step 5: Wire `app/page.tsx` without changing submission identity**

```tsx
const [asinDraft, setAsinDraft] = useState(() => inputs.filter(Boolean).join("\n"));
const asinParse = useMemo(() => parseBatchAsinInput(asinDraft), [asinDraft]);
const replaceInputAsins = useCallback((asins: string[]) => {
  setInputs(buildInputSlots(asins));
  setAsinDraft(asins.join("\n"));
}, []);

// Replace the ten overview inputs only:
<BatchAsinInput raw={asinDraft} result={asinParse} onRawChange={setAsinDraft} />

// First line of runAnalysis:
if (!asinParse.canSubmit) return setMessage("请修正 ASIN 输入后再开始分析");
const values = [...asinParse.asins];
setInputs(buildInputSlots(values));
```

Every existing project-load or URL-hydration site that currently calls `setInputs(buildInputSlots(asins))` must call `replaceInputAsins(asins)` instead. Raw invalid text is never replaced by parser output; only an explicit project load or successful submission normalizes it.

- [ ] **Step 6: Update the existing browser tests to fill the textarea and prove double-click remains one POST**

```ts
await page.getByRole("textbox", { name: "批量输入 ASIN" }).fill(asins.join("\n"));
await page.getByRole("button", { name: "开始全自动分析" }).dblclick();
assert.equal(syncPosts, 1);
```

- [ ] **Step 7: Run GREEN and lint**

Run: `npm exec -- tsx --conditions=react-server --test tests/agent/asin-batch-input.test.tsx tests/agent/asin-sync-session.test.ts`

Expected: PASS with 0 failures.

Run: `npx eslint app/lib/asin-batch-input.ts app/batch-asin-input.tsx app/page.tsx tests/agent/asin-batch-input.test.tsx tests/agent/asin-sync-session.test.ts && git diff --check`

Expected: exit 0.

- [ ] **Step 8: Commit only this slice**

```powershell
git add app/lib/asin-batch-input.ts app/batch-asin-input.tsx app/page.tsx app/warm-theme.css tests/agent/asin-batch-input.test.tsx tests/agent/asin-sync-session.test.ts
git commit -m "feat: add batch ASIN analysis input"
```
