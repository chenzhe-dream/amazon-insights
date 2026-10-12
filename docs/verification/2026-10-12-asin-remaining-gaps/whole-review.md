# Whole candidate review — ASIN remaining gaps

Verdict at reviewed commit `673eb9accff98d7b52657bce2f75e2bf34db8cd4`: **WITH FIXES — two Important findings remain.** This is the consolidated final finding list for this review pass; no other Critical, Important or Minor findings were identified.

## Scope and method

Reviewed the approved design and implementation plan, whole-candidate-review.diff (including appended new files), current affected source/tests, task reports/reviews and fix-report.md. Base is `88be795ecf4571a9cbeb6542cfa613daf9fc14b8`; the live reviewed checkout includes the explicit `prior &&` narrowing guards added after the package. Read relevant existing parser/cache/identity/display helpers only to check concrete integration risks. No code, Git state, providers, formal files or services were changed. Only this requested report was written.

Two narrow in-memory reproductions were run against current code. Full suites were not repeated. Test/build counts below are root/worker-reported evidence, rather than an independent rerun by this reviewer.

## Strengths

- Trend repair retains independent successful metrics and their original field collection dates when another metric fails; monthly/daily arrays coexist without summing unknown daily semantics into month or annual values. Current numeric/string calendar stamps, ASIN/type identity, mixed periods and conflicting observations are validated. Missing-only metric dispatch and the existing projection/hash path remain in use.
- Xiyou detail and annual-order decisions are separate. The order selector still validates source/country/parent/complete child identities, current twelve-month window and nonfuture timestamps; zero orders count as disclosed data. Detail-only repair excludes already complete order snapshots and preserves their timestamps. Aged partial families now keep known fields and null ratings through failed/empty detail or discovery requests, guarded by matching input/country and rediscovered parent/exact child set. The final explicit prior guards resolve the previously reported TypeScript narrowing issue.
- Image request diagnostics cross queue, progress, cache, candidate, frozen contract and snapshot rendering using closed fields. Unknown software/hash/scope exceptions remain fatal. Authentication and nontransient failures are not automatically requeued; transient attempts remain bounded per valid job and governed. Both outcomes and remarks align by URL before dispatch, and ambiguous duplicate identities are rejected.
- Image candidate hashes are verified on the original body before sanitization. Listing/source scope checks, persisted output hashes, ready-ASIN coverage and URL bindings remain active. The collector regression exercises the real executable path, reordered galleries, exactly two requested identities and 58 preserved notes.
- Existing focused tests cover independent zero orders with missing ratings, aged partial preservation, scoped split stderr parsing, safe diagnostic propagation and saved B0B response-to-persistence-to-frozen-to-rendered month evidence.

## Issues

### Critical

None.

### Important

1. **P2 — Reject unknown values and invalid months before marking legacy product trends verified.**
   - Files: `scripts/lib/sorftime-trend-parse.mjs:22-25`; `scripts/build-sorftime-sales-trend.mjs:48`. The inherited permissive conversion occurs in `parseTrendPart` at lines 78-89.
   - Reproduction using the current `buildSalesTrendRecord`: `responses.volume = "2026年09月="` or `"2026-09=   "` produces `[{month:"2026-09",value:0}]`, `status:"ready"`, and the newly introduced `category:"monthly-verified"`. `"2026-13=12"` similarly produces an invalid month labeled verified.
   - Why it matters: the verified legacy path delegates to `Number(valueRaw)` and does not validate the month calendar. Missing source values become measured zero and enter monthly chart/calculation inputs; invalid periods are also accepted. The permissive helper predates this candidate, but the new explicit legacy validation/classification still claims these observations are verified, violating this change's unknown-never-zero and verified-month requirements.
   - Fix: harden the product-specific legacy path before assigning a verified outcome. Distinguish a genuinely empty response from an observation with a blank/whitespace value; validate actual month numbers. Do not unnecessarily change category consumers of the old permissive helper. Add product parser/reducer/CLI regressions proving unknowns are never zero, invalid calendars never verified, literal zero remains valid, and a malformed refresh preserves previous successful fields and source dates.

