# ASIN Remaining Gaps Implementation Plan

> **For agentic workers:** Use subagent-driven-development, with test-first implementation and task reviews. Execute the approved design in this independent candidate worktree.

**Goal:** Preserve usable trend evidence, independently report Xiyou details and annual orders, and retain safe image failure diagnostics while retrying only missing image identities.

**Architecture:** Extend existing collectors and frozen stage contracts rather than creating another data path. Maintain scope, hash, coverage and governed request checks. Candidate tests and provider verification receipts are separate from formal publication and browser acceptance.

**Tech Stack:** Node ESM/node:test, TypeScript/tsx, React render tests, existing governed providers and PostgreSQL task contracts.

## Global Constraints

- Base commit: 88be795ecf4571a9cbeb6542cfa613daf9fc14b8. Only edit this managed worktree on codex/asin-remaining-gaps-repair.
- Do not publish, restart shared formal services, merge another window's checkout, rewrite captured historical rows, or resume unrelated market/VOC work.
- Keep successful observations, original unknowns, source identities, collection times and source hashes. Null is never zero.
- Daily observations are not natural-month sales unless verified as daily increments. Rolling windows must never be summed; cumulative counters require differences/reset handling.
- Xiyou currently receives YYYY-MM monthly orders; all declared children and all twelve months are required for annual completeness independently of ratings.
- Image diagnostics allow only closed request stage, HTTP status, error class and local governance category. No credentials, arbitrary response bodies or URLs.
- Target only missing trend metrics, four missing child details and G6 gallery slots 2/5 by URL identity; retain existing successful data. No forced full recollection.

## Task 1: Image diagnostics and safe targeted recovery

Files: scripts/lib/image-remark-request.mjs, image-remark-outcome.mjs, image-remark-queue.mjs, build-listing-image-remarks.mjs; image frozen-output schema and display types/components; tests/scripts/image-remark*.test.mjs and tests/agent/listing-image-remark-resolution.test.ts.

Interface: request error diagnostic -> sanitized outcome.diagnostic -> progress/cache/candidate/frozen output -> display reason. Existing outcomes without diagnostics remain valid, with historical reason marked unrecorded. Gallery URL binds each outcome and remark.

- [ ] Write regressions before code: actual request 429/401/403/network/invalid JSON/output traverses queue and serialized candidate; timeout remains distinct; injected secret fields are discarded. Historical connector failure displays unrecorded. Auth failure is not automatically requeued; transient failures are bounded by job/attempt policy.
- [ ] Run `node --test tests/scripts/image-remark-request.test.mjs tests/scripts/image-remarks-concurrency.test.mjs tests/scripts/image-remark-status-identity.test.mjs` and observe missing diagnostics failures.
- [ ] Extend existing sanitization/outcome projection: `imageRemarkOutcome(status, {attemptJobId, diagnostic})`; pass safe diagnostics at every serialization boundary, and preserve fatal source/hash/scope exceptions.
- [ ] Add collector regression with sixty prior outcomes and exactly two failed G6 URLs: assert `requests.length === 2`, all 58 ready notes preserved, changed gallery ordering realigned by URL, and missing/conflicting identities rejected.
- [ ] Run relevant queue, candidate/hash, frozen schema and rendered diagnostic tests; review diff and record exact results. Root commits reviewed task files to avoid concurrent git index mutation.

## Task 2: Independent Xiyou completeness and detail-only repair

Files: scripts/lib/xydc-repair-readiness.ts, scripts/build-xydc-variant-data.ts, scripts/run-asin-sync-job.mjs, app/asin-sync-funnel.tsx, app/xydc-order-card.tsx, Xiyou display components and tests/scripts/xydc*.test.ts.

Interface: existing readiness gains independent relationship/coreDetails/ratings/orders results and missing fields per child. Existing aggregate status remains truthful; runner uses an explicit reason with independently complete orders. Collector reuses verified orders when only details require repair.

- [ ] Write regressions before code using matched twelve-month zero orders and PARTIAL_CHILD_INFO: one child missing only stars/ratings keeps core ready and annual orders complete; missing title/image/price keeps core incomplete; mismatched family/window/all-child coverage remains rejected.
- [ ] Run `node --import tsx --test tests/scripts/xydc-repair-readiness.test.ts` and observe early family-status rejection failure.
- [ ] Remove detail-first early return; evaluate identity-bound order snapshot independently. Keep original family.infoStatus, null ratings and missing detail values unchanged.
- [ ] Add a collector detail-only regression: four missing child details dispatched, complete orders dispatched zero times; successful core details remain visible and valid empty ratings cause a bounded nonblocking detail gap.
- [ ] Update runner/funnel/order display copy to describe exact child/field gaps, with “全年订单已完整” where verified. Render regression asserts no combined order-gap claim for complete snapshots.
- [ ] Run readiness, collector/cache/window and display tests, review and record exact results. Root commits reviewed task files.

## Task 3: Trend evidence, classification and source daily display

Files: scripts/build-sorftime-sales-trend.mjs, scripts/lib/sorftime-trend-parse.mjs, scripts/lib/asin-data-status.mjs, scripts/lib/sync-stage-output.mjs, app/project-report-views/competitor-overview.tsx, sales data type/schema and trend tests.

Interface: each metric retains monthly arrays or dailyObservations plus collection dates/period and closed failure category. Frozen sales output preserves independent evidence. Monthly charts consume monthly arrays only; a separate source daily observation panel shows date/value with semantics unverified.

- [ ] Extend actual repair CLI regressions before code: valid empty, daily-only, request failure, wrong ASIN/type and malformed response have distinct classes. A later failed metric cannot erase successful fields. Keep real G6 historic generic cause unrecorded.
- [ ] Run `node --test tests/scripts/sorftime-sales-repair-cli.test.mjs tests/scripts/sorftime-current-sales.test.mjs` to observe missing classification failures.
- [ ] Reuse existing field reducer; add closed safe status metadata where missing and preserve source/hash checks. Never construct synthetic natural months from unknown daily sequences.
- [ ] Add rendered page test with valid daily points and no month points: source day observations visible with exact dates/values, monthly unavailability disclosed, no “日销量” or annual/growth inference. Check monthly arrays still render and zero/missing observations remain distinct.
- [ ] Run collection/parser/frozen/schema/display tests and offline saved B0B replay; points must match response -> persisted fields -> frozen output -> display.
- [ ] Root inspects current tool description and performs at most one governed single-ASIN probe if credentials/source access permits. Record raw echo and period semantics as confirmed or unresolved. Prepare missing-only recovery commands; never mutate formal canonical state.
- [ ] Task review and exact test evidence; root commits reviewed task files.

## Task 4: Whole-change review and integration receipt

- [ ] Run combined affected script/agent tests, `node node_modules/typescript/bin/tsc --noEmit`, and `git diff --check`; use production build if relevant runtime dependencies permit.
- [ ] Generate scoped task/whole-branch review packages and resolve actionable findings with regressions.
- [ ] Record candidate workspace/commits, passing counts, live supplier probe outcomes, remaining semantics, target-only request plan and formal update/browser acceptance steps in docs/verification/2026-10-12-asin-remaining-gaps-repair.md.
- [ ] Finish on a committed clean candidate branch. Formal deployment, real target recovery and current-report browser acceptance remain explicit unchecked items for main-window coordination.
