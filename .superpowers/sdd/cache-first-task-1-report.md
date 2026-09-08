# Task 1 report: cached annual order display

## Outcome

- Added a browser-safe, pure selector that safely parses candidates, rejects future/mismatched data, ranks complete current/history snapshots deterministically, preserves provenance, and projects stale state without mutating persisted data.
- Added canonical read-only family cache discovery. It scans only the validated country directory, accepts only regular non-symlink canonical parent/window files whose recomputed cache path exactly matches, and tolerates malformed/missing optional candidates.
- Runtime order lookup now delegates to discovery while retaining authorized family grouping/deduplication and the existing response shape.
- Cards, detail dialog, and annual inspection render the selected snapshot's actual period. Historical data is labelled `历史缓存 · 当前统计区间待补齐`; expired current-period data is labelled `缓存数据 · 待更新`; the section heading remains the requested default period.
- Extracted the existing 24-hour cache freshness predicate to one browser-safe shared module and re-exported it from the collector cache module without changing its public API or default.
- No writer change was required: existing focused regressions already prove failed forced refresh and forced partial response preserve an intact complete same-window snapshot as stale.

## TDD evidence

### RED

1. `node --conditions=react-server --import tsx --test tests/scripts/xydc-order-display.test.ts tests/agent/xydc-order-runtime.test.ts`
   - Initial import RED: 5 passed, 1 failed because the selector module did not exist.
   - After a minimal null-returning selector seam: 8 passed, 4 failed on prior complete fallback, current complete preference, current-partial fallback, and complete all-zero selection.
2. Same pure/runtime command after adding runtime expectations:
   - 10 passed, 2 failed because old-window complete data and expired current complete data were still discarded.
3. `node --import tsx --test tests/agent/xydc-order-section.test.tsx`
   - 13 passed, 2 failed: the historical complete snapshot was not selected and the new lifecycle label was absent.
4. `node --import tsx --test --test-name-pattern="historical detail" tests/agent/xydc-order-section.test.tsx`
   - 0 passed, 1 failed after proving the dialog used the historical totals/window but lacked the required historical lifecycle label.
5. `node --conditions=react-server --import tsx --test tests/scripts/xydc-order-display.test.ts`
   - Freshness extraction RED: module-not-found for the new shared freshness seam before extraction.

### GREEN while iterating

- Pure selector plus runtime focused run: 13 passed, 0 failed.
- Pure/discovery/freshness focused run: 9 passed, 0 failed.
- Historical SSR/status targeted run: 2 passed, 0 failed.
- Historical detail/annual inspection targeted browser run: 1 passed, 0 failed.

## Final task matrix

1. Server/pure/writer matrix:
   - Command: `node --conditions=react-server --import tsx --test tests/scripts/xydc-order-display.test.ts tests/agent/xydc-order-runtime.test.ts tests/scripts/xydc-order-summary.test.ts tests/scripts/xydc-order-sync.test.ts tests/agent/runtime-analysis-data.test.ts`
   - Result: 50 passed, 0 failed, 0 skipped.
2. UI matrix:
   - Command: `node --import tsx --test tests/agent/xydc-order-section.test.tsx tests/agent/xydc-variant-section.test.tsx tests/agent/xydc-variant-label.test.ts tests/agent/xydc-order-progress-ui.test.tsx tests/agent/xydc-order-poll-owner.test.ts`
   - Result: 35 passed, 0 failed, 0 skipped. Browser tests were headless and loopback-only; no external requests were made.
3. Changed-file lint plus whitespace verification:
   - Command: `npx eslint shared/xydc-order-display.ts shared/xydc-order-freshness.ts scripts/lib/xydc-order-display-cache.ts scripts/lib/xydc-order-cache.ts app/lib/runtime-analysis-data-server.ts app/xydc-variant-section.tsx app/xydc-order-card.tsx app/xydc-order-detail.tsx app/xydc-annual-inspection.tsx tests/scripts/xydc-order-display.test.ts tests/agent/xydc-order-runtime.test.ts tests/agent/xydc-order-section.test.tsx; git diff --check -- <same changed paths>`
   - Result: exit 0; no ESLint diagnostics or whitespace errors. Git emitted existing Windows LF-to-CRLF working-copy notices only.

## Changed paths owned by Task 1

- `shared/xydc-order-display.ts` (new)
- `shared/xydc-order-freshness.ts` (new extraction)
- `scripts/lib/xydc-order-display-cache.ts` (new)
- `scripts/lib/xydc-order-cache.ts`
- `app/lib/runtime-analysis-data-server.ts`
- `app/xydc-variant-section.tsx`
- `app/xydc-order-card.tsx`
- `app/xydc-order-detail.tsx`
- `app/xydc-annual-inspection.tsx`
- `tests/scripts/xydc-order-display.test.ts` (new)
- `tests/agent/xydc-order-runtime.test.ts`
- `tests/agent/xydc-order-section.test.tsx`
- `.superpowers/sdd/cache-first-task-1-report.md` (this report)

## Self-review and concerns

- Verified the selector never aggregates across windows, never mutates candidate snapshots, preserves fetched/source timestamps, and retains raw-zero-as-undisclosed summary behavior.
- Verified repeated runtime reads do not change file names, contents, or modification times; noncanonical and mismatched files cannot enter selection.
- Preserved all collector locks, cancellation, budgets, provider behavior, and newer-success/write protections; no Provider client, task, timer, build, deployment, restart, or real collection was invoked.
- The full TypeScript baseline comparison was intentionally left to the coordinator as assigned. No build was run.
- Coordinator commits `f5220e2` and `34b3180`, dirty evidence documents, and `test-results/` were preserved and excluded from this task commit.
