# Market Overview Progress State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task with verification checkpoints.

**Goal:** Make saved stage results visibly distinguishable from in-progress, incomplete, and final market overview reports without changing scoring or data semantics.

**Architecture:** Derive a small presentation state from the existing run status and saved report metadata. Render one status notice in `MarketOverviewSection` above the saved report; keep `MarketOverviewOriginalSummary` responsible only for score semantics and radar values. Reuse the existing polling and retry paths so completion automatically replaces the stage notice with the terminal status.

**Tech Stack:** React + TypeScript, Node `node:test`, `react-dom/server`, Vite build, PowerShell candidate runtime on port 32900.

## Global Constraints

- Preserve existing report cards, borders, layout, controls, history links, and radar scoring behavior.
- Do not treat missing values as zero or change score/grade calculations.
- Show stage results while a run is active, but label them as temporary and subject to update.
- Keep formal port 31900 untouched; only restart and validate candidate port 32900.
- Do not stage or commit unrelated existing worktree changes.

---

### Task 1: Add a pure report-progress state presenter

**Files:**
- Create: `app/lib/market-overview-progress-state.ts`
- Test: `tests/agent/market-overview-progress-state.test.ts`

**Interfaces:**
- Consumes: `MarketOverviewRunResponse['run']` from `shared/market-overview-report-contracts`.
- Produces: `marketOverviewProgressState(run)` and `marketOverviewProgressCopy(state)` for the page component.

- [ ] **Step 1: Write the failing tests**

Create tests for these exact cases:

```ts
const runWith = (overrides: Partial<Run>): Run => ({
  id: '00000000-0000-4000-8000-000000000001',
  scope: scopeFixture,
  status: 'running',
  createdAt: '2026-10-12T00:00:00.000Z',
  planRevision: 1,
  params: { headTopN: 10, newProductMonths: 6, sampleSize: 100 },
  steps: [],
  currentReport: null,
  latestSavedReport: null,
  history: [],
  ...overrides,
});

test('active run without saved report is active', () => {
  assert.equal(marketOverviewProgressState(runWith({ status: 'running' })), 'active');
});

test('active run with current report is stage-result', () => {
  assert.equal(marketOverviewProgressState(runWith({ status: 'running', currentReport: reportEntry })), 'active-with-report');
});

test('partial terminal run is incomplete', () => {
  assert.equal(marketOverviewProgressState(runWith({ status: 'partial', currentReport: reportEntry })), 'partial');
});

test('succeeded terminal run is complete', () => {
  assert.equal(marketOverviewProgressState(runWith({ status: 'succeeded', currentReport: reportEntry })), 'complete');
});

test('failed run with saved report preserves the failure state', () => {
  assert.equal(marketOverviewProgressState(runWith({ status: 'failed', currentReport: reportEntry })), 'failed-with-report');
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run:

```powershell
npx tsx --test tests/agent/market-overview-progress-state.test.ts
```

Expected: FAIL because the presenter module does not exist.

- [ ] **Step 3: Implement the pure presenter**

Add these exact state and copy contracts:

```ts
export type MarketOverviewProgressState =
  | 'active'
  | 'active-with-report'
  | 'partial'
  | 'complete'
  | 'failed-with-report'
  | 'failed'
  | 'cancelled'
  | 'idle';

export function marketOverviewProgressState(run: Run | null): MarketOverviewProgressState {
  if (!run) return 'idle';
  const hasReport = Boolean(run.currentReport ?? run.latestSavedReport);
  if (run.status === 'running' || run.status === 'queued') return hasReport ? 'active-with-report' : 'active';
  if (run.status === 'partial') return 'partial';
  if (run.status === 'succeeded') return 'complete';
  if (run.status === 'failed') return hasReport ? 'failed-with-report' : 'failed';
  if (run.status === 'cancelled') return 'cancelled';
  return 'idle';
}

