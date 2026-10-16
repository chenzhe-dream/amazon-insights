# 31900 category scope correction — 2026-10-16

## Reproduction
- Opening a saved-conditions link for US 16184244011 (no overviewRun) displayed Darts / 3405881.
- Opening the explicit saved report fe197e6f-c845-450b-b19a-9993f132347c correctly displayed Fitness Equipment / 166423011.
- Cause: idle overview selected the first global collection-history job, regardless of the query scope.

## Correction
- With no bound overview task, match basic data by category, site, period, head count and new-product window. No matching data is shown as missing; empty queries show no report.
- Explicit report snapshots and deliberate administrator history selection remain supported.
- Returning to favorites retains the report category and module instead of defaulting to the first directory category.
- No collection, data backfill or plugin inclusion.

## Verification before publication
- Browser regression reproduced the defect before the change, then passed with the fix, including empty/unmatched category and historical report paths.
- Navigation tests 3 passed; overview scope tests 2 passed; existing-report read-only flow 1 passed.
- Updated the old read-only-flow fixture to start with saved data rather than the obsolete pre-linkage single-job submit path.
- npm run typecheck passed; git diff --check passed.
- Formal manager ownership and PostgreSQL preflight passed; active jobs 0.
- Backup: runtime/backups/formal-category-scope-fix-20261016/database-before.dump
- SHA256: 5D4FE9984B8A35CAF41FC9B410E1C4BAD5205B93AED2C383030787F9CB467E95

Live post-publication verification is recorded separately after deployment.
