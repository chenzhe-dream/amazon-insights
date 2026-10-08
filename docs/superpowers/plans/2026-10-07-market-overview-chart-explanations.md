# Market Overview Chart Explanations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove technical chart notes from the formal market overview and make every original chapter's business explanation visible below its chart.

**Architecture:** Keep all data, collection, scoring, and report contracts unchanged. Make the report presentation layer select the saved chapter explanation, render it as an always-visible card, and remove only explanatory/source notes from chart components while leaving failure, missing-data, and trend-gap states.

**Tech Stack:** React 19, TypeScript, Node test runner, React server rendering, Playwright layout tests.

## Global Constraints

- Use the formal market worktree `C:\Users\EDY\.codex\worktrees\stable-persistent-20261006\feat-voc-positioning-skill-execution`.
- ZIP business rules and saved report data remain authoritative; do not change Sorftime requests or score calculations.
- Preserve actionable collection failure, missing-data, partial-data, and trend-gap messages.
- Follow the existing compact UI language and scoped `.market-ui-reference` styles.

---

### Task 1: Lock the requested chart presentation with a failing render test

**Files:**
- Modify: `tests/agent/market-overview-original-charts.test.tsx`
- Test fixture: `tests/agent/helpers/market-overview-page-fixture.ts`

**Interfaces:**
- Consumes `overviewDistributionDetails()` and `MarketOverviewReferenceSections`.
- Produces assertions for the visible business explanation and removed technical notes.

- [x] **Step 1: Write the failing test**

Add a test that renders a detail fixture with `chapterSynthesis` containing `sales-trend`, `brand-crn`, and `price` chapters, then asserts:

```ts
assert.doesNotMatch(html, /按原版展示 Sorftime 类目历史/);
assert.doesNotMatch(html, /月度数字与指标引用/);
assert.match(html, /业务解释 · 依据充分/);
assert.match(html, /数据表现/);
assert.match(html, /数据含义/);
assert.match(html, /业务结论/);
assert.match(html, /销售趋势业务结论/);
assert.match(html, /品牌集中度业务结论/);
assert.match(html, /价格分布业务结论/);
```

Add a second render with `chapterSynthesis` and `originalSynthesis` absent and assert `当前报告暂无可用业务总结` is present.

- [x] **Step 2: Run the focused test and verify it fails**

Run from the formal worktree:

```powershell
node --test --import tsx tests/agent/market-overview-original-charts.test.tsx
```

Expected: FAIL because the current report still renders the Sorftime note and collapsed metric-reference block, while `ChapterExplanation` is hidden or absent when chapter data is missing.

---

### Task 2: Render chapter explanations directly and remove technical chart notes

**Files:**
- Modify: `app/market-overview-reference-sections.tsx`
- Modify: `app/market-overview-distributions.tsx`
- Modify: `app/market-overview-demand-trend.tsx`
- Modify: `app/market-overview-product-demand.tsx`
- Modify: `app/market-ui-reference.css`

**Interfaces:**
- `MarketOverviewReferenceSections` continues to accept the existing `entry`, `detail`, `overview`, and `headTopN` props.
- `ChapterExplanation` accepts an optional chapter and always returns a visible business-explanation card.
- Existing error and empty-state strings remain the source of actionable collection status.

- [x] **Step 1: Implement the minimal visible explanation card**

Replace the `<details>` wrapper in `ChapterExplanation` with a visible `<section className="market-overview-business-explanation">`. Render the existing three fields directly. When no chapter exists, render the exact fallback `当前报告暂无可用业务总结`.

- [x] **Step 2: Remove only technical chart notes**

Remove the SalesCount/AvgPrice paragraph, month metric-reference `<details>`, source/denominator notes, request-bound explanatory notes, distribution formula notes, and product-demand source note. Keep all failed, not-collected, empty, partial, and trend-gap messages.

- [x] **Step 3: Add scoped UI styling**

Add compact styling under `.market-ui-reference` for the visible explanation card: purple-tinted border/background matching the existing report analysis card, a clear heading, three labeled rows, and readable line height on narrow screens.

- [x] **Step 4: Run the focused test and verify it passes**

```powershell
node --test --import tsx tests/agent/market-overview-original-charts.test.tsx
```

Expected: PASS with the technical notes absent, visible business explanation present, and actionable failure/缺口 content retained.

---

### Task 3: Verify the formal market overview layout and build

**Files:**
- No new production files.
- Verify: `tests/agent/market-overview-layout-browser.test.ts`

**Interfaces:**
- Uses the same rendered components and saved report fixture; no API or database changes.

- [x] **Step 1: Run the layout browser test**

```powershell
node --test --import tsx tests/agent/market-overview-layout-browser.test.ts
```

Expected: PASS with all existing chart dimensions, drilldowns, and actionable status behavior intact.

- [x] **Step 2: Run the project build**

```powershell
npm run build
```

Expected: exit code 0 with no TypeScript or bundler errors.

- [x] **Step 3: Review the diff**

```powershell
git diff --check
git status --short
```

Expected: only the planned report presentation, styles, tests, and documentation files are changed in the formal worktree; no data, API, collector, or scoring files are modified.

## Verification record

- `node --test --import tsx tests/agent/market-overview-original-charts.test.tsx` — 8 passed.
- `node --test --import tsx tests/agent/market-overview-layout-browser.test.ts` — 1 passed.
- `npm run build` — passed; only the existing proxy and chunk-size warnings were emitted.
- `git diff --check` — passed; the repository also contains pre-existing line-ending warnings from unrelated files.
