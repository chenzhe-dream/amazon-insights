# Xiyou annual inspection V2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add annual child share inspection and collapse the annual detail table without changing the existing twelve-month trend.

**Architecture:** A small annual-only inspection controller and named nonmodal information region consume the existing annual summary. The section owns one active child identity; the card and dialog compose it. The collector and progress remain a separate B plan.

**Tech Stack:** React19, TypeScript, existing CSS, node:test, Vite and Playwright; no new dependencies.

## Global Constraints

- Scope `XYDC-ANNUAL-V2`, approved and execution requested on 2026-09-08. Current design: `docs/superpowers/specs/2026-09-08-xydc-hover-and-collection-resilience-design.md`.
- Worktree `C:/Users/EDY/Amazon-Product-Opportunity-Insights/.worktrees/fix-voc-import-status-20260907`, branch `codex/feat-xydc-parent-orders-12m-20260908`. Base before V2 implementation `ef6867848e4e56c4450bf20946ca9f88973b43ca`.
- Allowed A1 annual share inspection and A2 annual table collapse. K1 preserves existing 12 complete UTC months, annual denominator, child identity, card top-three preview, current month chart and accessible data.
- Excluded D1: NO new monthly hover, month selector, monthly projection, or new monthly chart interaction. Excluded D2: no pie/donut. X1: no formal restart/activation, main merge, GitHub push, live Provider/shared-data writes or parallel-worktree edits. Retired mixed-monthly Task1 is never reused.
- Every independently extracted task includes these constraints and its scope identifiers in its own body. Changed source/tests must trace to A1/A2 or a K1 regression. Existing monthly regressions may run unchanged; new monthly feature tests cannot be smuggled in as coverage.
- Fresh pre-edit baseline: server67/67 and UI7/7 pass. An earlier UI rerender immediate assertion was intermittent; investigate its scheduling and preserve expected brand/value rather than assuming a product defect. Test-only condition waits are permitted in the owned fixture.

## Task 1: Annual inspection and collapsed annual details

**Binding scope (must stay in the task brief):** `XYDC-ANNUAL-V2`; implement A1/A2 only, preserve K1, exclude D1/D2, respect X1. No new monthly hover/projection/chart interaction, no pie. Work only `C:/Users/EDY/Amazon-Product-Opportunity-Insights/.worktrees/fix-voc-import-status-20260907` on `codex/feat-xydc-parent-orders-12m-20260908`. Do not edit formal/parallel worktrees, run live Providers, install dependencies, write shared data, push, merge or restart formal service. Root owns plans/ledger. Old `.superpowers/sdd/xydc-hover-task-1-brief.md` is revoked, not a requirement.

**Files and boundaries:**

- Create `app/xydc-annual-inspection.tsx`: annual-only controller, trigger props and information region. An additional focused positioning helper under `app/lib/xydc-annual-inspection-position.ts` is allowed if separation genuinely improves clarity; no generic chart platform.
- Modify `app/xydc-order-card.tsx`: positive annual share segments and every annual legend entry access a child inspection; pending/incomplete and raw0 children still have legend access.
- Modify `app/xydc-order-detail.tsx`: annual table collapse and annual legend access only. Keep the monthly chart, its native title behavior and monthly accessibility table unchanged.
- Modify `app/xydc-variant-section.tsx`: shared annual inspection state/current models and identity lifecycle, close outside inspection when opening detail.
- Modify only relevant styles in `app/comparison-layout.css` and UI tests `tests/agent/xydc-order-section.test.tsx`. May extract the existing fixture to `tests/helpers/xydc-order-browser-fixture.tsx` if reuse is needed, without duplicating servers.
- Do not edit shared monthly contract/summary, collection/runtime sources or `app/page.tsx` in this task. Backend B task later passes optional progress props separately.

**Interfaces:** consume existing `XydcOrderCardModel`, `summarizeXydcOrders(snapshot)` and `formatOrderCount/formatOrderShare/orderColorMap/orderAttributeLabel`. New module exposes annual-only provider/controller and trigger/region components; no network operation. Stable identity combines country, parent ASIN, window start/end and sorted full child ASIN set; active member adds child ASIN. Resolve displayed values from current models by this identity, never retain a stale summary in a click callback.

- [x] **Step 1 — Read owned source and capture a failing browser assertion.** Reuse real renderToString/hydrateRoot and current request interception. Add actual behavior assertions before implementation, including:

```tsx
await page.getByRole('button', {name: '查看全部 4 个子体与月度趋势'}).click();
const dialog = page.getByRole('dialog');
assert.equal(await dialog.getByLabel('订单明细排序').count(), 0);
const expand = dialog.getByRole('button', {name: '展开年度明细'});
assert.equal(await expand.getAttribute('aria-expanded'), 'false');
await expand.click();
assert.equal(await dialog.getByLabel('订单明细排序').count(), 1);
```

