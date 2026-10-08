# Market Four Modules ZIP Baseline Acceptance Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Freeze the ZIP package as the single business baseline, finish evidence-bound acceptance of the remaining market research flows, and document non-blocking issues without mixing rule versions.

**Architecture:** The four market-research modules continue to use saved, versioned evidence as the source of truth. Deterministic ZIP rules produce facts and scores; model explanations only project those facts and their source references. Supplier calls, translation jobs, persistence, permissions, and browser rendering remain explicit steps with bounded retries. No new overview-to-shape-report dependency is introduced.

**Tech Stack:** Next.js/React, TypeScript, Vitest/Node test runner, Playwright browser tests, PostgreSQL-backed report/revision stores, Sorftime supplier adapters, OpenSpec.

## Global constraints

- `zip-code-v1` means the complete ZIP version: its business documents, executable rule code, thresholds, grade bands, page behavior, and data contracts. The ZIP version is the business requirement for this repair.
- The ZIP score is frozen as: demand 25, competition 20, maturity 10, new-entry 15, product opportunity 15, and price opportunity 15, with grade thresholds 80/70/60/50/40. Product opportunity can reach 14 and price opportunity 13 under the ZIP branches, so the legal reachable total is 97. This is a ZIP property to test and report, not a business conflict.
- The external 20/20/20/15/15/10 proposal is a future rule-version candidate only. It must not be mixed into `zip-code-v1` or used to block this repair.
- Code-level completion and real acceptance are separate states. A passing fixture or typecheck does not prove a real supplier call, model call, permission boundary, or browser layout.
- Preserve original evidence, report versions, organization isolation, retry boundaries, and missing-data explanations. Never turn missing data into zero or an invented conclusion.
- Do not publish, archive, merge, or restart the formal stack from this plan. Those are later workflow steps after real acceptance and user review.

## 1. Freeze and test the ZIP score baseline

- [x] Add a focused fixture test beside the market overview tests, for example `tests/agent/market-overview-zip-score-baseline.test.ts`.
- [x] Use the actual `buildMarketOverviewSynthesis` input contract and assert all six ZIP dimensions, grade thresholds, missing-input behavior, and the independent product/price opportunity branches.
- [x] Assert the reachable maxima 14, 13, and 97 so a later refactor cannot silently replace the ZIP algorithm with the external scoring proposal.
- [x] Assert the report stores an explicit rule version (`zip-code-v1`) and that historical reports are not reinterpreted with a new default.
- [x] Run the focused test and `npx openspec validate enable-market-backend-evidence-flow --strict --no-interactive`.

## 2. Finish the translation chain and failure behavior

- [x] Verify `server/services/market-theme-translation.ts`, `shared/market-theme-translation-contracts.ts`, `server/routes/market-theme-translations.ts`, and the theme UI use the same organization, `moduleRunId`, `attemptId`, `reportHash`, item hash, source text, language, and model identity cache key.
- [x] Add or complete HTTP/browser tests covering: GET is read-only; explicit POST starts work; a provider failure leaves the original text visible with a failed state; retry requests only failed items; successful items are reused; a refreshed page does not duplicate calls; and two organizations or report windows cannot reuse each other's translations.
- [ ] Run one bounded real provider call if credentials and the authorized provider are available. Record the request/run identity and outcome. If unavailable, leave real-provider acceptance open and record the blocker instead of marking it complete.

## 3. Verify real 150/200 collection

- [ ] Trace `sampleSize` from `app/market-overview-section.tsx` through `server/services/market-overview-distribution-collector.ts`, request parameters, step identity, persisted report, and retry state.
- [ ] Add/finish tests for target 150 and 200: the requested target reaches the supplier request, actual returned count is displayed separately, shortfall remains visible, an upstream error is retryable, and a partial result cannot be shown as a full success.
- [ ] Execute one bounded real 150 run and one bounded real 200 run with the authorized Sorftime connector. Preserve run IDs, source metadata, returned counts, and supplier errors. Do not repeat paid calls automatically.
- [ ] If the real connector is unavailable, record the exact external blocker and keep OpenSpec 10.11 unchecked.

## 4. Save, refresh, and multi-window consistency

- [ ] Exercise the overview, theme, keyword, and shape report readers and editors using the current revision/ETag or equivalent optimistic-concurrency boundary.
- [ ] Add browser tests with two windows on the same report: a stale save is rejected without overwriting the newer revision; refresh restores the server revision; historical reports stay read-only; GET/report refresh never starts a paid job; and cached translations are not duplicated.
- [ ] Confirm the UI clearly shows saved, pending, failed, conflict, and retry states and does not hide a stale or failed report behind a success label.

