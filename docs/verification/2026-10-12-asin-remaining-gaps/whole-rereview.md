# Whole candidate re-review — consolidated trend fixes

Verdict: **WITH FIXES. Both original P2 findings are closed; one newly introduced cache-reuse regression remains.** This is the complete finding list for the current seven-file fix diff against `673eb9accff98d7b52657bce2f75e2bf34db8cd4`.

## Scope and evidence

Read whole-fix-report.md, whole-fixes-review.diff and current parser/reducer/types/rendering/tests. Inspected the existing missing-only selector and numeric parser consumers because the reducer's metadata/return shape changed. No product files, Git state, providers, formal data or services were changed. Only this report was written.

The worker reports 36/36 focused script tests, 8/8 rendered/display tests, clean final TypeScript, lint exit 0 with one existing img warning, and clean whitespace check. Root's wider tests/build were still running when this review was requested; this reviewer does not independently claim their completion. No full suites were repeated. One in-memory reducer plus exact existing selector reproduction was run to confirm the new finding below.

## Strengths and closed findings

- Original P2.1 is closed: the legacy PRODUCT path now validates complete anchored CN/ISO month tokens, actual month range and a nonblank finite nonnegative value. Blank values and malformed periods cannot become verified numeric observations. Literal zero and genuinely empty responses remain valid. Generic/category helper behavior remains unchanged, avoiding unrelated consumer changes. Parser/reducer and actual CLI regressions verify failed refreshes retain previous values and collection dates.
- Original P2.2 is closed for the specified raw daily path: current flat `-1` stamps now become separate missingDaily/missingMonthly evidence, while numeric arrays retain only numbers. Missing evidence survives the reducer/frozen data and is included in the source daily table's date union. Mixed zero/unknown/nonzero, all-unknown and genuinely empty sequences are exercised through the actual CLI temporary persisted file, frozen projection and React rendering. An all-unknown day sequence stays visible.
- Numeric evidence merging is keyed by exact period date, and new per-point provenance keeps an older retained observation's collection date separate from a later unknown observation. Later valid numeric data clears the corresponding unknown marker. Daily/missing fields remain excluded from numeric monthly/annual/growth inputs.
- New return properties are additive; the inspected price-strategy consumer still reads the existing numeric monthly/daily arrays. No source/hash/scope or image/Xiyou code changed in this fix wave.

## Issues

### Critical

None.

### Important

1. **P2 — Retained valid daily evidence loses repair-cache eligibility after an empty or unknown monthly response.**
   - Files: `scripts/build-sorftime-sales-trend.mjs:78` (new unconditional observationPeriods assignment), interacting with the existing missing-only selector at lines 130-134.
   - Reproduction: create a volume record from `[20260901,7]` on `2026-10-01`; refresh on `2026-10-12` with `[]`, or with `[202609,-1]`. In both cases the reducer correctly preserves `dailyObservations.volume=[{date:'2026-09-01',value:7}]` and `dailyFieldFetchedAt.volume='2026-10-01'`. However, the latest period becomes `null` or `month`. Applying the unchanged production selector yields reusable=false because it additionally requires `observationPeriods.volume === 'day'`.
   - Why it matters: the earlier reducer's empty-result preservation returned before replacing this period marker. The new reducer separates latest-attempt metadata from retained evidence but the selector still treats that latest marker as the evidence's identity. A subsequent missing-only repair therefore requests a previously successful metric again, contrary to the approved field-cache reuse and governed missing-only scope. This is an introduced regression rather than a request to broaden coverage.
   - Fix: decide daily reuse from independently validated retained daily evidence, or maintain an explicit retained-evidence period separate from the latest response period. Preserve latest unknown/empty diagnostic metadata. Add a regression covering empty refresh and all-unknown-month refresh followed by the actual repair CLI, asserting volume is not dispatched while genuinely missing metrics are dispatched.

### Minor

None additional.

## Assessment and limits

**Ready to integrate the candidate? With this cache-reuse fix.** The original unknown/zero/calendar and missing-date issues have meaningful direct regressions and are resolved. The new observation merge needs one selector alignment to keep retained evidence reusable.

This remains a candidate code verdict. No additional supplier calls occurred in review; prior controlled receipts, source identity/hash barriers and formal-state boundaries remain as recorded in whole-review.md. Formal deployment, current-report selection and full formal browser acceptance remain separate unchecked steps.
