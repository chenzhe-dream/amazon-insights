# Original overview synthesis v6 provenance

Pure sources: `C:/Users/EDY/.codex/project-notes/amazon-insights/ui-parity-20260914/reference/app/`.

- `sellersprite-market-overview-synthesis.ts`: SHA256 `63e600da48dd435db1f2cd6c6a39eb7748b10d8b4db806f3ec20c48c3a9d8727`.
- `sellersprite-market-price-analysis.ts`: SHA256 `ba6a3bd54b98c4af3b13306e408a0d2faf4d1ce5720878e045b7513af8177495`.
- `sellersprite-market-niche.ts`: SHA256 `d3f0adf7646614007113fde71dd16ed5c13b7ab6fe8b6b123f1add1028b5fbfc`.

The three original modules retain exact source bytes except one `@ts-expect-error` comment needed by this project's stricter TypeScript checking. The original `undefined > 1` condition is intentionally unchanged. The parity test removes that single comment before checking the original hashes. No weights, thresholds, labels, missing-data defaults or runtime expressions are edited.

`original-mappers.ts` extracts the original `toNumber`, `toPct`, `asRecord`, `labelPath`, `mapNiche`, `asList`, `parseDistProducts`, `distRows`, `crnRows`, and `parseProductDemand` function bodies from `app/lib/sellersprite-market-query.ts`, with local type imports and exports only. Network functions are not included.

`../overview-original-synthesis.ts` reads already verified frozen receipts, matches research/site/node/month, retains request-bound currency when no echo exists and rejects explicit currency conflicts, then calls those original mappers. It does not fetch data or consult other modules. Explicit null and empty numeric strings retain the original Number conversion behavior. Source gaps are reported separately from original score defaults.

The frozen catalogue has no original Sorftime category_trend SalesCount + AvgPrice pair. Original sales and amount trends remain empty; SellerSprite monthly totalUnits is not a substitute. Product demand page views use the saved market_product_demand_trend receipt. Price item profit is used directly without competitor lookup or invented average-profit samples. Original prose still contains fixed six-month and dollar-sign language; both caveats are exposed in the returned assumptions.
