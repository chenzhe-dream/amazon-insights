# Verification — 2026-10-13

## Historical data import (32900 only)
- Imported 81 favorites: 1 explicitly linked four-module batch, 77 independent historical runs, and 3 legacy condition-only favorites. All 81 original run IDs are represented; source run count remains 81.
- Repeated the import: before 81 / after 81, no warnings. No supplier collection or report mutation was performed.
- Actual application store list/export/schema verification: total 81, first page 10, export 81, sites 1; 78 partial projects and 3 condition-only entries. Four-module-ready count is 0, not a claim that every individual report failed.
- History import, navigation and favorites UI/helper regression slice: 11 passed, including a real PostgreSQL repeat-import/edit-preservation/transaction rollback case. TypeScript noEmit, OpenSpec strict validation and diff whitespace checks passed.
- Audit snapshots and results: C:/Users/EDY/Amazon-Product-Opportunity-Insights.runtime/verification/20261013-market-favorites-v2/history-dry-run, history-applied, history-repeat-verified.
- Browser inventory now identifies the loaded 32900 application, but getTab still times out. Visual refresh/open acceptance remains pending; database/application reads are verified independently.
- Implementation command: node --import tsx scripts/backfill-market-project-favorites.ts --output=<new-audit-directory> [--apply]. Default is dry-run; target is hard-coded to the candidate database. 31900 was not modified.

Candidate: C:/Users/EDY/.codex/worktrees/market-research-favorites-v2/feat-voc-positioning-skill-execution
Baseline: 253366e876728a6c9bc35bb9dda2c1b00575b87c.

## Verified
- Focused favorites, navigation and report-display slice: 21 passed (before additional shared-read regression).
- Same-origin proxy: 3 passed, using NODE_OPTIONS=--conditions=react-server.
- Final project favorites database suite: 2 passed, including real cross-organization report service/storage reads, original reader identity preserved, unrelated run denied and cross-organization cancel denied.
- Execution-store regression: 22 passed, including parent and 21 subtests.
- Theme selection-store regression: 3 passed using react-server condition.
- TypeScript noEmit and production build: passed.
- OpenSpec strict validation: passed.
- Candidate 32900/32901 restarted from this worktree; candidate migration 0066 present. Analysis task count remained 81. No collection was triggered.

## Visibility decision
All logged-in users with market permission can see new project favorites, groups and bound reports across organizations. Editing favorite metadata remains restricted to author and original-organization administrators/owners. Shared read authorization does not grant write access. Original single-module favorites retain their compatibility behavior.

## Pending
- Browser save, reload, grouping, export and report-open acceptance: in-app page operations timed out repeatedly; Chrome extension unavailable. User asked to check candidate page.
- 31900 release and post-release browser verification. Formal runtime was not changed.
- Archival is not performed while acceptance remains pending.

## Existing regression failure
The broader market-module-http.test.ts suite fails at line 56 (configuration version: null versus config/test-v1). The same command against untouched formal baseline 253366e8 reproduces exactly the same failure. It is not evidence of a new favorites regression. The failure stops that old HTTP case before later assertions; it does not count as passed acceptance.
Snapshot storage regressions: 9 passed. Proxy regressions: 3 passed. The standalone HTTP proxy-contract case passed; the database HTTP case above failed on both candidate and baseline.
