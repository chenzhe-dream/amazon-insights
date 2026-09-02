# Task 2 implementation report

## Scope

Implemented only Task 2 from `docs/superpowers/plans/2026-09-02-sync-publication-data-quality.md` against the reviewed Task 1 baseline `9fd32af872ad0f592e8dc1327fb9ede844a040c3`.

No real Provider call, service restart, deployment, business POST, or generated runtime-file edit was made.

## RED evidence

Command:

```powershell
node --test tests/scripts/commerce-data-validity.test.mjs tests/scripts/sorftime-fba-fee-parse.test.mjs tests/scripts/scoped-sorftime-module-fallback.test.mjs tests/scripts/asin-data-status.test.mjs; npx tsx --test tests/agent/competitor-metric-resolution.test.ts
```

Observed output (expected failures before production changes):

- `ERR_MODULE_NOT_FOUND` for the not-yet-created `scripts/lib/commerce-data-validity.mjs` and `app/lib/competitor-metric-resolution`.
- `stale zero price and FBA records are missing...`: actual `ready`, expected `missing`.
- `same-job FBA and price fallbacks reject zero money`: actual FBA `ready`, expected `empty`.
- `Sorftime FBA projection treats a zero fee as empty...`: actual `ready`, expected `empty`.

These failures directly covered the missing pure interfaces, stale readiness rejection, scoped fallback rejection, and FBA-zero projection before implementing them.

## GREEN evidence

Command:

```powershell
node --test tests/scripts/commerce-data-validity.test.mjs tests/scripts/sorftime-fba-fee-parse.test.mjs tests/scripts/scoped-sorftime-module-fallback.test.mjs tests/scripts/asin-data-status.test.mjs tests/scripts/sorftime-review-verified-empty.test.mjs; npx tsx --test tests/agent/competitor-metric-resolution.test.ts
```

Output: `31` tests passed, `0` failed.

Coverage includes strict positive-money validation (zero/negative/NaN/infinity/string rejected), positive values, FBA zero projection, scoped FBA/price fallback rejection, stale zero readiness, price current-price retention, rating catalog conflict, genuine zero-review retention, and UI fallback/missing labels. The required FBA, scoped-fallback, and verified-zero-review regression suites were included.

Focused changed-path TypeScript check:

```powershell
npx tsc --noEmit --pretty false 2>&1 | Select-String 'app/page\.tsx|competitor-metric-resolution\.ts'
```

Output: no diagnostics for the changed TS/TSX paths (the command filters the repository's known unrelated baseline diagnostics).

Changed-file lint command:

```powershell
npx eslint scripts/lib/commerce-data-validity.mjs scripts/lib/sorftime-fba-fee-parse.mjs scripts/lib/scoped-sorftime-fallbacks.mjs scripts/lib/asin-data-status.mjs scripts/build-sorftime-price-strategy.mjs scripts/build-sorftime-rating.mjs app/lib/competitor-metric-resolution.ts tests/scripts/commerce-data-validity.test.mjs tests/scripts/sorftime-fba-fee-parse.test.mjs tests/scripts/scoped-sorftime-module-fallback.test.mjs tests/scripts/asin-data-status.test.mjs tests/agent/competitor-metric-resolution.test.ts
```

Output: exit `0`, no findings.

Diff check command:

```powershell
git diff --check
```

Output: exit `0`; only CRLF advisory warnings, no whitespace errors.

## Files changed

- Added strict shared money and catalog-conflict predicates.
- Added pure UI metric resolvers and wired only rating, FBA, and price-strategy cells.
- Made FBA and same-job fallback zero values empty; made price strategies require positive current money; retained machine-readable `status` and `currentPrice` on price UI exports.
- Made rating generation use cached `refreshedCatalog` evidence and mark conflicting `0/0` records empty without Provider calls in tests.
- Made readiness reject stale ready-looking zero price/FBA records.
- Added focused unit tests for each Task 2 contract.

## Self-review

- Positive FBA/price values and `rating > 0, reviewCount = 0` remain valid.
- A `0/0` rating remains valid unless same-ASIN catalog evidence has a positive rating or review count.
- Real upstream empty values remain empty; no category, variants, seller, review text, or FBA fee is synthesized.
- No generated runtime data file was modified.
- The one compatibility caveat is intentional: old price-strategy UI records lacking a machine-readable `currentPrice` are treated as missing until regenerated, because their numeric value cannot be safely validated; their prose never renders as a successful price strategy.

## Independent-review Important fixes

### RED

```powershell
npx tsx --test tests/agent/competitor-metric-resolution.test.ts
```

The new partial-catalog conflict test failed as expected: a Sorftime `0/0` record with catalog `rating: 4.2, reviews: null` returned `{ source: "missing" }` instead of catalog evidence and the conflict/re-sync label.

```powershell
node --test tests/scripts/commerce-data-validity.test.mjs
```

The new price-export fixture failed as expected because `build-sorftime-price-strategy.mjs` did not export `buildPriceStrategyUiExport`; consequently the test could not assert the generator's emitted UI source contains `status` and `currentPrice`.

### GREEN

Implemented only the reviewed corrections:

- Rating resolution now falls back on either available catalog field, preserving a positive catalog rating with null reviews or positive catalog reviews with null rating and keeping the re-sync label.
- The price generator now routes its actual emitted TypeScript through the tested `buildPriceStrategyUiExport()` serializer; the fixture asserts serialized `"status": "ready"` and `"currentPrice": 19.99`.

Verification command:

```powershell
node --test tests/scripts/commerce-data-validity.test.mjs tests/scripts/sorftime-fba-fee-parse.test.mjs tests/scripts/scoped-sorftime-module-fallback.test.mjs tests/scripts/asin-data-status.test.mjs tests/scripts/sorftime-review-verified-empty.test.mjs; npx tsx --test tests/agent/competitor-metric-resolution.test.ts
```

Output: `33` tests passed, `0` failed.

Changed increment lint command:

```powershell
npx eslint app/lib/competitor-metric-resolution.ts scripts/build-sorftime-price-strategy.mjs tests/agent/competitor-metric-resolution.test.ts tests/scripts/commerce-data-validity.test.mjs
```

Output: exit `0`, no findings.

`app/page.tsx` is changed in this increment solely to render the catalog review-count-only case without inventing a rating. Its whole-file lint has the same 10 existing hooks/ref errors at lines `2091`, `2094`, `2402`, `2480`, `4033`, `4087`, and `4141`, all outside the changed comparison-table row near line `3369`; no Task 2 lint diagnostic was introduced. Focused TypeScript filtering for `app/page.tsx` and `competitor-metric-resolution.ts` produced no diagnostics.

```powershell
git diff --check
```

Output: exit `0`; no whitespace errors.
