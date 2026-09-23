# Market Module Independent Input Implementation Plan

> **For agentic workers:** Implement each checked task in sequence with a failing test before production code. This task is intentionally kept in one isolated branch.

**Goal:** Give each of the four market modules an independent, refreshable category query without changing analysis execution.

**Architecture:** Keep the existing overview query keys and add per-module URL-backed selection state for shapes, keywords and themes. The parent market section owns the four drafts and passes only the active draft into its existing module component; favorites project the active draft into the legacy favorite contract.

**Tech Stack:** React, TypeScript, Next.js, Playwright, Node test runner.

## Global Constraints

- Do not change market collectors, rules, run schemas, database tables or task start behavior.
- Preserve old module deep links and favorites, read-only report restoration and request idempotency.
- Do not modify or deploy the formal 31900/31901 service or the pending administrator UI branch.

## Tasks

### Task 1: Freeze independent-input behavior in browser tests

- [x] Add a Playwright case with four different node IDs. Navigate between modules, refresh, and assert each field retains its own value.
- [x] Assert the four module forms submit their own node ID without submitting the others.
- [x] Run the test before implementation and verify its cross-module assertion fails.

### Task 2: Isolate drafts and URL navigation

- [x] Add a pure URL adapter for per-module selection keys and legacy one-module link fallback, with focused tests.
- [x] Replace the parent section's single shared module selection with three independent selections while keeping overview scope unchanged.
- [x] Preserve per-module keys and market report IDs in `marketViewHref`; do not copy overview node to a new module.
- [x] Run browser and navigation tests to green.

### Task 3: Preserve favorites, reports and responsive UI

- [x] Make shared favorites save the active module's own selection and restore only that module's selection.
- [x] Keep already saved run IDs readable after navigation; verify switching and restoring never starts a collection.
- [x] Run targeted favorite, module entry and browser tests, typecheck, and inspect desktop/mobile screenshots.

### Task 4: Final verification

- [x] Compare changed files with the isolated baseline and verify no backend or formal-service changes.
- [x] Commit the independent-input change on its dedicated branch and report the exact validation and any unverified real-service behavior.

## Verification record

- TypeScript typecheck and production build passed in this worktree.
- Market navigation, independent-input browser, shared-favorite browser and HTTP submission browser tests passed serially: 12/12. The parallel run had a Vite test-server conflict in one existing overview subcase; that same case and the entire group passed serially.
- New helper, navigation and browser test files passed scoped ESLint. Existing ESLint failures in the untouched portions of `market-research-section.tsx` are inherited from the base commit.
- Isolated browser harness screenshots were inspected at 1440 px and 390 px widths. The authenticated formal-service page was not checked because this branch was not published.
