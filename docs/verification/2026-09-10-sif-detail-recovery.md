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
- Deployed web and agent source: f42ab3631c40ad436b6a115c32e26ce924383a05.
- Source hash c9f68932ec97a472e8a62d376657b1af55a6f399a4075bcbbc08d0e9359f2575; web artifact 3eeb2165fe3374213d9d83f2ff47d344a4ccb6efea9aac439068b50df03c0e5d. Local and LAN health checks passed.

## Real-data acceptance

- Collection 8f507174-ec66-49c3-a0a4-b93d139b620a binds historical snapshot 9ccaaa61-80f1-4a03-b142-57ce41a82f55.
- Collected at 2026-09-10T02:04:33.870Z. Six logical/physical requests, each one attempt, 3242 ms including readback and idempotent replay. Replay made no extra provider requests.
- Provider structure total and returned rows agree: 11 / 2 / 6. pageSize=1000 returned every reported child for these three ASINs; no universal pagination guarantee is inferred.

| ASIN | Listing total | Ad channels | Recommendation sources shown | Children |
|---|---:|---:|---:|---:|
| B01E6CX34C | 277123 | 4 | 6 | 11 |
| B07Y4PJJR4 | 22753 | 2 | 5 | 2 |
| B07WFC14VR | 187741 | 4 | 6 | 6 |

- Actual default repository-backed read and strict response contract return this collection; frontend mapping marks all three detail groups complete, with the new same-batch totals. Cross-organization read returns null.
- Formal anonymous GET and POST both return 401. Admin/member and strict scope injection behavior passed route tests.
- Current run's six snapshots, ten stage outputs, original job, all 24 VOC heads and 24 VOC revisions retain their before/after fingerprints.
- All 15 generated app files, 28 project/favorites JSON files and formal environment configuration retain exact hashes.
- Live Chrome control could not attach; the existing in-app tab is logged out. No credentials changed or authentication bypassed. Actual page layout is covered by the headless regression suite; final visual acceptance in the user's authenticated Chrome requires refreshing the original page.