## 5. Image loading and presentation safety

- [ ] Verify `app/api/amazon-image/route.ts`, `app/lib/amazon-image-validation.server.ts`, and all four module image consumers accept valid HTTPS image URLs and provide a stable fallback for invalid schemes, blocked hosts, 404s, or timeouts.
- [ ] Add tests for no mixed-content request, no broken image layout, preserved ASIN/title context, and fallback text when an image is unavailable.
- [ ] Run desktop and narrow browser checks for the image-heavy tables and drilldowns; retain a screenshot or trace for each failure and fix the layout before moving the acceptance gate.

## 6. Permission and organization isolation

- [ ] Test report, revision, translation, retry, and image-proxy endpoints with same-org and cross-org identities.
- [ ] Require a cross-org report or cache lookup to return the existing application denial semantics (403/404 as specified by the route), never data from another organization.
- [ ] Verify admin-only diagnostics and controls are hidden or denied for ordinary users, while ordinary users can still read their authorized evidence and missing-data explanations.

## 7. Complete dynamic business explanations and 14 keyword outputs

- [x] Use `original/亚马逊市场总览综合分析规则.md` and `original/亚马逊关键词需求分析与开品方向(1).md` as the source documents, with `server/domain/market-research/overview-original-synthesis.ts` and the keyword original-estimate/demand modules as the executable mapping.
- [x] For each overview chapter, assert that the conclusion changes with the saved trend, concentration, seller mix, country efficiency, listing, review, rating, price, and demand evidence. Missing or contradictory evidence must produce an explicit limitation.
- [x] For the 14 keyword outputs, require either a concrete conclusion with a source reference or an explicit “待验证” result naming the missing competition, profit, MOQ, compliance, or other evidence. Do not infer a product definition or opportunity grade from a neutral PVS estimate.
- [x] Bind score facts, dynamic explanations, and UI text to the same saved report version; do not add a cross-module shape-report read just to fill a missing field.

## 8. Browser acceptance matrix and final evidence

- [ ] Run the market-overview, shape, keyword, and review/theme browser suites in desktop and narrow viewport modes.
- [ ] Run the focused code suites already covering the completed work: the overview chart/synthesis/layout tests, translation tests, and the 46-test market-research suite; add the ZIP score test and real-run evidence to the same checkpoint.
- [ ] Run `npm run typecheck`, `git diff --check`, and strict OpenSpec validation. Keep the known unrelated `tests/agent/market-module-http.test.ts` fixture mismatch separate unless its own task is explicitly taken up.
- [ ] Update `openspec/changes/enable-market-backend-evidence-flow/tasks.md` only after each acceptance row has evidence. Keep 10.11 open for any unavailable supplier/provider/browser path.

## Acceptance gate

The repair is ready for user review when the ZIP baseline test is green, all code-level suites are green, each real 150/200 run has a preserved outcome, translation failure/retry is observed, save/refresh/multi-window and permission checks pass, image and desktop/narrow browser checks have evidence, and the 14 keyword outputs have source-bound results or explicit missing-evidence statuses. Until then the change remains in the formal worktree and the OpenSpec change remains unarchived.

## Current known state

Code-level translation, overview dynamic explanations, price-band details, and product drilldowns are already covered by focused regressions. The remaining gap is real supplier/provider/browser/permission acceptance and the ZIP score/source-binding closure described above. The standalone `market-module-http` failure expecting `config/test-v1` for a rules flow is a pre-existing fixture/identity mismatch and must not be “fixed” by changing the production rule flow.

## 2026-10-07 unknown-data repair checkpoint

- The live 200-target run returned 186 Sorftime products, with 0 queued/collecting and 0 failed steps. The shortfall is recorded as provider coverage, not padded locally.
- A later accidental UI re-collection (`a2c1d749-3ac0-48df-afbd-a77a9b475192`) was cancelled at 468 completed steps with 184 products and no failed steps. It is excluded from formal 150/200 acceptance evidence; the original completed 200 run remains the preserved acceptance record.
- A single missing price/price-band or a partial margin gap no longer hides the whole current synthesis. The synthesis remains usable and shows a field-level warning; missing recent history, uncertain listing dates, or an all-margin gap still block the conclusion that depends on them.
- Non-positive Sorftime pool prices are normalized to unknown at the shape-report boundary. The original historical catalog rule that preserves an observed zero remains unchanged.
- Focused shape tests: 57 passed. `npm run typecheck` and strict OpenSpec validation pass. The live browser has not been restarted or published after this checkpoint, so the current tab may still show the previous saved rendering.