export function marketOverviewProgressCopy(state: MarketOverviewProgressState) {
  return {
    'active-with-report': { tone: 'active', title: '总览分析进行中 · 以下是阶段性结果', detail: '后台仍在处理剩余步骤，完成后页面会自动更新；当前综合评分不代表最终结果。' },
    partial: { tone: 'partial', title: '报告已保存，但存在数据缺口', detail: '以下为已确认结果，当前不能作为最终评级；可重试或补齐缺失步骤。' },
    complete: { tone: 'complete', title: '分析已完成', detail: '六维评分和业务结论已生成，当前内容为本次任务的最终报告。' },
    'failed-with-report': { tone: 'failed', title: '分析未完整完成，已保留阶段性结果', detail: '以下结果不代表完整报告，可重试失败步骤。' },
  } as const satisfies Partial<Record<MarketOverviewProgressState, { tone: string; title: string; detail: string }>>;
}
```

Return `null` for states without a saved-report notice (`active`, `failed`, `cancelled`, `idle`).

- [ ] **Step 4: Run the focused test to verify it passes**

Run the same command. Expected: all presenter state and copy assertions pass.

- [ ] **Step 5: Commit only the presenter and test**

```powershell
git add app/lib/market-overview-progress-state.ts tests/agent/market-overview-progress-state.test.ts
git commit -m "feat: classify market overview report progress"
```

### Task 2: Render the state notice in the overview report shell

**Files:**
- Modify: `app/market-overview-section.tsx`
- Modify: `app/market-overview-reference.css`
- Test: `tests/agent/market-overview-progress-state.test.ts` (render-copy assertions remain pure)

**Interfaces:**
- Consumes: `marketOverviewProgressState(run)` and `marketOverviewProgressCopy(state)`.
- Produces: an accessible `role="status"` notice between the run metadata and the selected report.

- [ ] **Step 1: Write the failing markup assertions**

Extend the presenter test to assert the exact user-facing copy from `marketOverviewProgressCopy` for `active-with-report`, `partial`, and `complete`. The test must assert that the copy includes `阶段性结果`, `存在数据缺口`, and `分析已完成` respectively.

- [ ] **Step 2: Run the focused test and verify it fails**

```powershell
npx tsx --test tests/agent/market-overview-progress-state.test.ts
```

Expected: FAIL until the copy table contains the exact strings.

- [ ] **Step 3: Integrate the presenter into `MarketOverviewSection`**

Import the helper, derive `progressState` after `isActive`, and render the notice immediately after `.market-reference-report-meta` and before any `selected` report. Render only when `selected` exists and the helper returns copy. Use:

```tsx
{selected && progressCopy && <div className={`market-overview-progress-notice tone-${progressCopy.tone}`} role="status" aria-live={isActive ? 'polite' : 'off'}>
  {isActive && <span className="market-theme-spinner" aria-hidden="true" />}
  <div><strong>{progressCopy.title}</strong><p>{progressCopy.detail}</p></div>
</div>}
```

Keep the existing meta status, step list, retry buttons, and report content unchanged.

- [ ] **Step 4: Add minimal CSS using existing visual language**

In `app/market-overview-reference.css`, add styles for `.market-overview-progress-notice` using the existing 8px radius, neutral border, and current palette. Use amber for `tone-active` and `tone-partial`, green/blue-neutral for `tone-complete`, and red-neutral for `tone-failed`. Do not change report card dimensions or radar styles.

- [ ] **Step 5: Run focused regression tests**

```powershell
npx tsx --test tests/agent/market-overview-progress-state.test.ts tests/agent/market-overview-original-summary-presentation.test.tsx tests/agent/market-overview-hover.test.ts
```

Expected: new progress-state tests and existing radar/hover tests pass. Any unrelated pre-existing wording assertion must be reported separately.

- [ ] **Step 6: Commit only the status-shell changes**

```powershell
git add app/market-overview-section.tsx app/market-overview-reference.css tests/agent/market-overview-progress-state.test.ts
git commit -m "feat: show market overview report readiness"
```

### Task 3: Build and verify candidate runtime

**Files:**
- No source changes expected.
- Evidence: `test-results/market-overview-progress-state-build.log`

- [ ] **Step 1: Run the project build**

```powershell
npm run build *> test-results/market-overview-progress-state-build.log
if ($LASTEXITCODE -ne 0) { throw "build failed" }
```

Expected: exit code 0.

- [ ] **Step 2: Restart candidate only**

```powershell
& 'C:\Users\EDY\Amazon-Product-Opportunity-Insights.runtime\candidate-stack\stop.ps1'
& 'C:\Users\EDY\Amazon-Product-Opportunity-Insights.runtime\candidate-stack\start.ps1'
```

Expected: candidate web remains on port 32900 and candidate agent on 32901. Do not call the formal stack scripts.

- [ ] **Step 3: Verify candidate health and formal isolation**

```powershell
Invoke-WebRequest http://127.0.0.1:32900/api/health -UseBasicParsing
Invoke-WebRequest http://127.0.0.1:31900/api/health -UseBasicParsing
```

Expected: both return HTTP 200; candidate health is checked after restart and formal health is read-only.

- [ ] **Step 4: Verify the three UI states in the browser**

At `http://127.0.0.1:32900/`, use an active overview task with a saved current report to confirm the stage notice, then wait for completion and confirm it changes to either `分析已完成` or `报告已保存，但存在数据缺口`. Capture a screenshot or accessibility snapshot showing the notice and report. Do not claim formal publication.

- [ ] **Step 5: Commit only evidence if needed**

Do not stage runtime logs, screenshots, or unrelated files unless they are intentionally retained as verification evidence.


