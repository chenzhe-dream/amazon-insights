# Task 3 report: annual cards and per-parent detail dialog

Source locked at commit `5309104` (`feat: render Xiyou annual parent orders`).

## Implemented

- Replaced the legacy variant preview with two-column annual parent-order cards backed only by exact country/parent/full-childset/current-window snapshots.
- Added complete, partial, raw-zero/undisclosed, stale, and pending presentations without inventing orders or collapsing source/collection timestamps.
- Added top-three annual preview rows using the full-family denominator, stable ASIN colors, ordinary Amazon links, and retained catalog/variant source and failure context.
- Added one portal-based selected-parent detail dialog with all-child annual rows, twelve value-proportional stacked months, explicit missing gaps, accessible description/tooltips, backdrop/close/Escape handling, focus trap/return, and current-model derivation so runtime scope changes cannot retain old parent content.
- Wired `runtimeAnalysisData.variantOrders.families` into the existing page component. No backend/shared-contract change was made.

## TDD evidence

### RED

Command:

```powershell
node node_modules/tsx/dist/cli.mjs --test --test-name-pattern "renders fixed-window annual parent cards" tests/agent/xydc-order-section.test.tsx
```

Result: exit 1, 0 pass / 1 fail. The expected first assertion failed because the pre-implementation SSR output still contained `变体结构与商品页表现` and did not contain `父体订单量份额与12个月趋势`.

### GREEN

Command:

```powershell
node node_modules/tsx/dist/cli.mjs --test tests/agent/xydc-variant-section.test.tsx tests/agent/xydc-order-section.test.tsx
```

Result: exit 0, 11/11 pass. Coverage includes fixed 2026-09-08 clocks, SSR markup hydrated with `hydrateRoot` without hydration errors, 5,900 and full-denominator shares, pending/partial/stale/zero states, desktop/mobile geometry, blocked external traffic/mutations, value-proportional bars, missing-month gaps, two-parent identity isolation, runtime scope replacement, stable colors, dialog absence/open/close/Escape/focus trap/return, and safe links.

Command:

```powershell
node node_modules/tsx/dist/cli.mjs --conditions=react-server --test tests/scripts/xydc-order-summary.test.ts tests/scripts/xydc-order-sync.test.ts tests/agent/xydc-order-runtime.test.ts tests/agent/runtime-analysis-data.test.ts
```

Result: exit 0, 41/41 pass.

Additional checks:

- `npx eslint app/xydc-order-card.tsx app/xydc-order-detail.tsx app/xydc-variant-section.tsx tests/agent/xydc-order-section.test.tsx tests/agent/xydc-variant-section.test.tsx` — exit 0, no warnings.
- `git diff --check` — exit 0 (only repository line-ending notices).
- `npx tsc --noEmit --incremental false --pretty false` — historical exit 2 with exactly 341 diagnostics, matching the root-verified b211b21 baseline. Correction: `app/page.tsx` retains 8 pre-existing diagnostics; the verified claim is that Task 3 introduced no new diagnostics, not that every Task 3-adjacent file has zero diagnostics.

## Screenshots inspected

- Desktop: `C:\Users\EDY\Amazon-Product-Opportunity-Insights\.worktrees\fix-voc-import-status-20260907\test-results\xydc-orders-desktop.png`
- Mobile 390 px: `C:\Users\EDY\Amazon-Product-Opportunity-Insights\.worktrees\fix-voc-import-status-20260907\test-results\xydc-orders-mobile.png`
- Selected-parent dialog: `C:\Users\EDY\Amazon-Product-Opportunity-Insights\.worktrees\fix-voc-import-status-20260907\test-results\xydc-orders-dialog.png`

The mobile table keeps all columns in a labeled, keyboard-focusable horizontal scroll region; no fields are hidden and the document itself does not overflow.

## Files changed

- `.superpowers/sdd/xydc-orders-task-3-report.md`
- `app/comparison-layout.css`
- `app/page.tsx`
- `app/xydc-order-card.tsx`
- `app/xydc-order-detail.tsx`
- `app/xydc-variant-section.tsx`
- `tests/agent/xydc-order-section.test.tsx`
- `tests/agent/xydc-variant-section.test.tsx`

