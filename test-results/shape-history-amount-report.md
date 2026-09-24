# Task 1: Sorftime product amount history

## Scope and contract

- `collectMarketProductHistory` accepts optional `metric: 'SalesVolume' | 'SalesAmount'`; omission remains SalesVolume with identical request and evidence hash to explicit SalesVolume.
- SalesAmount uses independent points `{ month, amount, issues }`. `amount` is a finite, nonnegative decimal at most `Number.MAX_SAFE_INTEGER`, or `null` for unavailable/invalid/conflicting data. Real zero remains zero. The evidence unit is `currency` bound to `scope.currency`; any echoed top-level `currency`, `currency_code`, or `currencyCode` is checked.
- `ProductAmountHistoryPublicSchema` is separate from the volume contract and exposes `currency`, up to 300 products, amount points, and reference periods `{ id, fromMonth, toMonth, months, amount, missingMonths }`.
- `referenceProductHistoryPeriods(points, referenceMonth)` uses the original dashboard's sorted last 3/6 actual returned months and the previous two calendar years. A period with no points or an invalid point has `value: null`; `months` records the actual included months. Legacy `productHistoryPeriods` remains unchanged.
- `readMarketShapeAmountHistory` has the same read input as `readMarketShapeHistory`, reads current `collect-product-amount-history` steps, and replays immutable source/input hashes locally. It expects the input record `{ collection: 'product-amount-history', asin, metric: 'SalesAmount', points, sourceRef }` produced by the primary worker. It makes no remote provider request.
- The existing volume product list limit increases to 300; its point/period schemas and all existing behavior for up to 100 products remain unchanged.

## Test-first evidence

The new amount test file was run before implementation and failed because `ProductAmountHistoryPublicSchema` was absent. After implementation, the new and existing history tests pass. The tests cover decimal amount, zero, missing/invalid/negative/unsafe/conflicting amounts, response currency/site conflicts, source evidence hash stability for legacy volume, 300 capacity, actual-month reference periods, pending reads without snapshot access, and successful immutable replay without remote access.

## Commands and results

- `npx tsx --conditions=react-server --test tests/agent/market-product-history.test.ts tests/agent/market-product-history-amount.test.ts` — **12 passed, 0 failed**.
- `npx eslint shared/market-product-history-contracts.ts server/services/market-product-history-collector.ts server/services/market-shape-history-reader.ts tests/agent/market-product-history-amount.test.ts` — **passed**.
- `git diff --check -- shared/market-product-history-contracts.ts server/services/market-product-history-collector.ts server/services/market-shape-history-reader.ts` — **passed**.
- `npm run typecheck` — **not yet globally passing during parallel work**. The latest run reports only errors in the primary worker's in-progress `market-shape-sorftime-flow.test.ts` and `market-shape-sorftime-pool.test.ts`; no errors in Task 1 files. The primary worker owns their resolution.

No deployment, live provider, or network calls were made.