2. **P2 — Preserve dates explicitly returned with a missing-value marker through persistence and source display.**
   - Files: `app/project-report-views/competitor-overview.tsx:718-724`; `scripts/build-sorftime-sales-trend.mjs:48-54`; underlying loss at `scripts/lib/sorftime-trend-parse.mjs:60-64`.
   - Reproduction with current supported flat observations: `['20260901',0,'20260902',-1,'20260903',12]` loses `2026-09-02` entirely in the reducer and frozen output. The new source-daily panel renders the two numeric dates, with no row for the explicitly unknown date. With `['20260901',-1]`, the record is classified `valid-empty`, no date survives, and the panel disappears altogether. A narrow actual React static render confirmed both cases; literal zero remains present in the mixed case.
   - Why it matters: the approved design requires original unknown observations and exact source dates to survive through saved data, frozen output and page. Filtering `-1` from numeric chart inputs is appropriate, but also discarding its date makes an explicit unknown observation indistinguishable from a date the supplier never returned. The current render test constructs prefiltered arrays, so its em-dash assertions do not exercise this loss.
   - Fix: retain explicitly missing dates as separate bounded evidence or nullable source observations, including collection provenance. Keep them excluded from numeric month/annual/growth calculations and from successful readiness. Make the source display include returned unknown dates and an unknown marker, including an all-unknown series. Add raw response → reducer → frozen output → render regressions for mixed zero/missing/nonzero, all-missing and genuinely empty responses; preserve existing usable evidence on a later missing-only response.

### Minor

None additional. The prior missing-column collection-date presentation finding is already fixed, and the Xiyou order-only copy/parser findings are closed.

## Verification and live receipt limits

- Root reports final affected combined tests **223/223**, plus **5/5** static Xiyou render tests. Fixer reports final explicit-guard scoped tests **43/43** and direct `tsc --noEmit --incremental false` exit 0. Root reports scoped lint and whitespace checks clean and production build exit 0 with source hash `d03019b4687a366cf4d962482442e8d2b21162be1dae05eb368d0a9796631041`. These results predate any fixes to the two findings above and do not cover their reproduced inputs.
- Reviewed governed-attempt-receipt.json: six Sorftime physical attempts total (tool inspection/volume diagnosis and three other metrics) and two image attempts; canonicalWrites is zero. This is not a claim that six trend ASINs were recovered.
- Reviewed the two-image receipt: target G6 image numbers 2 and 5, immutable listing hash binding, 58 original ready notes preserved (54 frozen plus four URL-bound cache notes), 60 ready after, candidate validated, original source/cache hashes unchanged. This corroborates candidate recovery, not selection by the formal report.
- Root's B0B candidate replay retains four metrics with 25 monthly points each. Current direct monthly string stamps are supported by the saved response; historical daily increment semantics remain unverified, and the code must continue to exclude those from month/annual/growth inference.
- Formal-boundary receipt still identifies Web and Agent as `88be795e`, shared source hash `66ac3d301a5e73d25b06ea043823a1ee63b0ba5e0467dc4ca9950da3af229dcc`. No formal deployment, current-report switch or full formal browser acceptance is established. The earlier annual-tooltip browser timeout remains an explicit acceptance limitation. Live repair of the remaining nine trend ASINs and four Xiyou child details is not established by this review.

## Recommendations and assessment

Resolve the two product-trend unknown/period findings in one scoped fix wave, then rerun the affected trend parser/CLI/frozen/render regressions and the necessary type/build checks for those changes. Preserve the existing numeric consumer contracts and source/hash/scope barriers while adding unknown evidence; no additional provider calls are required to reproduce or fix these issues.

**Ready to integrate the candidate? With fixes.** Image and Xiyou changes meet their reviewed candidate boundaries, but the trend data path still fabricates zero from one supported legacy input and loses explicit missing-date evidence in another. Formal publication and user-browser acceptance remain separate, unchecked work after candidate code approval.