## 2026-10-07 P0/P1 targeted diagnosis and execution order

### P0: business truth and acceptance blockers

1. **200-target Sorftime run is a completed real run.** The evidence is `target=200`, `returned=186`, `included=186`, `completedSteps=571`, `queued/collecting=0`, `failed=0`, run id `20c77a01-2571-4ab5-ac9d-29d30f331899`. The 14-item difference is an upstream coverage shortfall and must remain visible; it is not a failed collection and must not be filled locally. The previously reported “缺真实 Sorftime 150 条运行” refers only to the separate 150-target acceptance case.
2. **The 150 case remains open.** Execute one bounded 150-target run, preserve its run id, target, returned/included counts, supplier metadata, and any retryable error. Do not infer 150 acceptance from the 200 run.
3. **ZIP score baseline is now locked.** The executable synthesis matches the ZIP reference after canonicalizing mixed Windows line endings to CRLF and removing only the project-required `@ts-expect-error` comment. The frozen hashes remain unchanged; the focused original-synthesis and ZIP-score suite now passes 13/13.
4. **Real provider evidence is still separate from code completion.** Translation and model paths have code-level tests, but the current local runtime uses a fake/unconfigured provider. A real provider run, including one observable failure and failed-item retry, is required before claiming the translation/model acceptance row complete.

### P1: consistency, presentation, and isolation

1. **Save/refresh/multi-window:** use two windows on one report; verify stale save conflict, refresh restoration of the server revision, historical read-only behavior, and no paid job from GET/refresh.
2. **Images:** verify valid HTTPS, invalid/blocked/404/timeout fallbacks, preserved ASIN/title context, no mixed-content request, and desktop/narrow layout stability.
3. **Permissions:** verify same-org access and cross-org denial for report, revision, translation, retry, and image proxy; verify ordinary users cannot access admin diagnostics.
4. **Dynamic explanations and keyword outputs:** bind every conclusion and all 14 keyword outputs to the same saved report version; missing or contradictory evidence must render `待验证/依据不足`, never a fabricated conclusion.
5. **Browser acceptance:** run the four modules in desktop and narrow viewports only after the above evidence is captured; then update 9.5, 9.6, 10.10, and 10.11 one row at a time.

### Execution order and closure gate

1. Repair and lock the ZIP score byte baseline, then run the focused P0 tests.
2. Record the independent real 150 run; retain the already completed 200 run as evidence without repeating it.
3. Configure an authorized real provider and verify translation failure/retry, or record the exact external blocker.
4. Execute P1 save/refresh/multi-window, permission, image, and desktop/narrow browser checks.
5. Update OpenSpec only from preserved evidence. Do not publish or archive until every P0/P1 row is green or has an explicitly recorded external blocker approved for deferral.

## 2026-10-08 P0/P1 execution checkpoint

- ZIP score, dynamic overview explanations, and 14 keyword business outputs are now closed at code level; focused P0 suites pass 28/28 when JSX tests run without the `react-server` condition, and translation server tests pass 3/3 with that condition.
- P1 code and browser regressions pass: image/shape/theme/keyword/module-isolation 47/47, plus the original-parity desktop/narrow browser group 22/22. The independent-input test was aligned to the current `查询关键词` action label; no production behavior changed for that assertion.
- `npm run test:market-research` passes 46/46; `npm run typecheck` passes; the main OpenSpec change validates strictly and is now 50/54.
- Real acceptance remains open: an independent Sorftime 150 run, real provider translation failure/retry, two-window and cross-organization checks, and desktop/narrow browser evidence against the formal runtime. Keep 10.11 unchecked and do not publish or archive.

### 2026-10-07 采集入口修复

- 重新采集和商品池上限变更现在先显示明确的目标数量确认条，确认后才调用 Sorftime；取消会恢复当前报告的实际上限。浏览器回归覆盖 100 和 150 两个目标，确认前不会新增采集请求。
- 形态报告新增“未知数据原因”折叠摘要：按已保存的商品池、历史销量、详情毛利和图片状态归类缺口，明确未知不等于 0，也不等于连接失败；缺口继续保留在原版统计口径中。
