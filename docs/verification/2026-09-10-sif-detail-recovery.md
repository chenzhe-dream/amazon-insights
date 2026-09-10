# SIF listing detail recovery verification

## Scope and evidence

- US ASINs B01E6CX34C / B07Y4PJJR4 / B07WFC14VR.
- Historical run c39a954a-7dc1-49ba-be86-07387731814b and job 81f00bbf-0a3e-4e67-91e5-10cf32be908a contain compact totals, not detail rows.
- New snapshots retain full same-batch listing records. Historical recovery uses a separate append-only, tenant/run-scoped PostgreSQL collection; no global raw cache, monthly fetch, VOC/model call or favorite mutation.
- Collection fetch deadline is 45 seconds; database statements/locks are separately bounded, and publication checks its deadline before insertion. This is not a claim that transaction COMMIT always occurs within 45 seconds.
- Official SIF tools/list checked live on 2026-09-10: overview supports listing aggregation and latelyDay=30; structure supports pageNum/pageSize integers with default page size 20 and no documented maximum. Actual returned rows remain the acceptance criterion.

## Local gates

- 33 collector/service/snapshot tests passed (then proxy test rerun under the repository's required react-server condition).
- PostgreSQL migrations, append-only recovery, proxy deadline: 30/30 passed using disposable Docker test databases.
- Actual page headless regression plus browser identity/race/route/data tests: 62/62 passed.
- Final collector/service/strict admin route/timeout tests: 18/18 passed.
- npm run build passed.
- Full TypeScript check reports the same 334 pre-existing diagnostics; no diagnostic in new traffic recovery/collection implementation files.
- Independent read-only review rechecked same-batch authority, cross-tenant scope, deadline behavior and all earlier review fixes. No current-three-ASIN release blocker identified.

## Controlled release preparation

- Formal baseline d391c9f; active work 0.
- Backup: shared runtime backups/sif-detail-recovery-20260910-095959 (118 verified file copies, 28 project JSON files, all 15 dirty generated app files, configuration, prior artifact, plus PostgreSQL custom-format dump).
- PostgreSQL host listener process remains 51004; database container amazon-insights-postgres-cutover must not be restarted.
- Real collection, deployed identity, UI acceptance and unchanged historical-data fingerprints are pending below.
