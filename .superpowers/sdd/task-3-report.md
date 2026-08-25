# Task 3 Report — Dispatch Leased Jobs And Preserve Refresh Recovery

## Summary

- Added a six-loop PostgreSQL sync job dispatcher and worker handler.
- Launch now happens only after a fenced PostgreSQL lease claim.
- Legacy `data/sync-jobs/*.json` files are redacted diagnostic mirrors, not admission or scheduling authority.
- Worker progress and terminal writes mirror JSON progress back to PostgreSQL with `jobId`, `leaseGeneration`, and `workerId` fencing.
- Agent Service starts/stops the dispatcher as part of service lifecycle; stop aborts worker heartbeats and leaves recovery to lease expiry.
- Running/queued sync job refresh remains GET-only and now carries a safe `queuePosition` through the public contract.

## RED Evidence

- Command:
  `npx tsx --conditions=react-server --test tests/agent/sync-job-dispatcher.test.ts tests/agent/asin-sync-session.test.ts`
- Initial result: 22 passed, 2 failed.
- Expected RED failures:
  - `tests/agent/sync-job-dispatcher.test.ts` failed because `server/runtime/sync-job-dispatcher` did not exist.
  - `tests/agent/asin-sync-session.test.ts` failed because restored running jobs did not expose/render `队列 #3`.

## GREEN Evidence

- Command:
  `npx tsx --conditions=react-server --test tests/agent/sync-job-dispatcher.test.ts tests/agent/asin-sync-session.test.ts`
- Result: 25 passed, 0 failed.
- Covered:
  - six loops do not exceed four running jobs;
  - mirror creation and runner launch happen after lease claim;
  - expired worker is fenced after reclaim;
  - exactly one replacement runner launches for a reclaimed job;
  - exhausted lease generations fail safely without launching;
  - terminal jobs settle active stages;
  - browser refresh/rerender remains GET-only and restores job ID/progress/queue position.

## Regression Evidence

- Command:
  `npx tsx --conditions=react-server --test tests/agent/postgres-sync-job-repository.test.ts tests/agent/local-data-bridge.test.ts tests/agent/agent-service-shutdown.test.ts tests/agent/postgres-agent-service.test.ts`
- Result: 25 passed, 0 failed.

- Command:
  `npx eslint server/runtime/sync-job-dispatcher.ts server/services/sync-job-worker-handler.ts server/db/sync-job-repository.ts server/db/postgres/sync-job-store.ts server/services/sync-job-service.ts server/routes/local-data.ts shared/agent-contracts.ts scripts/lib/sync-job-store.mjs tests/agent/sync-job-dispatcher.test.ts --quiet`
- Result: passed.

- Command:
  `git diff --check`
- Result: passed.

## Full Lint Concern

- Command:
  `npm run lint -- --quiet`
- Result: failed on existing React Compiler lint issues in `app/asin-sync-funnel.tsx`, `app/lib/resumed-sync-scope.ts`, `app/page.tsx`, and `tests/agent/helpers/asin-sync-funnel-browser-harness.tsx`.
- The only simple touched-file issue reported by full lint was `prefer-const` in `app/asin-sync-funnel.tsx`; it was fixed and target tests were rerun.
- Remaining full-lint failures are broad React hook/compiler rules already present in areas outside this Task3 backend dispatcher change.

## Safety Notes

- Did not start, stop, or modify live ports `31900`/`31901`.
- Did not access real providers.
- Used isolated PostgreSQL test containers and temporary mirror directories.
- Did not modify migrations `0001`-`0011`, package lock, generated data, or local databases.
- No push/amend/reset/checkout/clean/stash/rebase was used.

## Commit

- Initial Task3 commit: `c347f36f7cdfb880a356ef674d9761638b9e83fc`

## Review Repair — Important 1 And 2

### RED Evidence

- Command:
  `npx tsx --conditions=react-server --test tests/agent/sync-job-dispatcher.test.ts`
- Result: 2 passed, 2 failed.
- Expected RED failures:
  - terminal mirror reconciliation only persisted `currentStageId`; a fast runner that wrote `queue done / catalog skipped / build done` still left `catalog` pending in PostgreSQL and overwrote `queue.completedAt`;
  - progress timer errors from PostgreSQL generated asynchronous `unhandledRejection` activity and the worker did not exit/fail safely.

### GREEN Evidence

- Command:
  `npx tsx --conditions=react-server --test tests/agent/sync-job-dispatcher.test.ts`
- Result: 4 passed, 0 failed.
- Command:
  `npx tsx --conditions=react-server --test tests/agent/sync-job-dispatcher.test.ts tests/agent/asin-sync-session.test.ts`
- Result: 27 passed, 0 failed.
- Command:
  `npx tsx --conditions=react-server --test tests/agent/postgres-sync-job-repository.test.ts tests/agent/local-data-bridge.test.ts tests/agent/agent-service-shutdown.test.ts tests/agent/postgres-agent-service.test.ts`
- Result: 25 passed, 0 failed.
- Command:
  `npx eslint server/runtime/sync-job-dispatcher.ts server/services/sync-job-worker-handler.ts server/db/sync-job-repository.ts server/db/postgres/sync-job-store.ts server/services/sync-job-service.ts server/routes/local-data.ts shared/agent-contracts.ts scripts/lib/sync-job-store.mjs tests/agent/sync-job-dispatcher.test.ts --quiet`
- Result: passed.
- Command:
  `git diff --check`
- Result: passed.
- Command:
  `npm run lint -- --quiet`
- Result: still fails on existing React Compiler lint issues outside this Task3 worker/PG repair scope, including `app/asin-sync-funnel.tsx`, `app/lib/resumed-sync-scope.ts`, and `app/page.tsx`.

### Repair Summary

- PostgreSQL `recordProgress` now accepts and merges all diagnostic mirror stage records in one fenced write.
- Terminal `complete`/`fail` settlement now leaves no auto `active`, `running`, or `pending` stages; manual stages are preserved and existing `done`/`skipped`/`failed` statuses are kept.
- Worker heartbeat/progress intervals now attach explicit catch handlers. Lease loss exits without terminal overwrite; non-lease errors enter the worker failure path, clear timers, and avoid unhandled rejections.
