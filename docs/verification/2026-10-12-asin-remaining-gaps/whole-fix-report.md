# Consolidated whole-review fix report

Candidate only: C:/Users/EDY/.codex/worktrees/asin-remaining-gaps-repair/feat-voc-positioning-skill-execution.
Read whole-review.md, approved remaining-gaps design, task-3 brief/report. Fixed both Important/P2 findings; no provider calls, formal data writes, image/Xiyou changes, deployment, or Git mutations. Predecessor tracked .superpowers documents unchanged.

## Changes
- scripts/lib/sorftime-trend-parse.mjs: strict product legacy CN/ISO month validation rejects blank/whitespace values, malformed partial entries, out-of-range calendar months and unanchored CN dates. Literal zero and genuine empty responses remain valid. Generic/category legacy helpers retain compatibility. Current product parser returns separate missingDaily/missingMonthly labels for explicit -1 while numeric arrays exclude them.
- scripts/build-sorftime-sales-trend.mjs: missingDailyObservations/missingMonthlyObservations retain each date/month plus fetchedAt; dailyObservationFetchedAt/monthlyObservationFetchedAt retain per-point numeric provenance. Merges partial responses by exact period identity, retains prior known values on unknown/empty responses, and keeps both periods across refresh. An all-unknown daily response is daily-unverified; all-unknown monthly is source-unknown rather than valid-empty or verified. Missing metadata never enters numeric readiness/chart/aggregation inputs.
- app/sorftime-sales-trend-data.ts: matching additive type declarations only; generated records unchanged.
- app/project-report-views/competitor-overview.tsx: source daily table includes explicitly missing dates even for all-unknown series. Each missing cell shows em dash and missing collection time; an older retained numeric observation remains visible with its original per-date collection time. Numeric zero remains zero. No daily-to-month/year/growth aggregation.
- tests/scripts/sorftime-current-sales.test.mjs: strict legacy parser/reducer, missing period provenance, partial merge, parser missing labels and generic/category compatibility regressions.
- tests/scripts/sorftime-sales-repair-cli.test.mjs: actual CLI legacy invalid refresh -> temp persisted cache regression.
- tests/agent/project-page-snapshot-overview.test.tsx: raw mixed zero/-1/nonzero, all-unknown and genuine empty -> actual CLI temporary file -> cache reader -> partial frozen output -> actual React render; retained older zero/latest missing provenance render regression. Existing test casts cleaned for scoped lint.

Existing frozen projection already retains observationOutcomes, including classified unknown records. No projection/schema widening required; source identity/hash/scope rules remain active.

## Red evidence
1. node --test tests/scripts/sorftime-current-sales.test.mjs
   9/11 pass, 2 fail before production edits: blank CN value wrongly monthly-verified; missingDailyObservations absent.
2. node --import tsx --test tests/agent/project-page-snapshot-overview.test.tsx
   3/4 pass, 1 fail before UI edits: raw CLI/frozen mixed series lacked rendered 2026-09-02.
A preliminary Python command failed on Windows default GBK decoding before any edit; reran via explicit UTF-8. It did not supply red evidence.

## Green evidence
- node --test tests/scripts/sorftime-sales-repair-cli.test.mjs tests/scripts/sorftime-current-sales.test.mjs tests/scripts/sorftime-trend-parse.test.mjs tests/scripts/sync-stage-output.test.mjs
  36/36 pass. Latest output: .superpowers/sdd/remaining-asin-20261012/whole-fix-tests.log.
- node --import tsx --test tests/agent/project-page-snapshot-overview.test.tsx tests/agent/sorftime-display-contract-regression.test.ts
  8/8 pass, repeated after final test type cleanup.
- npx eslint scripts/build-sorftime-sales-trend.mjs scripts/lib/sorftime-trend-parse.mjs app/sorftime-sales-trend-data.ts app/project-report-views/competitor-overview.tsx tests/scripts/sorftime-sales-repair-cli.test.mjs tests/scripts/sorftime-current-sales.test.mjs tests/agent/project-page-snapshot-overview.test.tsx
  Exit 0, no errors; one pre-existing no-img-element warning at overview line 585.
- git diff --check: exit 0.
- npx tsc --noEmit --incremental false: final exit 0 after test type corrections.
Initial type runs exposed test-only omitted JS JSDoc dataAsins option and a mistaken test cast; both corrected. Final result below supersedes those runs.

## Self-review / limits
Both reviewed repros now have direct regressions. Unknown evidence is separate from numeric consumers, literal zero remains measurable, and invalid legacy refreshes preserve known values and original source dates. Same-period unknown overlap keeps the prior numeric point and a separate latest unknown marker; successful later numeric observations clear that marker. Missing day evidence survives monthly replacement. Numeric per-date timestamps preserve older known values when newly collected numeric points share a metric.
No supplier calls or formal publication/browser acceptance claimed. Root owns consolidated review, wider tests/build and commit.


## Final selector follow-up
Final reviewer identified a retained-evidence reuse issue: latest empty/month response updates observationPeriods even while old valid daily points remain. Repair selector incorrectly required latest response period to be day.

Source edits waited until root explicitly confirmed production build session36344 finished successfully. Changed only scripts/build-sorftime-sales-trend.mjs and tests/scripts/sorftime-sales-repair-cli.test.mjs in this follow-up. Selector now evaluates retained valid numeric daily evidence independently of latest attempt period; observationPeriods and observationOutcomes remain truthful to latest response. No provider calls, formal writes, Git mutations or unrelated changes.

Regression-first red:
node --test tests/scripts/sorftime-sales-repair-cli.test.mjs
8/9 passed; new actual persisted refresh -> repair CLI regression failed because SalesVolume dispatched once instead of zero.

Green:
node --test tests/scripts/sorftime-sales-repair-cli.test.mjs tests/scripts/sorftime-current-sales.test.mjs tests/scripts/sorftime-trend-parse.test.mjs tests/scripts/sync-stage-output.test.mjs
37/37 passed; output whole-fix-selector-tests.log. Test covers prior daily 2026-09-01=7 fetched2026-10-01, actual empty and all-unknown-month refreshes, cache persistence, then missing-only repair dispatching SalesAmount/Price/Rank and zero SalesVolume. Original daily/per-point provenance and missing-month fetched2026-10-12 survive.

npx eslint scripts/build-sorftime-sales-trend.mjs tests/scripts/sorftime-sales-repair-cli.test.mjs: exit0, no warnings/errors.
git diff --check: exit0.
npx tsc --noEmit --incremental false: exit0.
