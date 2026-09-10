# Review percentage and manual VOC recovery integration

Date: 2026-09-10. Worktree: `C:/Users/EDY/.codex/worktrees/5b97/feat-voc-positioning-skill-execution`. Baseline: `f2811b6`. No production deployment, restart, database mutation, provider/model invocation, or manual status repair in this implementation.

## Outcomes and source of evidence

- Review rows now retain their metric kind, numerator and denominator. Sample incidence can overlap across topics; Customers Say topic mention shares are not review rates. UI uses fixed 0–100% bars, Chinese explanations and conservative legacy-cache labels. Downstream preprocessing does not misinterpret legacy/Customers Say shares as measured review incidence.
- The actual production A/B revisions were read without mutation. The original cumulative candidate rejected lexical ASIN order that differed from the trusted target order. A pure fixed-runtime preview validated records and provenance in target order; insertion was intercepted with `created:false`. This did **not** recover C live.
- Publication replay retains durable revisions. Known publication conflicts can defer until eligible siblings are processed; missing publication never becomes fake success. Permission, scope, execution/audit fingerprint, cancellation and lease failures stop the page.
- A normalization predecessor retry allocates a free stage ordinal even after an appended input has occupied its former next ordinal. Remaining retries and logical execution cycle are preserved, not increased.

## Parent-executed fresh checks

```text
node --import tsx --conditions=react-server --test tests/agent/voc-queue-safety.test.ts tests/agent/voc-queue-runtime.test.ts tests/agent/alexa-voc-normalization-status-client.test.ts tests/agent/voc-review-display.test.ts tests/agent/voc-review-runtime.test.ts tests/agent/voc-review-browser.test.ts tests/agent/voc-review-page-integration.test.ts tests/agent/review-percentage-rendering.test.ts
64/64 PASS, fail/cancel/skip 0, 41062.7901 ms

node --test tests/scripts/review-percentage-semantics.test.mjs
5/5 PASS, 110.0278 ms

node --import tsx --conditions=react-server --test tests/agent/voc-deterministic-preprocessing.test.ts tests/agent/analysis-agent-eval-set.test.ts
22/22 PASS, 1119.0927 ms

node --import tsx --test tests/agent/alexa-voc-publication-boundaries.test.ts
13/13 PASS, 436.7707 ms

npm run build
exit 0; client/server/RSC/SSR built. Existing large-chunk/static-route-classification warnings remain.

npx eslint server/db/postgres/job-store.ts server/db/sqlite-repository.ts tests/agent/voc-queue-safety.test.ts --max-warnings 0
exit 0

git diff --check
exit 0; ordinary Windows line-ending notices only
```

The normalization implementation worker additionally ran its complete multi-ASIN, worker and authority-boundary suite after the final authority fix: **64/64 PASS**, 78799.1183 ms, no skipped/cancelled tests. See `2026-09-10-voc-publication-recovery-fix.md` for RED/GREEN and exact command. Counts above overlap and should not be summed as unique tests.

TypeScript is **not clean repository-wide**. Parent compared current code against baseline HEAD through an in-memory TypeScript compiler host, overlaying tracked changed source with `git show HEAD:path` and excluding only newly added source roots in the baseline while preserving generated declarations and dependencies. Result: **336 baseline diagnostics, 336 current diagnostics, zero new diagnostics**. `incremental:false` and `noEmit:true`; no generated build-info changes retained. A preliminary baseline excluding all untracked roots instead of only added source produced 342/336; the corrected like-for-like comparison above is authoritative.

## Independent review

Reviewer identified and implementers fixed CS-only zero-sample acceptance, incidence/parent denominator agreement, complete metric tuples in UI, real repository permission errors and actual execution-service scope/fingerprint errors. The appended-input pending-publication fixture closes the queue-allocation integration gap. Independent review confirmed these issues closed, including both adapters' direct insertion matrices and the old SQLite rejection case changed from zero to negative sampledReviews.

Parent additionally executed:

```text
node --import tsx --conditions=react-server --test --test-name-pattern 'SQLite snapshot adapter accepts|SQLite VOC trigger applies|PostgreSQL VOC trigger accepts' tests/agent/data-snapshot-repository.test.ts tests/agent/postgres-migrations.test.ts
3/3 PASS, fail/cancel/skip 0, 6848.2735 ms
```

The matrices test actual database inserts (not only schema parsing): legacy/new/CS-only-zero records accepted; incomplete metadata, arithmetic mismatch and parent denominator mismatch rejected. Invalid candidates carry recomputed checksums/hashes so rejection cannot be mistaken for an unrelated hash failure.

## Expanded-test caveat, verified against the unchanged baseline

Parent ran the entire `tests/agent/data-snapshot-repository.test.ts`: **13 passed / 2 failed**. The failures are `same semantic identity is idempotent and content drift conflicts` (missing expected `DataSnapshotConflictError`) and `different hashes racing in worker isolates close as one drift conflict` (two successes instead of one conflict). A separate detached worktree at **unchanged f2811b6**, sharing only installed dependencies, reproduced **the same two failures** with the exact test-name filter. No implementation files were overlaid into that baseline. These existing assertions were not weakened to claim a green complete suite. This task's changed review matrix and malformed-input tests pass. Therefore the complete repository suite is **not** claimed green.

The read-only baseline probe remains at `C:/Users/EDY/.codex/worktrees/voc-review-baseline-f2811b6`; its attempted cleanup was blocked by tool policy, so no alternate deletion method was attempted. Production and implementation files were preserved.

Parent also ran `node --test tests/rendered-html.test.mjs`: **3/3 PASS**, 540.8011 ms, against the successful local build.

## Production handoff boundary (not executed)

Input for third ASIN `B06VSQQ3SD` remains saved in run `0b1f247f-620b-4475-8a68-53964fdf4be7`; implementation does not claim a new live result. After a separately authorized controlled release (including migration 0029), use existing bounded normalization recovery. Verify A/B heads and model counts remain unchanged, C produces one real terminal, and published snapshot plus status agree. Do not delete audit history, edit status SQL, reset budgets, rerun completed models, or launch unrelated positioning merely to clear the queue. Legacy production review caches are intentionally not rewritten or silently assigned denominators.
