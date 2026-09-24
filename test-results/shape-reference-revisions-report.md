# Task: v4 manual reference revisions

## Result and contract

- Added an append-only `market_shape_reference_revisions` table with organization/run uniqueness, parent chain, idempotency key, v4 run/scope trigger, and update/delete protection. Legacy price revisions are untouched.
- `PostgresMarketShapeReferenceRevisionStore(context)` exposes `save({actor,moduleRunId,request,idempotencyKey})`, `find({actor,moduleRunId,revisionId?})`, and `list({actor,moduleRunId})`.
- Request: `{expectedParentRevisionId,selectedAsins,assignments:[{asin,label}],note?}`. Selection is 1–300 unique ASINs from the frozen Sorftime pool; labels are manual strings of at most 60 characters or null. The server supplies author, time, source data, and revision ID.
- Saved `revision.data` freezes `{scope,pool,productHistory,productAmountHistory,categoryDashboard}` from the current persistent readers. Save records source/input IDs and hashes of current attempt outputs. Find checks the stored revision, binding, source document hashes, and run/scope/actor identity without refreshing the report from newer attempts or calling the provider.
- `save` locks the run, checks the active actor, then enforces organization scoped idempotency and the expected latest parent. Repeating a prior idempotency key returns the identical saved revision even after source retries.
- `MarketShapeReferenceRevisionRequestSchema`, `MarketShapeReferenceRevisionSchema`, `MarketShapeReferenceRevisionResponseSchema`, and `MarketShapeReferenceRevisionHistorySchema` are exported for the primary worker's route/read integration.

## Test-first evidence and verification

The new PostgreSQL test was run before implementation and failed because the revision store module was absent. After implementation, a genuine v4 run saves a failed amount state, retries that source task, then verifies the first revision still contains the failed state while a new revision contains the successful amount. It also covers idempotent replay, changed-key conflict, invalid labels/selections, wrong organization, stale parent, no provider call on saved reads, ordered history, and immutable table rows.

- `npx tsx --conditions=react-server --test tests/agent/market-shape-reference-revisions.test.ts` — **1 passed, 0 failed**. The existing reader internals emitted a pg deprecation warning about overlapping queries on a transaction client; the test completed successfully.
- `npx eslint shared/market-shape-reference-revision-contracts.ts server/db/postgres/market-shape-reference-revision-store.ts tests/agent/market-shape-reference-revisions.test.ts` — **passed with no warnings**.
- `git diff --check` for task files — **passed**.
- `npm run typecheck` — **not globally passing during parallel work**. Latest output contains only errors in `server/services/market-shape-sorftime-reader.ts` and `tests/agent/market-shape-sorftime-pool.test.ts`; none are in revision task files. The primary worker owns those files.

No deployment or live provider/network requests were made.