Run `node --import tsx --test tests/agent/xydc-order-section.test.tsx`. Record RED showing the existing always-visible table, not a fixture/import error. Update the old table/sort test to explicitly expand when it expects table controls; retain all old chart/identity assertions.

- [x] **Step 2 — Add annual inspection behavioral tests and implementation.** Four-child fixture's Sand Black must show annual4000+,67.80%,0 missing/0 undisclosed; annual parent remains5900+. Do not substitute December/monthly numbers. Test raw0 =>未披露/—, incomplete=>unknown annualshare, missing metadata, stale badge/time, reordered children/sort and updated props. Complete/tiny/raw0/incomplete children all have named legend controls; ASIN remains full text.

Annual region markup uses the existing derived row, not a new calculator:

```tsx
<section role="region" aria-labelledby={titleId} id={panelId}>
  <h5 id={titleId}>{attributeLabel} · 年度订单明细</h5>
  <p>{row.asin}</p><p>{window.startMonth} — {window.endMonth}</p>
  <dl><dt>12个月订单量</dt><dd>{formatOrderCount(row.total, row.complete)}</dd>
    <dt>年度份额</dt><dd>{formatOrderShare(row.share)}</dd>
    <dt>缺失 / 未披露月份</dt><dd>{row.missingMonths.length} / {row.undisclosedMonths}</dd></dl>
  <button type="button" aria-label="关闭年度悬浮明细" onClick={dismiss}>关闭</button>
</section>
```

Use real snapshot metadata for stale/fetchedAt. One controlled region per module; stable ASIN palette can repeat beyond8, so text identities stay visible. Do not introduce monthly projection to obtain annual values.

- [x] **Step 3 — Implement annual-only interaction with regression tests.** Hover/focus previews; click/tap/Enter/Space pins/toggles. Mouse can enter region without flicker; leave both dismisses unpinned preview with a short cancelable delay. Explicit close/Escape/outside dismiss suppresses reopening while same trigger remains focused/hovered until it leaves/reenters or explicitly clicks. Another trigger replaces the active panel. Close restores a connected, valid trigger only. Opening detail or loss of identity closes external card panel. In-dialog annual panel is part of dialog DOM/focus scope, not a second modal; no interactive role=tooltip, no focusable under aria-hidden. Escape closes active annual region before outer dialog and stops that event. Position inside viewport, recompute scroll/resize, max-height internal scroll if needed. Text>=12px, no ASIN/number truncation. Test mouse path, keyboard, touch390px, edge positioning, outside dismissal and Escape ordering using observed-state waits.

- [x] **Step 4 — Implement collapse and lifecycle.** Conditionally mount annual sort/table together; do not just hide an ancestor. Keep monthly screen-reader table and main card top3 unchanged. Preserve expansion and sorting across equivalent objects and updated same-identity data, reset for new dialog/parent/window/childset. Use identity key or effect with correct current selection guard. Regression values must update after a React commit; use `page.waitForFunction` for expected updated brand/value if fixture is asynchronous, not arbitrary sleep or removal of assertions.

```tsx
const [expanded, setExpanded] = React.useState(false);
<button type="button" aria-expanded={expanded} aria-controls={tableRegionId}
  onClick={() => setExpanded(value => !value)}>
  {expanded ? '收起年度明细' : '展开年度明细'}
</button>
{expanded ? <AnnualTableAndSort /> : null}
```

The snippet specifies conditional mounting only; implement using existing table without duplicating its logic. Focus collector excludes genuinely hidden/inert content and includes annual panel controls.

- [x] **Step 5 — Verify GREEN and self-review scope.** Run `node --import tsx --test tests/agent/xydc-order-section.test.tsx`; `node --import tsx --test tests/scripts/xydc-order-summary.test.ts`; changed-file ESLint; `git diff --check`. Check console hydration and network violations, preserve baseline responsive chart tests, inspect desktop and390px screenshots under test-results only. For the scope audit confirm no added monthly triggers/handler/projection or pie. Capture body scroll/closed table focus behavior and same-ASIN updates.
- [x] **Step 6 — Commit/report.** Commit only owned source and tests after GREEN, not root plan/ledger/real snapshots. Full report `.superpowers/sdd/xydc-v2-annual-task-1-report.md` includes RED/GREEN commands, failures, exact screenshots, changed files, source-to-A1/A2/K1 mapping, commitSHA and concerns. Final <=15lines. Root then generates full recorded BASE..HEAD package for independent spec and quality review; fix/review before next task.

Task gate: implementation30296a4 plus correction8cab00e; independent re-review Spec compliant / Approved, no remaining findings. Root fresh UI14/14 (16217.3993ms); whole-V2 validation remains separate below.

## Joint validation after A and B

Root runs combined focused suites, isolated production build, changed-file lint and TS-baseline comparison, read-only actual21child/252month preview. No recollection needed for A. B must pass real local HTTP/process/cancellation tests; all-cache-hit is not network evidence. Final whole-branch review uses V2 baseline ef68678 and current sourceHEAD, verifies D1/D2 exclusions and X1 guards. No formal release without separate authorization.
