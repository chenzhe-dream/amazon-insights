# Sorftime gap fix report

## Bound evidence (read-only)

- Bound job/run was terminal with three ASINs and no active work.
- `fba`: all three generated records were `source: keepa` and `status: error`; the safe job diagnostics identified the first physical failure as SellerSprite governance/provider degradation. No Sorftime diagnostic was recorded for the preceding `product_detail` call.
  - Classification: upstream dependency error caused by an incorrect FBA adapter dependency. The pre-existing adapter fetched Sorftime `product_detail` but discarded its documented `fba_fee` projection and made Keepa mandatory.
- `listing`: all three Sorftime Listing records were already `ready`, with a non-zero gallery count (6, 7, and 7). The only safe diagnostics concerned optional SellerSprite badge enrichment, not the Sorftime gallery call.
  - Classification: verified successful Sorftime write; the reported missing images are an external image rendering/published-artifact follow-up, outside this adapter-only change. No Listing parser or UI code was changed.
- `category`: no requested ASIN appeared in the optional SellerSprite catalog and no Sorftime category record was created. The category builder filtered its input exclusively from that catalog, therefore issued no direct Sorftime node lookup for the requested ASINs.
  - Classification: scheduling/input omission.

No payloads, URLs, credentials, database URLs, or raw provider responses were retained in this report.

## TDD evidence

RED command:

```text
node --test tests/scripts/sorftime-fba-fee-parse.test.mjs tests/scripts/sorftime-category-input.test.mjs
```

Expected and observed RED: both tests failed with `ERR_MODULE_NOT_FOUND` because the FBA projection and Category request-input helpers did not exist.

GREEN/focused command:

```text
node --test tests/scripts/asin-data-status.test.mjs tests/scripts/sorftime-fba-fee-parse.test.mjs tests/scripts/sorftime-category-input.test.mjs tests/scripts/sorftime-listing-parse.test.mjs tests/scripts/sorftime-trend-parse.test.mjs tests/scripts/provider-degradation.test.mjs tests/agent/sync-job-production-main-resume.test.ts
```

Observed GREEN: 57 passed, 0 failed.

Changed-file lint:

```text
npx eslint scripts/build-sorftime-fba-fee.mjs scripts/build-sorftime-category-trend.mjs scripts/lib/sorftime-fba-fee-parse.mjs scripts/lib/sorftime-category-input.mjs tests/scripts/sorftime-fba-fee-parse.test.mjs tests/scripts/sorftime-category-input.test.mjs
```

Observed: exit 0.

One build only:

```text
npm run build
```

Observed: exit 0. The build emitted only pre-existing-size/proxy environment warnings; no build failure occurred.

## Fix and review

- Implementation commit: `33210b8fb5bc45d1419ed7539b3eb4633e307a55`.
- Exact implementation paths:
  - `scripts/build-sorftime-fba-fee.mjs`
  - `scripts/build-sorftime-category-trend.mjs`
  - `scripts/lib/sorftime-fba-fee-parse.mjs`
  - `scripts/lib/sorftime-category-input.mjs`
  - `tests/scripts/sorftime-fba-fee-parse.test.mjs`
  - `tests/scripts/sorftime-category-input.test.mjs`
- Self-review: `git diff --check` and `git show --check` were clean. The change is limited to Sorftime FBA projection and Category input selection. It does not call SellerSprite, SIF, image AI, Alexa, a browser, or a real provider.

## Protected WIP and concerns

- Protected worktree state stayed outside the index: 16 pre-existing modified files (generated app files plus the existing task report) and 10 pre-existing untracked project JSON files.
- The SHA-256 digest of the sorted protected-WIP status/hash manifest was unchanged across the final review and implementation commit: `c7cde135e1fe79f793a666bd82f101b1c12d87a644205995deec4100ae927346`.
- Concern: FBA now reports Sorftime's documented estimate (`fba_fee`), not a verified Keepa pick-and-pack fee. It is the correct available Sorftime-only result, and callers must label it as the Sorftime source.
- Follow-up: Listing image bytes are already written; diagnose CDN/browser rendering and deployed artifact alignment separately. Do not treat this adapter change as a fix for image display.
- No provider probe, new job, resume, deployment, browser action, or live ASIN action was performed.
