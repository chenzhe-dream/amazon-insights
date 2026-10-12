# 2026-10-12 ASIN Sorftime repair verification

## Delivery scope

Local isolated patch based on dd5b4dcb. Formal Web 31900, Agent 31901 and historical task data were not changed. Other windows' uncommitted market changes were preserved.

Implemented:

- Current identified category tuples and legacy node IDs, with empty/malformed/mismatched results distinguished.
- product_content galleries when product_detail/scoped detail has no gallery. Fresh legacy galleries remain usable during refresh. A+ detail survives content failures, with error status and correct detail provenance.
- product_trend type parameter, separate governed metric identities, strict current ASIN/type/date/pair validation, legacy month compatibility.
- Daily observations retained as daily evidence in immutable sales output, while monthly readiness and published gaps remain honest. Daily prices use observation counts, not months.
- Field-level sales collection and timestamped retention on later transport/schema failures.
- Signed current coupon semantics and absent-coupon safety, including scoped evidence fallback.
- Missing-gallery partitioning, no model dispatch when all galleries are missing, valid sibling retention, unchanged fatal scope/hash validation.
- Safe specific image-contract runner errors and product_content diagnostic schema compatibility.

## Verification

Regression tests were first observed failing before their corresponding fixes. Combined script suite: 107 tests. Worker lifecycle and shared/display projection suite: 18 tests. Typecheck and production build verified separately; final command outcomes recorded in the task.

Offline replay of saved real responses (new supplier calls: 0): B0BWCQHCWX resolves node 14109871, price 59.99 unchanged, 7 gallery images from product_content. SalesVolume contains 731 daily observations, 0 monthly points; all 731 remain in the immutable partial output with the ASIN still in its gap. Price rejects a response echoing SalesVolume.

Read-only replay of task ee026e41-82b1-4c57-9215-3831471302e7: its original empty gallery output produces 10 individual gaps and 0 image-worker dispatches. Stage finalization is covered with injected persistence and real projection/validation functions; a full real main/build/publication cycle is not represented by this replay.

Independent whole-change review found retention and schema integration defects; these were fixed with regressions. No remaining operational blocker was found in the final inspection. The final price detail missing-ASIN hardening also has a red/green regression.

## Remaining boundaries

- No formal deployment, live single-ASIN recovery, ten-ASIN recollection, browser acceptance, historical-task rewrite, archive or release in this turn.
- Natural-month sales cannot be inferred by summing daily observations. Supplier period semantics/source remain to be confirmed.
- Supplier balance and prior call counts are diagnosis snapshots, not a new live balance check.
- This is the ASIN entry repair; it does not mark unrelated market/OpenSpec changes completed.
