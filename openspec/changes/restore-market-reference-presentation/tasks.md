# Market Reference Frontend Implementation Plan

> Use subagent-driven-development for independent shape and insight presentation tasks; main owns overview and integration.

**Goal:** Restore original frontend presentation over our current backend.
**Architecture:** Existing browser client/task ownership and saved contracts remain; JSX and scoped CSS adapt their outputs to the reference.
**Tech Stack:** React, TypeScript, Vite, Playwright.

## Global Constraints
- Reference app is read-only. Never copy collector/backend logic.
- No server/shared/lib service changes. Preserve browserRequestId and idempotency.
- No paid provider calls in tests; no unrelated dirty worktree changes or bulk commits.

## Tasks
- [x] 1. Overview: add regression for result-row report action, selected scope, read-only reopen/restore; restore inline report and compact history/task controls in app/market-research-section.tsx and app/market-overview-section.tsx.
- [x] 2. Overview report: restore three KPI groups and report section hierarchy using saved values only in app/market-overview-report.tsx and dedicated scoped CSS; test unavailable metric handling.
- [x] 3. Shapes: restore reference presentation in shape components; preserve revisions/classification; browser fixture and screenshot.
- [x] 4. Keywords/themes: restore reference presentation with existing saved results; preserve commands/history/copy; browser fixture and screenshots.
- [x] 5. Integrate and review: inspect independent changes, desktop/mobile states, affected tests, typecheck, lint delta, strict OpenSpec.
- [x] 6. Publish with formal manager; verify exact source/artifact identity, health and unchanged backend/data.

## Follow-up: original presentation and analytical boundary (2026-09-16)
The earlier six tasks describe the prior release, not visual acceptance of this follow-up. Execute using subagent-driven-development; do not commit the shared dirty tree.

- [x] 7. Inventory original source boundaries and methodology in reference-boundaries.md: identify original UI, browser calculations, API routes and provider code; map each of four modules to current implementation and retained improvements. Add an executable browser-import boundary test so restored UI cannot import original collectors or preview fixtures.
- [x] 8. Overview: create a pure section/view-model mapping under app/lib; restore the original result report order, chart cards and visible missing states using current saved data in market-overview-report/distributions. Test stable ordering, null handling, original section coverage and read-only restoration; retain existing semantic analysis and evidence references.
- [x] 9. Shape: separate result presentation from orchestration as needed in market-shape-*; restore original dashboard, tables and conclusions; retain source gaps, classification, revisions and paging. Run existing shape fixture browser and regression tests and inspect result screenshots.
- [x] 10. Keyword/themes: separate result presentation from orchestration as needed in market-keyword-* and market-theme-*; restore original after-analysis layout with current facts and original analytical dimensions. Preserve copy, filtering/paging, manual classifications and task controls. Run targeted fixture browser and regression tests and inspect screenshots.
- [x] 11. Review integrated frontend and boundary tests, run typecheck/build and scoped regressions, verify backend hashes unchanged from start, and record local verification plus remaining data/capability gaps. Provide original-vs-current result preview for review without using fabricated data as production outputs.
