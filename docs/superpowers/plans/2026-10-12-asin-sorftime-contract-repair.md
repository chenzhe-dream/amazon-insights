# ASIN Sorftime Contract Repair Implementation Plan

> Execute task by task using executing-plans. The user approved the P0/P1 diagnosis on 2026-10-12.

**Goal:** Restore the ASIN collection entry for current Sorftime responses and stop a missing gallery from aborting the batch.

**Architecture:** Keep transport, request governance, immutable job scope and hashes intact. Adapt product detail/content and trend consumers at the ASIN script boundary, retaining legacy responses. Partition validated image input by ASIN before dispatch.

**Tech Stack:** Node ESM, node:test, TypeScript, existing PostgreSQL task store.

## Constraints

- Base: dd5b4dcb; independent managed worktree. Preserve other windows' market changes.
- Do not deploy, rewrite historical reports or bypass provider governance.
- Match ASIN and trend type. Daily observations cannot be summed or relabeled as natural-month totals.
- Reuse same-job validated galleries and existing successful modules. New content has separate provenance.
- Scope/hash corruption remains fatal; a valid report with a missing gallery becomes an individual gap.

## Task 1: Product detail/content contract

Files: scripts/lib/sorftime-product-contract.mjs, scripts/build-sorftime-category-trend.mjs,
scripts/build-sorftime-listing-content.mjs, scripts/lib/sorftime-listing-parse.mjs,
scripts/lib/scoped-sorftime-evidence.mjs, tests/scripts/sorftime-current-detail-content.test.mjs.

- [x] Red: identified tuple category resolves; empty tuple is empty; mismatched ASIN rejects; scoped A+ without gallery does not skip image collection.
- [x] Implement normalize detail and category identity; collect product_content only where galleries need loading; retain detail signals and correct provenance.
- [x] Green: category, scoped listing and consumer boundaries; replay saved real content.

## Task 2: Product trend contract

Files: scripts/lib/sorftime-trend-parse.mjs, scripts/build-sorftime-sales-trend.mjs,
scripts/build-sorftime-price-strategy.mjs, scripts/lib/sorftime-mcp-client.mjs,
tests/scripts/sorftime-current-trend.test.mjs, tests/scripts/sorftime-current-sales.test.mjs,
tests/scripts/sorftime-trend-request-identity.test.mjs, tests/scripts/sorftime-sales-admission.test.mjs.

- [x] Red: nested monthly flat pairs parse; daily points remain daily; wrong ASIN/type, mixed dates and malformed values reject.
- [x] Request type; parse supported new and old periods; daily price commentary uses observation counts, never month counts.
- [x] Keep daily sales observations separate from month arrays and disclose unsupported monthly period.
- [x] Green: current contract, legacy price/trend boundaries and single-provider admission.
- [x] Review fixes: preserve partial responses and collection dates; retain daily evidence in immutable reports without removing display gaps; handle signed/absent coupons safely.

## Task 3: Individual image gaps and final verification

Files: scripts/lib/image-remark-listing-input.mjs, scripts/run-asin-sync-job.mjs,
tests/scripts/image-remark-listing-input.test.mjs, tests/scripts/sync-image-gap-continuation.test.mjs.

- [x] Red: one missing gallery retains valid siblings; all missing dispatches no image worker and reaches the stage finalization gate; corrupted scope/hash rejects. Full main/publish execution is not claimed by this test.
- [x] Partition gallery-ready and missing ASINs; persist individual gap results; run only the valid cohort.
- [x] Green: image candidate/hash/cohort tests, pipeline ordering, worker lifecycle; typecheck and diff review.
- [x] Replay actual saved 10-ASIN task and current responses offline, without rewriting it.
- [x] Report code completion and remaining live publication/acceptance separately.

## Remaining live verification

- [ ] Integrate this isolated patch with the current formal/candidate worktree after a scoped review; do not overwrite other windows' changes.
- [ ] Update the authorized acceptance runtime, verify one real ASIN, then repair only missing modules of the 10-ASIN cohort.
- [ ] Confirm the supplier's daily SalesVolume meaning and supported natural-month source; until then monthly values remain unavailable rather than invented.

Evidence: docs/verification/2026-10-12-asin-sorftime-contract-replay.json and
docs/verification/2026-10-12-asin-sorftime-contract-repair.md.
