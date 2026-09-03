# Slice 2 evidence

## RED

`node --test tests/scripts/sync-job-progress.test.mjs tests/scripts/asin-sync-job-postconditions.test.mjs tests/scripts/sync-pipeline-ordering.test.mjs` failed as expected before implementation: missing `ASIN_MODULE_STATUSES` and `BASE_COHORT_STAGE_IDS` exports, and legacy postconditions reported `failed` rather than `partial`. `node --test tests/scripts/image-remarks-concurrency.test.mjs` failed because `scripts/lib/image-remark-queue.mjs` did not exist.

## GREEN

`node --test tests/scripts/sync-job-progress.test.mjs tests/scripts/asin-sync-job-postconditions.test.mjs tests/scripts/image-remarks-concurrency.test.mjs tests/scripts/sync-pipeline-ordering.test.mjs` — 11 passed, 0 failed.

`npx tsx --conditions=react-server --test tests/agent/asin-sync-readiness.test.ts tests/agent/contracts.test.ts` — 12 passed, 0 failed.

## Build

`npm run build` — completed successfully. The pre-existing bundler chunk-size advisory was emitted; no build error occurred.

## Deferred

No live connectors, browser automation, service lifecycle actions, deployment, or PostgreSQL dynamic-read work was performed.

## Repair round

RED: the added mixed cached/pending traffic, per-ASIN failure-continuation, Alexa-at-creation, image-outcome, and abort-aware concurrency tests failed against the first Slice 2 commit. The failures showed pending Alexa at creation, no per-ASIN invocation seam, generic image outcome handling, and a peak of 3 workers when caller requested concurrency 99.

GREEN: `node --test tests/scripts/sync-job-progress.test.mjs tests/scripts/asin-sync-job-postconditions.test.mjs tests/scripts/image-remarks-concurrency.test.mjs tests/scripts/sync-pipeline-ordering.test.mjs` — 15 passed, 0 failed. This includes mixed cached/pending traffic terminalization, connector failure continuation, preserved image timeout/failure statuses, hard concurrency clamp, and abort settlement.

Build: `npm run build` — completed successfully; the existing bundler chunk-size advisory remained non-blocking.

## Partial aggregation repair

RED: the new ordered BAD/GOOD stage-aggregation regression could not import `reconcileStageStatus`.

GREEN: `node --test tests/scripts/sync-job-progress.test.mjs tests/scripts/asin-sync-job-postconditions.test.mjs tests/scripts/sync-pipeline-ordering.test.mjs` — 13 passed, 0 failed. It verifies both result orders remain partial and all-ready is done. `npm run build` also completed successfully.
