# Xiyou monthly and annual hover details Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users inspect every child's monthly count/share and a child's annual summary without a permanently expanded detail table, preserving truthful missing-data semantics.

**Architecture:** Pure snapshot projection plus a small shared nonmodal inspection controller/panel, composed into the existing card and detail dialog. All interaction is local to authorized props. The separate collection-resilience plan owns Provider and runtime progress work.

**Tech Stack:** React 19, TypeScript, current CSS, node:test and existing Vite/Playwright fixture. No added dependencies.

## Global Constraints

- Worktree: `C:/Users/EDY/Amazon-Product-Opportunity-Insights/.worktrees/fix-voc-import-status-20260907`; branch `codex/feat-xydc-parent-orders-12m-20260908`. Never edit default or formal worktrees.
- Design authority: `docs/superpowers/specs/2026-09-08-xydc-hover-and-collection-resilience-design.md`, especially sections 3, 4 and 7. Approved by user on 2026-09-08. Follow-up baseline `9f44f9c`.
- No Provider requests, production/shared data writes, npm install, GitHub push, main merge, formal activation/restart. Keep existing untracked `test-results/` and parallel changes. Commit only explicitly owned source/tests/docs.
- Use TDD and separate server tests (`--conditions=react-server`) from UI tests (normal React). Baseline server 67/67; UI 6/7 with immediate assertion after React rerender failing at old test line395. Diagnose whether this is an asynchronous test race or a real stale-model defect before changing product behavior. Do not relax the actual updated-data expectation.
- Do not change twelve completed UTC months, parent/child identity checks, pricing, card top-three preview, existing stale-cache rules, or disabled native-browser control.

## Task 1: Read-only inspection panels and collapsed annual detail

**Owner:** one implementer; no other UI implementer concurrently. Standard multi-file UI integration; use high reasoning. Root owns this plan and ledger.

**Files:**

- Add `shared/xydc-order-inspection.ts` and `tests/scripts/xydc-order-inspection.test.ts` for pure monthly projection.
- Add `app/xydc-order-inspection.tsx` (split a small position/controller helper only if genuinely clearer).
- Modify `app/xydc-order-card.tsx`, `app/xydc-order-detail.tsx`, `app/xydc-variant-section.tsx` and the existing Xiyou CSS section in `app/comparison-layout.css`.
- Modify `tests/agent/xydc-order-section.test.tsx`; separate new fixture test file allowed if it reuses existing fixture infrastructure without duplicating a whole server.
- Do not edit `app/page.tsx`, runtime/server sources, collection files or B plan. Report source overlap needs instead.

**Interface and invariants:**

`projectXydcOrderMonth(snapshot: XydcOrderSnapshot, month: string)` returns `null` for a month outside the validated window; otherwise `{month, total: number|null, expectedChildren: number, returnedChildren: number, complete: boolean, rows: Array<{asin:string, orders:number|null, share:number|null}>}`. Read current strict contract and summary. Use each month's full child set, not annual top three. Reject or null any invalid identity input rather than remapping values by index. Sort positive counts descending, then raw0, then missing, ASIN tie-break. Shares exist only for positive rows in a complete positive-total month. Annual summaries remain from existing `summarizeXydcOrders`.

Inspection identity includes country, parent, ordered fixed window and current complete child identity, plus kind/month or kind/ASIN. Values must resolve from current props, not a stale clicked model. One panel is active across cards and dialog. A local provider/controller or an explicitly lifted state can enforce this without global app state. Opening detail closes an external card panel; detail panel DOM stays inside outer dialog, even though outer dialog itself portals to body. Identity removal/window change resets state and timers.

**Steps:**

- [ ] Read full approved design and owned source/tests. Reproduce baseline rerender failure; use waiting for a concrete React commit if the existing test assertion races asynchronous state, never an arbitrary sleep as the correctness condition. If current data truly stays stale after settlement, fix the model resolution with a failing regression.
- [ ] Write pure projection tests and run RED before implementation. Build a legal fixture with Dec2025 `[500,100,50,0]`, assert total650 and shares76.923/15.384/7.692/null; annual5900 remains distinct. Test raw0, allraw0, one missing (allmonthlyshares null, valid individual values retained), a complete month in annual-incomplete snapshot, reversed response order, equal ASIN tie-break, invalid/outside identity and no mutation. Name invalid cases descriptively.
- [ ] Run `node --import tsx --test tests/scripts/xydc-order-inspection.test.ts`, capture expected failure. Implement pure projection minimally and rerun GREEN.
- [ ] Add browser RED cases: full month column and label including zero/missing activate an accessible panel; all4/7/10 and >10 children remain inspectable with internal scroll; annual segment and text legend display correct ASIN's year/total/share/missing/undisclosed; incomplete annual still has accessible legend with unknown values. No outgoing Provider requests on hover/sort/expand.
- [ ] Add annual table RED cases: initially unmounted table and sort, correct aria-expanded/controls, expand and preserve both sort and open state across equivalent and updated same-identity props, reset after close/reopen or parent/window change. Card preview unchanged; monthly screen-reader table remains available while annual table collapsed.
- [ ] Implement panel content, trigger/controller and CSS. Use `role=region` with accessible title, button aria-expanded/controls; no focusable element under aria-hidden, no nested modal, no interactive role=tooltip. Controls have distinct names. Body text >=12px, full ASIN/numbers. Panel fits viewport, flips/clamps at edges, recomputes scroll/resize, scrolls internally without ancestor clipping.
- [ ] Implement hover/focus preview with short safe exit delay, click/tap/Enter/Space pin/toggle, outside/close dismissal, panel mouse entry, exact one-active-panel behavior. Explicit dismissal suppresses automatic reopening while same trigger remains hovered/focused; leaving then re-entering or explicit click reopens. Escape closes panel before outer dialog and restores valid trigger focus; next Escape closes outer dialog. Panel controls participate in outer focus range, collapsed table controls do not.
- [ ] Preserve exact-height stacked bars and ASIN-stable palette; no minimum-positive distortion or fake zero share. Do not add a pie chart or fetch data. Existing 8-color repeat is okay with clear ASIN/attribute text.
- [ ] Exercise interaction at desktop, 390px touch, near viewport boundaries, scroll/resize, pointer movement into long panel, keyboard focus cycle and Escape, close/remove/readd/changed identity. Use real renderToString/hydrateRoot, capture console hydration failures and forbidden requests. Await observed state rather than assuming a click succeeded. Save screenshots only under test-results.
- [ ] Run focused GREEN: `node --import tsx --test tests/scripts/xydc-order-inspection.test.ts tests/scripts/xydc-order-summary.test.ts`; then `node --import tsx --test tests/agent/xydc-order-section.test.tsx` (plus any extracted UI test file). Run changed-file ESLint and `git diff --check`. Existing broad TS debt is not authority to introduce changed-file errors; use targeted check/report to root.
- [ ] Self-review every section3/4 requirement and owned diff, inspect own desktop/mobile screenshots. Commit explicit owned source and tests only. Record RED/GREEN commands, counts, exact screenshot paths, remaining limitations in `.superpowers/sdd/xydc-hover-task-1-report.md` using apply_patch. Final response <=15 lines including commit SHA and any concern.

**Review/acceptance gate:** root generates full task BASE..HEAD package, independent reviewer checks spec and quality, fixes/re-review precede completion. Run separate server regression after UI changes. Root later reuses existing actual 21-child/252-month snapshots in the readonly preview; no need to recollect for UI testing. Collection side uses its own plan and review. Joint build/branch review required before reporting local readiness; formal service remains unchanged.