## Self-review

- Confirmed no provider call/fetch effect, no shared-contract/backend mutation, no rating/review allocation, and no 30-day fallback.
- Confirmed pending detail uses explicit missing gaps and `订单数据待采集`; it does not show an order collection timestamp or treat gaps as zero.
- Confirmed screenshots stay untracked under `test-results/`.
- No unresolved Task 3 concern. Whole-branch production build remains intentionally delegated to the root controller.

## Review correction wave

Commit: `fix: address Task 3 UI review findings` (locked SHA returned to the controller with this report).

Implemented all six Important review items in one bounded UI wave:

- Pending order cards retain known variant rows, attributes, ASIN links, prices, listing availability, input-ASIN links, child-info states, variant reason/timestamps and truthful unknown annual values.
- Matched input ASINs are labelled and linked in original competitor-input order, including merged inputs outside the annual top-three preview.
- Order-cache and variant-cache badges are distinct; pending/unavailable child information labels remain visible without conflating either cache source.
- Monthly bars use the exact disclosed total proportion with no 4% clamp/minimum. Zero-only and missing-only months have no quantitative bar; fixed marker rows sit outside the stacks, and positive child segments cannot flex-shrink.
- The decorative chart is hidden from accessibility APIs and paired with a semantic captioned table containing every month/child value as a number, `未披露`, or `缺失`.
- Dialog selection is bound to the selected current model instance, so remove/re-add stays closed until an explicit click while close, Escape, backdrop, focus trap/return and hydration behavior remain covered.

### Correction TDD evidence

RED command:

```powershell
node node_modules/tsx/dist/cli.mjs --test tests/agent/xydc-variant-section.test.tsx tests/agent/xydc-order-section.test.tsx
```

Result: exit 1, 7 pass / 5 fail. Expected failures proved the missing input-ASIN/pending metadata and child/cache labels, stale selection reopening, and distorted/inaccessible chart behavior before production edits.

GREEN command:

```powershell
node node_modules/tsx/dist/cli.mjs --test tests/agent/xydc-variant-section.test.tsx tests/agent/xydc-order-section.test.tsx
```

Result: exit 0, 13/13 pass, including refreshed desktop/mobile/dialog screenshots and no blocked external requests, mutation requests or hydration errors.

Additional scoped verification:

- `npx eslint app/xydc-order-card.tsx app/xydc-order-detail.tsx app/xydc-variant-section.tsx tests/agent/xydc-order-section.test.tsx tests/agent/xydc-variant-section.test.tsx` — exit 0, no warnings.
- `git diff --check` — exit 0; only Git line-ending notices.

Scoped files: `.superpowers/sdd/xydc-orders-task-3-report.md`, `app/comparison-layout.css`, `app/xydc-order-card.tsx`, `app/xydc-order-detail.tsx`, `app/xydc-variant-section.tsx`, `tests/agent/xydc-order-section.test.tsx`, `tests/agent/xydc-variant-section.test.tsx`.

Refreshed screenshots:

- `C:\Users\EDY\Amazon-Product-Opportunity-Insights\.worktrees\fix-voc-import-status-20260907\test-results\xydc-orders-desktop.png`
- `C:\Users\EDY\Amazon-Product-Opportunity-Insights\.worktrees\fix-voc-import-status-20260907\test-results\xydc-orders-mobile.png`
- `C:\Users\EDY\Amazon-Product-Opportunity-Insights\.worktrees\fix-voc-import-status-20260907\test-results\xydc-orders-dialog.png`

Self-review found no remaining Important issue in this correction scope. Final-review triage still retains the recorded Minor observations: small 10–11 px headings/warnings/metadata, palette repetition after 8 children without another discriminator, and independent SSR/client `new Date()` calls potentially crossing a UTC month boundary. Those were intentionally not expanded into typography, palette or architecture work here.
